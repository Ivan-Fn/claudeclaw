---
name: obsidian-tasks
description: Manage personal and work todos stored in Obsidian vault. Use when the user asks to add, list, check off, or manage tasks/todos. Also trigger on "remind me to", "add a task", "what's on my list", "mark done", personal tasks, work tasks, daily notes, or anything todo-related. This is the primary task management system -- always use it for task operations rather than other tools.
allowed-tools: Read, Edit, Write
---

# Obsidian Tasks

You manage tasks stored as markdown files in an Obsidian vault. Tasks use the Obsidian Tasks format.

## Vault Location

`/Users/mini1/Library/Mobile Documents/iCloud~md~obsidian/Documents/IF-vault/`

Structure:
- `Daily/` -- daily notes named `YYYY-MM-DD.md`
- `Tasks/personal.md` -- personal task list
- `Tasks/work.md` -- work task list
- `Notes/` -- knowledge base (notes, not tasks)

## Task Format

Standard Obsidian Tasks markdown:
```
- [ ] Task description 📅 2026-03-15 #tag
- [ ] High priority task 📅 2026-03-15 #work ⏫
- [x] Completed task ✅ 2026-03-15 #personal
```

Metadata (append after description, space-separated):
- `📅 YYYY-MM-DD` -- due date
- `⏫` high priority, `🔼` medium, `🔽` low
- `✅ YYYY-MM-DD` -- completion date (add when marking done)
- `#personal` or `#work` -- category tag

## Reading Tasks (MCP)

Use the `query_tasks` MCP tool from the `obsidian-tasks` server. Pass `rootDirs` as `["/Users/mini1/Library/Mobile Documents/iCloud~md~obsidian/Documents/IF-vault"]`.

Common queries (one filter per line in the query string):
- All incomplete: `not done`
- Due today: `not done\ndue today`
- Overdue: `not done\ndue before today`
- Work tasks: `not done\ntag include #work`
- Personal tasks: `not done\ntag include #personal`
- Due this week: `not done\ndue before next week`
- High priority: `not done\npriority is high`

Example MCP call:
```
query_tasks({ query: "not done\ndue today", rootDirs: ["/Users/mini1/Library/Mobile Documents/iCloud~md~obsidian/Documents/IF-vault"] })
```

## Writing Tasks (File Tools)

Use Claude Code's native Read/Edit tools to modify task files directly.

### Adding a task
1. Determine the right file:
   - Personal tasks go in `Tasks/personal.md`
   - Work/SV0 tasks go in `Tasks/work.md`
   - If user says "add to today" or the task is date-specific, use `Daily/YYYY-MM-DD.md`
2. Read the file (create it if it doesn't exist with a `# heading`)
3. Append the task line with proper format

### Completing a task
1. Query tasks to find the exact one (use MCP query_tasks)
2. Read the file at the returned filePath
3. Edit the line: change `- [ ]` to `- [x]` and append `✅ YYYY-MM-DD` with today's date

### Updating a task
1. Find it via query
2. Read the file
3. Edit the specific line to change description, due date, priority, or tags

### Creating a daily note
If adding tasks to a daily note that doesn't exist:
```markdown
# YYYY-MM-DD

## Tasks

- [ ] The task here 📅 YYYY-MM-DD #tag
```

## Inferring Context

- If user says "task" or "todo" without specifying personal/work, ask or infer from context
- If no due date mentioned, don't add one (leave it undated)
- If user says "tomorrow", "next Monday", etc., calculate the actual date
- Voice messages like "remind me to buy milk" = add a personal task
- "add a task for SV0: review PR" = work task in Tasks/work.md

## Response Format

When listing tasks, keep it clean for Telegram:

```
Tasks due today:
- Pay for swim (personal)
- Review Delta PR #12 (work) ⏫

3 overdue tasks (show all? y/n)
```

Don't show file paths or metadata symbols in the response unless asked.
