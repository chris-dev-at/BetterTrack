# BetterTrack ops runbook

Operations reference for the self-hosted deploy. This document is the source of
truth for the backup + restore procedure (PROJECTPLAN.md §10, §13.4 V4-P6).
Deploy topology lives in `README.md`; app-level config lives in
`infra/.env.production.example`. That annotated example is the single
production variable reference (including secret and rotation guidance); keep
operational procedures here instead of duplicating its key list.

## Container health and account exports

The production Compose stack separates process liveness from dependency
readiness:

- `GET /api/v1/health` is the API process liveness probe. It performs no
  Postgres or Redis work and remains useful while either dependency is down.
- `GET /api/v1/health/ready` probes Postgres and Redis concurrently, with a
  1.5-second budget for each. It returns `200` only when both answer and `503`
  with the same typed readiness body otherwise. The `api` container healthcheck
  uses this route, so Compose's `service_healthy` condition means both required
  dependencies are answering.
- The `worker` container runs
  `node dist/scripts/workerHealth.js`. The probe reads the existing
  `system:heartbeat:last` marker from Redis and succeeds only while it is at
  most three heartbeat intervals (three minutes) old. Compose grants a
  three-minute `start_period`; worker startup also enqueues an immediate
  heartbeat proof, and the scheduled job refreshes it every minute. A worker
  whose BullMQ loop never consumes the proof becomes unhealthy.
- The admin **Health** page uses the same freshness window. A heartbeat that was
  never created is tolerated during startup grace, then appears as degraded
  instead of remaining green indefinitely.

Account-export archives use the named `exportdata` volume. Compose sets
`BT_EXPORT_DIR=/var/lib/bettertrack/exports` and mounts that identical path in
both `api` and `worker`. The worker can therefore assemble a ZIP and store its
path in Postgres; the API resolves that path to the same file when the owner
downloads it. The image prepares the directory for the non-root `bettertrack`
user. Ready exports still expire through the existing 24-hour cleanup job; the
volume only makes their short lifetime survive process/container boundaries.
As with every named volume, `docker compose down -v` deletes it.

Render both effective production topologies after editing Compose. The
committed example supplies inert interpolation values; substitute `infra/.env`
to validate one deployment's configured values:

```bash
BT_MODE=subdomains docker compose --env-file infra/.env.production.example \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.subdomains.yml config -q
BT_MODE=ports docker compose --env-file infra/.env.production.example \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.ports.yml config -q
```

The public legal documents have one canonical source:
`apps/landing/site/{terms,privacy,impressum,cookies}/`, with EN at `index.html`
and DE at `de/index.html`. The generic `landing` image copies that tree as-is,
so both proxy modes serve `/<page>/` and `/<page>/de/`. The bespoke live updater
overlays those same four directories into
`$CONTROL/edge/html/product/` after each successful deploy; nginx serves the
mounted files immediately without a reload. Update legal files only in the
landing tree, then use the render commands above and the updater checks before
deployment.

## Browser Google Drive runtime configuration

Set `BT_GOOGLE_DRIVE_CLIENT_ID` in the deployment env to the public client id of
a Google Cloud OAuth **Web application** credential whose authorized JavaScript
origin is the BetterTrack user-app origin. BetterTrack requests only
`https://www.googleapis.com/auth/drive.appdata`. Leaving the value blank hides
the Google Drive card entirely.

The client id is public by design; do not put a client secret, access token, or
refresh token in this variable. The OAuth flow remains browser-only through
Google Identity Services: the BetterTrack API receives no Drive token, file id,
or proxied Drive request.

After changing the value, recreate only the `web` container with the same base
and topology Compose files used by the deployment (for example, append
`up -d --no-deps --force-recreate web` to the relevant Compose invocation).
This regenerates `/config.js` at container start without rebuilding the image.
Fetch the user origin's `/config.js` and confirm its `googleDriveClientId`; set
the variable blank and recreate `web` again to remove the value and hide the
card.

## Deployment-host log and image retention

Every repository Compose service uses Docker's `local` log driver with an
explicit `max-size: 10m` and `max-file: 3`. Docker therefore retains at most
three 10 MiB log files per container instead of the unbounded default:

| Compose file                    | Services                                                                                                                                                          | Retention per container |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `docker-compose.yml`            | `web`, `landing`, `api`, `worker`, `backup-scheduler`, `db`, `redis`, `prometheus`, `grafana`, `node-exporter`, `cadvisor`, `postgres-exporter`, `redis-exporter` | 3 × 10 MiB              |
| `docker-compose.ports.yml`      | `web` overlay                                                                                                                                                     | 3 × 10 MiB              |
| `docker-compose.subdomains.yml` | `web` overlay                                                                                                                                                     | 3 × 10 MiB              |
| `docker-compose.offsite.yml`    | `backup-offsite`, `backup-offsite-retention`                                                                                                                      | 3 × 10 MiB              |
| `docker-compose.dev.yml`        | `db`, `redis`                                                                                                                                                     | 3 × 10 MiB              |

The live updater's separate host file,
`$CONTROL/logs/updater.log`, rotates when it reaches 10 MiB. It keeps three
archives (`updater.log.1` through `.3`), so a long-running updater cannot append
to one file forever. Deploy-lifecycle notifications still go directly to the
updater container's stdout and remain visible through `docker logs`.

After each deploy tick, the updater checks
`$CONTROL/logs/last-docker-reclaim`. At most once every 24 hours it asks Docker
to remove only:

- unused build cache older than seven days; and
- dangling images older than seven days.

The reclaim deliberately uses `docker builder prune` and `docker image prune`
without `-a`. It never runs `docker system prune`, `docker volume prune`,
container prune, or any command with `--volumes`. Docker excludes images
referenced by a container, including the updater's own active image. Reclaim
failure is logged as non-fatal and the deploy loop continues.

The named data volumes are never cleanup targets:
`pgdata`, `redisdata`, `exportdata`, `pgbackups`, `backupstatus`, `promdata`, and
`grafanadata`. Do not replace the updater's narrow commands with a broader
prune.

Inspect current usage and the last reclaim attempt from the deploy host:

```sh
CONTROL=/absolute/path/to/live-control
docker system df
docker builder du
ls -lh "$CONTROL"/logs/updater.log*
cat "$CONTROL/logs/last-docker-reclaim" # UTC epoch seconds
```

To disable automatic reclaim, set `DOCKER_RECLAIM_ENABLED=0` on the `updater`
service in the control directory's machine-local `compose.override.yml`, then
recreate only that service with the same Compose file and env arguments used by
the live stack. The log rotation remains active.

## Backup architecture

Local recovery points are part of the base deployment. Encrypted offsite upload
is optional, and remote deletion is a third, separately credentialed step that
is off by default.

```
backup-scheduler ── pg_dump + gzip ──▶ pgbackups volume
       │                                  └─ restore-attestations.jsonl
       ├─ status-only healthcheck ───────▶ backupstatus volume
       │                                  └─ backup-status.env
       │
       ├─ restore-drill.sh ──▶ disposable database (create → probe → drop)
       │
       └─ optional backup-offsite ── age + delete-less rclone copy ──▶ remote
                                                    ▲
             optional backup-offsite-retention ─────┘
             separate credential + explicit profile/enable switch
```

### Local schedule, status, and health

`backup-scheduler` starts with the production Compose stack, takes one dump and
runs one safe restore drill immediately, then installs both schedules in its own
cron daemon. Local dumps default to `0 3 * * *` in UTC, matching the former
03:00 schedule; restore drills default to `0 4 1 * *` (04:00 UTC on the first of
each month). No host scheduler or external account is needed.

| Variable                         | Default     | Meaning                                                        |
| -------------------------------- | ----------- | -------------------------------------------------------------- |
| `BT_BACKUP_CRON`                 | `0 3 * * *` | Local-dump schedule; five-field numeric cron, evaluated in UTC |
| `BT_BACKUP_RESTORE_CRON`         | `0 4 1 * *` | Restore-drill schedule; five-field numeric cron, in UTC        |
| `BACKUP_RETENTION_DAYS`          | `14`        | Local dump retention                                           |
| `BT_BACKUP_FRESHNESS_MAX_HOURS`  | `26`        | Maximum age of the newest successful local dump                |
| `BT_BACKUP_RESTORE_MAX_AGE_DAYS` | `35`        | Maximum age of the newest successful restore-drill evidence    |

Every attempt atomically updates `/status/backup-status.env`. This
schema-versioned key/value file lives in the small `backupstatus` volume and is
the only freshness source used by the Docker healthcheck. Keeping status
separate lets the optional upload container mount plaintext dumps read-only
while recording its outcome. The file records the last attempt and success,
artifact name, byte size, SHA-256 checksum, offsite outcomes, restore evidence,
and current health reason.

```bash
cd /path/to/bettertrack/infra
docker compose ps backup-scheduler
docker compose exec -T backup-scheduler \
    sh -c 'sed -n "1,120p" /status/backup-status.env'
docker compose exec -T backup-scheduler /opt/bettertrack/backup.sh
```

Missing evidence, a missing or truncated recorded artifact, a dump older than
26 hours, or a restore drill older than 35 days makes the scheduler unhealthy.
It stays running so the next scheduled dump can recover backup freshness.

When upgrading a deployment that used the old runbook, remove its legacy host
crontab entry containing
`docker compose exec -T db bash /opt/bettertrack/backup.sh`. The script is
intentionally no longer mounted into `db`, and leaving the old entry creates a
silent failing duplicate. If that line also chained the optional offsite upload,
preserve the upload cadence in the trusted offsite control plane; the in-stack
scheduler replaces the local-dump and restore-drill portions.

### Scheduled and on-demand local restore drill

The scheduler runs the drill on startup after its first successful dump and
monthly thereafter. Run it additionally after database-version or backup-script
changes:

```bash
docker compose exec -T backup-scheduler /opt/bettertrack/restore-drill.sh
```

The script reads the newest successful artifact from the status file, verifies
its checksum, creates `bettertrack_restore_drill`, restores with
`ON_ERROR_STOP`, probes connectivity and public tables, then drops the scratch
database even on failure. It rejects the live `POSTGRES_DB`, `postgres`, and
template database names. Each attempt appends JSON evidence to
`/backups/restore-attestations.jsonl`; passing evidence also updates the status
file used by health.

### Security posture

- **Encrypt-only on the box.** The server only ever sees the age recipient
  (a `age1...` public key). The matching identity (private key) stays
  OFFLINE with the owner and is never present on the deploy host, in any
  image, in git, or in any environment variable.
- **rclone.conf is a secret.** Each config lives on the host filesystem, is
  bind-mounted read-only, and is never committed or logged. `offsite.sh` runs
  without shell tracing.
- **Upload cannot prune.** `backup-offsite` never invokes `rclone delete` and
  mounts only the upload config. Give that credential create/list/upload
  rights on one dedicated folder, but no delete permission.
- **Retention is isolated.** `backup-offsite-retention` mounts only its
  deletion-capable config and requires both its profile and
  `BT_BACKUP_REMOTE_RETENTION_ENABLED=true`. Prefer provider-side object lock,
  retention policy, or version history over running this service.
- **Plaintext dumps never leave the box.** Only the `.sql.gz.age` artifact
  is uploaded; the plaintext `.sql.gz` stays inside the `pgbackups` volume
  under `BACKUP_RETENTION_DAYS` local retention.
- **Encrypted artifact is atomic.** It is encrypted to a temp path, uploaded,
  and only then removed. A failed upload leaves the local `.sql.gz`
  untouched and exits non-zero so orchestration surfaces the failure. Every later run
  compares all eligible local dumps with the remote and retries every missing
  artifact, including a missed prior day.

## Enabling encrypted offsite upload

### 1. Generate an age keypair (offline, one time)

Run on the owner's OFFLINE machine — never on the deploy host:

```bash
# From github.com/FiloSottile/age or your distro's `age` package.
age-keygen -o bettertrack-backup-identity.txt
# Prints something like:
#   Public key: age1abc0defghijklmnopqrstuvwxyz...
```

- Copy the `Public key:` line into `bettertrack-backup-recipient.txt` (one
  `age1...` line per recipient — you can list multiple for redundancy).
- Keep `bettertrack-backup-identity.txt` (the private key) in offline cold
  storage (encrypted USB, paper, password manager, HSM — owner's choice).
  It is required to decrypt any backup; losing it means the offsite copies
  are permanently unreadable.

Copy ONLY the recipient file to the deploy host, e.g.
`/etc/bettertrack/age-recipient`. Root-owned, mode `0644` is fine (it holds
public-key material only).

### 2. Configure a delete-less rclone upload remote

On the deploy host:

```bash
rclone config
#   n) New remote
#   name> gdrive-upload
#   Storage> drive
#   client_id>       (leave blank — uses rclone's default, or set your own)
#   client_secret>   (blank)
#   scope>            (narrowest create/list/upload scope the provider supports)
#   root_folder_id>  (id of a dedicated BetterTrack backup folder)
#   service_account_file> (blank — interactive user login)
#   Edit advanced config> n
#   Use auto config> n (headless server; follow the browser dance on a
#                       machine that has one, paste the resulting token)
```

Store the resulting config at `/etc/bettertrack/rclone-upload.conf`,
root-owned, mode `0600`. Enable provider version history/trash retention on the
dedicated destination. Confirm this credential can list and upload but cannot
delete an existing test object.

Verify manually:

```bash
rclone --config /etc/bettertrack/rclone-upload.conf lsd gdrive-upload:
rclone --config /etc/bettertrack/rclone-upload.conf mkdir \
    gdrive-upload:bettertrack-backups
```

### 3. Fill in `infra/.env`

```dotenv
BT_BACKUP_AGE_RECIPIENT_HOST_FILE=/etc/bettertrack/age-recipient
BT_BACKUP_RCLONE_CONFIG_HOST_FILE=/etc/bettertrack/rclone-upload.conf
BT_BACKUP_RCLONE_REMOTE=gdrive-upload:bettertrack-backups
BT_BACKUP_REMOTE_RETENTION_ENABLED=false
```

These values affect only the optional offsite override.

### 4. Run the upload step

The profile-gated upload scans every local dump, compares the full remote
listing, and uploads every missing encrypted artifact—not only the newest. It
never invokes delete and therefore works with the delete-less credential:

```bash
cd /path/to/bettertrack/infra
docker compose \
    -f docker-compose.yml \
    -f docker-compose.subdomains.yml \
    -f docker-compose.offsite.yml \
    --profile offsite \
    run --rm backup-offsite
```

Run this from the trusted offsite control plane or backup product that owns the
upload credential. Local dumps do not depend on this optional step. If the
recipient or remote is unset, upload records `skipped_unconfigured`; an
explicitly configured but unreadable recipient fails.

### Optional remote pruning with a separate credential

Provider-side immutable retention, object lock, or version history is the
recommended default. If client-side pruning is unavoidable, create a second
rclone config with delete rights scoped only to the dedicated backup folder.
Never reuse the upload config.

```dotenv
BT_BACKUP_REMOTE_RETENTION_ENABLED=true
BT_BACKUP_RETENTION_RCLONE_CONFIG_HOST_FILE=/etc/bettertrack/rclone-retention.conf
BT_BACKUP_RETENTION_RCLONE_REMOTE=gdrive-retention:bettertrack-backups
BT_BACKUP_REMOTE_RETENTION_DAYS=30
```

Run the doubly gated step from the more trusted retention control plane:

```bash
docker compose \
    -f docker-compose.yml \
    -f docker-compose.subdomains.yml \
    -f docker-compose.offsite.yml \
    --profile offsite-retention \
    run --rm backup-offsite-retention
```

With the switch left `false`, the same command records `disabled`, exits
successfully, and never invokes `rclone delete`. Local and remote windows remain
independent; failed upload never triggers retention.

## Application data retention

Separate from the backup windows above: how long the app itself keeps its
identifying operational trails. A daily worker job (`data.retentionCleanup`,
04:50 Europe/Vienna) purges past-cutoff rows in bounded batches, so shortening a
window takes effect on the next run rather than in one long statement.

| Variable                      | Default | Notes                                                        |
| ----------------------------- | ------- | ------------------------------------------------------------ |
| `BT_AUDIT_RETENTION_DAYS`     | `400`   | Age at which `audit_log` rows are purged. `0` = keep forever |
| `BT_EMAIL_LOG_RETENTION_DAYS` | `180`   | Age at which `email_log` rows are purged. `0` = keep forever |

- Blank or unset uses the default; an explicit `0` disables that branch of the
  purge entirely (nothing is ever deleted from that table).
- Negative or fractional values are rejected at startup by the env schema.
- The same job retires remembered-device bindings (`remember_dev:*`) that
  predate their 400-day TTL — no operator action is needed, and it is a no-op
  once that population is gone.

An hourly worker job (`paranoid.retiredPurge`, minute 17 UTC) enforces the one
retention window that destroys user ciphertext: when a paranoid account switches
its vault to Drive-only, the previous server copy is kept as a recovery copy for
a fixed seven days and this job deletes it once that window has elapsed. It is
not operator-configurable — the window is a product guarantee, not an env var —
and it refuses any retirement whose account has server media again, a live vault
row or a staged candidate, so it can only ever complete a switch the user made.
Deletion is permanent and unrecoverable from the application side; only a
database backup predating the run holds those bytes. The run logs how many
copies it purged and, separately, how many it left in place because a guard
refused them. Each run restarts the sweep from the beginning of the account
order and stops at a per-run ceiling; the ceiling warning carries the cursor it
stopped at (`lastUserId`). Advancing between runs means it is working through a
backlog — the same cursor with a non-zero `skipped` every hour would mean
refused retirements are holding the ceiling, and those accounts need looking at.

## Recovering an offsite archive

Use a read-only recovery credential, not either production credential:

```bash
# List current objects. If one was removed, restore it from the provider's
# object versions, retention vault, or trash before continuing.
rclone --config /media/usb/rclone-recovery.conf \
    lsl gdrive-recovery:bettertrack-backups

rclone --config /media/usb/rclone-recovery.conf copy \
    gdrive-recovery:bettertrack-backups/bettertrack-20260715-030000.sql.gz.age \
    /tmp/bt-restore/

age -d -i /media/usb/bettertrack-backup-identity.txt \
    -o /tmp/bt-restore/bettertrack-20260715-030000.sql.gz \
    /tmp/bt-restore/bettertrack-20260715-030000.sql.gz.age
gzip -t /tmp/bt-restore/bettertrack-20260715-030000.sql.gz
```

Provider history is the availability boundary when the deploy host or upload
credential is compromised. Test version/trash recovery whenever provider
policy or credentials change.

### Restoring in place (production emergency)

After recovering and decrypting an archive, follow the production restore block
in `README.md`. Stop API writes **and** scheduled backups with
`docker compose stop api worker backup-scheduler` before placing the verified
`.sql.gz` in the backup volume. Keep all three services stopped until the
explicit restore completes so the scheduler cannot capture a partially rebuilt
schema. Then run `docker compose start api worker`, followed by
`docker compose start backup-scheduler`; the scheduler startup creates and
drills a fresh post-restore recovery point. Do not use the automated drill for
in-place recovery; it intentionally refuses the live database.

## Market-data provider failover

BetterTrack uses Yahoo as its primary market-data provider. The optional v5
failover chain adds the keyless Stooq provider for supported equities and ETFs;
crypto, FX, and commodities stay single-source. When Yahoo has a transient
failure or an open circuit breaker, the same quote/history read continues
through Stooq without changing the asset or cache key.

The chain is off by default. Set the following in `infra/.env`, then recreate
both market-data processes so API requests and worker refresh jobs use the same
configuration:

```dotenv
MARKET_FAILOVER_ENABLED=true
```

```bash
cd infra
docker compose up -d --force-recreate api worker
```

To verify it, sign in to the admin app, open **Health**, and request or refresh a
supported equity/ETF quote so an upstream provider has served traffic. The
provider failover panel shows the ordered `yahoo → stooq` chain, a badge for the
provider currently serving it, per-provider serve counts, and recent switch
events. The panel stays absent until a configured chain has served traffic; with
the flag off it remains absent.

Recovery needs no operator action. After Yahoo's circuit-breaker cooldown, the
next upstream refresh tries Yahoo in half-open state. A successful probe closes
the breaker, serves from Yahoo again, and records the switch back in **Health**;
a failed probe keeps Stooq serving and starts another cooldown. A still-fresh
cached quote can delay the probe and visible switch until the next upstream
refresh.

## Observability (Prometheus + Grafana)

Full monitoring ships **inside the deploy stack** — PROJECTPLAN.md §13.5 V5-P2
arc (a), §16 (2026-07-17). **There is nothing to set up.** No external account,
no SaaS console, no manual dashboard import: `docker compose up -d` in `infra/`
starts Prometheus, Grafana and the infra exporters (node / cAdvisor / postgres /
redis), all self-provisioning. For the full picture — the exporters, the admin
**Diagnostics** panel, and how to reach Grafana from **outside the LAN** through
an authenticated path (owner directive 2026-07-19) — see **`docs/monitoring.md`**.

```
┌──────────────┐   scrape api:9464/metrics   ┌──────────────┐   query   ┌──────────┐
│ api          │ ◀────────────────────────── │ prometheus   │ ◀──────── │ grafana  │
│  (metrics on │   internal docker network   │  (15d TSDB)  │           │  (dash-  │
│   0.0.0.0:   │   — NO host port published  │              │           │  boards) │
│   9464)      │                             │              │           │          │
└──────────────┘                             └──────┬───────┘           └────┬─────┘
                                                     │ 127.0.0.1:9090         │ 127.0.0.1:3001
                                                     ▼                        ▼
                                            localhost / LAN only — never the public origin
```

- **`prometheus`** (`prom/prometheus`) scrapes the API's dedicated `/metrics`
  listener (#564) over the internal compose network at `api:9464`. Config:
  `infra/prometheus/prometheus.yml`. Data persists in the `promdata` volume
  (15-day retention).
- **`grafana`** (`grafana/grafana-oss`) auto-provisions the Prometheus
  datasource (`infra/grafana/provisioning/datasources/`) and the starter
  dashboard **"BetterTrack — API & workers overview"**
  (`infra/grafana/dashboards/bettertrack-overview.json`) on first boot. It
  renders live: HTTP request rate + latency (p50/p95/p99), per-route counters,
  BullMQ queue depth + job outcomes, provider calls, market cache hit rate, and
  websocket connections. Data persists in the `grafanadata` volume.

### Exposure guarantee (localhost/LAN by default)

By default neither service is reachable from a public origin — the §16
(2026-07-17) posture is **localhost/LAN-only**. The owner later opted in
(2026-07-19) to **also** reach Grafana from outside the LAN, but **only through
an authenticated path** (admin-app proxy or an auth-gated subdomain), and never
Prometheus. That opt-in is off by default and password-gated; see
`docs/monitoring.md`. Everything below describes the default (unexposed) state.

- The API metrics listener binds `0.0.0.0` **inside** the api container so
  Prometheus can scrape it, but its port is **never** published to a host port,
  so it is unreachable from outside the docker network.
- Prometheus (`:9090`) and Grafana (`:3001`) publish host ports bound to
  **`BT_OBS_BIND_HOST`** (default `127.0.0.1` = localhost only). They are **not**
  added to any port overlay (`docker-compose.ports.yml` /
  `docker-compose.subdomains.yml`) and are **not** routed by the `web`/nginx
  front proxy — verifiable in `infra/docker-compose.yml` and `infra/nginx/`.

### Reaching Grafana

- **From the deploy host** — open `http://127.0.0.1:3001`.
- **Over SSH from your laptop** (keeps the default localhost bind):

  ```
  ssh -N -L 3001:127.0.0.1:3001 you@deploy-host
  # then open http://localhost:3001 on your laptop
  ```

- **From your LAN** — set `BT_OBS_BIND_HOST` in `infra/.env` to the host's LAN
  IP (e.g. `192.168.1.10`), `docker compose up -d`, then open
  `http://192.168.1.10:3001`. **Never** set it to `0.0.0.0` on a public host.

Log in with `BT_GRAFANA_ADMIN_USER` / `BT_GRAFANA_ADMIN_PASSWORD` from
`infra/.env` — change the default before first boot. Sign-up and anonymous
access are disabled. See `infra/.env.production.example` for every knob.

## Troubleshooting

**`backup-scheduler` is unhealthy** — inspect
`/status/backup-status.env` inside that service. `health_reason` distinguishes a
missing/stale dump, a missing/truncated artifact, and missing/stale restore
evidence. Run `backup.sh` for dump freshness or `restore-drill.sh` for restore
evidence after resolving the underlying database error.

**"offsite skipped (unset: …)"** — one or both of
`BT_BACKUP_AGE_RECIPIENT_FILE` / `BT_BACKUP_RCLONE_REMOTE` is empty inside
the sidecar. Check that `infra/.env` sets `BT_BACKUP_RCLONE_REMOTE` and the
`_HOST_FILE` vars, and that the override file is actually layered on the
compose command.

**"ERROR: recipient file not readable"** — the compose bind mount didn't
resolve to a real file. Check that `BT_BACKUP_AGE_RECIPIENT_HOST_FILE`
points at an existing, readable file on the host.

**Rclone upload fails but the local dump is still there** — expected;
the local dump is preserved on any offsite failure. Inspect the one-shot
container output and `offsite_outcome` in the status file. The next run scans
every eligible local dump, skips remote artifacts, and retries every missing
one.

**The remote keeps every archive** — this is the safe default. Configure
provider-side lifecycle/version retention, or explicitly enable and run
`backup-offsite-retention` with its separate deletion credential. The upload
service will never prune.
