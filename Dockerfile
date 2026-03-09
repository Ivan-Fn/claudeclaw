# ClaudeClaw Agent - Docker Image
# Used by autonomous coding bots (Mode B: Docker)
# Build from the claudeclaw repo root:
#   docker build -f ../master-agent/docker/Dockerfile -t claudeclaw-agent:latest .

FROM node:24-slim

# System deps (iptables/ipset included for future Phase 4 firewall)
RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl jq sudo ca-certificates unzip openssl \
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

# 1Password CLI (for resolving secrets at container start)
RUN ARCH=$(dpkg --print-architecture) \
  && curl -fsSL "https://cache.agilebits.com/dist/1P/op2/pkg/v2.32.1/op_linux_${ARCH}_v2.32.1.zip" -o /tmp/op.zip \
  && unzip /tmp/op.zip -d /usr/local/bin/ op \
  && chmod +x /usr/local/bin/op \
  && rm /tmp/op.zip

# Non-root user
ARG USERNAME=agent
RUN useradd -m -s /bin/zsh $USERNAME \
  && echo "$USERNAME ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/agent-firewall

# Claude Code CLI (agent SDK runtime)
# Always latest -- this space moves too fast to pin
RUN npm install -g @anthropic-ai/claude-code@latest

# Excalidraw: Playwright + Chromium for diagram rendering (~700-800MB)
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && pip install --break-system-packages playwright \
    && playwright install chromium --with-deps \
    && chmod -R o+rx $PLAYWRIGHT_BROWSERS_PATH

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
