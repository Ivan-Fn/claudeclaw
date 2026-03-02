// ── Platform-Agnostic Message Processing Core ────────────────────────
//
// This module contains the shared message processing pipeline used by
// all channel adapters (Telegram, Slack, etc.). It handles:
// - Agent invocation with auto-continue on timeout
// - Memory context building and conversation logging
// - Session management
// - Token usage tracking and context window warnings
//
// Channel-specific code (formatting, file download, commands) lives
// in src/channels/<channel>.ts.

import { MAX_TIMEOUT_RETRIES } from './config.js';
import { logger } from './logger.js';
import { runAgent, type UsageInfo } from './agent.js';
import { buildMemoryContext, saveConversationTurn } from './memory.js';
import {
  getSession,
  setSession,
  saveTokenUsage,
} from './db.js';
import { voiceCapabilities, synthesizeSpeech } from './voice.js';
import type { MessageChannel } from './channels/types.js';

// Re-export formatters for backward compatibility (tests import from bot.ts)
export { formatForTelegram, escapeHtml, splitMessage } from './channels/format-telegram.js';

// ── Context Window Tracking ─────────────────────────────────────────────
const CONTEXT_WARN_THRESHOLD = 150_000;
const lastUsage = new Map<string, UsageInfo>();

function checkContextWarning(compositeId: string, usage: UsageInfo): string | null {
  lastUsage.set(compositeId, usage);

  if (usage.didCompact) {
    return 'Context window was auto-compacted this turn. Some earlier conversation may have been summarized. Consider /newchat + /respin if things feel off.';
  }

  if (usage.lastCallCacheRead > CONTEXT_WARN_THRESHOLD) {
    const pct = Math.round((usage.lastCallCacheRead / 200_000) * 100);
    return `Context window at ~${pct}%. Getting close to the limit. Consider /newchat + /respin soon.`;
  }

  return null;
}

/** Get last known usage for a composite ID (used by channel adapters for /status). */
export function getLastUsage(compositeId: string): UsageInfo | undefined {
  return lastUsage.get(compositeId);
}

// ── Active Abort Controllers ───────────────────────────────────────────
const activeAborts = new Map<string, AbortController>();

/** Cancel an active request. Returns true if there was one to cancel. */
export function cancelRequest(compositeId: string): boolean {
  const controller = activeAborts.get(compositeId);
  if (controller) {
    controller.abort();
    activeAborts.delete(compositeId);
    return true;
  }
  return false;
}

// ── Per-chat voice mode toggle ─────────────────────────────────────────
const voiceEnabledChats = new Set<string>();

export function isVoiceEnabled(compositeId: string): boolean {
  return voiceEnabledChats.has(compositeId);
}

export function toggleVoice(compositeId: string): boolean {
  if (voiceEnabledChats.has(compositeId)) {
    voiceEnabledChats.delete(compositeId);
    return false;
  }
  voiceEnabledChats.add(compositeId);
  return true;
}

// ── Message Processing Pipeline ────────────────────────────────────────

/**
 * Platform-agnostic message processing pipeline.
 * Called by channel adapters after normalizing the incoming message.
 *
 * @param channel - The channel adapter for sending responses
 * @param cid - Composite ID (e.g., "telegram:12345")
 * @param rawChatId - Raw platform chat ID (for env vars passed to agent)
 * @param userMessage - The user's message text
 * @param respondWithVoice - Whether to respond with a voice note
 * @param skipLog - Whether to skip conversation logging (e.g., for /respin)
 */
export async function processMessage(
  channel: MessageChannel,
  cid: string,
  rawChatId: string,
  userMessage: string,
  respondWithVoice = false,
  skipLog = false,
): Promise<void> {
  // 1. Start typing indicator
  const stopTyping = channel.startTyping(rawChatId);

  // 2. Build memory context
  const memoryContext = buildMemoryContext(cid, userMessage);
  const fullMessage = memoryContext + userMessage;

  // 3. Get or create session
  const sessionId = getSession(cid);

  // 4. Create abort controller
  const abortController = new AbortController();
  activeAborts.set(cid, abortController);

  try {
    // 5. Run agent (with auto-continue on timeout)
    let currentMessage = fullMessage;
    let currentSessionId = sessionId;
    let result = await runAgentWithAbort(currentMessage, currentSessionId, rawChatId, abortController);

    // Auto-continue: if the agent timed out mid-work, resume automatically
    for (let retry = 0; retry < MAX_TIMEOUT_RETRIES && result.error === 'timeout'; retry++) {
      if (result.sessionId) {
        setSession(cid, result.sessionId);
        currentSessionId = result.sessionId;
      }

      logger.info({ compositeId: cid, retry: retry + 1, sessionId: currentSessionId }, 'Auto-continuing after timeout');
      await channel.send(rawChatId, `Still working... (auto-continue ${retry + 1}/${MAX_TIMEOUT_RETRIES})`);

      const retryAbort = new AbortController();
      activeAborts.set(cid, retryAbort);

      currentMessage = 'Continue where you left off. Complete the task you were working on.';
      result = await runAgentWithAbort(currentMessage, currentSessionId, rawChatId, retryAbort);
    }

    // 6. Save session
    if (result.sessionId) {
      setSession(cid, result.sessionId);
    }

    // 7. Save to memory + conversation log
    if (!skipLog) {
      saveConversationTurn(cid, userMessage, result.text, result.sessionId ?? sessionId);
    }

    // 8. Send response
    const caps = voiceCapabilities();
    const shouldSpeakBack = caps.tts && (respondWithVoice || voiceEnabledChats.has(cid)) && !result.error;

    if (shouldSpeakBack && channel.sendVoice) {
      try {
        const audio = await synthesizeSpeech(result.text);
        await channel.sendVoice(rawChatId, audio);
      } catch (err) {
        logger.warn({ err }, 'TTS failed, falling back to text');
        await channel.sendFormatted(rawChatId, result.text);
      }
    } else {
      await channel.sendFormatted(rawChatId, result.text);
    }

    // 9. Log token usage and check context warnings
    if (result.usage) {
      const activeSessionId = result.sessionId ?? sessionId;
      saveTokenUsage(
        cid,
        activeSessionId,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.lastCallCacheRead,
        result.usage.totalCostUsd,
        result.usage.didCompact,
      );

      const warning = checkContextWarning(cid, result.usage);
      if (warning) {
        await channel.send(rawChatId, warning);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('exited with code 1')) {
      const usage = lastUsage.get(cid);
      const hint = usage
        ? `Last known context: ~${Math.round(usage.lastCallCacheRead / 1000)}k tokens.`
        : 'No usage data from previous turns.';
      await channel.send(
        rawChatId,
        `Context window likely exhausted. ${hint}\nUse /newchat to start fresh, then /respin to pull recent conversation back in.`,
      );
    } else {
      logger.error({ err }, 'Agent error');
      await channel.send(rawChatId, 'Something went wrong. Check the logs and try again.');
    }
  } finally {
    stopTyping();
    activeAborts.delete(cid);
  }
}

// ── Agent Runner ────────────────────────────────────────────────────────

async function runAgentWithAbort(
  message: string,
  sessionId: string | undefined,
  chatId: string,
  abortController: AbortController,
) {
  const agentOpts: Parameters<typeof runAgent>[0] = {
    message,
    onTyping: () => {},
    abortSignal: abortController.signal,
    env: { TELEGRAM_CHAT_ID: chatId },
  };
  if (sessionId !== undefined) agentOpts.sessionId = sessionId;
  return runAgent(agentOpts);
}
