#!/bin/bash
# Bootstrap global skills for Claude Code agents.
# Run once per machine. Idempotent -- safe to re-run.
#
# Installs:
#   - agent-browser CLI (npm global) + Chromium
#   - agent-browser skill (vercel-labs) -> ~/.claude/skills/
#   - skill-creator skill (anthropics) -> ~/.claude/skills/
#
# Usage:
#   bash scripts/setup-global-skills.sh
#   npm run setup:skills

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

echo ""
echo "=== Global Skills Bootstrap ==="
echo ""

# 1. agent-browser CLI
if command -v agent-browser &>/dev/null; then
  info "agent-browser CLI already installed ($(agent-browser --version 2>/dev/null || echo 'unknown version'))"
else
  echo "Installing agent-browser CLI..."
  npm install -g agent-browser
  info "agent-browser CLI installed"
fi

# 2. Chromium for agent-browser
if [ -d "$HOME/.cache/ms-playwright" ] || [ -d "$HOME/Library/Caches/ms-playwright" ]; then
  info "Chromium already installed"
else
  echo "Installing Chromium browser..."
  agent-browser install
  info "Chromium installed"
fi

# 3. Global skills via npx skills
# Check if skills are already installed by looking for symlinks
SKILLS_DIR="$HOME/.claude/skills"
MISSING_SKILLS=()

if [ ! -L "$SKILLS_DIR/agent-browser" ] && [ ! -d "$SKILLS_DIR/agent-browser" ]; then
  MISSING_SKILLS+=("agent-browser")
fi

if [ ! -L "$SKILLS_DIR/skill-creator" ] && [ ! -d "$SKILLS_DIR/skill-creator" ]; then
  MISSING_SKILLS+=("skill-creator")
fi

if [ ${#MISSING_SKILLS[@]} -eq 0 ]; then
  info "Global skills already installed (agent-browser, skill-creator)"
else
  echo "Installing global skills: ${MISSING_SKILLS[*]}"

  # Install agent-browser skill (includes dogfood as bonus)
  if [[ " ${MISSING_SKILLS[*]} " =~ " agent-browser " ]]; then
    echo "  -> vercel-labs/agent-browser..."
    npx -y skills add vercel-labs/agent-browser \
      --yes --global \
      --skill agent-browser --skill dogfood \
      --agent claude-code 2>&1 | tail -5
  fi

  # Install skill-creator
  if [[ " ${MISSING_SKILLS[*]} " =~ " skill-creator " ]]; then
    echo "  -> anthropics/skills (skill-creator)..."
    npx -y skills add anthropics/skills \
      --yes --global \
      --skill skill-creator \
      --agent claude-code 2>&1 | tail -5
  fi

  info "Global skills installed"
fi

echo ""
echo "=== Installed Global Skills ==="
ls -1 "$SKILLS_DIR" 2>/dev/null | while read -r name; do
  if [ -L "$SKILLS_DIR/$name" ] || [ -d "$SKILLS_DIR/$name" ]; then
    echo "  - $name"
  fi
done
echo ""
info "Done. Global skills are available to all Claude Code sessions on this machine."
