#!/usr/bin/env bash
# BetterTrack Multi-Factory — Autorun launcher (run on the HOST).
#
#   ./multi-factory/autorun.sh            # build + start master and N workers, detached
#   ./multi-factory/autorun.sh --dry      # start in MF_DRY_RUN=1 mode (no LLM calls)
#   ./multi-factory/autorun.sh --logs     # follow all container logs
#   ./multi-factory/autorun.sh --stop     # stop containers (resume later with autorun.sh)
#   ./multi-factory/autorun.sh --down     # stop AND remove containers (state/ dir persists)
#   ./multi-factory/autorun.sh --fresh    # wipe protocol state + clone volumes, start clean
#
# The single factory and the multi-factory must NEVER run at the same time against
# the repo — both launchers refuse to start while the other project has containers.
# Prefer the control dashboard (multi-factory/control/) for day-to-day start/stop/
# pause/run-out/close-down.
set -euo pipefail
cd "$(dirname "$0")"

if docker info >/dev/null 2>&1; then DOCKER=docker; else DOCKER="sudo docker"; fi
dc(){ $DOCKER compose "$@"; }

require_env(){
  [ -f ../factory/.env ] || { echo "✗ factory/.env missing. Copy .env.example → .env and fill the tokens."; exit 1; }
}

# docker ps lists running AND paused containers, so a paused single factory blocks too.
guard_single_factory(){
  if [ -n "$($DOCKER ps -q --filter label=com.docker.compose.project=bettertrack-factory)" ]; then
    echo "✗ The single factory (bettertrack-factory) is running/paused."
    echo "  The two factories must never run at the same time against the repo."
    echo "  Stop it first:  ./factory/autorun.sh --stop"
    exit 1
  fi
}

prepare_state(){
  mkdir -p state/assignments state/status state/merge-queue state/control state/logs prompts
  rm -f state/STOP state/control/dry-done
  # (Re)starting the factory means: run. Drain modes are set via control/mode later.
  printf 'run\n' > state/control/mode.tmp && mv -f state/control/mode.tmp state/control/mode
}

case "${1:-up}" in
  --logs)  exec dc logs -f ;;
  --stop)  echo "→ stopping multi-factory"; dc stop; echo "✓ stopped. Resume with: ./multi-factory/autorun.sh"; exit 0 ;;
  --down)  echo "→ downing multi-factory"; dc down --remove-orphans; echo "✓ removed (state/ and clone volumes kept)"; exit 0 ;;
  --fresh) require_env; guard_single_factory
           echo "→ wiping multi-factory state + clone volumes"
           dc down -v --remove-orphans 2>/dev/null || true
           rm -rf state; prepare_state ;;
  --dry)   require_env; guard_single_factory; prepare_state
           echo "→ building image…"; dc build
           echo "→ starting multi-factory in DRY-RUN mode (no LLM calls)…"
           MF_DRY_RUN=1 dc up -d --force-recreate
           dc ps; exit 0 ;;
  up|"")   require_env; guard_single_factory; prepare_state ;;
  *) echo "usage: autorun.sh [--dry|--logs|--stop|--down|--fresh]"; exit 1 ;;
esac

echo "→ building image…"
dc build
echo "→ starting multi-factory (detached, restart=unless-stopped)…"
MF_DRY_RUN=${MF_DRY_RUN:-0} dc up -d --force-recreate
sleep 2
dc ps
cat <<'EOF'

✓ Multi-factory running: 1 master (composer → scheduler → merger) + workers.

  Dashboard:  node multi-factory/control/server.mjs   →  http://127.0.0.1:8790
  Watch:      ./multi-factory/autorun.sh --logs
  Stop:       ./multi-factory/autorun.sh --stop        (hard, resumable)
  Drain:      echo run-out    > multi-factory/state/control/mode   (finish ALL open issues, then idle)
              echo close-down > multi-factory/state/control/mode   (finish in-flight only, then idle)
  Pause:      docker compose -p bettertrack-multifactory pause / unpause
EOF
