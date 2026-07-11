# infra/live

Canonical, version-controlled copies of the files that drive the **live**
(`bettertrack.at`) deployment's self-updating deploy loop. The scripts that
actually run live OUTSIDE this repo, in the control dir on the prod host (mounted
into the deploy containers); the copies here are the source of truth the
deployment **adopts** with a single `cp` + container restart.

## `updater.sh`

The auto-updater loop. It runs inside a `docker:28-cli` container (BusyBox
`/bin/sh` — POSIX sh, no bashisms). Every `INTERVAL` seconds it fetches
`origin/main`; when the remote SHA differs from the last **successfully deployed**
one (tracked in `logs/deployed.sha`, not by HEAD, so a failed deploy retries
instead of being abandoned), it fast-forwards the clone and rebuilds/redeploys the
app services through the mounted docker socket.

What this canonical copy adds over the historical control-dir script:

- **Whole-stack deploys.** The `build` and final `up -d` lists include **every**
  compose service that builds app code — web, api, **worker**, landing — not
  just web+api. Each buildable service owns its own image tag and `up -d` never
  recreates a service it doesn't list, so the historical web+api-only deploy
  left the worker (and landing) frozen on their first-bring-up images across
  every auto-deploy. That is exactly how the 2026-07-11 `alert.triggered` P1
  happened: the notifications-v2 cutover (#427) redeployed the api off the
  ephemeral-bus dispatcher while the frozen pre-v2 worker kept publishing
  `alert.triggered` onto that now-unconsumed bus — triggered alerts produced no
  inbox row and no push. The deploy set is guarded against the compose file by
  `apps/api/src/__tests__/liveDeployTopology.test.ts`. **Adopting this version
  on the prod host (see below) is required for the fix to take effect**; the
  first deploy tick after adoption recreates the worker onto current code.
- **Deploy-reason logging.** When a new SHA is detected, before deploying it logs
  the trigger — a summary line (`deploying <short-sha>, N new commit(s)`) plus one
  line per non-merge commit in `<deployed>..<new>` (squash-merges carry the PR id,
  e.g. `… (#397)`). A missing/empty/stale `deployed.sha` is handled gracefully (it
  logs the target without inventing a commit range).
- **Seed on every deploy.** After `migrate.js` it runs `node dist/scripts/seed.js`
  through the same `compose run` mechanism. The seed is idempotent by design
  (#398), so this converges the first-party OAuth client scope ceiling on every
  deploy — not only on `start.sh` — without narrowing anything already present.
- **Deploy marker.** Right after the fast-forward and before the build, it stamps
  the deployed commit and a UTC build time into `GIT_SHA` / `GIT_BUILD_TIME` and
  exports them, so compose bakes them into the web + api images (build args → the
  Dockerfiles). The live API then reports them at the public, no-auth
  `GET /api/v1/version`, and the admin login page shows a `web <sha> · api <sha>`
  footer — so anyone can verify exactly which commit is live.

All prior behavior and safety semantics are preserved exactly: the poll loop,
fast-forward, db+redis brought up before migrate, `deployed.sha` written on
success only, the updater excluding itself from `up`, and the same-path mount
assumptions.

### Adopt (on the prod host)

From the control dir (the app clone lives at `./app` under it):

```sh
cp app/infra/live/updater.sh ./updater.sh      # over the old control-dir copy
docker restart bettertrack-live-updater-1
```

The script is read once at container start, so the restart is what picks up the
new version.

### Deploy marker on `start.sh`-driven builds

The updater stamps the deploy marker (`GIT_SHA` / `GIT_BUILD_TIME`) on every
auto-deploy. Manual bring-ups driven by the control-dir `start.sh` (first boot,
or a hand-run rebuild) will still report `unknown` for both `web` and `api` at
`GET /api/v1/version` and in the login footer until `start.sh` exports the same
two vars before its `docker compose build` / `up`. Paste these two lines into
`start.sh` before the build step (the app clone lives at `./app` under the
control dir):

```sh
export GIT_SHA="$(git -C app rev-parse HEAD 2>/dev/null || echo unknown)"
export GIT_BUILD_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
```

## `edge/bt-live-edge.conf`

The go-live edge overlay for the `web` nginx container: Cloudflare real-IP
recovery, the edge-secret gate, the SEO fence, the legacy-sites reroute, and an
`api.bettertrack.at` server block that **shadows** the repo template's api block.
It loads from the control dir alongside the template render (`conf.d`), so its
api block is the one actually serving `api.bettertrack.at` — which is why the
WebSocket upgrade forwarding (#396) has to live here too, under its own
`$bt_connection_upgrade` map so it never collides with the template's
`$connection_upgrade` (a duplicate map name makes nginx refuse to boot).

### Adopt (on the prod host)

From the control dir (the app clone lives at `./app` under it):

```sh
cp app/infra/live/edge/bt-live-edge.conf ./edge/bt-live-edge.conf   # over the old copy
docker exec bettertrack-live-web-1 nginx -s reload                  # or: docker restart bettertrack-live-web-1
```

Unlike the updater, this file is read by nginx at (re)load, so the reload is what
picks up the change. `nginx -s reload` is zero-downtime; the restart is the
fallback if a reload is refused.
