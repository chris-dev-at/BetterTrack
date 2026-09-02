#!/usr/bin/env bash
# multi-factory/opencode-install.sh — make the `opencode` provider runnable in the
# multi-factory containers. Run on the HOST. Idempotent: safe to re-run any time.
#
# WHY THIS EXISTS
# ---------------
# The durable home for the opencode binary is factory/Dockerfile (it is in the
# global npm install next to claude-code / codex / CCR). But rebuilding that image
# recreates all five containers, which is disruptive while a milestone is running.
# This script is the bridge: it installs opencode into the CONTAINERS AS THEY ARE,
# so the provider works before the next rebuild.
#
# ⚠ DURABILITY CAVEAT — READ THIS
# `docker cp` writes into a container's WRITABLE LAYER. That survives
# `docker restart` and `docker compose stop/start`, but is DESTROYED by
# `docker compose up --force-recreate`, `--fresh`, `down`, or any image rebuild.
# After ANY of those, either:
#   a) the image was rebuilt from the updated Dockerfile → nothing to do, or
#   b) it was not → re-run this script.
# Verify with:  ./multi-factory/opencode-install.sh --check
#
# CREDENTIALS
# The OpenRouter API key is copied, never printed. Its host source is the owner's
# isolated opencode keystore (OPENCODE_AUTH_SRC below). It lands at mode 600 owned
# by `factory`, both in the per-container bind-mount dir under ./auth (which
# survives a recreate) and directly inside each running container (which does not).
set -uo pipefail
cd "$(dirname "$0")"

if docker info >/dev/null 2>&1; then DOCKER=docker; else DOCKER="sudo docker"; fi

OPENCODE_VERSION=${OPENCODE_VERSION:-1.4.3}
PROJECT=${MF_COMPOSE_PROJECT:-bettertrack-multifactory}
# Must match MF_OPENCODE_HOME in compose.yml / mflib.sh.
CONTAINER_HOME=/home/factory/.opencode
OPENCODE_AUTH_SRC=${OPENCODE_AUTH_SRC:-$HOME/.bettertrack-factory/opencode-sandbox/home/.local/share/opencode/auth.json}
OPENCODE_MODELS_SRC=${OPENCODE_MODELS_SRC:-$HOME/.bettertrack-factory/opencode-sandbox/home/.cache/opencode/models.json}
CACHE_DIR=${OPENCODE_CACHE_DIR:-$HOME/.bettertrack-factory/opencode-dist}

containers(){ $DOCKER ps --format '{{.Names}}' --filter "label=com.docker.compose.project=$PROJECT" | sort; }

check(){
  local n rc=0
  for n in $(containers); do
    local bin auth cat
    bin=$($DOCKER exec "$n" sh -c 'command -v opencode >/dev/null && opencode --version 2>/dev/null | tail -1' 2>/dev/null)
    auth=$($DOCKER exec "$n" sh -c "[ -s $CONTAINER_HOME/share/opencode/auth.json ] && echo yes || echo NO" 2>/dev/null)
    cat=$($DOCKER exec "$n" sh -c "[ -s $CONTAINER_HOME/cache/opencode/models.json ] && echo yes || echo NO" 2>/dev/null)
    printf '%-42s binary=%-8s auth=%-3s catalog=%s\n' "$n" "${bin:-MISSING}" "$auth" "$cat"
    [ -n "$bin" ] && [ "$auth" = yes ] && [ "$cat" = yes ] || rc=1
  done
  return $rc
}

# The binary is a single Bun-compiled executable published per platform through
# npm optionalDependencies. Fetch it on the HOST (which has working DNS even when
# the container NAT does not) and cache it, so repeat runs need no network.
fetch_binary(){ # $1=linux arch (arm64|x64)
  local arch=$1 pkg="opencode-linux-$arch" dest="$CACHE_DIR/$OPENCODE_VERSION-$arch/opencode"
  if [ -x "$dest" ]; then printf '%s\n' "$dest"; return 0; fi
  mkdir -p "$(dirname "$dest")" || return 1
  local tarball
  tarball=$(npm view "$pkg@$OPENCODE_VERSION" dist.tarball 2>/dev/null) || return 1
  [ -n "$tarball" ] || return 1
  curl -fsSL "$tarball" -o "$CACHE_DIR/$pkg-$OPENCODE_VERSION.tgz" || return 1
  tar xzf "$CACHE_DIR/$pkg-$OPENCODE_VERSION.tgz" -C "$(dirname "$dest")" \
    --strip-components=2 package/bin/opencode || return 1
  chmod +x "$dest"
  printf '%s\n' "$dest"
}

install_all(){
  [ -s "$OPENCODE_AUTH_SRC" ] || {
    echo "✗ no opencode credential at $OPENCODE_AUTH_SRC"
    echo "  Create it once on the host (the key is never printed or committed):"
    echo "    HOME=\$HOME/.bettertrack-factory/opencode-sandbox/home opencode auth login"
    return 1
  }
  local n arch bin services=""
  for n in $(containers); do
    arch=$($DOCKER exec "$n" uname -m 2>/dev/null)
    case "$arch" in aarch64|arm64) arch=arm64;; x86_64|amd64) arch=x64;;
      *) echo "✗ $n: unsupported arch '$arch'"; continue;; esac
    bin=$(fetch_binary "$arch") || { echo "✗ $n: could not obtain the $arch binary"; continue; }

    # 1. the bind-mounted per-service dir (survives a recreate; compose mounts it)
    local svc
    svc=$($DOCKER inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$n" 2>/dev/null)
    if [ -n "$svc" ]; then
      mkdir -p "auth/$svc/opencode/share/opencode" "auth/$svc/opencode/cache/opencode" \
               "auth/$svc/opencode/config"
      chmod 700 "auth/$svc/opencode" 2>/dev/null || true
      cp -f "$OPENCODE_AUTH_SRC" "auth/$svc/opencode/share/opencode/auth.json"
      chmod 600 "auth/$svc/opencode/share/opencode/auth.json"
      [ -s "$OPENCODE_MODELS_SRC" ] &&
        cp -f "$OPENCODE_MODELS_SRC" "auth/$svc/opencode/cache/opencode/models.json"
      services="$services $svc"
    fi

    # 2. the running container itself (works NOW, without a recreate)
    $DOCKER exec -u root "$n" mkdir -p "$CONTAINER_HOME/share/opencode" \
      "$CONTAINER_HOME/cache/opencode" "$CONTAINER_HOME/config" || continue
    $DOCKER cp "$bin" "$n:/usr/local/bin/opencode" >/dev/null || continue
    $DOCKER exec -u root "$n" chmod 0755 /usr/local/bin/opencode
    $DOCKER cp "$OPENCODE_AUTH_SRC" "$n:$CONTAINER_HOME/share/opencode/auth.json" >/dev/null \
      || { echo "✗ $n: could not install the opencode credential"; continue; }
    # The models.dev catalog — a cold-start warm-up ONLY. opencode replaces this
    # file with its own fetch on first run, and that in-container fetch has been
    # observed returning a SHORT catalog (176 vs 367 entries) that omits preview
    # models; a route missing from the catalog fails with the same "Model not
    # found" text an expired key produces. What actually guarantees the route is
    # the explicit provider.openrouter.models block in opencode-factory.json
    # (copied below), which opencode never rewrites.
    if [ -s "$OPENCODE_MODELS_SRC" ]; then
      $DOCKER cp "$OPENCODE_MODELS_SRC" "$n:$CONTAINER_HOME/cache/opencode/models.json" >/dev/null \
        || echo "  ! $n: models.dev warm-up copy failed (opencode will fetch its own)"
    fi
    # /work/mf/opencode-factory.json is bind-mounted READ-ONLY by the current
    # compose.yml, so this cp FAILS on an up-to-date container — and that failure
    # is the good case: the mount already serves the host file. It only has real
    # work to do on a container created before that mount existed, which is the
    # whole point of this script. So a failure is only fatal when the file is
    # also absent/unreadable in the container; never report ✓ without proving it.
    if ! $DOCKER cp opencode-factory.json "$n:/work/mf/opencode-factory.json" >/dev/null 2>&1; then
      $DOCKER exec "$n" test -s /work/mf/opencode-factory.json 2>/dev/null \
        || { echo "✗ $n: /work/mf/opencode-factory.json is neither writable nor mounted"; continue; }
    fi
    $DOCKER exec -u root "$n" chown -R factory:factory "$CONTAINER_HOME" \
      || { echo "✗ $n: could not chown $CONTAINER_HOME"; continue; }
    $DOCKER exec -u root "$n" chmod 700 "$CONTAINER_HOME" \
      || { echo "✗ $n: could not chmod $CONTAINER_HOME"; continue; }
    $DOCKER exec -u root "$n" chmod 600 "$CONTAINER_HOME/share/opencode/auth.json" \
      || { echo "✗ $n: could not restrict the credential to 0600"; continue; }
    echo "✓ $n"
  done
  chmod -R go-rwx auth 2>/dev/null || true
}

case "${1:-install}" in
  --check|check) check; exit $? ;;
  install|"")    install_all || exit 1; echo; check ;;
  *) echo "usage: opencode-install.sh [install|--check]"; exit 1 ;;
esac
