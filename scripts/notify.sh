#!/usr/bin/env bash
# Send a Telegram message from the command line
# Usage: ./scripts/notify.sh "Your message here"
#
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_IDS from .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE" >&2
  exit 1
fi

# shellcheck source=/dev/null
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT_IDS=$(grep '^ALLOWED_CHAT_IDS=' "$ENV_FILE" | cut -d= -f2-)

if [ -z "$TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN not set in .env" >&2
  exit 1
fi

if [ -z "$CHAT_IDS" ]; then
  echo "Error: ALLOWED_CHAT_IDS not set in .env" >&2
  exit 1
fi

MESSAGE="${1:?Usage: notify.sh \"message\"}"

# Send to all allowed chat IDs
IFS=',' read -ra IDS <<< "$CHAT_IDS"
for CHAT_ID in "${IDS[@]}"; do
  CHAT_ID=$(echo "$CHAT_ID" | tr -d ' ')
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${MESSAGE}" \
    --data-urlencode "parse_mode=HTML" > /dev/null
  echo "Sent to ${CHAT_ID}"
done
