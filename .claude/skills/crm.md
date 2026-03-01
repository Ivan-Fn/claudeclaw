---
name: crm
description: Personal CRM for managing contacts, tracking interactions, and
  delivering pre-meeting briefings. Use when the user asks about contacts,
  people, meetings, follow-ups, or when processing scheduled CRM tasks.
  Also use when user explicitly requests adding a photo to a contact profile.
---

## Personal CRM

Manage contacts and interactions in the local SQLite database.
Database path: store/master-agent.db
Photo storage: store/crm/photos/

### When to Use
- User asks about a person: "Who is Alex?", "What do I know about John?"
- User wants to add/update a contact: "Add Alex, alex@acme.com, CTO at Acme"
- User asks about follow-ups: "Who haven't I talked to recently?"
- User sends a photo to add to a contact profile
- Scheduled task: daily contact scan, pre-meeting briefing
- After meetings/calls: "Log that I met with Sarah about the API migration"

### Database Operations

All operations use sqlite3 CLI against store/master-agent.db.

**Getting chat_id:** The agent does not have $CHAT_ID as an env var.
Get it from the sessions table:
```bash
CHAT_ID=$(sqlite3 store/master-agent.db "SELECT chat_id FROM sessions LIMIT 1;")
```
Use $CHAT_ID in all subsequent queries within the same command chain.

**SQL quoting safety:** When interpolating user-provided values (names, notes,
emails) into sqlite3 CLI commands, always escape single quotes by doubling them.
For example, O'Brien becomes O''Brien. Apply this to ALL string values:
```bash
SAFE_NAME=$(echo "$NAME" | sed "s/'/''/g")
```

#### Find a contact
sqlite3 store/master-agent.db "
  SELECT id, name, email, company, role, notes, photo_path,
    datetime(last_contact, 'unixepoch', 'localtime') as last_seen,
    interaction_count
  FROM contacts
  WHERE chat_id = '$CHAT_ID'
    AND (name LIKE '%QUERY%' OR email LIKE '%QUERY%' OR company LIKE '%QUERY%')
  LIMIT 10;
"

#### Full-text search
sqlite3 store/master-agent.db "
  SELECT c.* FROM contacts c
  JOIN contacts_fts f ON c.id = f.rowid
  WHERE f.contacts_fts MATCH 'QUERY*' AND c.chat_id = '$CHAT_ID'
  ORDER BY rank LIMIT 10;
"

#### Add a contact
sqlite3 store/master-agent.db "
  INSERT INTO contacts (chat_id, name, email, phone, company, role, notes, source)
  VALUES ('$CHAT_ID', 'Name', 'email', 'phone', 'Company', 'Role', 'Notes', 'manual')
  ON CONFLICT(chat_id, email) DO UPDATE SET
    name = excluded.name,
    company = COALESCE(excluded.company, company),
    role = COALESCE(excluded.role, role),
    notes = COALESCE(excluded.notes, notes),
    updated_at = unixepoch();
"

#### Update a contact
sqlite3 store/master-agent.db "
  UPDATE contacts SET
    notes = 'new notes',
    updated_at = unixepoch()
  WHERE id = ID AND chat_id = '$CHAT_ID';
"

#### Log an interaction
sqlite3 store/master-agent.db "
  INSERT INTO interactions (chat_id, contact_id, type, source, summary)
  VALUES ('$CHAT_ID', CONTACT_ID, 'meeting', 'manual', 'Discussed API migration');

  UPDATE contacts SET
    last_contact = unixepoch(),
    interaction_count = interaction_count + 1,
    updated_at = unixepoch()
  WHERE id = CONTACT_ID;
"

#### Get interaction history for a contact
sqlite3 store/master-agent.db "
  SELECT type, summary, datetime(date, 'unixepoch', 'localtime') as when
  FROM interactions
  WHERE contact_id = ID
  ORDER BY date DESC LIMIT 10;
"

#### Contacts needing follow-up (not contacted in 30+ days)
sqlite3 store/master-agent.db "
  SELECT name, email, company,
    CAST((unixepoch() - last_contact) / 86400 AS INT) as days_since
  FROM contacts
  WHERE chat_id = '$CHAT_ID'
    AND (unixepoch() - last_contact) > 30 * 86400
  ORDER BY last_contact ASC;
"

#### CRM stats
sqlite3 store/master-agent.db "
  SELECT COUNT(*) as total_contacts,
    SUM(CASE WHEN (unixepoch() - last_contact) < 7*86400 THEN 1 ELSE 0 END) as active_7d,
    SUM(CASE WHEN (unixepoch() - last_contact) > 30*86400 THEN 1 ELSE 0 END) as stale_30d
  FROM contacts WHERE chat_id = '$CHAT_ID';
"

### Contact Photos

Photos are stored permanently in store/crm/photos/ (not affected by the
24-hour upload cleanup). The directory is gitignored.

#### Adding a photo to a contact

When the user explicitly asks to add a photo to a contact
(e.g., "Add this to Alex's profile" or "Save this photo for Sarah"):

1. Find the contact by name in the database
2. Create the photos directory if needed:
   mkdir -p store/crm/photos
3. Get the original file extension from the upload path (preserve .jpg/.png/etc)
4. Copy from the temporary upload path to permanent storage:
   cp workspace/uploads/{original-file} store/crm/photos/contact-{id}-{timestamp}.{ext}
5. Update the contact record:
   sqlite3 store/master-agent.db "
     UPDATE contacts SET
       photo_path = 'store/crm/photos/contact-{id}-{timestamp}.{ext}',
       updated_at = unixepoch()
     WHERE id = {id} AND chat_id = '$CHAT_ID';
   "
6. Confirm: "Photo saved to [Name]'s profile."

#### Sending a contact's photo back

When the user asks "Show me Alex's photo" or "What does Sarah look like":
1. Look up the contact and get photo_path
2. If photo_path exists, send it via Telegram:
   ```bash
   BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN .env | cut -d= -f2)
   curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto" \
     -F "chat_id=$CHAT_ID" \
     -F "photo=@{photo_path}" \
     -F "caption=Name (Company)"
   ```
   Note: this is a direct Telegram API call outside grammy. It works for MVP
   but is tech debt -- consider adding a helper script if photo sending
   becomes unreliable.
3. If no photo: "No photo on file for [Name]."

### Daily Contact Scan (Scheduled Task)

When running the daily contact scan:
1. Call n8n webhook for recent emails:
   curl -s -X POST http://localhost:5678/webhook/gmail \
     -H "Content-Type: application/json" \
     -d '{"action":"unread"}'
2. Call n8n webhook for today's calendar:
   curl -s -X POST http://localhost:5678/webhook/calendar \
     -H "Content-Type: application/json" \
     -d '{}'
3. Parse email senders and calendar attendees
4. For each new person: INSERT into contacts with source='email' or source='calendar'
5. For existing contacts: UPDATE last_contact, increment interaction_count
6. Log interactions with source='auto' to distinguish from manual entries
7. Report: "Found X new contacts, updated Y existing"

### Pre-Meeting Briefing (Scheduled Task)

When running the pre-meeting briefing:
1. Get today's calendar events via n8n
2. For each event with external attendees:
   a. Search contacts DB for each attendee by email
   b. Get their interaction history
   c. Build a briefing: who they are, last interaction, key notes
   d. If they have a photo, send it along with the briefing
3. Send briefing to Telegram with format:
   Meeting: [Event Title] at [Time]
   Attendees:
   - Name (Company, Role) -- last contact: X days ago
     Recent: [last interaction summary]
     Notes: [contact notes]

### Response Format

Keep responses tight for Telegram:
- Contact lookups: name, company, last seen, key notes
- Lists: table format or numbered list, max 10 entries
- Briefings: structured but concise
- Always mention if no contacts found for a query
