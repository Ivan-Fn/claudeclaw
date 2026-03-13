#!/bin/bash
# Update ClaudeClaw Docker bots to a new image version
# Source: claudeclaw/scripts/update-bots.sh v1.0.0
#
# Usage:
#   ./update-bots.sh --tag v1.2.0                     # update all bots
#   ./update-bots.sh --tag v1.2.0 sv0-echo sv0-delta  # update specific bots
#   ./update-bots.sh --tag v1.2.0 --pin sv0-echo      # pin tag+digest in compose file
#   ./update-bots.sh --update-scripts                  # refresh start-agent.sh from claudeclaw
set -euo pipefail

IMAGE="ghcr.io/ivan-fn/claudeclaw-agent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options] [agent1 agent2 ...]

Options:
  --tag <version>       Image tag to deploy (e.g. v1.2.0, edge)
  --config-dir <path>   Config repo directory (default: current directory)
  --pin                 Write tag+digest into compose files and git commit
  --update-scripts      Copy latest start-agent.sh from claudeclaw
  --dry-run             Show what would happen without doing it
  -h, --help            Show this help
EOF
  exit 1
}

# ── Parse args ──────────────────────────────────────────────────────────
TAG=""
CONFIG_DIR="."
PIN=false
UPDATE_SCRIPTS=false
DRY_RUN=false
AGENTS=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --tag)             TAG="$2"; shift 2 ;;
    --config-dir)      CONFIG_DIR="$2"; shift 2 ;;
    --pin)             PIN=true; shift ;;
    --update-scripts)  UPDATE_SCRIPTS=true; shift ;;
    --dry-run)         DRY_RUN=true; shift ;;
    -h|--help)         usage ;;
    -*)                echo "Unknown option: $1"; usage ;;
    *)                 AGENTS+=("$1"); shift ;;
  esac
done

CONFIG_DIR=$(cd "$CONFIG_DIR" && pwd)

# ── Update scripts if requested ─────────────────────────────────────────
if [[ "$UPDATE_SCRIPTS" == true ]]; then
  CLAUDECLAW_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
  SRC="${CLAUDECLAW_DIR}/scripts/start-agent.sh"
  DST="${CONFIG_DIR}/start-agent.sh"
  if [[ -f "$SRC" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      echo "[dry-run] Would copy $SRC -> $DST"
    else
      cp "$SRC" "$DST"
      chmod +x "$DST"
      echo "Updated start-agent.sh from claudeclaw"
    fi
  else
    echo "Warning: start-agent.sh not found at $SRC"
  fi
  # If no tag specified, just updating scripts is all we do
  [[ -z "$TAG" ]] && exit 0
fi

[[ -z "$TAG" ]] && { echo "Error: --tag is required"; usage; }

# ── Discover agents if none specified ────────────────────────────────────
if [[ ${#AGENTS[@]} -eq 0 ]]; then
  for f in "$CONFIG_DIR"/docker-compose.*.yml; do
    [[ -f "$f" ]] || continue
    name=$(basename "$f" | sed 's/docker-compose\.\(.*\)\.yml/\1/')
    AGENTS+=("$name")
  done
fi

if [[ ${#AGENTS[@]} -eq 0 ]]; then
  echo "Error: No agents found in $CONFIG_DIR"
  exit 1
fi

echo "Target image: ${IMAGE}:${TAG}"
echo "Agents: ${AGENTS[*]}"
echo ""

# ── Pull the image ──────────────────────────────────────────────────────
if [[ "$DRY_RUN" == true ]]; then
  echo "[dry-run] Would pull ${IMAGE}:${TAG}"
else
  echo "Pulling ${IMAGE}:${TAG}..."
  docker pull "${IMAGE}:${TAG}"
fi

# ── Resolve digest for pinning ──────────────────────────────────────────
DIGEST=""
if [[ "$PIN" == true && "$DRY_RUN" != true ]]; then
  DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE}:${TAG}" 2>/dev/null \
    | sed "s|.*@||")
  if [[ -z "$DIGEST" ]]; then
    echo "Warning: Could not resolve digest for ${IMAGE}:${TAG}, pinning tag only"
  fi
fi

# ── Update each agent ───────────────────────────────────────────────────
for AGENT in "${AGENTS[@]}"; do
  COMPOSE_FILE="${CONFIG_DIR}/docker-compose.${AGENT}.yml"
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "  [skip] ${AGENT}: compose file not found"
    continue
  fi

  echo "Updating ${AGENT}..."

  if [[ "$DRY_RUN" == true ]]; then
    echo "  [dry-run] Would restart ${AGENT} with IMAGE_TAG=${TAG}"
    if [[ "$PIN" == true ]]; then
      echo "  [dry-run] Would pin image reference in ${COMPOSE_FILE}"
    fi
    continue
  fi

  # Pin image reference in compose file if requested
  if [[ "$PIN" == true ]]; then
    if [[ -n "$DIGEST" ]]; then
      PIN_REF="${IMAGE}:${TAG}@${DIGEST}"
    else
      PIN_REF="${IMAGE}:${TAG}"
    fi
    # Replace the image line in the compose file
    sed -i.bak "s|image:.*claudeclaw-agent.*|image: ${PIN_REF}|" "$COMPOSE_FILE"
    rm -f "${COMPOSE_FILE}.bak"
    echo "  Pinned to: ${PIN_REF}"
  fi

  # Restart the agent
  docker compose -f "$COMPOSE_FILE" down
  IMAGE_TAG="$TAG" "${CONFIG_DIR}/start-agent.sh" "$AGENT"
  echo "  ${AGENT} restarted with ${TAG}"
  echo ""
done

# ── Git commit if pinning ───────────────────────────────────────────────
if [[ "$PIN" == true && "$DRY_RUN" != true ]]; then
  cd "$CONFIG_DIR"
  if git diff --quiet 2>/dev/null; then
    echo "No compose file changes to commit."
  else
    echo ""
    echo "Compose files updated. To commit:"
    echo "  cd $CONFIG_DIR"
    echo "  git add docker-compose.*.yml"
    echo "  git commit -m 'chore: pin bots to ${TAG}'"
  fi
fi

echo ""
echo "Done. Check status: docker ps --filter 'ancestor=${IMAGE}'"
