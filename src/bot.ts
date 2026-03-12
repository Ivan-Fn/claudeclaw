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

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { MAX_TIMEOUT_RETRIES } from './config.js';
import { logger } from './logger.js';
import { runAgent, type UsageInfo } from './agent.js';
import { buildMemoryContext, saveConversationTurn } from './memory.js';
import {
  getSession,
  setSession,
  saveTokenUsage,
  setActiveRequest,
  clearActiveRequest,
  getModelOverride,
  logToHiveMind,
} from './db.js';
import { BOT_NAME } from './config.js';
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

// ── File Marker Extraction ────────────────────────────────────────────

interface FileMarker {
  type: 'document' | 'photo';
  filePath: string;
  caption?: string | undefined;
}

interface ExtractResult {
  text: string;
  files: FileMarker[];
}

const HOME = homedir();
const BLOCKED_PATTERNS = ['.env', 'credentials', 'token', 'secret', '.key', '.pem', 'id_rsa', 'id_ed25519'];

function isPathSafe(filePath: string): boolean {
  const resolved = resolve(filePath);
  // Must be under home directory
  if (!resolved.startsWith(HOME)) return false;
  // Block path traversal
  if (filePath.includes('..')) return false;
  // Block known sensitive files
  const lower = resolved.toLowerCase();
  if (BLOCKED_PATTERNS.some(p => lower.includes(p))) return false;
  return true;
}

export function extractFileMarkers(text: string): ExtractResult {
  const files: FileMarker[] = [];
  const pattern = /\[SEND_(FILE|PHOTO):([^\]|]+)(?:\|([^\]]*))?\]/g;

  const cleaned = text.replace(pattern, (_, kind: string, filePath: string, caption?: string) => {
    const trimmedPath = filePath.trim();
    if (isPathSafe(trimmedPath)) {
      files.push({
        type: kind === 'PHOTO' ? 'photo' : 'document',
        filePath: trimmedPath,
        caption: caption?.trim() || undefined,
      });
    } else {
      logger.warn({ filePath: trimmedPath }, 'Blocked unsafe file send path');
    }
    return '';
  });

  const trimmed = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { text: trimmed, files };
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
  // Start typing indicator outside try so it's always available for finally
  const stopTyping = channel.startTyping(rawChatId);
  try {
    // Track this request as in-flight (for auto-resume if bot restarts mid-task).
    // Skip re-registering on resumed messages -- the row already exists and
    // re-inserting would reset resume_count to 0, defeating the max-attempts guard.
    if (!skipLog) {
      setActiveRequest(cid, channel.channelId, rawChatId, userMessage);
    }

    // Build memory context
    const memoryContext = buildMemoryContext(cid, userMessage);
    const fullMessage = memoryContext + userMessage;

    // Get or create session + model override
    const sessionId = getSession(cid);
    const modelOverride = getModelOverride(cid);

    // Create abort controller
    const abortController = new AbortController();
    activeAborts.set(cid, abortController);
    // 5. Run agent (with auto-continue on timeout)
    let currentMessage = fullMessage;
    let currentSessionId = sessionId;
    let result = await runAgentWithAbort(currentMessage, currentSessionId, rawChatId, channel.channelId, abortController, modelOverride);

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
      result = await runAgentWithAbort(currentMessage, currentSessionId, rawChatId, channel.channelId, retryAbort, modelOverride);
    }

    // 6. Save session
    if (result.sessionId) {
      setSession(cid, result.sessionId);
    }

    // 7. Save to memory + conversation log
    if (!skipLog) {
      saveConversationTurn(cid, userMessage, result.text, result.sessionId ?? sessionId);
    }

    // 7b. Log to HiveMind (cross-agent activity log)
    const costStr = result.usage ? `$${result.usage.totalCostUsd.toFixed(4)}` : '';
    const modelStr = result.model || 'unknown';
    logToHiveMind(
      BOT_NAME,
      rawChatId,
      result.error ? `error:${result.error}` : 'response',
      `${userMessage.slice(0, 120)}${userMessage.length > 120 ? '...' : ''}`,
      JSON.stringify({ model: modelStr, cost: costStr, tokens: result.usage?.outputTokens ?? 0 }),
    );

    // 8. Extract file markers and send response
    const { text: responseText, files: fileMarkers } = extractFileMarkers(result.text);

    const caps = voiceCapabilities();
    const shouldSpeakBack = caps.tts && (respondWithVoice || voiceEnabledChats.has(cid)) && !result.error;

    if (shouldSpeakBack && channel.sendVoice) {
      try {
        const audio = await synthesizeSpeech(responseText);
        await channel.sendVoice(rawChatId, audio);
      } catch (err) {
        logger.warn({ err }, 'TTS failed, falling back to text');
        await channel.sendFormatted(rawChatId, responseText);
      }
    } else {
      await channel.sendFormatted(rawChatId, responseText);
    }

    // Send any file attachments
    for (const file of fileMarkers) {
      if (!existsSync(file.filePath)) {
        await channel.send(rawChatId, `Could not send file: ${file.filePath} (not found)`);
        continue;
      }
      try {
        if (file.type === 'photo' && channel.sendPhoto) {
          await channel.sendPhoto(rawChatId, file.filePath, file.caption);
        } else if (channel.sendDocument) {
          await channel.sendDocument(rawChatId, file.filePath, file.caption);
        }
      } catch (err) {
        logger.warn({ err, filePath: file.filePath }, 'Failed to send file');
        await channel.send(rawChatId, `Failed to send: ${file.filePath}`);
      }
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
        result.model,
      );

      const warning = checkContextWarning(cid, result.usage);
      if (warning) {
        await channel.send(rawChatId, warning);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logToHiveMind(BOT_NAME, rawChatId, 'crash', userMessage.slice(0, 120), JSON.stringify({ error: errMsg.slice(0, 200) }));
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
    clearActiveRequest(cid);
  }
}

// ── Agent Runner ────────────────────────────────────────────────────────

async function runAgentWithAbort(
  message: string,
  sessionId: string | undefined,
  chatId: string,
  channelId: string,
  abortController: AbortController,
  model?: string,
) {
  // Pass the channel-specific chat ID env var to the agent subprocess
  const envKey = `${channelId.toUpperCase()}_CHAT_ID`;
  const agentOpts: Parameters<typeof runAgent>[0] = {
    message,
    onTyping: () => {},
    abortSignal: abortController.signal,
    env: { [envKey]: chatId },
  };
  if (sessionId !== undefined) agentOpts.sessionId = sessionId;
  if (model) agentOpts.model = model;
  return runAgent(agentOpts);
}
