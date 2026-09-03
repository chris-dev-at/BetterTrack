FROM node:22-bookworm
RUN apt-get update && apt-get install -y git curl jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && npm install -g \
      @anthropic-ai/claude-code@2.1.218 \
      @openai/codex@0.145.0 \
      @musistudio/claude-code-router@3.0.7 \
      opencode-ai@1.4.3
# opencode (the multi-factory's `opencode` provider) ships as a ~170 MB
# Bun-compiled binary selected by npm through per-platform optionalDependencies
# (opencode-linux-arm64 / -x64). Its postinstall only links that binary — no
# network fetch of its own. Auth is NOT baked in: autorun.sh syncs the API key
# into the per-container mount that mflib.sh points MF_OPENCODE_HOME at.
# Pinned like every other CLI above so a rebuild can never silently change the
# harness under a running milestone.
# Own /work (incl. the /work/state volume mountpoint) as the unprivileged user, so
# a fresh named volume mounted at /work/state inherits factory ownership and is writable.
RUN useradd -m factory && mkdir -p /work/state && chown -R factory:factory /work
USER factory
# The Antigravity CLI (agy) install lived here for the gemini provider, which
# #1623 removed after it had never run a single production role. The ~/.local/bin
# entry stays on PATH: it is the conventional per-user bin dir for anything a
# provider bootstrap installs at runtime.
ENV HOME=/home/factory
ENV PATH="/home/factory/.local/bin:${PATH}"
ENV CCR_EXPECTED_VERSION=3.0.7
ENV CCR_FACTORY_PROFILE=bettertrack-factory-claudex
WORKDIR /work
COPY --chown=factory run.sh lib.sh /work/
# Bake prompts into the image as a fallback; compose bind-mounts factory/prompts
# over /work/state/prompts so they can be tuned without rebuilding.
COPY --chown=factory prompts /work/prompts
ENTRYPOINT ["bash", "/work/run.sh"]
