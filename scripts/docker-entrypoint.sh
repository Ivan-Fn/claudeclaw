#!/bin/bash
# Docker entrypoint: resolve secrets from 1Password, configure git/gh, start the bot
set -euo pipefail

# ── Resolve secrets from 1Password ────────────────────────────────────
# If OP_SERVICE_ACCOUNT_TOKEN and op-env file are available, resolve
# op:// references to real values. This runs on every container start,
# so crash-restarts always get fresh tokens.
OP_ENV_FILE="/bot/op-env"
OP_TOKEN_FILE="/bot/.op-token"
# Read OP token from mounted file if not already in env
if [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] && [ -f "$OP_TOKEN_FILE" ]; then
  export OP_SERVICE_ACCOUNT_TOKEN=$(cat "$OP_TOKEN_FILE")
fi
if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] && [ -f "$OP_ENV_FILE" ]; then
  echo "Resolving secrets from 1Password..."
  # op run resolves op:// URIs and exports them into the environment
  # We eval the resolved env vars so they're available to the bot process
  # Note: GITHUB_APP_PRIVATE_KEY (multiline PEM) is handled separately below
  eval "$(op run --no-masking --env-file "$OP_ENV_FILE" -- env \
    | grep -E '^(TELEGRAM_|CLAUDE_|GH_|GIT_|ALLOWED_|AGENT_|BOT_|ANTHROPIC_|MAX_|GITHUB_APP_ID=|GITHUB_APP_INSTALLATION_ID=)' \
    | sed 's/"/\\"/g; s/=\(.*\)/="\1"/' \
    | sed 's/^/export /')"
  echo "Secrets resolved."
else
  echo "No 1Password config found, using existing env vars."
fi

# ── GitHub App authentication ──────────────────────────────────────────
# If GITHUB_APP_ID is set (and no GH_TOKEN from PAT), generate an
# installation token from the GitHub App private key stored in 1Password.
if [ -n "${GITHUB_APP_ID:-}" ] && [ -n "${GITHUB_APP_INSTALLATION_ID:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
  echo "GitHub App credentials found, generating installation token..."

  # Extract the private key separately -- can't go through eval pipeline (multiline).
  # Stored in 1Password as base64 (single line, no newline issues).
  # Decode it to a PEM file for openssl.
  GITHUB_APP_PRIVATE_KEY_FILE="/tmp/github-app-key.pem"
  if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] && [ -f "$OP_ENV_FILE" ] \
     && grep -q 'GITHUB_APP_PRIVATE_KEY' "$OP_ENV_FILE" 2>/dev/null; then
    op run --no-masking --env-file "$OP_ENV_FILE" -- \
      bash -c 'printf "%s" "$GITHUB_APP_PRIVATE_KEY" | base64 -d' > "$GITHUB_APP_PRIVATE_KEY_FILE" 2>/dev/null || true
    chmod 600 "$GITHUB_APP_PRIVATE_KEY_FILE" 2>/dev/null || true
  fi

  if [ -f "$GITHUB_APP_PRIVATE_KEY_FILE" ] && [ -s "$GITHUB_APP_PRIVATE_KEY_FILE" ]; then
    # Build JWT: header.payload.signature (RS256)
    # Issued at: now-60s (clock skew buffer), expires: now+600s (10 min)
    NOW=$(date +%s)
    IAT=$((NOW - 60))
    EXP=$((NOW + 600))
    APP_ID="${GITHUB_APP_ID}"

    # Base64url encode (no padding)
    b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

    HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
    PAYLOAD=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$IAT" "$EXP" "$APP_ID" | b64url)
    SIGNING_INPUT="${HEADER}.${PAYLOAD}"
    SIGNATURE=$(printf '%s' "$SIGNING_INPUT" \
      | openssl dgst -sha256 -sign "$GITHUB_APP_PRIVATE_KEY_FILE" \
      | b64url)
    JWT="${SIGNING_INPUT}.${SIGNATURE}"

    # Exchange JWT for installation access token
    INSTALL_TOKEN=$(curl -sf \
      -X POST \
      -H "Authorization: Bearer ${JWT}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens" \
      | jq -r '.token // empty')

    if [ -n "${INSTALL_TOKEN:-}" ]; then
      export GH_TOKEN="$INSTALL_TOKEN"
      echo "GitHub App token generated (installation ${GITHUB_APP_INSTALLATION_ID})."
    else
      echo "WARNING: Failed to generate GitHub App installation token." >&2
    fi

    # Keep PEM file -- refreshGitHubAppToken() in agent.ts needs it to regenerate
    # the installation token every session (tokens expire after 1 hour).
    chmod 600 "$GITHUB_APP_PRIVATE_KEY_FILE" 2>/dev/null || true
  else
    echo "WARNING: GITHUB_APP_PRIVATE_KEY not found or empty, skipping App auth." >&2
  fi
fi

# ── Git identity ──────────────────────────────────────────────────────
git config --global user.name "${GIT_AUTHOR_NAME:-ClaudeClaw Bot}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-bot@claudeclaw.dev}"

# Configure gh CLI to handle git credentials (uses GH_TOKEN env var)
if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git 2>/dev/null || true
fi

# Mark mounted repos as safe directories
if [ -d /repos ]; then
  for repo in /repos/*/; do
    [ -d "$repo/.git" ] && git config --global --add safe.directory "$repo"
  done
fi

exec node dist/index.js
