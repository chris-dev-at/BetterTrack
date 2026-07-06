FROM node:22-bookworm
RUN apt-get update && apt-get install -y git curl jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/* \
 && corepack enable && npm install -g @anthropic-ai/claude-code @openai/codex
# Own /work (incl. the /work/state volume mountpoint) as the unprivileged user, so
# a fresh named volume mounted at /work/state inherits factory ownership and is writable.
RUN useradd -m factory && mkdir -p /work/state && chown -R factory:factory /work
USER factory
# Antigravity CLI (agy) — the multi-factory's gemini provider. Installs to
# ~/.local/bin; auth is NOT baked in (autorun.sh bind-mounts synced host auth
# into /home/factory/.gemini at runtime).
ENV HOME=/home/factory
ENV PATH="/home/factory/.local/bin:${PATH}"
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash
WORKDIR /work
COPY --chown=factory run.sh lib.sh /work/
# Bake prompts into the image as a fallback; compose bind-mounts factory/prompts
# over /work/state/prompts so they can be tuned without rebuilding.
COPY --chown=factory prompts /work/prompts
ENTRYPOINT ["bash", "/work/run.sh"]
