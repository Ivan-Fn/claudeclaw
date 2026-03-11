import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PID_FILE, PROJECT_ROOT, TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, BOT_DISPLAY_NAME } from './config.js';
import { logger } from './logger.js';
import { initDatabase, closeDatabase } from './db.js';
import { escapeHtml } from './channels/format-telegram.js';
import { initScheduler, stopScheduler, type TaskExecutor } from './scheduler.js';
import { runAgent } from './agent.js';
import { enqueue } from './queue.js';
import { runDecaySweep } from './memory.js';
import { cleanupOldUploads } from './media.js';
import { checkNewSkills } from './skills-check.js';
import { startDashboard, stopDashboard } from './dashboard.js';
import { TelegramChannel } from './channels/telegram.js';
import { SlackChannel } from './channels/slack.js';
import { channelFromComposite, rawChatId } from './channels/types.js';
import type { MessageChannel } from './channels/types.js';

// ── PID Lock ───────────────────────────────────────────────────────────

function acquireLock(): void {
  mkdirSync(dirname(PID_FILE), { recursive: true });

  // Try atomic exclusive create first (prevents TOCTOU race)
  try {
    writeFileSync(PID_FILE, String(process.pid), { flag: 'wx' });
    return; // Lock acquired
  } catch {
    // File exists -- check if the owning process is still alive
  }

  const existingPid = readFileSync(PID_FILE, 'utf8').trim();
  try {
    process.kill(Number(existingPid), 0);
    logger.error({ pid: existingPid }, 'Another instance is already running');
    process.exit(1);
  } catch {
    // Process not running, stale PID file
    logger.warn({ pid: existingPid }, 'Removing stale PID file');
  }

  writeFileSync(PID_FILE, String(process.pid));
}

function releaseLock(): void {
  try {
    if (existsSync(PID_FILE)) {
      const pid = readFileSync(PID_FILE, 'utf8').trim();
      if (pid === String(process.pid)) {
        unlinkSync(PID_FILE);
      }
    }
  } catch {
    // Best effort
  }
}

// ── Scheduled Task Executor ────────────────────────────────────────────

function createTaskExecutor(channels: Map<string, MessageChannel>): TaskExecutor {
  return async (task) => {
    const queueId = `__task__${task.chat_id}`;
    const result = await enqueue(queueId, () => runAgent({ message: task.prompt }));

    // Route output to the correct channel based on the composite ID
    const channelId = channelFromComposite(task.chat_id);
    const chatId = rawChatId(task.chat_id);
    const channel = channelId ? channels.get(channelId) : undefined;

    if (channel) {
      const escapedPrompt = escapeHtml(task.prompt.slice(0, 80));
      await channel.sendFormatted(chatId, `Scheduled Task: ${escapedPrompt}\n\n${result.text}`);
    } else {
      logger.warn({ chatId: task.chat_id }, 'No channel found for scheduled task output');
    }

    return result.text;
  };
}

// ── Maintenance Tasks ──────────────────────────────────────────────────

const DECAY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Crash Guard ─────────────────────────────────────────────────────────
// Track consecutive startup failures (persisted to disk so it survives
// process restarts by launchd). After MAX_CRASH_RETRIES consecutive 409s,
// the bot stays down instead of looping forever.

const MAX_CRASH_RETRIES = 3;
const CRASH_FILE = join(PROJECT_ROOT, 'store', '.crash-count');
const CRASH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

interface CrashState {
  count: number;
  firstCrash: number;
}

function readCrashState(): CrashState {
  try {
    if (existsSync(CRASH_FILE)) {
      return JSON.parse(readFileSync(CRASH_FILE, 'utf8')) as CrashState;
    }
  } catch { /* corrupted file */ }
  return { count: 0, firstCrash: 0 };
}

function writeCrashState(state: CrashState): void {
  try {
    writeFileSync(CRASH_FILE, JSON.stringify(state));
  } catch { /* best effort */ }
}

function clearCrashState(): void {
  try {
    if (existsSync(CRASH_FILE)) unlinkSync(CRASH_FILE);
  } catch { /* best effort */ }
}

function recordCrash(): boolean {
  const now = Date.now();
  const state = readCrashState();

  // Reset counter if outside the crash window
  if (now - state.firstCrash > CRASH_WINDOW_MS) {
    writeCrashState({ count: 1, firstCrash: now });
    return true; // still OK to retry
  }

  state.count++;
  writeCrashState(state);
  return state.count < MAX_CRASH_RETRIES;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info({ pid: process.pid }, `${BOT_DISPLAY_NAME} starting`);

  // 1. Acquire PID lock
  acquireLock();

  // 2. Initialize database
  initDatabase();
  logger.info('Database initialized');

  // 2.5. Check for new skills
  const newSkills = checkNewSkills();
  if (newSkills.length > 0) {
    logger.info(
      `New skills available: ${newSkills.map((s) => s.name).join(', ')}. Run "npm run skills" to manage.`,
    );
  }

  // 3. Create channels based on available configuration
  const channels = new Map<string, MessageChannel>();

  let telegram: TelegramChannel | undefined;
  if (TELEGRAM_BOT_TOKEN) {
    telegram = new TelegramChannel();
    channels.set('telegram', telegram);
    logger.info('Telegram channel configured');
  }

  let slack: SlackChannel | undefined;
  if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
    slack = new SlackChannel();
    channels.set('slack', slack);
    logger.info('Slack channel configured');
  }

  if (channels.size === 0) {
    logger.error('No channels configured. Set TELEGRAM_BOT_TOKEN (and/or SLACK_BOT_TOKEN) in .env');
    process.exit(1);
  }

  // 4. Initialize scheduler with multi-channel task executor
  initScheduler(createTaskExecutor(channels));

  // 4.5. Start dashboard server (non-blocking)
  startDashboard();

  // 5. Start maintenance intervals
  const decayInterval = setInterval(() => runDecaySweep(), DECAY_INTERVAL_MS);
  const cleanupInterval = setInterval(() => cleanupOldUploads(), CLEANUP_INTERVAL_MS);

  // 6. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');

    clearInterval(decayInterval);
    clearInterval(cleanupInterval);
    stopScheduler();
    stopDashboard();

    for (const channel of channels.values()) {
      try {
        await channel.stop();
      } catch {
        // Best effort
      }
    }

    closeDatabase();
    releaseLock();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 7. Check crash guard before starting channels
  const crashState = readCrashState();
  if (crashState.count >= MAX_CRASH_RETRIES && Date.now() - crashState.firstCrash < CRASH_WINDOW_MS) {
    logger.error(
      { crashes: crashState.count, windowMs: CRASH_WINDOW_MS },
      `Giving up after ${crashState.count} consecutive startup failures. Delete ${CRASH_FILE} to retry.`,
    );
    releaseLock();
    // Exit 0 so launchd KeepAlive doesn't restart us
    process.exit(0);
  }

  // 8. Start all channels
  // Slack uses Socket Mode (non-blocking), start it first.
  // Telegram's start() blocks (long-polling), so start it last.
  try {
    if (slack) {
      await slack.start();
    }
    if (telegram) {
      // Clear crash counter once polling is established (onStart fires before polling)
      // We hook into the first successful getUpdates by clearing after a short delay
      setTimeout(() => clearCrashState(), 15_000);
      await telegram.start();
    }
  } catch (err) {
    const is409 = err instanceof Error && err.message.includes('409');
    if (is409) {
      const canRetry = recordCrash();
      logger.error({ err, canRetry }, 'Telegram 409 conflict on startup');
      if (!canRetry) {
        logger.error(`Max startup retries (${MAX_CRASH_RETRIES}) reached. Staying down.`);
      }
    } else {
      logger.error({ err }, 'Channel failed to start');
    }
    releaseLock();
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  releaseLock();
  process.exit(1);
});
