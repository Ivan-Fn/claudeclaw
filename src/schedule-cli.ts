import { randomUUID } from 'node:crypto';
import {
  createTask,
  getTask,
  listTasks,
  deleteTask,
  pauseTask,
  resumeTask,
} from './db.js';
import { computeNextRun, validateCron } from './scheduler.js';

// ── CLI for scheduled task management ──────────────────────────────────
//
// These functions are called from Telegram bot commands:
//   /schedule <cron> <prompt>   → scheduleNewTask
//   /tasks                      → formatTaskList
//   /deltask <id>               → removeTask
//   /pausetask <id>             → pauseScheduledTask
//   /resumetask <id>            → resumeScheduledTask

export function scheduleNewTask(
  chatId: string,
  cronExpr: string,
  prompt: string,
): { id: string; nextRun: number } | { error: string } {
  if (!validateCron(cronExpr)) {
    return { error: `Invalid cron expression: ${cronExpr}` };
  }

  if (!prompt.trim()) {
    return { error: 'Prompt cannot be empty' };
  }

  const nextRun = computeNextRun(cronExpr);

  // Retry with a new ID on collision (8-char UUID prefix can rarely collide)
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomUUID().slice(0, 8);
    try {
      createTask(id, chatId, prompt.trim(), cronExpr, nextRun);
      return { id, nextRun };
    } catch (err) {
      if (attempt === 2) {
        return { error: 'Failed to create task (ID collision). Please try again.' };
      }
    }
  }

  return { error: 'Failed to create task.' };
}

export function formatTaskList(chatId: string): string {
  const tasks = listTasks(chatId);

  if (tasks.length === 0) {
    return 'No scheduled tasks.';
  }

  const lines = tasks.map((t) => {
    const nextDate = new Date(t.next_run * 1000).toLocaleString();
    const status = t.status === 'paused' ? ' [PAUSED]' : '';
    return `• <code>${t.id}</code>${status}\n  ${t.schedule} → ${t.prompt.slice(0, 80)}\n  Next: ${nextDate}`;
  });

  return `<b>Scheduled Tasks:</b>\n\n${lines.join('\n\n')}`;
}

export function removeTask(id: string): string {
  if (deleteTask(id)) {
    return `Task ${id} deleted.`;
  }
  return `Task ${id} not found.`;
}

export function pauseScheduledTask(id: string): string {
  const task = getTask(id);
  if (!task) return `Task ${id} not found.`;
  if (task.status === 'paused') return `Task ${id} is already paused.`;

  pauseTask(id);
  return `Task ${id} paused.`;
}

export function resumeScheduledTask(id: string): string {
  const task = getTask(id);
  if (!task) return `Task ${id} not found.`;
  if (task.status === 'active') return `Task ${id} is already active.`;

  const nextRun = computeNextRun(task.schedule);
  resumeTask(id, nextRun);
  return `Task ${id} resumed. Next run: ${new Date(nextRun * 1000).toLocaleString()}`;
}
