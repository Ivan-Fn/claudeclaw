---
date: 2026-03-12
updated: 2026-03-12
type: docs
project: claudeclaw
tags: [docs, claudeclaw, error-handling, fts5, resilience]
---

# Error Handling & Resilience

## Defense-in-Depth Model

ClaudeClaw uses layered error handling so that no single failure can crash the bot or silently drop messages.

```
Layer 1: Input Sanitization    (prevent known bad inputs)
Layer 2: Try/Catch at Source   (catch failures at the module boundary)
Layer 3: Pipeline Try/Catch    (catch anything that escapes layers 1-2)
Layer 4: Queue Error Logging   (catch unhandled rejections in the queue)
Layer 5: Crash Guard           (limit restart loops on persistent failures)
Layer 6: Lifecycle Logging     (diagnose silent failures after the fact)
```

## FTS5 Search Hardening

SQLite FTS5 has reserved keywords (`AND`, `OR`, `NOT`) that cause syntax errors when they appear in user queries. Since every inbound message triggers a memory search, this is a crash vector on the hot path.

### Layer 1: sanitizeFtsQuery()

Located in `db.ts`. Transforms raw user text into safe FTS5 query syntax.

```
Input:  "I'm NOT sure about the OR condition"
Output: "im* sure* about* the* condition*"
```

What it does:
1. Strip non-alphanumeric characters (Unicode-aware: `\p{L}\p{N}`)
2. Lowercase everything (FTS5 operators are case-sensitive: `AND` is an operator, `and` is not)
3. Filter tokens shorter than 2 characters
4. Remove FTS5 operators (`and`, `or`, `not`) when other terms exist
5. If ALL tokens are operators (e.g., query is just "NOT"), keep them as regular search terms
6. Append `*` wildcard to each token for prefix matching

**NEAR is not in the denylist.** `NEAR` only triggers an FTS5 syntax error when used bare between two terms (e.g., `coffee NEAR park`). With the `*` suffix that `sanitizeFtsQuery` always adds, `NEAR*` is a valid prefix search. Stripping it would break legitimate queries containing the word "near."

### Layer 2: Try/Catch in searchMemories()

Even with sanitization, unknown edge cases can cause FTS5 failures (corrupt index, future SQLite changes, untested character combinations). `searchMemories()` wraps the MATCH query in try/catch and returns `[]` on any failure:

```typescript
try {
  return db.prepare(`...MATCH ?...`).all(sanitized, chatId, limit);
} catch (err) {
  logger.warn({ err, chatId, query, sanitized }, 'Memory FTS search failed');
  return [];
}
```

Memory search is an enhancement, not a requirement. The bot works fine without search results -- it still gets recent memories from the time-based query, and the agent can still answer questions.

### Layer 3: Pipeline Try/Catch

`processMessage()` in `bot.ts` wraps the entire pipeline in try/catch. If memory building, agent invocation, or response sending fails, the user gets an error message instead of silence.

### Residual: contacts_fts

The contacts FTS table (used for CRM searches) does not have the same try/catch protection. It's only used in manual `/contact` searches, not on every message, so the blast radius is smaller.

## Message Pipeline Errors

### Context Window Exhaustion

When the Claude Agent SDK subprocess exits with code 1 after a long session, it typically means the context window is full. The bot detects this via the error message (`exited with code 1`) and sends a recovery hint:

```
Context window likely exhausted. Last known context: ~150k tokens.
Use /newchat to start fresh, then /respin to pull recent conversation back in.
```

### Agent Timeout and Auto-Continue

The agent has a per-turn timeout (default 300s). When Claude is mid-turn executing tool calls and the timeout fires, the bot auto-continues instead of giving up:

1. Preserve the session (partial work is not lost)
2. Send "Still working... (auto-continue N/3)" to the user
3. Resume the session with "Continue where you left off"
4. Retry up to `MAX_TIMEOUT_RETRIES` times (default 3)

This gives complex tasks up to ~20 minutes of total execution time.

### Request Cancellation

Each in-flight request has an `AbortController`. The `/cancel` command signals the controller, which propagates to the agent SDK subprocess. The abort controller is cleaned up in the `finally` block of `processMessage()`.

## Queue Error Handling

The queue (`queue.ts`) catches unhandled promise rejections from message processing:

```typescript
const chain = next.then(() => {}, (err) => {
  logger.error({ err, chatId }, 'Unhandled error in queue task');
});
```

This prevents a single failed message from breaking the per-chat promise chain and blocking all future messages for that chat.

## Lifecycle Logging

Two log lines bracket the entire message pipeline:

```
processMessage started  { cid, channel, msgLen }
processMessage finished { cid }
```

These are in the entry point and `finally` block of `processMessage()`. Their purpose is diagnosing silent message drops -- if a message enters the pipeline but never produces output, these logs show whether `processMessage` was called at all, and whether it completed.

### Background: The Silent Drop Incident

On 2026-03-12, a message was flushed from the debounce buffer but produced zero log output for 10+ minutes. No agent completion, no error, no timeout. Root cause unknown. The lifecycle logging was added so future occurrences can be diagnosed:

- If "started" appears but "finished" doesn't: the pipeline hung somewhere
- If neither appears: the queue never dispatched the message
- If both appear but no agent output: the agent returned empty text

## Auto-Resume on Restart

When the bot restarts (via `/restart`, `/rebuild`, or a crash), the Telegram adapter checks for in-flight requests that were interrupted:

1. On startup, query `active_requests` table for stale entries
2. For each, send a notification: "Bot restarted, resuming your request"
3. Re-process the original message with `skipLog: true` (avoids duplicate conversation log entries)
4. Track resume attempts; give up after `MAX_RESUME_ATTEMPTS` to prevent loops

This provides continuity when the bot restarts mid-task.

## Rate Limiting

The queue tracks messages per chat per minute. If a chat exceeds `MAX_MESSAGES_PER_MINUTE` (10), new messages are silently rate-limited. This prevents abuse and protects the Claude API budget.

## Daily Cost Limits

`agent.ts` tracks cumulative API cost per day. If `AGENT_DAILY_COST_LIMIT_USD` is set and the daily total exceeds it, new requests are blocked with a message:

```
Daily cost limit reached ($X.XX / $Y.YY). Try again tomorrow.
```

The counter resets at midnight (local time).
