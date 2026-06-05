# AFK worker image: Node + git + gh + jq + Claude Code CLI + Playwright(chromium) + skill-pack.
# Generic across projects — per-project deps install at sandbox start via afk.config.json "setup".
FROM node:22-bookworm

# System deps (jq is required by afk-gate.sh)
RUN apt-get update && apt-get install -y git curl jq \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (used by skills that read docs/issues if you grant it; not required by the gate)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Playwright + chromium with OS deps (root, before user switch). Pin to match your project's @playwright/test.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@1.50 install --with-deps chromium

# Align container user to the host user so bind-mounted files share an owner (sandcastle convention).
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Claude Code CLI (the agent runtime). Authenticated at runtime via CLAUDE_CODE_OAUTH_TOKEN.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

# Skill-pack — the skills the worker self-selects from (see .sandcastle/skills/README.md).
COPY --chown=${AGENT_UID}:${AGENT_GID} skills/ /home/agent/.claude/skills/

# Sandcastle bind-mounts the git worktree at /home/agent/workspace and runs there.
WORKDIR /home/agent/workspace
ENTRYPOINT ["sleep", "infinity"]
