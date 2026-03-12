import { logger } from './logger.js';
import { MAX_MESSAGES_PER_MINUTE, MESSAGE_DEBOUNCE_MS } from './config.js';

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
  const chain = next.then(() => {}, (err) => {
    logger.error({ err, chatId }, 'Unhandled error in queue task');
  });
  chatQueues.set(chatId, chain);

  // Remove the map entry once the chain settles (prevents unbounded growth)
  void chain.then(() => {
    if (chatQueues.get(chatId) === chain) {
      chatQueues.delete(chatId);
    }
  });

  return next;
}

// ── Message Debounce Buffer ───────────────────────────────────────────
//
// When messages arrive in rapid succession (e.g., forwarded post + instruction),
// buffer them and merge into a single prompt before sending to Claude.

interface DebounceBuffer {
  messages: string[];
  timer: ReturnType<typeof setTimeout>;
}

const debounceBuffers = new Map<string, DebounceBuffer>();

/**
 * Buffer a message for debounced processing. If more messages arrive within
 * MESSAGE_DEBOUNCE_MS, they're merged. When the timer fires, processFn is
 * called with the joined messages via the serial queue.
 */
export function enqueueDebounced(
  chatId: string,
  message: string,
  processFn: (merged: string) => Promise<void>,
): void {
  recordMessage(chatId);

  const existing = debounceBuffers.get(chatId);

  if (existing) {
    existing.messages.push(message);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushDebounce(chatId, processFn), MESSAGE_DEBOUNCE_MS);
    logger.debug({ chatId, buffered: existing.messages.length }, 'Message buffered (debounce)');
  } else {
    const timer = setTimeout(() => flushDebounce(chatId, processFn), MESSAGE_DEBOUNCE_MS);
    debounceBuffers.set(chatId, { messages: [message], timer });
    logger.debug({ chatId }, 'Debounce timer started');
  }
}

function flushDebounce(
  chatId: string,
  processFn: (merged: string) => Promise<void>,
): void {
  const buffer = debounceBuffers.get(chatId);
  if (!buffer) return;
  debounceBuffers.delete(chatId);

  const merged = buffer.messages.join('\n\n');
  logger.info({ chatId, messageCount: buffer.messages.length }, 'Flushing debounce buffer');

  void enqueue(chatId, () => processFn(merged));
}

// ── Cleanup ────────────────────────────────────────────────────────────

export function clearQueues(): void {
  for (const buf of debounceBuffers.values()) {
    clearTimeout(buf.timer);
  }
  debounceBuffers.clear();
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
