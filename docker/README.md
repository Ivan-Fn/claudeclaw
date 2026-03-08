# Running ClaudeClaw in Docker

Run autonomous AI agents in isolated Docker containers. Each agent gets its own Telegram bot, GitHub token, and resource limits while sharing a single Docker image.

## When to use Docker mode

Docker mode is designed for **autonomous coding agents** -- bots that work on git repositories, create branches, and open PRs. The container isolates the agent so it can only access explicitly mounted repos and paths.

For a personal assistant bot (the default use case), running directly on the host with `npm run dev` or launchd is simpler. See the main README for that setup.

## Architecture

```
Host machine
  |
  +--> Docker runtime (Docker Desktop, Colima, etc.)
  |      |
  |      +--> agent-1 (container)     @my_first_bot
  |      +--> agent-2 (container)     @my_second_bot
  |
  +--> Secrets backend (1Password, SOPS, plain .env, etc.)
  |
  +--> Git repos (bind-mounted into containers)
```

## Quick Start

### 1. Build the image

From the claudeclaw repo root:

```bash
npm run build
docker build -t claudeclaw-agent:latest .
```

### 2. Set up agent config

```bash
# Copy the example templates
mkdir -p my-deployment/agents/my-agent
cp docker/agents/example/CLAUDE.md.example my-deployment/agents/my-agent/CLAUDE.md
cp docker/agents/example/settings.json.example my-deployment/agents/my-agent/settings.json
cp docker/agents/example/env.example my-deployment/agents/my-agent/.env
cp docker/docker-compose.example.yml my-deployment/docker-compose.my-agent.yml
cp docker/start-agent.example.sh my-deployment/start-agent.sh
chmod +x my-deployment/start-agent.sh
```

Edit the copied files:
- **CLAUDE.md** -- agent personality and constraints
- **settings.json** -- Claude Code tool deny rules (e.g., block `git push --force`)
- **.env** or **op-env** -- secrets (Telegram token, OAuth token, GitHub PAT)
- **docker-compose.yml** -- volume mounts for your repos

### 3. Generate an OAuth token

The agent needs a Claude Code OAuth token for headless auth:

```bash
docker run --rm -it --entrypoint bash claudeclaw-agent:latest
# Inside the container:
claude setup-token
```

Copy the generated token into your env file as `CLAUDE_CODE_OAUTH_TOKEN`.

### 4. Launch

```bash
cd my-deployment
./start-agent.sh my-agent
```

## Container Filesystem

```
/bot/                   Bot code (baked into image, read-only)
  dist/                 Compiled JS
  scripts/              Entrypoint, notify
  store/                SQLite DB           <-- Docker volume (persists)
  CLAUDE.md             Agent personality   <-- bind mount (read-only)

/repos/                 Git repositories    <-- bind mount from host (read-write)
  repo1/                Your first repo
  repo2/                Your second repo

/home/agent/.claude/    Claude CLI state    <-- Docker volume (persists)
  settings.json         Tool deny rules     <-- bind mount (read-only)
```

**Repos are bind-mounted, not cloned.** The agent works directly on host repos via mount. Branch changes are visible on both sides.

**Persistent volumes** survive `docker compose down`. They only disappear with explicit `docker volume rm`.

## Entrypoint

On startup, `scripts/docker-entrypoint.sh` runs before the bot:

1. Sets `git config` (user.name, user.email) from env vars
2. Runs `gh auth setup-git` so `git push` uses `GH_TOKEN`
3. Marks all repos under `/repos/` as `safe.directory`
4. Starts `node dist/index.js`

## Secrets Management

The example `start-agent.sh` supports three backends:

### 1Password (default)

Store secrets as `op://vault/item/field` references in an `op-env` file. The launcher resolves them at startup via `op run`, writes a temp `.env.resolved`, and deletes it after Docker reads it.

```
# agents/my-agent/op-env
TELEGRAM_BOT_TOKEN=op://my-vault/my-agent-telegram/token
CLAUDE_CODE_OAUTH_TOKEN=op://my-vault/claude-oauth/oauth-token
```

Requires: `op` CLI + a service account token at `~/.config/op/shared.token`.

### SOPS

Encrypt your env file with `sops encrypt agents/my-agent/.env > secrets/my-agent.enc.env`. The launcher decrypts to a temp file at startup.

### Plain .env

Just fill in `agents/my-agent/.env` directly. Do NOT commit this file.

## Resource Limits

Each container is capped at (configurable in compose file):

- **Memory:** 2GB
- **CPU:** 1.5 cores
- **Shared memory:** 256MB

## Safety Controls

Three layers of protection:

1. **CLAUDE.md constraints** -- agent personality with hard rules (never push to main, never merge PRs)
2. **settings.json deny rules** -- Claude Code blocks tool patterns at the SDK level
3. **Docker isolation** -- container can only access explicitly mounted paths

## Rebuilding the Image

When the bot code changes:

```bash
cd /path/to/claudeclaw
git pull
npm install && npm run build
docker build -t claudeclaw-agent:latest .
```

Then restart running agents:

```bash
docker compose -f docker-compose.my-agent.yml down
./start-agent.sh my-agent
```

## Adding a New Agent

1. Create agent config directory with CLAUDE.md, settings.json, env file
2. Create a docker-compose file (copy from example, update volume mounts)
3. Store secrets in your backend
4. Run `./start-agent.sh <agent-name>`

See `agents/example/` for templates.

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

- **Shared repos**: If you're working on a repo on the host while an agent modifies it in Docker, you may see unexpected branches. Agents should always create feature branches, never touch your working branch.
- **Image rebuild required**: Code changes to claudeclaw require rebuilding the Docker image. Agents don't `git pull` the bot code -- it's baked in.
- **OAuth token expiry**: Regenerate with `claude setup-token` inside the container when it expires.
- **macOS + Colima**: virtiofs maps host files as the container user automatically, so file permissions work transparently.
