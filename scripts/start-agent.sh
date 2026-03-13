#!/bin/bash
# Start a ClaudeClaw agent in Docker
# Source: claudeclaw/scripts/start-agent.sh v1.0.0
#
# Usage: ./start-agent.sh <agent-name>
#   IMAGE_TAG=v1.2.0 ./start-agent.sh <agent-name>   # override image version
#
# Requires: 1Password CLI (op) + service account token
set -euo pipefail

AGENT=${1:?Usage: ./start-agent.sh <agent-name>}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Validate agent config exists
if [ ! -f "agents/${AGENT}/op-env" ]; then
  echo "Error: agents/${AGENT}/op-env not found"
  exit 1
fi

COMPOSE_FILE="docker-compose.${AGENT}.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Error: ${COMPOSE_FILE} not found"
  exit 1
fi

# ── 1Password secret resolution ────────────────────────────────────────
# Per-agent token takes priority, then shared token
TOKEN_FILE="$HOME/.config/op/${AGENT}.token"
SHARED_TOKEN_FILE="$HOME/.config/op/sv0-shared.token"
if [ -f "$TOKEN_FILE" ]; then
  export OP_SERVICE_ACCOUNT_TOKEN=$(cat "$TOKEN_FILE")
elif [ -f "$SHARED_TOKEN_FILE" ]; then
  export OP_SERVICE_ACCOUNT_TOKEN=$(cat "$SHARED_TOKEN_FILE")
else
  echo "Error: No 1Password token found."
  echo "Place a shared token at: ${SHARED_TOKEN_FILE}"
  echo "Or a per-agent token at: ${TOKEN_FILE}"
  exit 1
fi

# Resolve op:// references to real values via tmpfs (RAM only)
TMPENV=$(mktemp /dev/shm/agent-env.XXXXXX 2>/dev/null || mktemp /tmp/agent-env.XXXXXX)
trap "rm -f $TMPENV ${SCRIPT_DIR}/.env.resolved" EXIT
op run --no-masking --env-file "agents/${AGENT}/op-env" -- env \
  | grep -E '^(TELEGRAM_|CLAUDE_|GH_|GIT_|ALLOWED_|AGENT_|BOT_|ANTHROPIC_|MAX_)' \
  > "$TMPENV"
chmod 600 "$TMPENV"

# Write resolved env for docker compose (deleted on exit via trap)
cp "$TMPENV" "${SCRIPT_DIR}/.env.resolved"
chmod 600 "${SCRIPT_DIR}/.env.resolved"

# ── Launch ──────────────────────────────────────────────────────────────
# IMAGE_TAG env var is read by docker compose from the ${IMAGE_TAG:-...} in the compose file
export IMAGE_TAG="${IMAGE_TAG:-}"

echo "Starting ${AGENT} in Docker..."
if [ -n "$IMAGE_TAG" ]; then
  echo "  Image override: IMAGE_TAG=${IMAGE_TAG}"
fi
docker compose -f "$COMPOSE_FILE" up -d

echo "${AGENT} started. Check logs: docker compose -f ${COMPOSE_FILE} logs -f"
