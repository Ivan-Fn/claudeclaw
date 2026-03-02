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

### Quick Digest (trigger the n8n workflow)

For a fast morning digest without CRM enrichment, trigger the existing n8n workflow:

```bash
curl -s -X POST http://localhost:5678/webhook/morning-digest \
  -H "Content-Type: application/json" -d '{}'
```

This fires the full n8n pipeline (priority inbox, financial alerts, deals, calendar)
and sends the formatted digest directly to Telegram. Use this when the user just
wants the standard morning digest quickly.

### Rich Briefing (agent-built, with CRM)

For pre-meeting briefings or when CRM context is valuable, build the digest
by calling individual webhooks and enriching with contact data.

#### Step 1: Fetch data in parallel

Run these curl commands (all in one bash block for speed):

```bash
# Fetch all data sources in parallel
PRIORITY=$(curl -s -X POST http://localhost:5678/webhook/gmail \
  -H "Content-Type: application/json" \
  -d '{"q":"is:unread newer_than:12h -category:promotions -category:social -category:forums"}')

FINANCIAL=$(curl -s -X POST http://localhost:5678/webhook/gmail \
  -H "Content-Type: application/json" \
  -d '{"q":"newer_than:7d subject:(payment OR invoice OR renewal OR subscription)"}')

CALENDAR=$(curl -s -X POST http://localhost:5678/webhook/calendar \
  -H "Content-Type: application/json" -d '{}')

echo "===PRIORITY==="
echo "$PRIORITY"
echo "===FINANCIAL==="
echo "$FINANCIAL"
echo "===CALENDAR==="
echo "$CALENDAR"
```

#### Step 2: Look up meeting attendees in CRM

For each calendar event with attendees, search the contacts DB:

```bash
CHAT_ID=$(sqlite3 store/master-agent.db "SELECT chat_id FROM sessions LIMIT 1;")

# Look up attendee by email
sqlite3 store/master-agent.db "
  SELECT c.name, c.company, c.role, c.notes, c.photo_path,
    datetime(c.last_contact, 'unixepoch', 'localtime') as last_seen,
    c.interaction_count
  FROM contacts c
  WHERE c.chat_id = '$CHAT_ID' AND c.email = 'attendee@email.com';
"

# Get recent interactions with this contact
sqlite3 store/master-agent.db "
  SELECT type, summary, datetime(date, 'unixepoch', 'localtime') as when
  FROM interactions
  WHERE contact_id = CONTACT_ID
  ORDER BY date DESC LIMIT 3;
"
```

#### Step 3: Format the briefing

Use this format for Telegram (keep it tight):

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
- Deals section: only include if user has asked for it or it's the full morning digest
- Cap total message at ~4000 chars for Telegram
- If more than 10 inbox items, show top 10 + "...and N more"

### Date Ranges for Different Queries

| Request | Gmail query modifier | Calendar range |
|---------|---------------------|----------------|
| Today | `newer_than:12h` | today |
| Tomorrow | n/a | tomorrow |
| This week | `newer_than:7d` | next 7 days |

For tomorrow's calendar:
```bash
curl -s -X POST http://localhost:5678/webhook/calendar \
  -H "Content-Type: application/json" \
  -d "{\"timeMin\":\"$(date -v+1d '+%Y-%m-%dT00:00:00')\",\"timeMax\":\"$(date -v+2d '+%Y-%m-%dT00:00:00')\"}"
```

For this week's calendar:
```bash
curl -s -X POST http://localhost:5678/webhook/calendar \
  -H "Content-Type: application/json" \
  -d "{\"timeMin\":\"$(date '+%Y-%m-%dT00:00:00')\",\"timeMax\":\"$(date -v+7d '+%Y-%m-%dT00:00:00')\"}"
```

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

To set up daily morning briefings with CRM enrichment:
```
/schedule 0 7 * * * Run my morning briefing. Fetch emails and calendar, look up meeting attendees in the CRM, and send me the full digest.
```

For pre-meeting briefings on weekdays:
```
/schedule 0 8 * * 1-5 Check my calendar for today's meetings. For each meeting with external attendees, look them up in the CRM and send me a prep briefing with their background, last interaction, and any notes.
```
