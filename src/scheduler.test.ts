import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initDatabase, closeDatabase, getTask } from './db.js';
import { computeNextRun, validateCron, stopScheduler } from './scheduler.js';
import {
  scheduleNewTask,
  formatTaskList,
  removeTask,
  pauseScheduledTask,
  resumeScheduledTask,
} from './schedule-cli.js';

const TMP = join(tmpdir(), 'master-agent-test-scheduler');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  const dbPath = join(TMP, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDatabase(dbPath);
});

afterEach(() => {
  stopScheduler();
  closeDatabase();
});

// ── computeNextRun ────────────────────────────────────────────────────

describe('computeNextRun', () => {
  it('returns a future timestamp for a valid cron', () => {
    const now = Math.floor(Date.now() / 1000);
    const next = computeNextRun('* * * * *');
    expect(next).toBeGreaterThan(now - 1);
  });

  it('respects the "after" parameter', () => {
    const fixedDate = new Date('2025-06-15T00:00:00');
    const next = computeNextRun('30 6 * * *', fixedDate);
    // Next 6:30 after midnight should be 6:30 same day (local time)
    const expected = new Date('2025-06-15T06:30:00');
    expect(next).toBe(Math.floor(expected.getTime() / 1000));
  });

  it('throws for invalid cron expression', () => {
    expect(() => computeNextRun('not a cron')).toThrow();
  });
});

// ── validateCron ──────────────────────────────────────────────────────

describe('validateCron', () => {
  it('returns true for valid expressions', () => {
    expect(validateCron('* * * * *')).toBe(true);
    expect(validateCron('0 9 * * 1-5')).toBe(true);
    expect(validateCron('*/5 * * * *')).toBe(true);
  });

  it('returns false for invalid expressions', () => {
    expect(validateCron('not a cron')).toBe(false);
    expect(validateCron('99 99 99 99 99')).toBe(false);
  });
});

// ── schedule-cli ──────────────────────────────────────────────────────

describe('scheduleNewTask', () => {
  it('creates a task with valid cron', () => {
    const result = scheduleNewTask('chat1', '*/5 * * * *', 'Check status');
    expect('id' in result).toBe(true);
    if ('id' in result) {
      expect(result.nextRun).toBeGreaterThan(0);
      const task = getTask(result.id);
      expect(task).toBeDefined();
      expect(task!.prompt).toBe('Check status');
    }
  });

  it('rejects invalid cron', () => {
    const result = scheduleNewTask('chat1', 'bad cron', 'Test');
    expect('error' in result).toBe(true);
  });

  it('rejects empty prompt', () => {
    const result = scheduleNewTask('chat1', '* * * * *', '   ');
    expect('error' in result).toBe(true);
  });
});

describe('formatTaskList', () => {
  it('shows empty message when no tasks', () => {
    expect(formatTaskList('chat1')).toBe('No scheduled tasks.');
  });

  it('lists tasks with details', () => {
    scheduleNewTask('chat1', '0 9 * * *', 'Morning check');
    const output = formatTaskList('chat1');
    expect(output).toContain('Morning check');
    expect(output).toContain('0 9 * * *');
  });
});

describe('removeTask', () => {
  it('deletes existing task', () => {
    const result = scheduleNewTask('chat1', '* * * * *', 'Test');
    if ('id' in result) {
      expect(removeTask(result.id)).toContain('deleted');
      expect(getTask(result.id)).toBeUndefined();
    }
  });

  it('returns not found for missing task', () => {
    expect(removeTask('nonexistent')).toContain('not found');
  });
});

describe('pauseScheduledTask / resumeScheduledTask', () => {
  it('pauses and resumes a task', () => {
    const result = scheduleNewTask('chat1', '* * * * *', 'Test');
    if ('id' in result) {
      expect(pauseScheduledTask(result.id)).toContain('paused');
      expect(getTask(result.id)!.status).toBe('paused');

      expect(resumeScheduledTask(result.id)).toContain('resumed');
      expect(getTask(result.id)!.status).toBe('active');
    }
  });

  it('handles already paused', () => {
    const result = scheduleNewTask('chat1', '* * * * *', 'Test');
    if ('id' in result) {
      pauseScheduledTask(result.id);
      expect(pauseScheduledTask(result.id)).toContain('already paused');
    }
  });

  it('handles already active', () => {
    const result = scheduleNewTask('chat1', '* * * * *', 'Test');
    if ('id' in result) {
      expect(resumeScheduledTask(result.id)).toContain('already active');
    }
  });
});
