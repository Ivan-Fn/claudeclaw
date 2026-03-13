---
date: 2026-03-12
updated: 2026-03-12
type: docs
project: claudeclaw
tags: [docs, claudeclaw, architecture, typescript]
---

# ClaudeClaw Architecture

## Overview

ClaudeClaw is a multi-channel AI assistant framework that routes messages from Telegram, Slack, and other platforms through the Claude Agent SDK. It runs as a persistent service managed by launchd (macOS) or Docker.

```
Telegram ─┐
           ├─> Channel Adapter ─> Queue ─> processMessage ─> Claude Agent SDK
Slack ─────┘        │                           │
                    │                    Memory Context
                    │                    Session Mgmt
              Platform I/O              Token Tracking
           (format, commands,            Abort/Cancel
            file download)              Auto-Continue
```

## Module Map

| Module | Purpose |
|--------|---------|
| `index.ts` | Process lifecycle: PID lock, crash guard, channel startup, shutdown |
| `bot.ts` | Platform-agnostic message processing pipeline |
| `agent.ts` | Claude Agent SDK wrapper, cost tracking, config injection |
| `queue.ts` | Per-chat serial queue, global concurrency gate, debounce, rate limiting |
| `memory.ts` | Context builder, conversation logging, semantic fact extraction |
| `db.ts` | SQLite schema, FTS5 search, token usage, HiveMind cross-agent log |
| `crash-guard.ts` | Consecutive startup failure tracking (persisted to disk) |
| `config.ts` | All environment variable parsing, defaults |
| `channels/types.ts` | `MessageChannel` interface, composite ID helpers |
| `channels/telegram.ts` | Telegram adapter: Grammy bot, commands, file handling |
| `channels/slack.ts` | Slack adapter: Bolt, Socket Mode |
| `channels/format-telegram.ts` | HTML formatting, message splitting for Telegram |
| `scheduler.ts` | Cron-based scheduled tasks |
| `voice.ts` | STT (Groq) and TTS (ElevenLabs) |
| `dashboard.ts` | Web dashboard (Express) |

## Message Flow

### 1. Inbound Message

A message arrives at a channel adapter (e.g., `TelegramChannel`). The adapter:
- Validates the sender against `ALLOWED_CHAT_IDS`
- Normalizes the content (text, voice transcription, photo description)
- Checks for bot commands (`/restart`, `/newchat`, etc.) and handles them directly
- For regular messages, calls `enqueueDebounced()` with the composite ID

### 2. Debounce and Queue

`enqueueDebounced()` (in `queue.ts`) buffers messages for `MESSAGE_DEBOUNCE_MS` (default 3s). When the timer fires, all buffered messages for that chat are joined with `\n\n` and passed to the serial queue via `enqueue()`.

The queue provides two guarantees:
- **Per-chat serialization**: Only one message processes at a time per chat (prevents session corruption)
- **Global concurrency cap**: At most `MAX_CONCURRENT=2` agent calls run simultaneously

### 3. processMessage Pipeline

`processMessage()` (in `bot.ts`) is the core pipeline. It is completely platform-agnostic -- it takes a `MessageChannel` interface and composite ID, not a Telegram context.

Steps:
1. Register request as in-flight (for auto-resume on restart)
2. Build memory context from FTS5 search + recent memories
3. Get or create session ID + check for model override
4. Create abort controller (for `/cancel`)
5. Run agent via `runAgentWithAbort()`
6. If agent timed out, auto-continue up to `MAX_TIMEOUT_RETRIES` times
7. Save session, log conversation turn
8. Log to HiveMind (cross-agent activity)
9. Extract file markers (`[SEND_FILE:path]`, `[SEND_PHOTO:path]`)
10. Send response (text, voice, or files) via channel adapter
11. Save token usage, check context window warnings

### 4. Agent Execution

`runAgent()` (in `agent.ts`) wraps the Claude Agent SDK's `query()` function:
- Injects the system prompt (from CLAUDE.md + skills catalog)
- Configures MCP servers, model, subagents
- Sets a timeout (`AGENT_TIMEOUT_MS`, default 300s)
- Tracks token usage (input, output, cache reads, compaction)
- Enforces daily cost limits
- Supports `onFirstText` callback for quick acknowledgment before tool calls complete

## Channel Abstraction

All channels implement the `MessageChannel` interface:

```typescript
interface MessageChannel {
  channelId: ChannelId;       // 'telegram' | 'slack'
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId, text): Promise<void>;
  sendFormatted(chatId, text): Promise<void>;
  startTyping(chatId): () => void;
  downloadFile(fileId): Promise<string>;
  sendVoice?(chatId, audio): Promise<void>;
  sendDocument?(chatId, filePath, caption?): Promise<void>;
  sendPhoto?(chatId, filePath, caption?): Promise<void>;
}
```

Database entries use composite IDs (`telegram:12345`, `slack:D1234567`) to scope sessions, memories, and token usage per channel.

## Memory System

Two-layer context retrieval on every message:

1. **FTS5 keyword search**: Matches user message against stored memories (top 3)
2. **Recent memories**: Last 5 memories by access time (deduplicated against search results)

Both layers are combined into a `<memory-context>` block prepended to the user's message before the agent call.

Memories are:
- **Episodic**: User messages over 20 chars (auto-saved, decay over time)
- **Semantic**: Durable facts extracted from agent responses via regex patterns

Pruning: Max 200 memories per chat. Excess is pruned by lowest salience + oldest access time. Hourly decay sweep reduces salience by `MEMORY_DECAY_FACTOR` (0.98); memories below `MEMORY_MIN_SALIENCE` (0.1) are deleted.

## Configuration

All configuration is via environment variables in `.env`. See `config.ts` for the full list.

Key groups:

| Group | Variables |
|-------|-----------|
| Identity | `BOT_NAME`, `BOT_DISPLAY_NAME` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_IDS` |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ALLOWED_CHANNEL_IDS` |
| Agent | `AGENT_CWD`, `AGENT_MODEL`, `AGENT_TIMEOUT_MS`, `AGENT_DAILY_COST_LIMIT_USD` |
| Subagents | `AGENT_SUBAGENTS` (JSON: model routing definitions) |
| MCP | `AGENT_MCP_SERVERS` (JSON: server definitions passed to SDK) |
| Voice | `GROQ_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |
| Queue | `MESSAGE_DEBOUNCE_MS`, `MAX_TIMEOUT_RETRIES`, `MAX_RESUME_ATTEMPTS` |
| Dashboard | `DASHBOARD_PORT`, `DASHBOARD_TOKEN` |
