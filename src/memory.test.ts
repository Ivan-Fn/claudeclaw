import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initDatabase, closeDatabase, getRecentMemories, insertMemory } from './db.js';
import { buildMemoryContext, saveConversationTurn, runDecaySweep } from './memory.js';

const TMP = join(tmpdir(), 'master-agent-test-memory');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  const dbPath = join(TMP, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
});

// ── buildMemoryContext ─────────────────────────────────────────────────

describe('buildMemoryContext', () => {
  it('returns empty string when no memories exist', () => {
    expect(buildMemoryContext('chat1', 'hello')).toBe('');
  });

  it('includes relevant FTS5 matches', () => {
    insertMemory('chat1', 'TypeScript is a statically typed language', 'semantic');
    insertMemory('chat1', 'JavaScript is dynamically typed', 'semantic');

    const ctx = buildMemoryContext('chat1', 'TypeScript types');
    expect(ctx).toContain('TypeScript');
    expect(ctx).toContain('<memory-context>');
  });

  it('includes recent memories', () => {
    insertMemory('chat1', 'A short note that is long enough to be saved', 'episodic');

    const ctx = buildMemoryContext('chat1', 'unrelated search query xyz');
    expect(ctx).toContain('Recent Memories');
    expect(ctx).toContain('short note');
  });

  it('deduplicates between search and recent', () => {
    insertMemory('chat1', 'Unique memory about coding patterns and practices', 'semantic');

    const ctx = buildMemoryContext('chat1', 'coding patterns');
    // Should appear once, not in both sections
    const count = (ctx.match(/coding patterns/g) ?? []).length;
    expect(count).toBe(1);
  });
});

// ── saveConversationTurn ──────────────────────────────────────────────

describe('saveConversationTurn', () => {
  it('saves user message as episodic memory', () => {
    saveConversationTurn('chat1', 'This is a long enough user message to be saved as memory', 'OK');

    const memories = getRecentMemories('chat1', 10);
    expect(memories.some((m) => m.sector === 'episodic')).toBe(true);
  });

  it('skips short user messages', () => {
    saveConversationTurn('chat1', 'hi', 'Hello!');

    const memories = getRecentMemories('chat1', 10);
    expect(memories).toHaveLength(0);
  });

  it('extracts semantic facts from agent response', () => {
    saveConversationTurn(
      'chat1',
      'What is my name?',
      'Your name is Ivan.',
    );

    const memories = getRecentMemories('chat1', 10);
    const semantic = memories.filter((m) => m.sector === 'semantic');
    expect(semantic.length).toBeGreaterThanOrEqual(1);
    expect(semantic.some((m) => m.content.includes('Ivan'))).toBe(true);
  });

  it('extracts "remember:" facts', () => {
    saveConversationTurn(
      'chat1',
      'This is a long enough message to be an episodic memory',
      'Sure! Remember: always use ESM modules in this project.',
    );

    const memories = getRecentMemories('chat1', 10);
    const semantic = memories.filter((m) => m.sector === 'semantic');
    expect(semantic.some((m) => m.content.includes('ESM'))).toBe(true);
  });

  it('extracts preference facts', () => {
    saveConversationTurn(
      'chat1',
      'This is a decently long message for testing preferences',
      'Got it. I always prefer TypeScript over JavaScript for new projects.',
    );

    const memories = getRecentMemories('chat1', 10);
    const semantic = memories.filter((m) => m.sector === 'semantic');
    expect(semantic.some((m) => m.content.includes('TypeScript'))).toBe(true);
  });
});

// ── runDecaySweep ─────────────────────────────────────────────────────

describe('runDecaySweep', () => {
  it('does not throw on empty database', () => {
    expect(() => runDecaySweep()).not.toThrow();
  });

  it('runs without errors when memories exist', () => {
    insertMemory('chat1', 'Some memory content', 'episodic');
    expect(() => runDecaySweep()).not.toThrow();
  });
});
