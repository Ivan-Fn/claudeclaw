# Running ClaudeClaw in Docker

Run autonomous AI agents in isolated Docker containers. Each agent gets its own Telegram bot, GitHub token, and resource limits while sharing a single Docker image from GHCR.

## When to use Docker mode

Docker mode is designed for **autonomous coding agents** -- bots that work on git repositories, create branches, and open PRs. The container isolates the agent so it can only access explicitly mounted repos and paths.

For a personal assistant bot (the default use case), running directly on the host with `npm run dev` or launchd is simpler. See the main README for that setup.

## Architecture

```
GHCR (public)
  ghcr.io/ivan-fn/claudeclaw-agent
    :v1.0.0                   Stable release (pin bots here)
    :edge                     Latest main build (testing only)
    :sha-abc1234              Commit-level builds

Host machine
  +--> Docker runtime (Colima, Docker Desktop, etc.)
  |      +--> agent-1 container   @my_first_bot   (pinned to v1.0.0)
  |      +--> agent-2 container   @my_second_bot  (pinned to v1.0.0)
  |
  +--> Config repo (private)
  |      +--> agents/agent-1/   (CLAUDE.md, settings.json, op-env)
  |      +--> agents/agent-2/
  |      +--> docker-compose.agent-1.yml
  |      +--> start-agent.sh
  |
  +--> Git repos (bind-mounted into containers)
```

## Quick Start

### 1. Pull the image

```bash
docker pull ghcr.io/ivan-fn/claudeclaw-agent:v1.0.0
```

Or build locally for development:

```bash
npm run build
docker build -t ghcr.io/ivan-fn/claudeclaw-agent:local .
```

### 2. Generate agent config

```bash
# From the claudeclaw repo
./scripts/new-bot.sh my-agent \
  --config-dir ~/my-project/docker \
  --vault my-bots \
  --copy-launcher
```

This creates all config files from templates. Edit them:
- **CLAUDE.md** -- agent personality and constraints
- **settings.json** -- Claude Code tool deny rules
- **op-env** -- 1Password secret references
- **docker-compose.yml** -- volume mounts for your repos

### 3. Set up secrets

Create 1Password items (or use `--setup-op` flag with `new-bot.sh`):

```bash
op item create --vault my-bots --title my-agent-telegram --category login
op item create --vault my-bots --title my-agent-github-pat --category login
op item create --vault my-bots --title my-agent-config --category login
```

Fill in: Telegram token (from BotFather), GitHub PAT, allowed chat IDs.

### 4. Generate an OAuth token

```bash
docker run --rm -it --entrypoint bash ghcr.io/ivan-fn/claudeclaw-agent:v1.0.0
# Inside the container:
claude setup-token
```

Store the token in 1Password as `claude-oauth` with field `oauth-token`.

### 5. Launch

```bash
cd ~/my-project/docker
./start-agent.sh my-agent
```

## Updating Bots

When a new claudeclaw release is published:

```bash
# Update all bots in a config repo to a new version
./scripts/update-bots.sh --tag v1.1.0 --config-dir ~/my-project/docker

# Update specific bots only
./scripts/update-bots.sh --tag v1.1.0 --config-dir ~/my-project/docker my-agent

# Pin the version in compose files (tag + digest, for git history)
./scripts/update-bots.sh --tag v1.1.0 --pin --config-dir ~/my-project/docker

# Override image at runtime without changing compose files
IMAGE_TAG=edge ./start-agent.sh my-agent
```

## Container Filesystem

```
/bot/                   Bot code (baked into image, read-only)
  dist/                 Compiled JS
  scripts/              Entrypoint, notify
  store/                SQLite DB           <-- Docker volume (persists)
  CLAUDE.md             Agent personality   <-- bind mount (read-only)

/repos/                 Git repositories    <-- bind mount from host (read-write)
  repo1/
  repo2/

/home/agent/.claude/    Claude CLI state    <-- Docker volume (persists)
  settings.json         Tool deny rules     <-- bind mount (read-only)
```

**Repos are bind-mounted, not cloned.** The agent works directly on host repos via mount. Branch changes are visible on both sides.

**Persistent volumes** survive `docker compose down`. They only disappear with explicit `docker volume rm`.

## Safety Controls

Three layers of protection:

1. **CLAUDE.md constraints** -- agent personality with hard rules (never push to main, never merge PRs)
2. **settings.json deny rules** -- Claude Code blocks tool patterns at the SDK level
3. **Docker isolation** -- container can only access explicitly mounted paths

## Templates

Templates live in `docker/templates/`. The `new-bot.sh` script substitutes placeholders:

| Placeholder | Description |
|-------------|-------------|
| `{{AGENT_NAME}}` | Agent identifier (e.g. `sv0-echo`) |
| `{{AGENT_DISPLAY_NAME}}` | Human-readable name (e.g. `Echo`) |
| `{{OP_VAULT}}` | 1Password vault name |
| `{{PINNED_TAG}}` | Latest stable release tag at generation time |

## Config Repo Structure

Each project that uses ClaudeClaw bots keeps configs in a private repo:

```
my-project-bots/
  docker/
    agents/
      bot-1/          CLAUDE.md, settings.json, op-env
      bot-2/
    docker-compose.bot-1.yml
    docker-compose.bot-2.yml
    start-agent.sh    (copied from claudeclaw)
```

## Debugging

```bash
# Live logs
docker compose -f docker-compose.my-agent.yml logs -f

# Shell into running container
docker exec -it my-agent zsh

# Check env vars (non-secret)
docker exec my-agent env | grep -E 'BOT_|AGENT_' | sort

# Check git config
docker exec my-agent git config --global --list

# Check GitHub auth
docker exec my-agent gh auth status

# Container health
docker inspect my-agent --format='{{.State.Health.Status}}'

# Resource usage
docker stats my-agent --no-stream
```

## Notes

- **Image versioning**: Always pin bots to a release tag (e.g. `v1.0.0`). Use `edge` only for testing. Never run production bots on a mutable tag.
- **Shared repos**: Agents always create feature branches, never touch your working branch.
- **OAuth token expiry**: Regenerate with `claude setup-token` inside the container when it expires.
- **macOS + Colima**: virtiofs maps host files as the container user automatically.
- **Claude Code CLI**: Always installs `@latest` to stay current with the fast-moving ecosystem. Image tags provide rollback if a CLI update causes issues.
