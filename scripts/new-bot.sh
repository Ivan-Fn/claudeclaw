#!/bin/bash
# Generate config files for a new ClaudeClaw Docker bot
# Source: claudeclaw/scripts/new-bot.sh
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <agent-name> [options]

Options:
  --config-dir <path>   Target config repo directory (default: current directory)
  --vault <name>        1Password vault name (default: derived from agent prefix or "bots")
  --display-name <name> Human-readable name (default: derived from agent name)
  --setup-op            Create empty 1Password items for the agent
  --copy-launcher       Copy start-agent.sh into the config directory

Examples:
  $(basename "$0") sv0-foxtrot --config-dir ~/dev/securityv0/sv0-claws/docker
  $(basename "$0") master-aux --config-dir ~/dev/claw/claw-master/docker --vault claw-bots
  $(basename "$0") sv0-foxtrot --config-dir . --setup-op --copy-launcher
EOF
  exit 1
}

# ── Parse args ──────────────────────────────────────────────────────────
AGENT_NAME=""
CONFIG_DIR="."
OP_VAULT=""
DISPLAY_NAME=""
SETUP_OP=false
COPY_LAUNCHER=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --config-dir)  CONFIG_DIR="$2"; shift 2 ;;
    --vault)       OP_VAULT="$2"; shift 2 ;;
    --display-name) DISPLAY_NAME="$2"; shift 2 ;;
    --setup-op)    SETUP_OP=true; shift ;;
    --copy-launcher) COPY_LAUNCHER=true; shift ;;
    --help|-h)     usage ;;
    -*)            echo "Unknown option: $1"; usage ;;
    *)
      if [[ -z "$AGENT_NAME" ]]; then
        AGENT_NAME="$1"; shift
      else
        echo "Unexpected argument: $1"; usage
      fi
      ;;
  esac
done

[[ -z "$AGENT_NAME" ]] && usage

# ── Derive defaults ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="${SCRIPT_DIR}/../docker/templates"

if [[ -z "$DISPLAY_NAME" ]]; then
  # sv0-foxtrot -> Foxtrot, master-aux -> Aux
  DISPLAY_NAME=$(echo "$AGENT_NAME" | sed 's/.*-//' | sed 's/./\U&/')
fi

if [[ -z "$OP_VAULT" ]]; then
  # sv0-foxtrot -> sv0-bots, master-aux -> master-bots, plain-name -> bots
  PREFIX=$(echo "$AGENT_NAME" | sed 's/-[^-]*$//')
  if [[ "$PREFIX" == "$AGENT_NAME" ]]; then
    OP_VAULT="bots"
  else
    OP_VAULT="${PREFIX}-bots"
  fi
fi

# Query latest stable release tag from GitHub releases (fall back to "edge" if none)
PINNED_TAG="edge"
if command -v gh &>/dev/null; then
  LATEST_TAG=$(gh release list --repo ivan-fn/claudeclaw --limit 1 \
    --json tagName --jq '.[0].tagName // empty' 2>/dev/null || true)
  if [[ -n "$LATEST_TAG" && "$LATEST_TAG" != "null" ]]; then
    PINNED_TAG="$LATEST_TAG"
  fi
fi

# ── Validate ────────────────────────────────────────────────────────────
if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo "Error: Template directory not found at $TEMPLATE_DIR"
  echo "Run this script from the claudeclaw repo."
  exit 1
fi

CONFIG_DIR=$(cd "$CONFIG_DIR" && pwd)
AGENT_DIR="${CONFIG_DIR}/agents/${AGENT_NAME}"

if [[ -d "$AGENT_DIR" ]]; then
  echo "Error: Agent directory already exists: $AGENT_DIR"
  exit 1
fi

# ── Generate files ──────────────────────────────────────────────────────
substitute() {
  sed -e "s|{{AGENT_NAME}}|${AGENT_NAME}|g" \
      -e "s|{{AGENT_DISPLAY_NAME}}|${DISPLAY_NAME}|g" \
      -e "s|{{OP_VAULT}}|${OP_VAULT}|g" \
      -e "s|{{PINNED_TAG}}|${PINNED_TAG}|g" \
      "$1"
}

mkdir -p "$AGENT_DIR"

substitute "$TEMPLATE_DIR/CLAUDE.md.tmpl" > "$AGENT_DIR/CLAUDE.md"
substitute "$TEMPLATE_DIR/settings.json.tmpl" > "$AGENT_DIR/settings.json"
substitute "$TEMPLATE_DIR/op-env.tmpl" > "$AGENT_DIR/op-env"
substitute "$TEMPLATE_DIR/docker-compose.tmpl.yml" > "$CONFIG_DIR/docker-compose.${AGENT_NAME}.yml"

# ── Copy launcher if requested ──────────────────────────────────────────
if [[ "$COPY_LAUNCHER" == true ]]; then
  LAUNCHER_SRC="${SCRIPT_DIR}/start-agent.sh"
  if [[ -f "$LAUNCHER_SRC" ]]; then
    cp "$LAUNCHER_SRC" "$CONFIG_DIR/start-agent.sh"
    chmod +x "$CONFIG_DIR/start-agent.sh"
    echo "Copied start-agent.sh to $CONFIG_DIR/"
  else
    echo "Warning: start-agent.sh not found at $LAUNCHER_SRC"
  fi
fi

# ── Create 1Password items if requested ─────────────────────────────────
if [[ "$SETUP_OP" == true ]]; then
  if ! command -v op &>/dev/null; then
    echo "Warning: op CLI not found, skipping 1Password setup"
  else
    echo "Creating 1Password items in vault '${OP_VAULT}'..."
    op item create --vault "$OP_VAULT" \
      --title "${AGENT_NAME}-telegram" \
      --category login \
      --generate-password=false 2>/dev/null && echo "  Created ${AGENT_NAME}-telegram" || echo "  Skipped ${AGENT_NAME}-telegram (may already exist)"
    op item create --vault "$OP_VAULT" \
      --title "${AGENT_NAME}-github-pat" \
      --category login \
      --generate-password=false 2>/dev/null && echo "  Created ${AGENT_NAME}-github-pat" || echo "  Skipped ${AGENT_NAME}-github-pat (may already exist)"
    op item create --vault "$OP_VAULT" \
      --title "${AGENT_NAME}-config" \
      --category login 2>/dev/null && echo "  Created ${AGENT_NAME}-config" || echo "  Skipped ${AGENT_NAME}-config (may already exist)"
  fi
fi

# ── Report ──────────────────────────────────────────────────────────────
cat <<EOF

Generated files:
  ${AGENT_DIR}/CLAUDE.md
  ${AGENT_DIR}/settings.json
  ${AGENT_DIR}/op-env
  ${CONFIG_DIR}/docker-compose.${AGENT_NAME}.yml

Image pinned to: ${PINNED_TAG}
1Password vault: ${OP_VAULT}

Manual steps remaining:
  1. Create Telegram bot via @BotFather, get token
  2. Create 1Password items (if not using --setup-op):
       op item create --vault ${OP_VAULT} --title ${AGENT_NAME}-telegram --category login
       op item create --vault ${OP_VAULT} --title ${AGENT_NAME}-github-pat --category login
       op item create --vault ${OP_VAULT} --title ${AGENT_NAME}-config --category login
  3. Fill in 1Password items with real values (Telegram token, GitHub PAT, allowed chat IDs)
  4. Edit agents/${AGENT_NAME}/CLAUDE.md with agent personality
  5. Edit docker-compose.${AGENT_NAME}.yml to add repo volume mounts
  6. Run: ./start-agent.sh ${AGENT_NAME}
EOF
