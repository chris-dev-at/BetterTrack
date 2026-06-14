FROM node:22-bookworm
RUN apt-get update && apt-get install -y git curl jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/* \
 && corepack enable && npm install -g @anthropic-ai/claude-code
RUN useradd -m factory
USER factory
WORKDIR /work
COPY --chown=factory run.sh /work/run.sh
ENTRYPOINT ["bash", "/work/run.sh"]
