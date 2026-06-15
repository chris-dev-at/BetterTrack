#!/usr/bin/env bash
# BetterTrack Build Factory — Autorun launcher (run on the HOST).
#
# One command to (re)start the factory cleanly and leave it running permanently:
#   ./factory/autorun.sh            # build + start detached (auto-resumes after reboots/crashes)
#   ./factory/autorun.sh --fresh    # also wipe the factory's clone/log volume and start clean
#   ./factory/autorun.sh --logs     # just follow the logs of the running factory
#   ./factory/autorun.sh --stop     # stop the factory (resume later with autorun.sh)
#   ./factory/autorun.sh --smoke    # run a single issue in the foreground, then exit
#
# The factory waits out token/usage limits on its own and resumes automatically —
# you never need to babysit it. `restart: unless-stopped` brings it back after a
# crash or a host reboot (ensure Docker starts on boot: `sudo systemctl enable docker`).
set -euo pipefail
cd "$(dirname "$0")"

# Use sudo for docker only if the socket isn't directly accessible.
if docker info >/dev/null 2>&1; then DOCKER=docker; else DOCKER="sudo docker"; fi
dc(){ $DOCKER compose "$@"; }

CANONICAL=bettertrack-factory          # compose `name:` in compose.yml
LEGACY_PROJECTS=(factory claude-bettertrack-factory-worker)

require_env(){
  [ -f .env ] || { echo "✗ factory/.env missing. Copy .env.example → .env and fill the tokens."; exit 1; }
  for v in GH_TOKEN CLAUDE_CODE_OAUTH_TOKEN REPO; do
    grep -qE "^${v}=.+" .env && ! grep -qE "^${v}=replace_me$" .env \
      || { echo "✗ factory/.env: ${v} is not set."; exit 1; }
  done
}

stop_legacy(){
  # Remove any factory containers from earlier launches under other project names,
  # so exactly one factory runs. Volumes are kept unless --fresh is given.
  for p in "${LEGACY_PROJECTS[@]}"; do
    if $DOCKER ps -a --format '{{.Label "com.docker.compose.project"}}' | grep -qx "$p"; then
      echo "→ removing legacy factory project '$p'"
      $DOCKER compose -p "$p" down --remove-orphans 2>/dev/null \
        || $DOCKER rm -f "$($DOCKER ps -aq --filter "label=com.docker.compose.project=$p")" 2>/dev/null || true
    fi
  done
}

case "${1:-up}" in
  --logs)  exec dc logs -f ;;
  --stop)  echo "→ stopping factory"; dc stop; echo "✓ stopped. Resume with: ./factory/autorun.sh"; exit 0 ;;
  --fresh) require_env; echo "→ wiping factory state volume"; dc down -v --remove-orphans 2>/dev/null || true; stop_legacy ;;
  --smoke) require_env; stop_legacy
           echo "→ smoke run (one issue, foreground)…"
           dc build
           ONE_SHOT=1 dc run --rm factory
           exit 0 ;;
  up|"")   require_env; stop_legacy ;;
  *) echo "usage: autorun.sh [--fresh|--logs|--stop|--smoke]"; exit 1 ;;
esac

echo "→ building image…"
dc build
echo "→ starting factory (detached, restart=unless-stopped)…"
dc up -d --force-recreate
sleep 2
dc ps
cat <<EOF

✓ Factory running. It plans → writes → reviews → merges issues continuously,
  pausing automatically when tokens run out and resuming when they replenish.

  Watch:   ./factory/autorun.sh --logs        (or: $DOCKER compose -p $CANONICAL logs -f)
  Dashboard: GitHub Issues + PRs for $(grep -E '^REPO=' .env | cut -d= -f2)
  Stop:    ./factory/autorun.sh --stop
  Resume:  ./factory/autorun.sh
  Hard stop: $DOCKER compose -p $CANONICAL exec factory touch /work/state/STOP
EOF
