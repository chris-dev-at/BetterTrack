#!/bin/sh
# ============================================================================
# CANONICAL live auto-updater — source of truth for the prod deploy loop.
#
# The running script lives OUTSIDE the app clone, in the live control dir on the
# prod host (mounted into the bettertrack-live-updater container). This file is
# the version-controlled copy the deployment adopts. To ADOPT a new version, from
# the control dir on the prod host (the app clone lives at ./app under it):
#
#   1. cp app/infra/live/updater.sh ./updater.sh     # over the old control-dir copy
#   2. docker restart bettertrack-live-updater-1
#
# The script is read once at container start, so the restart is what picks up
# changes (the running container keeps executing the old copy until then). The
# control dir is the CONTROL path the container mounts (see compose.override.yml).
# ============================================================================
#
# Auto-updater loop — runs INSIDE a docker:28-cli container (see compose.override.yml).
# Every INTERVAL seconds it checks origin/main; when the remote SHA differs from the
# last SUCCESSFULLY DEPLOYED one it fast-forwards the clone and rebuilds/redeploys
# the app services through the mounted docker socket. Success is tracked in
# logs/deployed.sha rather than by comparing HEAD: `git reset --hard` moves HEAD
# even when the deploy afterwards fails, so a HEAD comparison abandons a failed
# deploy forever (that stranded the db dead with site-wide 500s on 2026-07-04) —
# the SHA file makes every failed deploy retry on the next tick. It never lists
# `updater` in `up` (so it can't recreate/kill itself).
#
# IMPORTANT: the control dir must be mounted at the SAME path inside this container
# as on the host, and CONTROL set to that path (see compose.override.yml for why).
#
# The container runs BusyBox /bin/sh (ash), NOT bash — keep this script POSIX sh.
set -u

INTERVAL="${INTERVAL:-300}"
CONTROL="${CONTROL:-/work/control}"
APP="$CONTROL/app"
LOG="$CONTROL/logs/updater.log"
ENVF="$CONTROL/live.env"
BASE="$APP/infra/docker-compose.yml"
OVR="$CONTROL/compose.override.yml"
PROJECT="bettertrack-live"
DEPLOYED_SHA="$CONTROL/logs/deployed.sha"

mkdir -p "$CONTROL/logs"
log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG"; }

# Log WHY this deploy is firing: the commits between the last deployed SHA and the
# new one (owner ask). Summary line + one line per non-merge commit; squash-merges
# already carry the PR id in their subject, e.g. "… (#397)". Purely informational —
# it must never affect the deploy outcome, so every git call tolerates failure and
# the missing/empty/stale deployed.sha edge is handled without guessing a range.
log_deploy_reason() {
  # $1 = last deployed SHA (or "none"), $2 = new remote SHA
  _prev="$1"
  _new="$2"
  _short="$(git -C "$APP" rev-parse --short "$_new" 2>/dev/null || echo "$_new")"
  if [ "$_prev" != "none" ] && git -C "$APP" rev-parse --quiet --verify "${_prev}^{commit}" >/dev/null 2>&1; then
    _count="$(git -C "$APP" rev-list --no-merges --count "${_prev}..${_new}" 2>/dev/null || echo '?')"
    log "deploying ${_short}, ${_count} new commit(s) (last deployed: ${_prev})"
    git -C "$APP" log --no-merges --oneline "${_prev}..${_new}" 2>/dev/null | while IFS= read -r _line; do
      log "  ${_line}"
    done
  else
    # No usable previous SHA on record (first deploy, wiped log, or a history
    # rewrite where the old SHA is gone) — deploy anyway, just can't list a range.
    log "deploying ${_short} (no previous deployed SHA on record — first deploy or reset)"
  fi
}

# The clone is owned by the host user; silence git's "dubious ownership" guard.
git config --global --add safe.directory "$APP" 2>/dev/null || true

dc() { docker compose -p "$PROJECT" -f "$BASE" -f "$OVR" --env-file "$ENVF" "$@"; }

log "updater started (interval=${INTERVAL}s, project=${PROJECT}, control=${CONTROL})"

while true; do
  if [ -d "$APP/.git" ]; then
    if git -C "$APP" fetch origin main --quiet 2>>"$LOG"; then
      REMOTE="$(git -C "$APP" rev-parse origin/main 2>/dev/null || echo unknown)"
      DEPLOYED="$(cat "$DEPLOYED_SHA" 2>/dev/null || echo none)"
      # An empty deployed.sha (e.g. a truncated write) must behave like "none".
      [ -n "$DEPLOYED" ] || DEPLOYED=none
      if [ "$REMOTE" != "unknown" ] && [ "$REMOTE" != "$DEPLOYED" ]; then
        log_deploy_reason "$DEPLOYED" "$REMOTE"
        # db+redis come up BEFORE migrate so a db that can't start fails loudly
        # here, not halfway into `compose run`'s implicit dependency start.
        # seed runs right after migrate — it is idempotent by design (#398), so
        # running it on every deploy (not just start.sh) converges the first-party
        # OAuth client ceiling without narrowing anything already there.
        #
        # Deploy marker: after fast-forwarding, stamp the deployed commit + UTC
        # build time and export them so compose resolves the GIT_SHA/GIT_BUILD_TIME
        # build args (infra/docker-compose.yml → the web/api Dockerfiles), so
        # GET /api/v1/version and the admin-login footer report exactly what is
        # live. Both assignments always succeed (|| echo unknown / date), so the
        # && chain's success semantics are unchanged.
        #
        # Deploy the WHOLE app stack: every compose service that builds app code
        # (web, api, worker, landing) must be in BOTH the `build` and the final
        # `up -d` list. Each buildable service owns its own image tag
        # (<project>-<service>), so building web+api alone leaves the worker's
        # image untouched, and `up -d` never recreates a service it doesn't
        # list. Historically only web+api deployed: the worker container stayed
        # frozen on its first-bring-up image across every auto-deploy — on
        # 2026-07-11 that stranded a pre-notifications-v2 worker publishing
        # alert.triggered onto the retired ephemeral bus nobody consumes, so
        # triggered alerts produced no inbox row and no push (P1). The worker
        # build is near-free: same Dockerfile as api, so its layers come out of
        # the build cache. Guarded by
        # apps/api/src/__tests__/liveDeployTopology.test.ts.
        if git -C "$APP" reset --hard "$REMOTE" >>"$LOG" 2>&1 &&
          GIT_SHA="$(git -C "$APP" rev-parse HEAD 2>/dev/null || echo unknown)" &&
          GIT_BUILD_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" &&
          export GIT_SHA GIT_BUILD_TIME &&
          dc build web api worker landing >>"$LOG" 2>&1 &&
          dc up -d db redis >>"$LOG" 2>&1 &&
          dc run --rm api node dist/scripts/migrate.js >>"$LOG" 2>&1 &&
          dc run --rm api node dist/scripts/seed.js >>"$LOG" 2>&1 &&
          dc up -d db redis api web worker landing >>"$LOG" 2>&1; then
          printf '%s\n' "$REMOTE" >"$DEPLOYED_SHA"
          log "update complete -> ${REMOTE}"
        else
          log "update FAILED at ${REMOTE} — retrying next tick (see output above)"
        fi
      else
        log "up-to-date (${REMOTE})"
      fi
    else
      log "git fetch failed (offline?)"
    fi
  else
    log "app clone missing at ${APP} — skipping"
  fi
  sleep "$INTERVAL"
done
