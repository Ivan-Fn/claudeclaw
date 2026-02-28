import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PID_FILE } from './config.js';
import { logger } from './logger.js';
import { initDatabase, closeDatabase } from './db.js';
import { createBot, formatForTelegram, escapeHtml } from './bot.js';
import { initScheduler, stopScheduler, type TaskExecutor } from './scheduler.js';
import { runAgent } from './agent.js';
import { enqueue } from './queue.js';
import { runDecaySweep } from './memory.js';
import { cleanupOldUploads } from './media.js';

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

function createTaskExecutor(sendMessage: (chatId: string, text: string) => Promise<void>): TaskExecutor {
  return async (task) => {
    // Use a dedicated namespace to avoid colliding with user chat queues
    const queueId = `__task__${task.chat_id}`;
    const result = await enqueue(queueId, () => runAgent({ message: task.prompt }));
    const escapedPrompt = escapeHtml(task.prompt.slice(0, 80));
    const formattedResult = formatForTelegram(result.text);
    await sendMessage(task.chat_id, `<b>Scheduled Task:</b> ${escapedPrompt}\n\n${formattedResult}`);
    return result.text;
  };
}

// ── Maintenance Tasks ──────────────────────────────────────────────────

const DECAY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info({ pid: process.pid }, 'Master Agent starting');

  // 1. Acquire PID lock
  acquireLock();

  // 2. Initialize database
  initDatabase();
  logger.info('Database initialized');

  // 3. Create and start bot
  const bot = createBot();

  // 3a. Register bot menu commands with Telegram
  try {
    await bot.api.setMyCommands([
      { command: 'newchat', description: 'Clear session, start fresh' },
      { command: 'respin', description: 'New session with recent context' },
      { command: 'cancel', description: 'Cancel current request' },
      { command: 'status', description: 'Bot status and diagnostics' },
      { command: 'cost', description: 'API cost estimates' },
      { command: 'voice', description: 'Toggle voice mode on/off' },
      { command: 'memory', description: 'Show recent memories' },
      { command: 'gmail', description: 'Email summary (unread/promos)' },
      { command: 'cal', description: 'Calendar (today/tomorrow/week)' },
      { command: 'todo', description: 'Notion tasks (list/add)' },
      { command: 'n8n', description: 'Call any n8n webhook' },
      { command: 'schedule', description: 'Schedule a cron task' },
      { command: 'tasks', description: 'List scheduled tasks' },
      { command: 'deltask', description: 'Delete a scheduled task' },
      { command: 'pausetask', description: 'Pause a scheduled task' },
      { command: 'resumetask', description: 'Resume a scheduled task' },
      { command: 'restart', description: 'Restart the bot process' },
      { command: 'rebuild', description: 'Git pull + npm install + restart' },
    ]);
    logger.info('Bot commands registered with Telegram');
  } catch (err) {
    logger.warn({ err }, 'Failed to register bot commands (non-fatal)');
  }

  // 4. Initialize scheduler
  const sendMessage = async (chatId: string, text: string) => {
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send scheduled task result');
    }
  };
  initScheduler(createTaskExecutor(sendMessage));

  // 5. Start maintenance intervals
  const decayInterval = setInterval(() => runDecaySweep(), DECAY_INTERVAL_MS);
  const cleanupInterval = setInterval(() => cleanupOldUploads(), CLEANUP_INTERVAL_MS);

  // 6. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');

    clearInterval(decayInterval);
    clearInterval(cleanupInterval);
    stopScheduler();

    try {
      await bot.stop();
    } catch {
      // Bot may not have started
    }

    closeDatabase();
    releaseLock();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 7. Start bot (blocks until stopped)
  try {
    await bot.start({
      onStart: (botInfo) => {
        logger.info({ username: botInfo.username }, 'Bot started');
      },
    });
  } catch (err) {
    logger.error({ err }, 'Bot failed to start');
    releaseLock();
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  releaseLock();
  process.exit(1);
});
