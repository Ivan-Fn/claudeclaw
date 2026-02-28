import { logger } from './logger.js';
import { MAX_MESSAGES_PER_MINUTE } from './config.js';

// ── Per-Chat Message Queue ─────────────────────────────────────────────
//
// Each chat_id gets a serial queue -- messages are processed one at a time
// to prevent session corruption from concurrent Claude SDK calls.
//
// Global concurrency is capped at MAX_CONCURRENT to avoid overloading.

const MAX_CONCURRENT = 2;

const chatQueues = new Map<string, Promise<void>>();
let activeConcurrent = 0;
const concurrencyWaiters: Array<() => void> = [];

// ── Rate Limiting ──────────────────────────────────────────────────────

const rateLimitWindows = new Map<string, number[]>();

export function isRateLimited(chatId: string): boolean {
  const now = Date.now();
  const window = rateLimitWindows.get(chatId) ?? [];
  const recent = window.filter((t) => now - t < 60_000);
  rateLimitWindows.set(chatId, recent);
  return recent.length >= MAX_MESSAGES_PER_MINUTE;
}

function recordMessage(chatId: string): void {
  const window = rateLimitWindows.get(chatId) ?? [];
  window.push(Date.now());
  rateLimitWindows.set(chatId, window);
}

// ── Concurrency Gate ───────────────────────────────────────────────────

function acquireConcurrency(): Promise<void> {
  if (activeConcurrent < MAX_CONCURRENT) {
    activeConcurrent++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    concurrencyWaiters.push(resolve);
  });
}

function releaseConcurrency(): void {
  const next = concurrencyWaiters.shift();
  if (next) {
    next();
  } else {
    activeConcurrent--;
  }
}

// ── Queue ──────────────────────────────────────────────────────────────

export function enqueue<T>(
  chatId: string,
  fn: () => Promise<T>,
): Promise<T> {
  recordMessage(chatId);

  const prev = chatQueues.get(chatId) ?? Promise.resolve();

  const next = prev
    .then(async () => {
      await acquireConcurrency();
      try {
        return await fn();
      } finally {
        releaseConcurrency();
      }
    });

  // Store the void-typed chain for sequencing, then clean up the entry
  const chain = next.then(() => {}, () => {});
  chatQueues.set(chatId, chain);

  // Remove the map entry once the chain settles (prevents unbounded growth)
  void chain.then(() => {
    if (chatQueues.get(chatId) === chain) {
      chatQueues.delete(chatId);
    }
  });

  return next;
}

// ── Cleanup ────────────────────────────────────────────────────────────

export function clearQueues(): void {
  chatQueues.clear();
  rateLimitWindows.clear();
  activeConcurrent = 0;
  concurrencyWaiters.length = 0;
}

// ── Stats ──────────────────────────────────────────────────────────────

export function getQueueStats(): {
  activeChats: number;
  activeConcurrent: number;
  waitingForConcurrency: number;
} {
  return {
    activeChats: chatQueues.size,
    activeConcurrent,
    waitingForConcurrency: concurrencyWaiters.length,
  };
}
