import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH, MEMORY_DECAY_FACTOR, MEMORY_MIN_SALIENCE } from './config.js';
import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface Memory {
  id: number;
  chat_id: string;
  topic_key: string | null;
  content: string;
  sector: 'semantic' | 'episodic';
  salience: number;
  created_at: number;
  accessed_at: number;
}

export interface ScheduledTask {
  id: string;
  chat_id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused';
  created_at: number;
}

// ── Singleton ──────────────────────────────────────────────────────────

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialized. Call initDatabase() first.');
  return _db;
}

export function initDatabase(dbPath?: string): Database.Database {
  const path = dbPath ?? DB_PATH;
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  createSchema(db);

  // Integrity check on startup
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrity[0]?.integrity_check !== 'ok') {
    logger.error({ integrity }, 'SQLite integrity check failed');
  }

  _db = db;
  return db;
}

export function closeDatabase(): void {
  _db?.close();
  _db = undefined;
}

// ── Schema ─────────────────────────────────────────────────────────────

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      accessed_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_memories_chat_sector
      ON memories(chat_id, sector);
    CREATE INDEX IF NOT EXISTS idx_memories_salience
      ON memories(salience);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id'
    );

    -- FTS sync triggers
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content)
        VALUES (new.id, new.content);
    END;

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_due
      ON scheduled_tasks(status, next_run);

    CREATE TABLE IF NOT EXISTS conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_convo_log_chat
      ON conversation_log(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      session_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      did_compact INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_session
      ON token_usage(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_chat
      ON token_usage(chat_id, created_at DESC);

    -- ── CRM ─────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company TEXT,
      role TEXT,
      notes TEXT,
      photo_path TEXT,
      source TEXT DEFAULT 'manual',
      first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
      last_contact INTEGER NOT NULL DEFAULT (unixepoch()),
      interaction_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_chat ON contacts(chat_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_chat_email
      ON contacts(chat_id, email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_chat_name
      ON contacts(chat_id, LOWER(name)) WHERE email IS NULL;

    CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
      name, email, company, role, notes,
      content='contacts',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS contacts_ai AFTER INSERT ON contacts BEGIN
      INSERT INTO contacts_fts(rowid, name, email, company, role, notes)
        VALUES (new.id, new.name, new.email, new.company, new.role, new.notes);
    END;

    CREATE TRIGGER IF NOT EXISTS contacts_ad AFTER DELETE ON contacts BEGIN
      INSERT INTO contacts_fts(contacts_fts, rowid, name, email, company, role, notes)
        VALUES('delete', old.id, old.name, old.email, old.company, old.role, old.notes);
    END;

    CREATE TRIGGER IF NOT EXISTS contacts_au AFTER UPDATE ON contacts BEGIN
      INSERT INTO contacts_fts(contacts_fts, rowid, name, email, company, role, notes)
        VALUES('delete', old.id, old.name, old.email, old.company, old.role, old.notes);
      INSERT INTO contacts_fts(rowid, name, email, company, role, notes)
        VALUES (new.id, new.name, new.email, new.company, new.role, new.notes);
    END;

    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('email','meeting','call','note','other')),
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','auto')),
      summary TEXT,
      date INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_interactions_contact
      ON interactions(contact_id, date DESC);
  `);
}

// ── Sessions ───────────────────────────────────────────────────────────

export function getSession(chatId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(chatId: string, sessionId: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (chat_id, session_id, updated_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    )
    .run(chatId, sessionId);
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
}

// ── Memories ───────────────────────────────────────────────────────────

export function insertMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string,
): number {
  const info = getDb()
    .prepare(
      `INSERT INTO memories (chat_id, content, sector, topic_key)
       VALUES (?, ?, ?, ?)`,
    )
    .run(chatId, content, sector, topicKey ?? null);
  return Number(info.lastInsertRowid);
}

export function searchMemories(
  chatId: string,
  query: string,
  limit = 3,
): Memory[] {
  // Sanitize for FTS5: keep alphanumeric + spaces, split, add * suffix
  const sanitized = query
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .map((w) => `${w}*`)
    .join(' ');

  if (!sanitized) return [];

  return getDb()
    .prepare(
      `SELECT m.* FROM memories m
       JOIN memories_fts f ON m.id = f.rowid
       WHERE f.content MATCH ? AND m.chat_id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(sanitized, chatId, limit) as Memory[];
}

export function getRecentMemories(chatId: string, limit = 5): Memory[] {
  return getDb()
    .prepare(
      `SELECT * FROM memories
       WHERE chat_id = ?
       ORDER BY accessed_at DESC
       LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function touchMemory(id: number, salienceBoost = 0.1): void {
  getDb()
    .prepare(
      `UPDATE memories
       SET accessed_at = unixepoch(),
           salience = MIN(salience + ?, 5.0)
       WHERE id = ?`,
    )
    .run(salienceBoost, id);
}

export function decayAllMemories(): { decayed: number; deleted: number } {
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - 86400;

  // Time-based decay: salience *= DECAY_FACTOR ^ hours_since_last_access
  // Using power function: factor^(elapsed_hours) = e^(ln(factor) * elapsed_hours)
  // SQLite doesn't have POW, so we compute in JS
  const memories = getDb()
    .prepare('SELECT id, salience, accessed_at FROM memories WHERE created_at < ?')
    .all(oneDayAgo) as Array<{ id: number; salience: number; accessed_at: number }>;

  let decayed = 0;
  const updateStmt = getDb().prepare('UPDATE memories SET salience = ? WHERE id = ?');
  const deleteStmt = getDb().prepare('DELETE FROM memories WHERE id = ?');
  let deleted = 0;

  const runInTransaction = getDb().transaction(() => {
    for (const mem of memories) {
      const hoursSinceAccess = Math.max(0, (now - mem.accessed_at) / 3600);
      const newSalience = mem.salience * Math.pow(MEMORY_DECAY_FACTOR, hoursSinceAccess);

      if (newSalience < MEMORY_MIN_SALIENCE) {
        deleteStmt.run(mem.id);
        deleted++;
      } else if (newSalience < mem.salience - 0.001) {
        updateStmt.run(newSalience, mem.id);
        decayed++;
      }
    }
  });

  runInTransaction();

  return { decayed, deleted };
}

export function getMemoryStats(
  chatId: string,
): { semantic: number; episodic: number; total: number } {
  const rows = getDb()
    .prepare(
      `SELECT sector, COUNT(*) as cnt FROM memories
       WHERE chat_id = ? GROUP BY sector`,
    )
    .all(chatId) as Array<{ sector: string; cnt: number }>;

  let semantic = 0;
  let episodic = 0;
  for (const row of rows) {
    if (row.sector === 'semantic') semantic = row.cnt;
    else if (row.sector === 'episodic') episodic = row.cnt;
  }

  return { semantic, episodic, total: semantic + episodic };
}

// ── Scheduled Tasks ────────────────────────────────────────────────────

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, chatId, prompt, schedule, nextRun);
}

export function getDueTasks(): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000);
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run <= ?`,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  lastResult: string,
  nextRun: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET last_run = ?, last_result = ?, next_run = ?
       WHERE id = ?`,
    )
    .run(now, lastResult, nextRun, id);
}

export function getTask(id: string): ScheduledTask | undefined {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduledTask | undefined;
}

export function listTasks(chatId?: string): ScheduledTask[] {
  if (chatId) {
    return getDb()
      .prepare('SELECT * FROM scheduled_tasks WHERE chat_id = ? ORDER BY next_run')
      .all(chatId) as ScheduledTask[];
  }
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY next_run')
    .all() as ScheduledTask[];
}

export function deleteTask(id: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM scheduled_tasks WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

export function pauseTask(id: string): boolean {
  const result = getDb()
    .prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function resumeTask(id: string, nextRun: number): boolean {
  const result = getDb()
    .prepare(
      "UPDATE scheduled_tasks SET status = 'active', next_run = ? WHERE id = ?",
    )
    .run(nextRun, id);
  return result.changes > 0;
}

// ── Conversation Log ────────────────────────────────────────────────────

export interface ConversationTurn {
  id: number;
  chat_id: string;
  session_id: string | null;
  role: string;
  content: string;
  created_at: number;
}

export function logConversationTurn(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  sessionId?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_log (chat_id, session_id, role, content)
       VALUES (?, ?, ?, ?)`,
    )
    .run(chatId, sessionId ?? null, role, content);
}

export function getRecentConversation(
  chatId: string,
  limit = 20,
): ConversationTurn[] {
  return getDb()
    .prepare(
      `SELECT * FROM conversation_log WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as ConversationTurn[];
}

export function pruneConversationLog(keepPerChat = 500): void {
  const chats = getDb()
    .prepare('SELECT DISTINCT chat_id FROM conversation_log')
    .all() as Array<{ chat_id: string }>;

  const deleteStmt = getDb().prepare(`
    DELETE FROM conversation_log
    WHERE chat_id = ? AND id NOT IN (
      SELECT id FROM conversation_log
      WHERE chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `);

  for (const chat of chats) {
    deleteStmt.run(chat.chat_id, chat.chat_id, keepPerChat);
  }
}

// ── Token Usage ────────────────────────────────────────────────────────

export interface SessionTokenSummary {
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastCacheRead: number;
  totalCostUsd: number;
  compactions: number;
  firstTurnAt: number;
  lastTurnAt: number;
}

export function saveTokenUsage(
  chatId: string,
  sessionId: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  costUsd: number,
  didCompact: boolean,
): void {
  getDb()
    .prepare(
      `INSERT INTO token_usage (chat_id, session_id, input_tokens, output_tokens, cache_read, cost_usd, did_compact)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(chatId, sessionId ?? null, inputTokens, outputTokens, cacheRead, costUsd, didCompact ? 1 : 0);
}

export function getSessionTokenUsage(sessionId: string): SessionTokenSummary | null {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*)           as turns,
         SUM(input_tokens)  as totalInputTokens,
         SUM(output_tokens) as totalOutputTokens,
         SUM(cost_usd)      as totalCostUsd,
         SUM(did_compact)   as compactions,
         MIN(created_at)    as firstTurnAt,
         MAX(created_at)    as lastTurnAt
       FROM token_usage WHERE session_id = ?`,
    )
    .get(sessionId) as {
      turns: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCostUsd: number;
      compactions: number;
      firstTurnAt: number;
      lastTurnAt: number;
    } | undefined;

  if (!row || row.turns === 0) return null;

  const lastRow = getDb()
    .prepare(
      `SELECT cache_read FROM token_usage
       WHERE session_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { cache_read: number } | undefined;

  return {
    turns: row.turns,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    lastCacheRead: lastRow?.cache_read ?? 0,
    totalCostUsd: row.totalCostUsd,
    compactions: row.compactions,
    firstTurnAt: row.firstTurnAt,
    lastTurnAt: row.lastTurnAt,
  };
}

export interface CostPeriodSummary {
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

/** Get aggregated cost for a chat within a unix-timestamp range. */
export function getCostSummary(chatId: string, sinceUnix: number): CostPeriodSummary {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*)           as turns,
         COALESCE(SUM(input_tokens), 0)  as totalInputTokens,
         COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
         COALESCE(SUM(cost_usd), 0)      as totalCostUsd
       FROM token_usage
       WHERE chat_id = ? AND created_at >= ?`,
    )
    .get(chatId, sinceUnix) as CostPeriodSummary;

  return row;
}
