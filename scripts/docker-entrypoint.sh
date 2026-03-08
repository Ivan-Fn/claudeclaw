#!/bin/bash
# Docker entrypoint: configure git/gh then start the bot
set -euo pipefail

# Git identity (from env or defaults)
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
