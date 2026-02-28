Load shared context from the Master Agent database. This gives you visibility into recent conversations and memories from ALL channels (Telegram, other Claude Code sessions, Slack, etc.).

Run these queries against the SQLite database at `store/master-agent.db`:

1. **Recent conversations** (last 20 turns across all sessions):
```bash
sqlite3 store/master-agent.db "
  SELECT role, substr(content, 1, 300) as content,
         datetime(created_at, 'unixepoch', 'localtime') as time
  FROM conversation_log
  ORDER BY created_at DESC LIMIT 20;
"
```

2. **Active memories** (high-salience facts and recent context):
```bash
sqlite3 store/master-agent.db "
  SELECT sector, content,
         round(salience, 2) as salience,
         datetime(accessed_at, 'unixepoch', 'localtime') as last_accessed
  FROM memories
  WHERE salience > 0.3
  ORDER BY salience DESC, accessed_at DESC LIMIT 15;
"
```

3. **Scheduled tasks** (what's running on cron):
```bash
sqlite3 store/master-agent.db "
  SELECT id, prompt, schedule, status,
         datetime(next_run, 'unixepoch', 'localtime') as next_run
  FROM scheduled_tasks
  ORDER BY next_run;
"
```

4. **Session info** (current active sessions):
```bash
sqlite3 store/master-agent.db "
  SELECT chat_id, session_id,
         datetime(updated_at, 'unixepoch', 'localtime') as last_active
  FROM sessions;
"
```

After running these, summarize what you found concisely. Don't dump raw SQL output -- tell me:
- What was discussed recently
- What key facts/decisions are stored
- What tasks are scheduled
- Whether there's an active session
