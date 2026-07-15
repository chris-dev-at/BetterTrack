# BetterTrack ops runbook

Operations reference for the self-hosted deploy. This document is the source of
truth for the backup + restore procedure (PROJECTPLAN.md §10, §13.4 V4-P6).
Deploy topology lives in `README.md`; app-level config lives in
`infra/.env.production.example`.

## Backup architecture

Two independent layers, both env-gated. The offsite layer is OPTIONAL — the
stack keeps working without it exactly as it did before V4-P6.

```
┌─────────────────────┐   pg_dump | gzip                    ┌────────────┐
│ db container        │ ──────────────────────────────────▶ │ pgbackups  │
│  (postgres:17)      │   backup.sh                         │  volume    │
│                     │   local retention: 14d              │ /backups   │
└─────────────────────┘                                     └─────┬──────┘
                                                                  │ read-only
                                                                  ▼
                                                        ┌───────────────────┐
              age (encrypt-to-recipient) + rclone       │ backup-offsite    │
              ─ optional sidecar, host cron ─────────── │  (sidecar)        │
                                                        │  offsite.sh       │
                                                        │  remote retention │
                                                        │  30d              │
                                                        └────────┬──────────┘
                                                                 │
                                                     rclone copy │
                                                                 ▼
                                                        ┌───────────────────┐
                                                        │ Google Drive      │
                                                        │ (or any rclone    │
                                                        │  remote — `local` │
                                                        │  works for drills)│
                                                        └───────────────────┘
```

**Local layer (always on).** `infra/backup/backup.sh` runs inside the `db`
service via `docker compose exec`, produces
`bettertrack-YYYYmmdd-HHMMSS.sql.gz` into the `pgbackups` volume, verifies the
archive (`gzip -t`), then deletes dumps older than `BACKUP_RETENTION_DAYS`
(default 14). Configure it in `infra/.env`; run it from host cron.

**Offsite layer (optional).** `infra/backup/offsite.sh` runs inside the
`backup-offsite` sidecar (`infra/docker-compose.offsite.yml`). It reads the
shared `pgbackups` volume read-only, encrypts the newest local dump with `age`
to an owner-provided PUBLIC recipient, uploads via `rclone` to a configured
remote (Google Drive in production; any rclone backend works, including
`local` for drills), then prunes remote objects older than
`BT_BACKUP_REMOTE_RETENTION_DAYS` (default 30). If either the recipient or
the remote is unset, it logs one `offsite skipped` line and exits 0.

### Security posture

- **Encrypt-only on the box.** The server only ever sees the age recipient
  (a `age1...` public key). The matching identity (private key) stays
  OFFLINE with the owner and is never present on the deploy host, in any
  image, in git, or in any environment variable.
- **rclone.conf is a secret.** It contains OAuth refresh tokens for the
  Drive remote. It lives on the host filesystem, is bind-mounted read-only
  into the sidecar, and is never committed or logged. `offsite.sh` runs
  without `set -x` so no tracing exposes it.
- **Plaintext dumps never leave the box.** Only the `.sql.gz.age` artifact
  is uploaded; the plaintext `.sql.gz` stays inside the `pgbackups` volume
  under `BACKUP_RETENTION_DAYS` local retention.
- **Encrypted artifact is atomic.** It is encrypted to a temp path, uploaded,
  and only then removed. A failed upload leaves the local `.sql.gz`
  untouched and exits non-zero so cron surfaces the failure; the next run
  finds the same dump and tries again.

## Enabling offsite backup

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

### 2. Configure the rclone Drive remote (one time)

On the deploy host:

```bash
# Install rclone (Debian/Ubuntu: apt-get install rclone; or download the
# static binary from rclone.org — the sidecar has its own copy either way).
rclone config
#   n) New remote
#   name> gdrive
#   Storage> drive
#   client_id>       (leave blank — uses rclone's default, or set your own)
#   client_secret>   (blank)
#   scope> 1         (Full access — required for delete-on-prune)
#   root_folder_id>  (optional; the id of a dedicated backup folder in Drive)
#   service_account_file> (blank — interactive user login)
#   Edit advanced config> n
#   Use auto config> n (headless server; follow the browser dance on a
#                       machine that has one, paste the resulting token)
```

Store the resulting `~/.config/rclone/rclone.conf` at a stable host path
(e.g. `/etc/bettertrack/rclone.conf`), root-owned, mode `0600`. This file
contains a Google OAuth refresh token — treat as a secret.

Verify manually:

```bash
rclone --config /etc/bettertrack/rclone.conf lsd gdrive:
rclone --config /etc/bettertrack/rclone.conf mkdir gdrive:bettertrack-backups
```

### 3. Fill in `infra/.env`

```dotenv
BT_BACKUP_AGE_RECIPIENT_HOST_FILE=/etc/bettertrack/age-recipient
BT_BACKUP_RCLONE_CONFIG_HOST_FILE=/etc/bettertrack/rclone.conf
BT_BACKUP_RCLONE_REMOTE=gdrive:bettertrack-backups
BT_BACKUP_REMOTE_RETENTION_DAYS=30
```

The base compose file does NOT know about these — they only take effect
when the offsite override is layered on the compose stack (next step).

### 4. Layer the offsite override + wire cron

`docker-compose.offsite.yml` adds the `backup-offsite` sidecar (an alpine
image with `age` + `rclone`). It is `profiles: [offsite]`-gated: even with
the override on the stack, `up -d` leaves it stopped. Invoke it as a
one-shot after `backup.sh`:

```bash
# Host crontab (crontab -e) — nightly at 03:00 server time:
0 3 * * * cd /path/to/bettertrack/infra && \
    docker compose exec -T db bash /opt/bettertrack/backup.sh && \
    docker compose -f docker-compose.yml \
                   -f docker-compose.subdomains.yml \
                   -f docker-compose.offsite.yml \
                   run --rm backup-offsite \
    >> /var/log/bettertrack-backup.log 2>&1
```

The `&&` sequencing means the offsite step only runs if the local dump
succeeded; a failed dump aborts before uploading anything stale.

Take a manual offsite run on demand (same command, sans cron), or bypass
the local step to re-upload the latest dump:

```bash
cd /path/to/bettertrack/infra
docker compose -f docker-compose.yml \
               -f docker-compose.subdomains.yml \
               -f docker-compose.offsite.yml \
               run --rm backup-offsite
```

## Environment reference

| Variable                            | Layer      | Default    | Notes                                                                                   |
| ----------------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------- |
| `BACKUP_RETENTION_DAYS`             | local      | `14`       | Days of local `.sql.gz` dumps kept in the `pgbackups` volume                            |
| `BT_BACKUP_AGE_RECIPIENT_HOST_FILE` | offsite    | (unset)    | Host path to age recipient file; bind-mounted into the sidecar. Unset ⇒ offsite skipped |
| `BT_BACKUP_RCLONE_CONFIG_HOST_FILE` | offsite    | (unset)    | Host path to `rclone.conf` (Drive tokens); bind-mounted read-only                       |
| `BT_BACKUP_RCLONE_REMOTE`           | offsite    | (unset)    | Rclone remote target, e.g. `gdrive:bettertrack-backups`. Unset ⇒ offsite skipped        |
| `BT_BACKUP_REMOTE_RETENTION_DAYS`   | offsite    | `30`       | Days of encrypted artifacts kept on the remote (per V4-P6 arc-b acceptance)             |
| `BT_BACKUP_AGE_RECIPIENT_FILE`      | (internal) | (fixed)    | In-container path — set by the compose override to `/etc/bettertrack/age-recipient`     |
| `BT_BACKUP_SOURCE_DIR`              | (internal) | `/backups` | In-container path to the shared `pgbackups` mount — do not change                       |

### Retention contract

- **Local:** every run of `backup.sh` deletes local dumps older than
  `BACKUP_RETENTION_DAYS`. Default 14 days.
- **Remote:** every successful run of `offsite.sh` deletes remote objects
  matching `bettertrack-*.sql.gz.age` that are older than
  `BT_BACKUP_REMOTE_RETENTION_DAYS`. Default 30 days.
- The two windows are independent; changing one does not affect the other.
- A failed upload does NOT trigger a prune — retention stays at whatever
  the last successful run set it to.

## Restore drill

The drill below restores a chosen encrypted dump onto a fresh scratch
Postgres and verifies the schema/row counts match expectations. Run it at
least once at the V4 gate (per §13.4 acceptance) and any time the age
identity or rclone remote changes.

### Prerequisites

- `age` v1.x AND `rclone` v1.60+ on the machine you drill from (the
  sidecar has its own copies; the drill runs OUTSIDE that container).
- The offline age IDENTITY file, e.g. `bettertrack-backup-identity.txt`
  (bring it from cold storage; keep it offline again after).
- Access to the rclone remote (the same `rclone.conf` used by the sidecar,
  or a separate identity that can read the backup folder).
- A scratch Postgres 17 you can freely trash — the compose dev stack
  (`docker compose -f infra/docker-compose.dev.yml up -d db`) is perfect.

### Steps

```bash
# 1. Pick a dump to restore. List what's on the remote:
rclone --config /etc/bettertrack/rclone.conf lsl gdrive:bettertrack-backups \
    | grep '.sql.gz.age'
# Choose one — e.g. bettertrack-20260715-030000.sql.gz.age

# 2. Fetch it to a scratch directory (NOT the deploy host's backup volume).
mkdir -p /tmp/bt-restore && cd /tmp/bt-restore
rclone --config /etc/bettertrack/rclone.conf copy \
    gdrive:bettertrack-backups/bettertrack-20260715-030000.sql.gz.age .

# 3. Decrypt using the offline identity (bring it in, use it, take it back
#    offline). age reads the identity from a file with `-i`.
age -d -i /media/usb/bettertrack-backup-identity.txt \
    -o bettertrack-20260715-030000.sql.gz \
    bettertrack-20260715-030000.sql.gz.age

# 4. Verify the gzip is intact.
gzip -t bettertrack-20260715-030000.sql.gz && echo 'gzip ok'

# 5. Bring up a SCRATCH Postgres 17 and pipe the dump in. The dumps were
#    taken with --clean --if-exists, so the restore drops+recreates every
#    object itself; a bone-empty database works fine as the target.
docker run -d --name bt-restore-scratch \
    -e POSTGRES_USER=bt -e POSTGRES_PASSWORD=scratch -e POSTGRES_DB=bettertrack \
    -p 55432:5432 postgres:17
# Wait ~10s for the container to accept connections, then:
gunzip -c bettertrack-20260715-030000.sql.gz \
    | docker exec -i -e PGPASSWORD=scratch bt-restore-scratch \
        psql -U bt -d bettertrack

# 6. Sanity check — the schema and a handful of table sizes should look
#    right for the day the dump was taken.
docker exec -e PGPASSWORD=scratch bt-restore-scratch \
    psql -U bt -d bettertrack -c '\dt' | head -20
docker exec -e PGPASSWORD=scratch bt-restore-scratch \
    psql -U bt -d bettertrack -c \
    "select relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc limit 10;"

# 7. Tear down the scratch DB.
docker rm -f bt-restore-scratch
rm -rf /tmp/bt-restore
```

The drill is considered PASSED if step 4 (`gzip ok`), step 5 (psql exits 0),
and step 6 (tables present, non-trivial row counts on user-owned tables)
all succeed. Log the drill result in the operations journal per the V4-P6
acceptance criterion.

### Restoring in place (production emergency)

Same procedure, but at step 5 restore into the running `db` container
after stopping api + worker (see the "Restore from a dump" block in
`README.md` — the local-dump variant of this procedure). The offsite
artifact is a superset of that dump; once decrypted it's a normal
`.sql.gz` file usable with the existing local-restore procedure.

## Troubleshooting

**"offsite skipped (unset: …)"** — one or both of
`BT_BACKUP_AGE_RECIPIENT_FILE` / `BT_BACKUP_RCLONE_REMOTE` is empty inside
the sidecar. Check that `infra/.env` sets `BT_BACKUP_RCLONE_REMOTE` and the
`_HOST_FILE` vars, and that the override file is actually layered on the
compose command.

**"ERROR: recipient file not readable"** — the compose bind mount didn't
resolve to a real file. Check that `BT_BACKUP_AGE_RECIPIENT_HOST_FILE`
points at an existing, readable file on the host.

**Rclone upload fails but the local dump is still there** — expected;
the local dump is preserved on any offsite failure. Inspect
`/var/log/bettertrack-backup.log`; the next successful run picks the same
dump and retries the upload.

**Drive fills up despite the 30-day retention** — the prune step runs only
after a SUCCESSFUL upload. If uploads have been failing (see above),
retention stops advancing. Fix the upload path first, then the next
success will prune the backlog.
