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

// ── CRM helpers (raw SQL, no exported functions) ─────────────────────────

function insertContact(
  db: ReturnType<typeof getDb>,
  chatId: string,
  name: string,
  opts: { email?: string; phone?: string; company?: string; role?: string; notes?: string; source?: string } = {},
): number {
  const info = db
    .prepare(
      `INSERT INTO contacts (chat_id, name, email, phone, company, role, notes, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(chatId, name, opts.email ?? null, opts.phone ?? null, opts.company ?? null, opts.role ?? null, opts.notes ?? null, opts.source ?? 'manual');
  return Number(info.lastInsertRowid);
}

function insertInteraction(
  db: ReturnType<typeof getDb>,
  chatId: string,
  contactId: number,
  type: string,
  opts: { source?: string; summary?: string } = {},
): number {
  const info = db
    .prepare(
      `INSERT INTO interactions (chat_id, contact_id, type, source, summary)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(chatId, contactId, type, opts.source ?? 'manual', opts.summary ?? null);
  return Number(info.lastInsertRowid);
}

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

// ── CRM: Contacts ────────────────────────────────────────────────────────

describe('contacts', () => {
  it('inserts and retrieves a contact', () => {
    const db = getDb();
    const id = insertContact(db, 'chat1', 'Alice Smith', {
      email: 'alice@acme.com',
      company: 'Acme Corp',
      role: 'CTO',
    });

    const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.name).toBe('Alice Smith');
    expect(row.email).toBe('alice@acme.com');
    expect(row.company).toBe('Acme Corp');
    expect(row.role).toBe('CTO');
    expect(row.chat_id).toBe('chat1');
    expect(row.source).toBe('manual');
    expect(row.interaction_count).toBe(0);
  });

  it('updates a contact', () => {
    const db = getDb();
    const id = insertContact(db, 'chat1', 'Bob', { email: 'bob@test.com' });

    db.prepare('UPDATE contacts SET company = ?, updated_at = unixepoch() WHERE id = ?')
      .run('NewCorp', id);

    const row = db.prepare('SELECT company FROM contacts WHERE id = ?').get(id) as { company: string };
    expect(row.company).toBe('NewCorp');
  });

  it('deletes a contact', () => {
    const db = getDb();
    const id = insertContact(db, 'chat1', 'Charlie', { email: 'charlie@test.com' });

    db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('enforces unique (chat_id, email) constraint', () => {
    const db = getDb();
    insertContact(db, 'chat1', 'Alice', { email: 'alice@acme.com' });

    // Same email, same chat - should fail
    expect(() =>
      insertContact(db, 'chat1', 'Alice Duplicate', { email: 'alice@acme.com' }),
    ).toThrow();
  });

  it('allows same email in different chats', () => {
    const db = getDb();
    insertContact(db, 'chat1', 'Alice', { email: 'alice@acme.com' });
    // Same email, different chat - should succeed
    expect(() =>
      insertContact(db, 'chat2', 'Alice', { email: 'alice@acme.com' }),
    ).not.toThrow();
  });

  it('enforces unique (chat_id, LOWER(name)) for contacts without email', () => {
    const db = getDb();
    insertContact(db, 'chat1', 'David');

    // Same name, no email, same chat - should fail
    expect(() => insertContact(db, 'chat1', 'David')).toThrow();
    // Case-insensitive
    expect(() => insertContact(db, 'chat1', 'david')).toThrow();
  });

  it('allows duplicate names when emails differ', () => {
    const db = getDb();
    insertContact(db, 'chat1', 'Alice', { email: 'alice1@test.com' });
    // Same name, different email - should succeed (email constraint takes priority)
    expect(() =>
      insertContact(db, 'chat1', 'Alice', { email: 'alice2@test.com' }),
    ).not.toThrow();
  });

  it('handles ON CONFLICT upsert for email contacts', () => {
    const db = getDb();
    insertContact(db, 'chat1', 'Alice', { email: 'alice@acme.com', company: 'OldCorp' });

    // Upsert via ON CONFLICT
    db.prepare(`
      INSERT INTO contacts (chat_id, name, email, company, role, notes, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, email) DO UPDATE SET
        name = excluded.name,
        company = COALESCE(excluded.company, company),
        role = COALESCE(excluded.role, role),
        notes = COALESCE(excluded.notes, notes),
        updated_at = unixepoch()
    `).run('chat1', 'Alice Updated', 'alice@acme.com', 'NewCorp', 'CEO', null, 'manual');

    const row = db.prepare('SELECT name, company, role FROM contacts WHERE email = ? AND chat_id = ?')
      .get('alice@acme.com', 'chat1') as { name: string; company: string; role: string };
    expect(row.name).toBe('Alice Updated');
    expect(row.company).toBe('NewCorp');
    expect(row.role).toBe('CEO');

    // Should still be just one contact
    const count = db.prepare('SELECT COUNT(*) as cnt FROM contacts WHERE chat_id = ?')
      .get('chat1') as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('stores and retrieves photo_path', () => {
    const db = getDb();
    const id = insertContact(db, 'chat1', 'Eve', { email: 'eve@test.com' });

    // Initially null
    let row = db.prepare('SELECT photo_path FROM contacts WHERE id = ?').get(id) as { photo_path: string | null };
    expect(row.photo_path).toBeNull();

    // Update photo
    db.prepare('UPDATE contacts SET photo_path = ?, updated_at = unixepoch() WHERE id = ?')
      .run('store/crm/photos/contact-1-12345.jpg', id);

    row = db.prepare('SELECT photo_path FROM contacts WHERE id = ?').get(id) as { photo_path: string | null };
    expect(row.photo_path).toBe('store/crm/photos/contact-1-12345.jpg');
  });

  it('handles apostrophes in names', () => {
    const db = getDb();
    const id = insertContact(db, 'chat1', "Tim O'Brien", { company: "O'Reilly" });

    const row = db.prepare('SELECT name, company FROM contacts WHERE id = ?').get(id) as { name: string; company: string };
    expect(row.name).toBe("Tim O'Brien");
    expect(row.company).toBe("O'Reilly");
  });
});

// ── CRM: Contacts FTS5 ──────────────────────────────────────────────────

describe('contacts FTS5', () => {
  it('searches by name', () => {
    const db = getDb();
    insertContact(db, 'chat1', 'Alice Wonderland', { email: 'alice@test.com' });
    insertContact(db, 'chat1', 'Bob Builder', { email: 'bob@test.com' });

    const results = db
      .prepare(
        `SELECT c.* FROM contacts c
         JOIN contacts_fts f ON c.id = f.rowid
         WHERE f.contacts_fts MATCH 'Alice*' AND c.chat_id = ?
         ORDER BY rank LIMIT 10`,
      )
      .all('chat1') as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Alice Wonderland');
  });

  it('searches by company', () => {
    const db = getDb();
    insertContact(db, 'chat1', 'Alice', { email: 'alice@test.com', company: 'Anthropic' });
    insertContact(db, 'chat1', 'Bob', { email: 'bob@test.com', company: 'Google' });

    const results = db
      .prepare(
        `SELECT c.* FROM contacts c
         JOIN contacts_fts f ON c.id = f.rowid
         WHERE f.contacts_fts MATCH 'Anthropic*' AND c.chat_id = ?
         ORDER BY rank LIMIT 10`,
      )
      .all('chat1') as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Alice');
  });

  it('searches by role', () => {
    const db = getDb();
    insertContact(db, 'chat1', 'Alice', { email: 'alice@test.com', role: 'Engineering Manager' });
    insertContact(db, 'chat1', 'Bob', { email: 'bob@test.com', role: 'Designer' });

    const results = db
      .prepare(
        `SELECT c.* FROM contacts c
         JOIN contacts_fts f ON c.id = f.rowid
         WHERE f.contacts_fts MATCH 'Engineer*' AND c.chat_id = ?
         ORDER BY rank LIMIT 10`,
      )
      .all('chat1') as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Alice');
  });

  it('syncs FTS after delete', () => {
    const db = getDb();
    const id = insertContact(db, 'chat1', 'DeleteMe UniqueXyz', { email: 'del@test.com' });

    let results = db
      .prepare(
        `SELECT c.* FROM contacts c
         JOIN contacts_fts f ON c.id = f.rowid
         WHERE f.contacts_fts MATCH 'UniqueXyz*' AND c.chat_id = ?`,
      )
      .all('chat1');
    expect(results).toHaveLength(1);

    db.prepare('DELETE FROM contacts WHERE id = ?').run(id);

    results = db
      .prepare(
        `SELECT c.* FROM contacts c
         JOIN contacts_fts f ON c.id = f.rowid
         WHERE f.contacts_fts MATCH 'UniqueXyz*' AND c.chat_id = ?`,
      )
      .all('chat1');
    expect(results).toHaveLength(0);
  });

  it('syncs FTS after update', () => {
    const db = getDb();
    const id = insertContact(db, 'chat1', 'OriginalNameXyz', { email: 'orig@test.com' });

    db.prepare('UPDATE contacts SET name = ? WHERE id = ?').run('UpdatedNameAbc', id);

    const oldResults = db
      .prepare(
        `SELECT c.* FROM contacts c
         JOIN contacts_fts f ON c.id = f.rowid
         WHERE f.contacts_fts MATCH 'OriginalNameXyz*' AND c.chat_id = ?`,
      )
      .all('chat1');
    expect(oldResults).toHaveLength(0);

    const newResults = db
      .prepare(
        `SELECT c.* FROM contacts c
         JOIN contacts_fts f ON c.id = f.rowid
         WHERE f.contacts_fts MATCH 'UpdatedNameAbc*' AND c.chat_id = ?`,
      )
      .all('chat1');
    expect(newResults).toHaveLength(1);
  });
});

// ── CRM: Interactions ────────────────────────────────────────────────────

describe('interactions', () => {
  it('logs an interaction', () => {
    const db = getDb();
    const contactId = insertContact(db, 'chat1', 'Alice', { email: 'alice@test.com' });
    const id = insertInteraction(db, 'chat1', contactId, 'meeting', {
      summary: 'Discussed roadmap',
    });

    const row = db.prepare('SELECT * FROM interactions WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.type).toBe('meeting');
    expect(row.source).toBe('manual');
    expect(row.summary).toBe('Discussed roadmap');
    expect(row.contact_id).toBe(contactId);
  });

  it('supports auto source', () => {
    const db = getDb();
    const contactId = insertContact(db, 'chat1', 'Bob', { email: 'bob@test.com' });
    const id = insertInteraction(db, 'chat1', contactId, 'email', {
      source: 'auto',
      summary: 'Auto-discovered email',
    });

    const row = db.prepare('SELECT source FROM interactions WHERE id = ?').get(id) as { source: string };
    expect(row.source).toBe('auto');
  });

  it('rejects invalid interaction type', () => {
    const db = getDb();
    const contactId = insertContact(db, 'chat1', 'Eve', { email: 'eve@test.com' });

    expect(() =>
      insertInteraction(db, 'chat1', contactId, 'invalid_type'),
    ).toThrow();
  });

  it('rejects invalid source', () => {
    const db = getDb();
    const contactId = insertContact(db, 'chat1', 'Eve', { email: 'eve@test.com' });

    expect(() =>
      insertInteraction(db, 'chat1', contactId, 'meeting', { source: 'unknown' }),
    ).toThrow();
  });

  it('cascade deletes interactions when contact is deleted', () => {
    const db = getDb();
    const contactId = insertContact(db, 'chat1', 'Alice', { email: 'alice@test.com' });
    insertInteraction(db, 'chat1', contactId, 'meeting', { summary: 'First meeting' });
    insertInteraction(db, 'chat1', contactId, 'email', { summary: 'Follow-up email' });

    // Verify interactions exist
    let interactions = db
      .prepare('SELECT * FROM interactions WHERE contact_id = ?')
      .all(contactId);
    expect(interactions).toHaveLength(2);

    // Delete the contact
    db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);

    // Interactions should be cascade-deleted
    interactions = db
      .prepare('SELECT * FROM interactions WHERE contact_id = ?')
      .all(contactId);
    expect(interactions).toHaveLength(0);
  });

  it('retrieves interaction history in order', () => {
    const db = getDb();
    const contactId = insertContact(db, 'chat1', 'Alice', { email: 'alice@test.com' });

    // Insert with specific dates
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO interactions (chat_id, contact_id, type, source, summary, date)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('chat1', contactId, 'meeting', 'manual', 'Old meeting', now - 86400);

    db.prepare(
      `INSERT INTO interactions (chat_id, contact_id, type, source, summary, date)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('chat1', contactId, 'email', 'auto', 'Recent email', now);

    const history = db
      .prepare(
        `SELECT type, summary FROM interactions
         WHERE contact_id = ? ORDER BY date DESC LIMIT 10`,
      )
      .all(contactId) as Array<{ type: string; summary: string }>;
    expect(history).toHaveLength(2);
    expect(history[0]!.summary).toBe('Recent email');
    expect(history[1]!.summary).toBe('Old meeting');
  });
});
