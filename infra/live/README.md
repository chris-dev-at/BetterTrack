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

- **Deploy-reason logging.** When a new SHA is detected, before deploying it logs
  the trigger — a summary line (`deploying <short-sha>, N new commit(s)`) plus one
  line per non-merge commit in `<deployed>..<new>` (squash-merges carry the PR id,
  e.g. `… (#397)`). A missing/empty/stale `deployed.sha` is handled gracefully (it
  logs the target without inventing a commit range).
- **Seed on every deploy.** After `migrate.js` it runs `node dist/scripts/seed.js`
  through the same `compose run` mechanism. The seed is idempotent by design
  (#398), so this converges the first-party OAuth client scope ceiling on every
  deploy — not only on `start.sh` — without narrowing anything already present.

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
