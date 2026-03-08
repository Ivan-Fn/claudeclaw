# ClaudeClaw Agent - Docker Image
# Used by autonomous coding bots (Mode B: Docker)
# Build from the claudeclaw repo root:
#   docker build -f ../master-agent/docker/Dockerfile -t claudeclaw-agent:latest .

FROM node:24-slim

# System deps (iptables/ipset included for future Phase 4 firewall)
RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl jq sudo \
  iptables ipset iproute2 dnsutils \
  zsh openssh-client python3 \
  build-essential python3-dev \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Non-root user
ARG USERNAME=agent
RUN useradd -m -s /bin/zsh $USERNAME \
  && echo "$USERNAME ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/agent-firewall

# Claude Code CLI (agent SDK runtime)
RUN npm install -g @anthropic-ai/claude-code@latest

# Bot runtime
WORKDIR /bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled bot code
COPY dist/ ./dist/
COPY scripts/ ./scripts/

# Config directories
RUN mkdir -p /home/agent/.claude /repos /bot/store /shared \
  && chown -R agent:agent /home/agent /bot/store /repos /shared

USER agent
WORKDIR /bot

ENTRYPOINT ["/bot/scripts/docker-entrypoint.sh"]
