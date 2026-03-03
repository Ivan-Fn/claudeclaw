---
name: morning-briefing
description: Morning digest and pre-meeting briefings. Combines email triage,
  calendar, financial alerts, and CRM contact lookups into a concise daily
  briefing. Use when the user asks for their morning briefing, daily digest,
  what's on today, pre-meeting prep, or when a scheduled briefing task runs.
---

## Morning Briefing

Build a daily digest combining email, calendar, and CRM data.

### When to Use

- "What's on today?" / "Morning briefing" / "Give me my digest"
- "Prep me for my meetings today"
- Scheduled daily briefing task
- "Any emails I need to deal with?"
- "What's coming up this week?" (adjust date range)
- "Create a calendar event for..." / "Schedule a meeting with..."

### Tool Priority

ALWAYS prefer the Google Workspace MCP tools over n8n webhooks:
- MCP tools: direct Google API access, supports read AND write (create events, send emails)
- n8n webhooks: read-only for gmail/calendar, use only for the automated morning digest pipeline

The MCP server is configured at ~/.claude/settings.json as "google-workspace".
User email: ivan.fofanov@gmail.com

### Available MCP Tools

#### Calendar
- **get_events** -- fetch events from Google Calendar (single event or range)
- **manage_event** -- create, update, or delete calendar events
- **list_calendars** -- list available calendars
- **query_freebusy** -- check free/busy status (requires --tool-tier complete)

#### Gmail
- **search_gmail_messages** -- search emails with Gmail query syntax
- **get_gmail_message_content** -- get full email content by ID
- **get_gmail_messages_content_batch** -- get multiple emails at once
- **send_gmail_message** -- send or reply to emails
- **draft_gmail_message** -- create email drafts (requires --tool-tier complete)

### Creating Calendar Events

Use the manage_event MCP tool:

```
manage_event({
  user_google_email: "ivan.fofanov@gmail.com",
  action: "create",
  summary: "Meeting title",
  start_time: "2026-03-02T14:00:00-05:00",  // RFC3339 format
  end_time: "2026-03-02T15:00:00-05:00",
  timezone: "America/New_York",
  description: "Meeting notes",
  attendees: ["person@email.com"],           // optional
  add_google_meet: true                       // optional
})
```

### Fetching Calendar Events

Use the get_events MCP tool:

```
get_events({
  user_google_email: "ivan.fofanov@gmail.com",
  time_min: "2026-03-02T00:00:00-05:00",
  time_max: "2026-03-03T00:00:00-05:00"
})
```

### Searching Emails

Use the search_gmail_messages MCP tool:

```
search_gmail_messages({
  user_google_email: "ivan.fofanov@gmail.com",
  query: "is:unread newer_than:12h -category:promotions",
  max_results: 20
})
```

### Quick Digest (n8n -- for automated/scheduled runs)

For the automated morning digest, trigger the n8n workflow:

```bash
curl -s -X POST http://localhost:5678/webhook/morning-digest \
  -H "Content-Type: application/json" -d '{}'
```

This fires the full n8n pipeline (priority inbox, financial alerts, deals, calendar)
and sends the formatted digest directly to Telegram.

### Rich Briefing (agent-built, with CRM)

For pre-meeting briefings or when CRM context is valuable:

1. Fetch today's calendar via MCP get_events
2. Fetch unread emails via MCP search_gmail_messages
3. Look up meeting attendees in CRM:

```bash
CHAT_ID=$(sqlite3 store/master-agent.db "SELECT chat_id FROM sessions LIMIT 1;")

sqlite3 store/master-agent.db "
  SELECT c.name, c.company, c.role, c.notes,
    datetime(c.last_contact, 'unixepoch', 'localtime') as last_seen,
    c.interaction_count
  FROM contacts c
  WHERE c.chat_id = '$CHAT_ID' AND c.email = 'attendee@email.com';
"
```

4. Format the briefing:

```
Good morning. Here's your day:

CALENDAR (N events)
- 9:45am Ruby (15 min)
- 2:00pm Team sync (30 min)
  With: Alex Chen (Acme, CTO) -- last contact: 5 days ago
  Recent: Discussed partnership deal
- 4:30pm Client call (1hr)
  With: Sarah Miller (LaunchPad, Cofounder) -- last contact: 12 days ago
  Notes: Series A timeline, interested in our API

NEEDS REPLY (N)
- Alex R: "Quick question about the API migration"
- Sarah K: "Contract review -- need sign-off by Friday"

FINANCIAL ALERTS
- Netflix renewal $15.99 due Mar 3
- AWS invoice $47.22 pending

FYI (N more emails)
```

### Formatting Rules

- Calendar first (most actionable)
- Only add CRM context for meetings with external people
- Skip CRM lookup for internal/recurring meetings
- Financial alerts: extract amounts and due dates from subject/snippet
- Cap total message at ~4000 chars for Telegram
- If more than 10 inbox items, show top 10 + "...and N more"

### Auto-Discovery Integration

When processing the briefing, if you see email senders or calendar attendees
that aren't in the CRM yet, mention it at the end:

```
New contacts spotted:
- jane@newco.com (from inbox: "Partnership intro")
- mark@vendor.io (calendar: 3pm meeting)
Want me to add them to your CRM?
```

Only suggest this for real people (not noreply@, notifications@, etc).

### Scheduled Task Setup

Daily morning briefings with CRM enrichment:
```
/schedule 0 7 * * * Run my morning briefing. Fetch emails and calendar, look up meeting attendees in the CRM, and send me the full digest.
```

Pre-meeting briefings on weekdays:
```
/schedule 0 8 * * 1-5 Check my calendar for today's meetings. For each meeting with external attendees, look them up in the CRM and send me a prep briefing with their background, last interaction, and any notes.
```
