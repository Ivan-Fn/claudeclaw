---
date: 2026-03-12
updated: 2026-03-12
type: docs
project: claudeclaw
tags: [docs, claudeclaw, launchd, process-management, crash-guard]
---

# Process Management

## How ClaudeClaw Stays Running

ClaudeClaw runs as a persistent service. On macOS, launchd manages the process. In Docker, the container restart policy serves the same role.

### launchd Configuration

The plist uses `KeepAlive` with `SuccessfulExit: false`:

```xml
<key>KeepAlive</key>
<dict>
  <key>SuccessfulExit</key>
  <false/>
</dict>
<key>ThrottleInterval</key>
<integer>10</integer>
```

This means:
- **Exit 0** (success): launchd does NOT restart the process
- **Exit 1** (failure): launchd restarts the process after `ThrottleInterval` seconds

This is deliberate. Exit 0 means "I chose to stop" and exit 1 means "please restart me."

### Exit Code Convention

Every `process.exit()` call in the codebase follows this convention:

| Scenario | Exit Code | launchd Behavior |
|----------|-----------|-------------------|
| `/restart` command | 1 | Restarts |
| `/rebuild` command | 1 | Restarts |
| Startup failure (retries remaining) | 1 | Restarts |
| SIGINT / SIGTERM (clean shutdown) | 0 | Stays down |
| Crash guard exhausted (3 failures) | 0 | Stays down |
| Already running (PID lock conflict) | 0 | Stays down |

### PID Lock

On startup, the bot writes its PID to `store/<BOT_NAME>.pid`. If the file already exists:

1. Read the PID from the file
2. Check if that process is still alive (`process.kill(pid, 0)`)
3. If alive: throw `AlreadyRunningError`, exit 0
4. If dead: stale file, overwrite with current PID

Special case: PID 1 (Docker init process) is always treated as stale to prevent false lock detection in containers.

## Crash Guard

The crash guard prevents infinite restart loops when the bot hits a persistent startup error (bad config, DB corruption, Telegram 409 conflicts, etc.).

### How It Works

State is persisted to `store/<BOT_NAME>.crash-count` as JSON:

```json
{ "count": 2, "firstCrash": 1741824000000 }
```

On each startup failure:
1. `recordCrash()` reads the current state
2. If the first crash was more than 5 minutes ago, reset the counter (new failure window)
3. Otherwise, increment the counter
4. If count reaches `MAX_CRASH_RETRIES` (3), exit with code 0 (stay down)
5. Otherwise, exit with code 1 (launchd will restart)

On successful startup (15 seconds after `telegram.start()` returns without crashing):
- `clearCrashState()` deletes the crash file

On clean shutdown (SIGTERM/SIGINT):
- `clearCrashState()` deletes the crash file

### What Counts as a Crash

- Any uncaught error during startup: YES (increments counter)
- `AlreadyRunningError` (PID lock conflict): NO (exits 0 directly, not counted)
- Errors after startup health check passes: NO (clears crash state instead)
- Clean shutdown via signal: NO (clears crash state)

### Recovery

If the crash guard blocks startup, the bot logs:

```
Giving up after 3 consecutive startup failures. Delete store/<BOT_NAME>.crash-count to retry.
```

To recover:
1. Fix the underlying issue
2. Delete `store/<BOT_NAME>.crash-count`
3. Start the bot (or `launchctl kickstart`)

### Why Not Just Restart Forever?

Without the crash guard, a persistent error (e.g., invalid bot token, DB locked by another process) causes an infinite restart loop -- launchd restarts the bot every 10 seconds, it crashes immediately, repeat. This burns CPU, floods logs, and never self-heals.

The crash guard gives the bot 3 attempts within a 5-minute window. If all 3 fail, it stays down and waits for human intervention.

## Startup Sequence

```
main()
  ├── acquireLock()                    # PID file check
  ├── initDatabase()                   # SQLite schema + migrations
  ├── checkNewSkills()                 # Skill catalog scan
  ├── Create channel adapters          # TelegramChannel, SlackChannel
  ├── initScheduler()                  # Cron task runner
  ├── startDashboard()                 # Express web server
  ├── Start maintenance intervals      # Memory decay, upload cleanup
  ├── Register signal handlers         # SIGINT, SIGTERM -> clean shutdown
  ├── Check crash guard                # Block if 3 recent failures
  ├── slack.start()                    # Socket Mode (non-blocking)
  └── telegram.start()                 # Long-polling (blocking)
       └── After 15s alive -> markStartupHealthy() -> clearCrashState()
```

Telegram's `start()` blocks (Grammy long-polling), so it must be the last channel to start. The startup health timer gives a 15-second grace period before declaring the startup successful -- this prevents false positives if the process crashes seconds after `start()` returns.

## Self-Management Commands

These are handled directly by the Telegram adapter without invoking the agent:

| Command | What It Does |
|---------|-------------|
| `/restart` | Replies "Restarting...", then `process.exit(1)` after 500ms |
| `/rebuild` | Runs `git pull && npm install && npm run build`, then `process.exit(1)` |
| `/cancel` | Aborts the in-flight agent request via `AbortController` |

Both `/restart` and `/rebuild` exit with code 1 so that launchd restarts the process with the updated code.
