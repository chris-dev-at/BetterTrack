# Dev box — `*.dev.bettertrack.at`

A permanently-running, publicly reachable staging deployment that behaves like the live server,
not like `vite dev`: the same images, the same front proxy, the same five-origin topology
(PROJECTPLAN.md §4.6, §11), behind Cloudflare exactly the way the production box sits behind it
(`infra/live/edge/bt-live-edge.conf`). Plus one thing production does not have: the north-star
redesign demo on its own `demo.` origin.

| Origin                      | Serves                       | Container         |
| --------------------------- | ---------------------------- | ----------------- |
| `web.dev.bettertrack.at`    | user SPA (`app: "user"`)     | `web` (static)    |
| `admin.dev.bettertrack.at`  | admin SPA (`app: "admin"`)   | `web` (static)    |
| `api.dev.bettertrack.at`    | Express API + `/ws` realtime | `web` → `api`     |
| `demo.dev.bettertrack.at`   | north-star redesign demo     | `web` → `demo`    |
| `dev.bettertrack.at` (apex) | static product landing       | `web` → `landing` |
| `mobile.dev.bettertrack.at` | static mobile placeholder    | `web` → `landing` |

Everything is one published host port (`:80` on the `web` front proxy). No other container binds a
public port.

## Files

| Path                                                | What it is                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `infra/docker-compose.devbox.yml`                   | the overlay — project name, volumes, `demo` service, conf mounts |
| `infra/devbox/edge/bt-devbox-edge.conf`             | the dev-box edge conf mounted into `web`'s `conf.d`              |
| `infra/devbox/edge/edge-secret.disabled.inc`        | edge-gate stub (open); the compose default                       |
| `infra/devbox/edge/edge-secret.enabled.inc.example` | copy OUTSIDE the repo to enforce the gate                        |
| `infra/devbox/demo.Dockerfile`                      | builds `apps/redesign-demo` into a static nginx image            |
| `infra/devbox/demo-nginx.conf`                      | the demo container's static server + CSP                         |
| `infra/.env.devbox.example`                         | every variable, with what breaks if it is wrong                  |

Nothing in `infra/docker-compose.yml`, `infra/docker-compose.subdomains.yml` or
`infra/nginx/templates/` is modified — those are shared with production. Production has no demo
origin, so the demo server block lives only in the dev-box conf.

## Prerequisites

**Host**

- Docker with Compose v2 (`docker compose version`).
- **Port 80 free.** This host currently serves the north-star demo directly on `:80`. Cloudflare's
  proxy connects to the origin on `:80` for plain HTTP, so the front proxy must have it — there is
  no alternative port that keeps the hostnames working. Stop the current demo server first; the
  demo comes back at `demo.dev.bettertrack.at` once this stack is up.
- Free host ports `3011` (Grafana) and `9091` (Prometheus), both bound to `127.0.0.1` only. Change
  them in the env file if something already holds them.

**Repo**

- `apps/redesign-demo/` must be present in the checkout you build from. **It is currently untracked
  in git** — a fresh clone does not have it, and `docker compose … build demo` fails at the `COPY`
  with a clear error. It is also inside the pnpm workspace glob (`apps/*`) with no entry in
  `pnpm-lock.yaml`, which is why `infra/devbox/demo.Dockerfile` deliberately copies no lockfile and
  resolves the demo's dependencies fresh (they are therefore not pinned). Committing the demo app,
  and its lockfile entry, removes both caveats.

**Cloudflare** (records already exist; nothing here needs changing)

- `web` / `admin` / `api` / `demo` under `dev.bettertrack.at` are **proxied** (orange-cloud) CNAMEs
  or A records pointing at this host.
- **TLS terminates at Cloudflare.** The origin hop is plain HTTP on `:80` — the same arrangement as
  the live box. SSL/TLS mode must be the one that talks HTTP to the origin (Flexible); with Full or
  Full (Strict) Cloudflare would try `:443` on this host and nothing is listening there.
- The certificate limit that decides the naming shape: free Universal SSL covers `bettertrack.at`
  and `*.bettertrack.at` — **one** level. `*.dev.bettertrack.at` is a second-level wildcard and is
  **not** covered without Advanced Certificate Manager or a per-host certificate. See below.

## Naming shape: pick one, edit five lines

Both shapes work from the env file alone. No compose file, nginx conf or Dockerfile changes.

**Shape A (default)** — `BT_DOMAIN=dev.bettertrack.at`, `BT_SUB_WEB=web`, `BT_SUB_API=api`,
`BT_SUB_ADMIN=admin`, `BT_SUB_MOBILE=mobile`. Hostnames: `web.dev.bettertrack.at`, … Needs an edge
certificate covering `*.dev.bettertrack.at`.

**Shape B (fallback)** — `BT_DOMAIN=bettertrack.at`, `BT_SUB_WEB=web-dev`, `BT_SUB_API=api-dev`,
`BT_SUB_ADMIN=admin-dev`, `BT_SUB_MOBILE=mobile-dev`. Hostnames: `web-dev.bettertrack.at`, … Covered
by the free `*.bettertrack.at` certificate.

If a dev-box hostname shows a browser certificate error while the production hostnames are fine,
that is the wildcard limit and shape B is the fix.

What follows the shape automatically:

- the demo origin — the edge conf matches `demo.` and `demo-dev.` by regex, so it needs no domain;
- the api-origin hardening — that server block lists both shapes' hostnames, and the one the env
  selects is the one that takes effect;
- CORS, cookie `Secure`, the SPA's `config.js`, the rendered CSP, and every generated link, all
  derived from `BT_MODE` + `BT_DOMAIN` + `BT_SUB_*`.

What does **not** follow automatically: `BT_API_ORIGIN` / `BT_WEB_ORIGIN` / `BT_ADMIN_ORIGIN`. The
example file sets them explicitly for shape A. Update them too, or blank all three and let
derivation produce them — a stale explicit origin wins over derivation and shows up as a CORS
failure that looks like a browser bug.

Under shape B the apex origin renders as the production hostname `bettertrack.at`. Nothing points
there, so the block is inert — do not create an apex or `www` record aimed at this box. Session
cookies are host-only (no `Domain` attribute), so a `api-dev.bettertrack.at` cookie is never sent to
`api.bettertrack.at`; sharing the parent domain is safe for cookies and is not a reason to share
secrets.

## One-time setup

```bash
cd /path/to/BetterTrack

cp infra/.env.devbox.example infra/.env.devbox
$EDITOR infra/.env.devbox
```

Fill in every `CHANGE_ME`. **All of them must differ from production** — a shared `SESSION_SECRET`
makes a dev-box session cookie replayable against production, and a shared
`BT_DATA_ENCRYPTION_KEY` lets anyone with dev-box access decrypt production TOTP/Discord records.

```bash
openssl rand -hex 64        # SESSION_SECRET, BT_DATA_ENCRYPTION_KEY
openssl rand -base64 24     # POSTGRES_PASSWORD, ADMIN_PASSWORD, BT_GRAFANA_ADMIN_PASSWORD
openssl rand -hex 32        # the edge secret, if you enable the gate
```

`infra/.env.devbox` is git-ignored. Never commit a filled-in copy.

## The compose invocation

Three files, in this order, every time. The order matters: the last file wins, and the devbox
overlay is what sets the project name and the volume names.

Define this once per shell — it works identically in zsh and bash (a plain `export BT_DEVBOX="-f …"`
does **not**: zsh performs no word splitting on unquoted expansion and would pass the whole string as
one argument):

```sh
btdev() {
  docker compose \
    -f infra/docker-compose.yml \
    -f infra/docker-compose.subdomains.yml \
    -f infra/docker-compose.devbox.yml \
    --env-file infra/.env.devbox "$@"
}
```

Run every command below from the repo root. Verify the rendering before anything else — this only
renders and validates, it starts nothing:

```bash
btdev config | head -5
# name: bettertrack-devbox     ← must say devbox, not "bettertrack" and not "bettertrack-dev"
```

Without the function, spell all four flags out every time. Any command that omits them — plain
`docker compose -f infra/docker-compose.yml …` — is the **production** project, on production
volumes.

## First bring-up

Staged on purpose: nothing takes port 80 until nginx has been proven to accept the config.

```bash
# 1. Build every image (this is the step that needs apps/redesign-demo present).
btdev build

# 2. Start the backing services. None of these publish a public port.
btdev up -d db redis api landing demo

# 3. Migrate, then seed the first admin. The seed is a no-op if the admin exists.
btdev run --rm api node dist/scripts/migrate.js
btdev run --rm api node dist/scripts/seed.js

# 4. Prove the front proxy accepts the merged config BEFORE it takes port 80.
#    This renders the template exactly as at boot, then runs `nginx -t` instead of
#    starting nginx. It publishes no host port. Upstreams resolve because step 2
#    is running.
btdev run --rm --no-deps --entrypoint /bin/sh web -c \
  'sed "s|^exec nginx .*|nginx -t|" /usr/local/bin/bt-web-entrypoint.sh > /tmp/t.sh && sh /tmp/t.sh'
# expect: "syntax is ok" + "test is successful", plus a benign
#         "conflicting server name" warning for the api hostname (see below).

# 5. Free port 80 on the host (stop the current demo server), then start everything.
btdev up -d
```

`ADMIN_EMAIL` / `ADMIN_PASSWORD` from the env file are what the seed uses. If you would rather not
leave the admin password in the file, blank it there and pass it to that one command:

```bash
btdev run --rm -e ADMIN_PASSWORD="$(openssl rand -base64 24)" api node dist/scripts/seed.js
```

…noting that you then have to read it off your own terminal — the seed never prints credentials.

**Then, in the admin app: confirm Registration mode is `Closed`.** There is no env variable for it;
it is an `app_settings` row whose default is `closed`
(`apps/api/src/services/appSettings/appSettingsService.ts`, `DEFAULT_REGISTRATION_MODE`). Closed is
the only mode enforced in V1 and the only correct one for a box on the public internet. Users are
created by the admin, or by invite.

## Verify

```bash
btdev ps            # every service Up; api and worker healthy
btdev exec web nginx -t
```

From anywhere on the internet:

```bash
curl -s https://api.dev.bettertrack.at/api/v1/health
curl -s https://api.dev.bettertrack.at/api/v1/version      # no auth; shows the deployed sha
curl -s https://web.dev.bettertrack.at/config.js           # window.__BT__ = { app: "user",  apiOrigin: … }
curl -s https://admin.dev.bettertrack.at/config.js         # window.__BT__ = { app: "admin", apiOrigin: … }
curl -sI https://demo.dev.bettertrack.at/ | head -1
```

`config.js` is the check that matters: `apiOrigin` there must be byte-identical to the origin the
API derives, or the SPA loads and every request is blocked by CORS.

On the host only (never public):

```bash
curl -s http://127.0.0.1:9091/-/healthy      # Prometheus
open http://127.0.0.1:3011                   # Grafana
```

A direct request with an unknown `Host` gets no response at all — the edge conf's catch-all returns
`444`. That is intentional, so do not health-check the box with `curl http://localhost/`; pass a
real hostname (`curl -H 'Host: api.dev.bettertrack.at' http://127.0.0.1/api/v1/health`).

## Day-2

**Logs**

```bash
btdev logs -f --tail=100 web
btdev logs -f --tail=100 api worker
btdev logs --since=15m api | grep -i error
```

**Redeploy after a code change**

```bash
btdev build web api worker landing demo
btdev run --rm api node dist/scripts/migrate.js
btdev up -d web api worker landing demo
```

Build `worker` explicitly. A `web`+`api`-only redeploy is exactly how the 2026-07-11 live incident
happened — the worker stayed frozen on its first-bring-up image (see `infra/live/README.md`). To
stamp the deploy marker so `/api/v1/version` is truthful:

```bash
export GIT_SHA="$(git rev-parse HEAD)" GIT_BUILD_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
```

**Edge conf change** — `infra/devbox/edge/bt-devbox-edge.conf` is a bind mount, so nginx picks it up
on reload. Always validate first; a rejected config leaves the running nginx untouched:

```bash
btdev exec web nginx -t && btdev exec web nginx -s reload
```

**Stop / start**

```bash
btdev stop          # keeps containers and data
btdev up -d
btdev down          # removes containers, KEEPS volumes
```

**Reset the box to empty**

```bash
btdev down -v       # DESTROYS bt-devbox-* volumes: db, redis, exports, backups, metrics
btdev up -d db redis api
btdev run --rm api node dist/scripts/migrate.js
btdev run --rm api node dist/scripts/seed.js
btdev up -d
```

`-v` only ever touches `bt-devbox-*`. The production stack's volumes and the local dev stack's
`bettertrack-dev_pgdata` / `bettertrack-dev_redisdata` (the ones behind `localhost:5432` / `:6379`)
are different Docker volumes with different names and are not reachable from this project. That
separation is the whole reason the overlay renames both the project and the volumes — but it only
holds if you always pass all three `-f` files. `docker compose -f infra/docker-compose.yml …` on its
own is the **production** project.

## Exposure

Once this is up, the public internet can reach:

- **the API** (`api.`) — the full `/api/v1` surface, `/docs`, and the realtime `/ws`. Inherently
  public: the SPA is a browser app and calls it cross-origin.
- **the admin console** (`admin.`) — the login page. The API refuses admin routes without an
  admin-kind session and returns 404 rather than 403 to non-admins, but the login form itself is
  reachable and is a credential-stuffing target.
- **the user SPA** (`web.`), **the demo** (`demo.`), and the static apex/mobile pages.

Not reachable from the internet, and it must stay that way: Grafana, Prometheus, Postgres, Redis and
the metrics listeners. They bind `127.0.0.1` or no host port at all, and none is routed through the
front proxy.

**One caveat to understand.** Real client IPs are recovered from Cloudflare's `CF-Connecting-IP`
header for any private-range peer, because Docker Desktop NATs every inbound connection — the same
arrangement as the live box. That means anything reaching this origin **directly**, bypassing
Cloudflare, also arrives from a private address and can therefore forge `CF-Connecting-IP`, i.e.
forge the rate-limit key. The edge-secret gate is the answer.

**Available mitigations, in order of value:**

1. **Cloudflare Access in front of `admin.`** — an identity gate before the request ever reaches
   this host. This removes the admin login from the public internet entirely. Set it up in the
   Cloudflare dashboard (Zero Trust → Access → Applications, host `admin.dev.bettertrack.at`, policy
   = your email). Not implemented here; it is a dashboard change, not a repo change.
2. **The edge-secret gate**, already wired in `bt-devbox-edge.conf` and off by default. A Cloudflare
   Transform Rule stamps `x-bt-edge: <secret>` on every proxied request; the api and demo origins
   return `444` to anything without it. This is what makes direct-to-origin requests — and therefore
   `CF-Connecting-IP` forgery — impossible. Enable it in this order:
   ```bash
   cp infra/devbox/edge/edge-secret.enabled.inc.example ~/bt-devbox/edge-secret.inc
   $EDITOR ~/bt-devbox/edge-secret.inc        # paste `openssl rand -hex 32`
   # Cloudflare: Rules → Transform Rules → Modify Request Header → set x-bt-edge to the same value,
   # on the dev-box hostnames. VERIFY the rule is live before the next step.
   # infra/.env.devbox: BT_DEVBOX_EDGE_SECRET_INC=/Users/you/bt-devbox/edge-secret.inc
   btdev up -d web
   ```
   Rule first, mount second. The other order closes every connection including yours.
3. **Registration mode `Closed`** — the default; verify it after first boot and leave it. Nobody
   self-registers; accounts are admin-created or invited.
4. **Rate limits** at their defaults. `RATE_LIMIT_BURST_*` is a per-user capacity control and is
   sized for normal use (§10); the control that bounds credential stuffing from one source is
   `RATE_LIMIT_LOGIN_IP_LIMIT`, and raising _that_ on a public box raises how much a single source
   may attempt.
5. **No production anything** — separate secrets, separate database, no production data, no
   production SMTP sender, no production push credentials.

**Recommended default posture:** Cloudflare Access on `admin.` + edge-secret gate enabled +
registration Closed + default rate limits + a unique admin password. That leaves exactly one
deliberately public surface — the API and the two SPAs — which is the point of the box.

## What is different from production, and why

| Difference                                                                | Why                                                                                            |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Project `bettertrack-devbox`, volumes `bt-devbox-*`                       | so this box can never adopt or corrupt the production or local-dev database                    |
| A `demo` service and a `demo.` origin                                     | the north-star demo moved off the apex; production has no demo origin                          |
| `X-Robots-Tag: noindex, nofollow` on **every** origin, including the apex | a public copy of the product site would otherwise compete with `bettertrack.at` in search      |
| A `default_server` returning `444`                                        | the live box reroutes unmatched hosts to the legacy sites; this box serves nothing else        |
| No legacy-sites reroute, no `legacy-upstream.inc`                         | same reason                                                                                    |
| No auto-updater, no self-adopting edge pipeline                           | deploys here are manual and deliberate; `infra/live/updater.sh` is not part of this stack      |
| No offsite backup sidecar, `BACKUP_RETENTION_DAYS=7`                      | dev-box data is disposable                                                                     |
| Email / push / Drive OAuth off                                            | a dev box must not send mail as the production sender or push to real devices                  |
| Grafana on `127.0.0.1:3011`, Prometheus on `:9091`                        | non-default host ports so they cannot collide with the local dev stack or a running dev server |
| The demo's dependencies are not lockfile-pinned                           | `apps/redesign-demo` is untracked and absent from `pnpm-lock.yaml` (see Prerequisites)         |

Everything else is deliberately identical: same Dockerfiles, same front proxy image and template,
same `BT_MODE=subdomains` five-origin layout, same Cloudflare-terminates-TLS / origin-on-plain-`:80`
hop, same `CF-Connecting-IP` real-IP recovery, same worker, same migrations, same seed.

## Known traps

- **"conflicting server name" in the nginx log.** Expected and benign. The dev-box conf loads before
  the rendered template and intentionally shadows the template's api block to add the Cloudflare
  header handling. Same warning as on the live box.
- **`nginx -t` says "host not found in upstream".** The `web` container resolves `api`, `landing`
  and `demo` by name at config load, so all three must already be running — that is what bring-up
  step 2 is for. It is also why the `web` service waits on `demo` in the overlay: without that,
  a restart could bring nginx up before the demo container exists and the front proxy would refuse
  to boot.
- **The demo build fails at the `COPY`.** `apps/redesign-demo/` is not in the build context. Either
  build from the checkout that has it, or — as a stop-gap only — run the demo from its pre-built
  `dist/` by adding a tiny local override that replaces the `demo` service's `build:` with
  `image: nginx:alpine` plus a read-only bind mount of `apps/redesign-demo/dist` onto
  `/usr/share/nginx/html`. Keep that override out of the repo.
- **`cadvisor` or `node-exporter` will not start.** They mount host paths and `/dev/kmsg`, which
  Docker Desktop on macOS does not always provide. They are metrics exporters only — nothing else
  depends on them, so skip them and let Prometheus show those two targets as down:

  ```bash
  btdev up -d --scale cadvisor=0 --scale node-exporter=0
  ```

- **Port 80 already in use.** Something else on the host still holds it. The stack cannot move to
  another port and stay reachable through Cloudflare's proxy.
- **A blank page with CORS errors in the browser console.** `BT_API_ORIGIN` / `BT_WEB_ORIGIN` /
  `BT_ADMIN_ORIGIN` disagree with `BT_DOMAIN` + `BT_SUB_*`. Compare `curl https://web…/config.js`
  against the origin the API derives.
