import { CronExpressionParser } from 'cron-parser';
import {
  getDueTasks,
  updateTaskAfterRun,
  type ScheduledTask,
} from './db.js';
import { SCHEDULER_POLL_MS } from './config.js';
import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export type TaskExecutor = (task: ScheduledTask) => Promise<string>;

// ── Compute Next Run ───────────────────────────────────────────────────

export function computeNextRun(cronExpr: string, after?: Date): number {
  const opts = after ? { currentDate: after } : {};
  const expr = CronExpressionParser.parse(cronExpr, opts);
  const next = expr.next();
  return Math.floor(next.getTime() / 1000);
}

export function validateCron(cronExpr: string): boolean {
  try {
    CronExpressionParser.parse(cronExpr);
    return true;
  } catch {
    return false;
  }
}

// ── Scheduler Loop ─────────────────────────────────────────────────────

let pollInterval: ReturnType<typeof setInterval> | undefined;

export function initScheduler(executor: TaskExecutor): void {
  if (pollInterval) {
    logger.warn('Scheduler already running');
    return;
  }

  // Run immediately on startup (catches tasks missed during sleep)
  void runDueTasks(executor);

  pollInterval = setInterval(() => {
    void runDueTasks(executor);
  }, SCHEDULER_POLL_MS);

  logger.info({ pollMs: SCHEDULER_POLL_MS }, 'Scheduler started');
}

export function stopScheduler(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = undefined;
    logger.info('Scheduler stopped');
  }
}

async function runDueTasks(executor: TaskExecutor): Promise<void> {
  const tasks = getDueTasks();

  if (tasks.length === 0) return;

  logger.info({ count: tasks.length }, 'Running due scheduled tasks');

  for (const task of tasks) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const overdueBy = now - task.next_run;
      if (overdueBy > 300) {
        logger.info({ taskId: task.id, overdueBy }, 'Running overdue task (missed during sleep/downtime)');
      }

      const result = await executor(task);
      const nextRun = computeNextRun(task.schedule);
      updateTaskAfterRun(task.id, truncateResult(result), nextRun);

      logger.info({ taskId: task.id, nextRun }, 'Scheduled task completed');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: task.id, err: errMsg }, 'Scheduled task failed');

      try {
        const nextRun = computeNextRun(task.schedule);
        updateTaskAfterRun(task.id, `ERROR: ${truncateResult(errMsg)}`, nextRun);
      } catch {
        logger.error({ taskId: task.id }, 'Failed to update task after error');
      }
    }
  }
}

function truncateResult(text: string): string {
  const MAX = 10_000;
  if (text.length <= MAX) return text;
  return text.slice(0, MAX - 3) + '...';
}
