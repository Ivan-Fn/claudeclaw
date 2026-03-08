#!/bin/bash
# Start a ClaudeClaw agent in Docker
# Usage: ./start-agent.sh <agent-name>
#
# This example uses 1Password for secret management.
# Adapt for your preferred secrets backend (SOPS, Vault, plain .env, etc.)
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

# ── Option 1: 1Password ──────────────────────────────────────────────
# Requires: `op` CLI + a service account token
TOKEN_FILE="$HOME/.config/op/${AGENT}.token"
SHARED_TOKEN_FILE="$HOME/.config/op/shared.token"
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

TMPENV=$(mktemp /dev/shm/agent-env.XXXXXX 2>/dev/null || mktemp /tmp/agent-env.XXXXXX)
trap "rm -f $TMPENV" EXIT
op run --no-masking --env-file "agents/${AGENT}/op-env" -- env \
  | grep -E '^(TELEGRAM_|CLAUDE_|GH_|GIT_|ALLOWED_|AGENT_|BOT_|ANTHROPIC_|MAX_)' \
  > "$TMPENV"

# ── Option 2: SOPS (commented out) ───────────────────────────────────
# sops decrypt "secrets/${AGENT}.enc.env" > "$TMPENV"

# ── Option 3: Plain .env (commented out) ─────────────────────────────
# cp "agents/${AGENT}/.env" "$TMPENV"

chmod 600 "$TMPENV"
cp "$TMPENV" "${SCRIPT_DIR}/.env.resolved"
chmod 600 "${SCRIPT_DIR}/.env.resolved"

echo "Starting ${AGENT} in Docker..."
docker compose -f "$COMPOSE_FILE" up -d

rm -f "${SCRIPT_DIR}/.env.resolved"
echo "${AGENT} started. Check logs: docker compose -f ${COMPOSE_FILE} logs -f"
