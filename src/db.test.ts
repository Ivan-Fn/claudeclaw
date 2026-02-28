import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  initDatabase,
  closeDatabase,
  getDb,
  getSession,
  setSession,
  clearSession,
  insertMemory,
  searchMemories,
  getRecentMemories,
  touchMemory,
  decayAllMemories,
  getMemoryStats,
  createTask,
  getDueTasks,
  updateTaskAfterRun,
  getTask,
  listTasks,
  deleteTask,
  pauseTask,
  resumeTask,
} from './db.js';

const TMP = join(tmpdir(), 'master-agent-test-db');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  const dbPath = join(TMP, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
});

// ── Sessions ──────────────────────────────────────────────────────────────

describe('sessions', () => {
  it('returns undefined for unknown chat_id', () => {
    expect(getSession('unknown')).toBeUndefined();
  });

  it('stores and retrieves a session', () => {
    setSession('chat1', 'sess-abc');
    expect(getSession('chat1')).toBe('sess-abc');
  });

  it('upserts on conflict', () => {
    setSession('chat1', 'sess-1');
    setSession('chat1', 'sess-2');
    expect(getSession('chat1')).toBe('sess-2');
  });

  it('clears a session', () => {
    setSession('chat1', 'sess-abc');
    clearSession('chat1');
    expect(getSession('chat1')).toBeUndefined();
  });
});

// ── Memories ──────────────────────────────────────────────────────────────

describe('memories', () => {
  it('inserts and retrieves by recent', () => {
    insertMemory('chat1', 'Remember to buy milk', 'episodic');
    insertMemory('chat1', 'TypeScript is a typed language', 'semantic');

    const recent = getRecentMemories('chat1', 10);
    expect(recent).toHaveLength(2);
    expect(recent.map((m) => m.content)).toContain('Remember to buy milk');
    expect(recent.map((m) => m.content)).toContain('TypeScript is a typed language');
  });

  it('respects chat_id isolation', () => {
    insertMemory('chat1', 'Chat 1 memory', 'episodic');
    insertMemory('chat2', 'Chat 2 memory', 'episodic');

    const chat1 = getRecentMemories('chat1', 10);
    expect(chat1).toHaveLength(1);
    expect(chat1[0]!.content).toBe('Chat 1 memory');
  });

  it('stores topic_key', () => {
    const id = insertMemory('chat1', 'Topic memory', 'semantic', 'project-x');
    const rows = getDb()
      .prepare('SELECT topic_key FROM memories WHERE id = ?')
      .get(id) as { topic_key: string | null };
    expect(rows.topic_key).toBe('project-x');
  });

  it('defaults salience to 1.0', () => {
    const id = insertMemory('chat1', 'test', 'episodic');
    const row = getDb()
      .prepare('SELECT salience FROM memories WHERE id = ?')
      .get(id) as { salience: number };
    expect(row.salience).toBe(1.0);
  });
});

// ── FTS5 Search ───────────────────────────────────────────────────────────

describe('FTS5 search', () => {
  it('finds memories by keyword', () => {
    insertMemory('chat1', 'The quick brown fox jumps over the lazy dog', 'semantic');
    insertMemory('chat1', 'TypeScript compiler options', 'semantic');
    insertMemory('chat1', 'A lazy afternoon in the park', 'episodic');

    const results = searchMemories('chat1', 'lazy');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((m) => m.content.includes('lazy'))).toBe(true);
  });

  it('returns empty for non-matching query', () => {
    insertMemory('chat1', 'Hello world', 'semantic');
    const results = searchMemories('chat1', 'xyznonexistent');
    expect(results).toHaveLength(0);
  });

  it('respects chat_id in search', () => {
    insertMemory('chat1', 'Important project deadline', 'semantic');
    insertMemory('chat2', 'Important meeting notes', 'semantic');

    const results = searchMemories('chat1', 'important');
    expect(results).toHaveLength(1);
    expect(results[0]!.chat_id).toBe('chat1');
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      insertMemory('chat1', `Memory about coding topic ${i}`, 'semantic');
    }

    const results = searchMemories('chat1', 'coding', 3);
    expect(results).toHaveLength(3);
  });

  it('handles special characters in query without throwing', () => {
    insertMemory('chat1', 'Test memory content', 'semantic');
    // Should not throw on special FTS5 characters like quotes, parens, etc.
    expect(() => searchMemories('chat1', 'test (with) "special" chars!')).not.toThrow();
    expect(() => searchMemories('chat1', '"unclosed quote')).not.toThrow();
    expect(() => searchMemories('chat1', 'NEAR/3')).not.toThrow();
    expect(() => searchMemories('chat1', '***')).not.toThrow();
  });

  it('returns empty for empty/short query', () => {
    insertMemory('chat1', 'Some content', 'semantic');
    expect(searchMemories('chat1', '')).toHaveLength(0);
    expect(searchMemories('chat1', 'a')).toHaveLength(0);
  });

  it('syncs FTS after delete', () => {
    const id = insertMemory('chat1', 'Deletable memory about unique keyword', 'episodic');
    let results = searchMemories('chat1', 'deletable');
    expect(results).toHaveLength(1);

    getDb().prepare('DELETE FROM memories WHERE id = ?').run(id);
    results = searchMemories('chat1', 'deletable');
    expect(results).toHaveLength(0);
  });

  it('syncs FTS after update', () => {
    const id = insertMemory('chat1', 'Original unique content xyzabc', 'semantic');
    let results = searchMemories('chat1', 'xyzabc');
    expect(results).toHaveLength(1);

    getDb()
      .prepare('UPDATE memories SET content = ? WHERE id = ?')
      .run('Updated different content qwerty', id);

    expect(searchMemories('chat1', 'xyzabc')).toHaveLength(0);
    expect(searchMemories('chat1', 'qwerty')).toHaveLength(1);
  });
});

// ── Touch & Decay ─────────────────────────────────────────────────────────

describe('touch and decay', () => {
  it('boosts salience on touch', () => {
    const id = insertMemory('chat1', 'test', 'episodic');
    touchMemory(id, 0.5);

    const row = getDb()
      .prepare('SELECT salience FROM memories WHERE id = ?')
      .get(id) as { salience: number };
    expect(row.salience).toBe(1.5);
  });

  it('caps salience at 5.0', () => {
    const id = insertMemory('chat1', 'test', 'episodic');
    touchMemory(id, 10.0);

    const row = getDb()
      .prepare('SELECT salience FROM memories WHERE id = ?')
      .get(id) as { salience: number };
    expect(row.salience).toBe(5.0);
  });

  it('decays old memories based on time since last access', () => {
    // Insert a memory and backdate both created_at and accessed_at
    const id = insertMemory('chat1', 'Old memory', 'episodic');
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
    const tenHoursAgo = Math.floor(Date.now() / 1000) - 10 * 3600;
    getDb()
      .prepare('UPDATE memories SET created_at = ?, accessed_at = ?, salience = 1.0 WHERE id = ?')
      .run(twoDaysAgo, tenHoursAgo, id);

    const { decayed } = decayAllMemories();
    expect(decayed).toBeGreaterThanOrEqual(1);

    // salience should be 1.0 * 0.98^10 ≈ 0.817
    const row = getDb()
      .prepare('SELECT salience FROM memories WHERE id = ?')
      .get(id) as { salience: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.salience).toBeCloseTo(Math.pow(0.98, 10), 2);
  });

  it('deletes memories below minimum salience', () => {
    const id = insertMemory('chat1', 'Fading memory', 'episodic');
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
    getDb()
      .prepare('UPDATE memories SET created_at = ?, accessed_at = ?, salience = 0.05 WHERE id = ?')
      .run(twoDaysAgo, twoDaysAgo, id);

    decayAllMemories();

    const row = getDb()
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(id);
    expect(row).toBeUndefined();
  });
});

// ── Memory Stats ──────────────────────────────────────────────────────────

describe('getMemoryStats', () => {
  it('returns zero counts for empty chat', () => {
    expect(getMemoryStats('empty')).toEqual({ semantic: 0, episodic: 0, total: 0 });
  });

  it('counts by sector', () => {
    insertMemory('chat1', 'sem1', 'semantic');
    insertMemory('chat1', 'sem2', 'semantic');
    insertMemory('chat1', 'epi1', 'episodic');

    expect(getMemoryStats('chat1')).toEqual({ semantic: 2, episodic: 1, total: 3 });
  });
});

// ── Scheduled Tasks ───────────────────────────────────────────────────────

describe('scheduled tasks', () => {
  const futureTs = Math.floor(Date.now() / 1000) + 3600;
  const pastTs = Math.floor(Date.now() / 1000) - 60;

  it('creates and retrieves a task', () => {
    createTask('task-1', 'chat1', 'Run backup', '0 * * * *', futureTs);
    const task = getTask('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('Run backup');
    expect(task!.schedule).toBe('0 * * * *');
    expect(task!.status).toBe('active');
    expect(task!.last_run).toBeNull();
  });

  it('returns undefined for unknown task', () => {
    expect(getTask('nonexistent')).toBeUndefined();
  });

  it('lists tasks by chat_id', () => {
    createTask('t1', 'chat1', 'Task 1', '* * * * *', futureTs);
    createTask('t2', 'chat2', 'Task 2', '* * * * *', futureTs);
    createTask('t3', 'chat1', 'Task 3', '* * * * *', futureTs + 100);

    const chat1Tasks = listTasks('chat1');
    expect(chat1Tasks).toHaveLength(2);
    expect(chat1Tasks.map((t) => t.id)).toEqual(['t1', 't3']);
  });

  it('lists all tasks when no chatId', () => {
    createTask('t1', 'chat1', 'Task 1', '* * * * *', futureTs);
    createTask('t2', 'chat2', 'Task 2', '* * * * *', futureTs);

    expect(listTasks()).toHaveLength(2);
  });

  it('gets due tasks', () => {
    createTask('due', 'chat1', 'Due task', '* * * * *', pastTs);
    createTask('future', 'chat1', 'Future task', '* * * * *', futureTs);

    const due = getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0]!.id).toBe('due');
  });

  it('updates task after run', () => {
    createTask('t1', 'chat1', 'Task', '* * * * *', pastTs);
    updateTaskAfterRun('t1', 'Success', futureTs);

    const task = getTask('t1');
    expect(task!.last_result).toBe('Success');
    expect(task!.next_run).toBe(futureTs);
    expect(task!.last_run).toBeDefined();
  });

  it('deletes a task', () => {
    createTask('t1', 'chat1', 'Task', '* * * * *', futureTs);
    expect(deleteTask('t1')).toBe(true);
    expect(getTask('t1')).toBeUndefined();
    expect(deleteTask('t1')).toBe(false);
  });

  it('pauses and resumes a task', () => {
    createTask('t1', 'chat1', 'Task', '* * * * *', pastTs);

    expect(pauseTask('t1')).toBe(true);
    expect(getTask('t1')!.status).toBe('paused');

    // Paused tasks should not appear as due
    expect(getDueTasks()).toHaveLength(0);

    expect(resumeTask('t1', futureTs)).toBe(true);
    expect(getTask('t1')!.status).toBe('active');
    expect(getTask('t1')!.next_run).toBe(futureTs);
  });
});
