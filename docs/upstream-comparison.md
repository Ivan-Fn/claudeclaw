---
date: 2026-03-12
updated: 2026-03-12
type: docs
project: claudeclaw
tags: [docs, claudeclaw, upstream, fork-comparison]
---

# Upstream Comparison

This document summarizes how this fork differs from the upstream [earlyaidopters/claudeclaw](https://github.com/earlyaidopters/claudeclaw) repository and why.

Last compared: 2026-03-12 (upstream at `17db9bc`, fork at `8172f91`)

## Summary

The upstream repo is a **generic framework** -- runs anywhere, single-channel (Telegram), minimal operational hardening. This fork is a **production deployment** -- runs under launchd, multi-channel (Telegram + Slack), with operational resilience features required for 24/7 unattended operation.

The fork is not over-engineered. Every addition solves a specific operational problem that doesn't exist in a manually-restarted dev setup but matters when the bot runs as a persistent service.

## Key Differences

### Architecture

| Aspect | Upstream | Fork |
|--------|----------|------|
| Message processing | Monolithic `bot.ts` (~53KB) with Grammy embedded | Platform-agnostic `bot.ts` + channel adapters |
| Channel support | Telegram only (+ WhatsApp, Slack stubs) | Telegram + Slack, extensible via `MessageChannel` interface |
| Process management | No crash guard, no exit code convention | Crash guard, deliberate exit codes for launchd |
| PID lock | Kills old process on conflict | Refuses to start (safer) |
| Queue | Simple per-chat promise chain | Per-chat serial + global concurrency cap + debounce + rate limiting |

### FTS5 Search

| Aspect | Upstream | Fork |
|--------|----------|------|
| Sanitization | ASCII-only (`\w`), wraps in quotes | Unicode-aware (`\p{L}\p{N}`), strips FTS5 operators |
| Reserved keywords | Not handled (AND/OR/NOT crash the bot) | Stripped when other terms exist, kept for single-operator queries |
| Error handling | No try/catch (crash on malformed query) | Try/catch returns `[]` on any FTS5 failure |
| NEAR handling | Not handled | Deliberately preserved (NEAR* is safe with wildcard suffix) |

### Process Lifecycle

| Aspect | Upstream | Fork |
|--------|----------|------|
| Crash guard | None | 3 failures in 5 minutes -> stay down |
| Exit codes | Ad hoc (0 or 1) | Convention: 0 = stay down, 1 = restart me |
| launchd integration | None | KeepAlive with SuccessfulExit semantics |
| Startup health check | None | 15s grace period before clearing crash state |
| Lifecycle logging | None | processMessage start/finish brackets |

### Agent Features

| Aspect | Upstream | Fork |
|--------|----------|------|
| Auto-continue on timeout | None | Up to 3 retries with session preservation |
| Daily cost limits | None | Configurable per-day USD cap |
| Subagent routing | None | Multi-model task routing (e.g., Sonnet for simple tasks) |
| Quick acknowledgment | None | Optional early response before tool calls complete |
| MCP servers | Via settings files | Via env var (`AGENT_MCP_SERVERS`) for container support |
| Request cancellation | Basic | AbortController per request, cleanup in finally block |
| Auto-resume on restart | None | Resumes interrupted requests after bot restart |

## What We Intentionally Don't Have

Some upstream features are not in this fork:

- **Agent orchestrator** (`orchestrator.ts`): Multi-agent coordination. Not needed for single-bot deployments.
- **Migrations system** (`migrations.ts`): Schema versioning with applied tracking. We use inline schema creation in `db.ts`.
- **WhatsApp channel**: Not configured in our deployment.
- **Message encryption**: AES-256-GCM for message bodies. Added to upstream for WhatsApp/Slack compliance. Not yet ported.
- **Banner display**: Cosmetic startup banner. Omitted.

## Keeping in Sync

The fork has diverged structurally (channel abstraction, separate modules) so cherry-picking from upstream requires manual review. Key areas to watch:

- **Agent SDK changes**: `agent.ts` wraps `@anthropic-ai/claude-agent-sdk`. When the SDK API changes, check both codebases.
- **Grammy updates**: Upstream's `bot.ts` and our `channels/telegram.ts` both use Grammy. Breaking changes affect both.
- **New features**: Upstream may add features worth porting (encryption, new channels). Review upstream releases periodically.
