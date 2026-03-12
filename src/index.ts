import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PID_FILE, PROJECT_ROOT, TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, BOT_DISPLAY_NAME, BOT_NAME } from './config.js';
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
import { clearCrashState, readCrashState, recordCrash, shouldBlockStartup } from './crash-guard.js';
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
  const numPid = Number(existingPid);

  // PID 1 is the container init process — a stale PID file containing "1"
  // always passes the kill(pid,0) liveness check, causing a false "already
  // running" exit and an infinite restart loop in Docker.
  if (numPid !== 1 && numPid === numPid) { // second check: guard NaN
    try {
      process.kill(numPid, 0);
    } catch {
      // Process not running, stale PID file
      logger.warn({ pid: existingPid }, 'Removing stale PID file');
      writeFileSync(PID_FILE, String(process.pid));
      return;
    }

    throw new AlreadyRunningError(existingPid);
  } else {
    logger.warn({ pid: existingPid }, 'Removing stale PID file (PID 1 or invalid)');
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

class AlreadyRunningError extends Error {
  constructor(readonly pid: string) {
    super('Another instance is already running');
    this.name = 'AlreadyRunningError';
  }
}

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
// process restarts by launchd). After MAX_CRASH_RETRIES failures inside the
// startup window, the bot stays down instead of looping forever.

const MAX_CRASH_RETRIES = 3;
const CRASH_FILE = join(PROJECT_ROOT, 'store', `${BOT_NAME}.crash-count`);
const CRASH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_HEALTHY_DELAY_MS = 15_000;

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info({ pid: process.pid }, `${BOT_DISPLAY_NAME} starting`);

  let startupHealthy = false;
  let startupHealthTimer: ReturnType<typeof setTimeout> | undefined;
  const channels = new Map<string, MessageChannel>();
  const markStartupHealthy = () => {
    if (startupHealthy) return;
    startupHealthy = true;
    clearCrashState(CRASH_FILE);
    logger.info('Startup health check passed');
  };

  try {
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
      throw new Error('No channels configured. Set TELEGRAM_BOT_TOKEN (and/or SLACK_BOT_TOKEN) in .env');
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

      if (startupHealthTimer) clearTimeout(startupHealthTimer);
      clearCrashState(CRASH_FILE);
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
    const crashState = readCrashState(CRASH_FILE);
    if (shouldBlockStartup(crashState, MAX_CRASH_RETRIES, CRASH_WINDOW_MS)) {
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
    if (slack) {
      await slack.start();
    }
    if (telegram) {
      // onStart fires before polling, so only mark startup healthy after a short
      // grace period with the process still alive.
      startupHealthTimer = setTimeout(markStartupHealthy, STARTUP_HEALTHY_DELAY_MS);
      await telegram.start();
    } else {
      markStartupHealthy();
    }
  } catch (err) {
    if (startupHealthTimer) clearTimeout(startupHealthTimer);

    if (err instanceof AlreadyRunningError) {
      logger.error({ pid: err.pid }, err.message);
      releaseLock();
      process.exit(0);
    }

    if (!startupHealthy) {
      const { canRetry } = recordCrash(CRASH_FILE, MAX_CRASH_RETRIES, CRASH_WINDOW_MS);
      logger.error({ err, canRetry }, 'Startup failed');
      if (!canRetry) {
        logger.error(`Max startup retries (${MAX_CRASH_RETRIES}) reached. Staying down.`);
        releaseLock();
        process.exit(0);
      }
    } else {
      clearCrashState(CRASH_FILE);
      logger.error({ err }, 'Channel stopped after startup');
    }

    releaseLock();
    process.exit(1);
  }
}

void main();
