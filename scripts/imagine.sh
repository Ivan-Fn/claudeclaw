#!/usr/bin/env bash
# Generate an image with Gemini and send it to Telegram
# Usage: ./scripts/imagine.sh "prompt" [chat_id]
#
# Reads GEMINI_API_KEY, TELEGRAM_BOT_TOKEN from .env
# If chat_id is not provided, falls back to $TELEGRAM_CHAT_ID env var,
# then to the first entry in ALLOWED_CHAT_IDS from .env.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE" >&2
  exit 1
fi

# Read config from .env
GEMINI_KEY=$(grep '^GEMINI_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
MODEL=$(grep '^GEMINI_IMAGE_MODEL=' "$ENV_FILE" | cut -d= -f2- || true)
MODEL="${MODEL:-gemini-3.1-flash-image-preview}"

if [ -z "$GEMINI_KEY" ]; then
  echo "Error: GEMINI_API_KEY not set in .env" >&2
  exit 1
fi

if [ -z "$BOT_TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN not set in .env" >&2
  exit 1
fi

PROMPT="${1:?Usage: imagine.sh \"prompt\" [chat_id]}"

# Resolve chat_id: arg > env var > first ALLOWED_CHAT_IDS
CHAT_ID="${2:-${TELEGRAM_CHAT_ID:-}}"
if [ -z "$CHAT_ID" ]; then
  CHAT_ID=$(grep '^ALLOWED_CHAT_IDS=' "$ENV_FILE" | cut -d= -f2- | cut -d, -f1 | tr -d ' ')
fi

if [ -z "$CHAT_ID" ]; then
  echo "Error: No chat_id provided and ALLOWED_CHAT_IDS not set" >&2
  exit 1
fi

# Build JSON payload safely with python3
JSON_BODY=$(python3 -c "
import json, sys
prompt = sys.argv[1]
body = {
    'contents': [{'parts': [{'text': prompt}]}],
    'generationConfig': {'responseModalities': ['TEXT', 'IMAGE']}
}
print(json.dumps(body))
" "$PROMPT")

# Call Gemini REST API
RESPONSE=$(curl -s -w '\n%{http_code}' \
  "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}" \
  -H 'Content-Type: application/json' \
  -d "$JSON_BODY")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
  # Extract error message safely
  ERR_MSG=$(python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    msg = data.get('error', {}).get('message', 'Unknown error')
    print(msg[:200])
except:
    print('HTTP $HTTP_CODE')
" <<< "$BODY" 2>/dev/null || echo "HTTP ${HTTP_CODE}")
  echo "Gemini API error: ${ERR_MSG}" >&2
  exit 1
fi

# Extract image from response and save to temp file
TMPFILE=$(mktemp /tmp/imagine-XXXXXX.png)
CAPTION=$(python3 -c "
import json, sys, base64
data = json.loads(sys.stdin.read())
candidates = data.get('candidates', [])
if not candidates:
    print('NO_IMAGE', file=sys.stderr)
    sys.exit(1)
parts = candidates[0].get('content', {}).get('parts', [])
text_parts = []
image_saved = False
for part in parts:
    if 'inlineData' in part and not image_saved:
        img = base64.b64decode(part['inlineData']['data'])
        with open(sys.argv[1], 'wb') as f:
            f.write(img)
        image_saved = True
    elif 'text' in part:
        text_parts.append(part['text'])
if not image_saved:
    print('NO_IMAGE', file=sys.stderr)
    sys.exit(1)
# Print caption (if any) to stdout
if text_parts:
    print(' '.join(text_parts)[:1024])
" "$TMPFILE" <<< "$BODY" 2>/dev/null)

EXTRACT_STATUS=$?
if [ $EXTRACT_STATUS -ne 0 ]; then
  rm -f "$TMPFILE"
  echo "Gemini returned no image. Try a different prompt." >&2
  exit 1
fi

# Send to Telegram via sendPhoto
if [ -n "$CAPTION" ]; then
  SEND_RESULT=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto" \
    -F "chat_id=${CHAT_ID}" \
    -F "photo=@${TMPFILE}" \
    -F "caption=${CAPTION}")
else
  SEND_RESULT=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto" \
    -F "chat_id=${CHAT_ID}" \
    -F "photo=@${TMPFILE}")
fi

rm -f "$TMPFILE"

# Check Telegram API response
OK=$(python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('ok', False))" <<< "$SEND_RESULT" 2>/dev/null || echo "False")

if [ "$OK" = "True" ]; then
  echo "Image generated and sent to chat ${CHAT_ID}"
else
  echo "Image generated but failed to send to Telegram" >&2
  exit 1
fi
