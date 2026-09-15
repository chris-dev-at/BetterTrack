# Monitoring (Prometheus + Grafana + exporters)

BetterTrack ships its own monitoring **inside the deploy stack** — PROJECTPLAN.md
§13.5 V5-P2 arc (a). There is **nothing to sign up for**: `docker compose up -d`
in `infra/` (and every live auto-deploy) starts a self-provisioning Prometheus +
Grafana + a set of infra exporters. This page covers **what runs**, **how it is
reached**, and the **two external-access options** the owner chose to add on
2026-07-19.

> **Owner directive (2026-07-19).** This deliberately **extends** the earlier
> "localhost/LAN only, never public" decision (§16, 2026-07-17): the owner wants
> to reach monitoring from outside the LAN too. External access is therefore
> **always authenticated and never raw-public**. Prometheus (which has no auth of
> its own) is **never** directly exposed; only Grafana (which has a login) or the
> admin-app proxy (which inherits admin auth) is reachable.

## What runs

```
              scrape (internal docker network — no host ports on exporters)
  ┌───────────────┬───────────────┬────────────────┬────────────────┐
  │ api:9464      │ node-exporter │ cadvisor:8080  │ postgres-exp.  │  redis-exp.
  │  /metrics     │  :9100 host   │  containers    │  :9187 db      │  :9121 cache
  └───────┬───────┴───────┬───────┴────────┬───────┴───────┬────────┘
          └───────────────┴────────┬───────┴───────────────┘
                                    ▼
                            ┌──────────────┐   query   ┌──────────┐
                            │ prometheus   │ ◀──────── │ grafana  │
                            │  (15d TSDB)  │           │ dashboards│
                            └──────┬───────┘           └────┬─────┘
                     127.0.0.1:9090│                        │127.0.0.1:3001
                                   ▼                        ▼
                         localhost only         +   localhost / LAN bind
                         (no login of its own)      + authenticated external path (opt-in)
```

| Service             | Image                                   | Scrapes / shows                          | Host port                      |
| ------------------- | --------------------------------------- | ---------------------------------------- | ------------------------------ |
| `prometheus`        | `prom/prometheus`                       | everything below (15-day TSDB)           | `BT_PROMETHEUS_BIND_HOST:9090` |
| `grafana`           | `grafana/grafana-oss`                   | dashboards over Prometheus               | `BT_OBS_BIND_HOST:3001`        |
| `node-exporter`     | `prom/node-exporter`                    | host CPU / memory / disk / network       | **none** (internal only)       |
| `cadvisor`          | `gcr.io/cadvisor/cadvisor`              | per-container CPU / mem / IO             | **none**                       |
| `postgres-exporter` | `prometheuscommunity/postgres-exporter` | DB connections, cache hit ratio, commits | **none**                       |
| `redis-exporter`    | `oliver006/redis_exporter`              | cache memory, hit rate, evictions        | **none**                       |

The exporters publish **no host ports at all** — Prometheus reaches them by
service name over the internal docker network, so they are unreachable from any
host origin. Scrape config: `infra/prometheus/prometheus.yml`.

### Auto-start on deploy

The live auto-updater (`infra/live/updater.sh`) brings the whole monitoring
stack up in its `docker compose up -d …` list on every deploy — they are
**pulled** images, so they are not in the `docker compose build` list. This is
pinned by `apps/api/src/__tests__/liveDeployTopology.test.ts` so a monitoring
service can never again silently fail to boot on the live box.

### Dashboards

Grafana auto-provisions the Prometheus datasource and every dashboard JSON under
`infra/grafana/dashboards/` on first boot (zero manual import):

- **BetterTrack — API & workers overview** — HTTP rate/latency, queue depth, job
  outcomes, provider calls, cache hit rate, websocket connections.
- **BetterTrack — Infrastructure** — the exporters above: host CPU/mem/disk/net,
  per-container CPU/mem, Postgres connections/cache-hit/commits, Redis
  memory/hit-ratio/evictions, and a scrape-health tile.

## Reaching it — localhost / LAN (default, unchanged)

By default nothing changes from the §16 (2026-07-17) posture: Grafana binds to
**`BT_OBS_BIND_HOST`**, Prometheus to **`BT_PROMETHEUS_BIND_HOST`** (both default
`127.0.0.1`), and neither is routed by the `web`/nginx front proxy.

- **On the deploy host** — `http://127.0.0.1:3001`.
- **Over SSH** — `ssh -N -L 3001:127.0.0.1:3001 you@host`, then
  `http://localhost:3001`. Same shape for Prometheus:
  `ssh -N -L 9090:127.0.0.1:9090 you@host`.
- **On your LAN** — set `BT_OBS_BIND_HOST` to the host's LAN IP; **never**
  `0.0.0.0` on a public host. This moves **Grafana only**: `BT_OBS_BIND_HOST`
  does not touch Prometheus, which stays on `127.0.0.1` (below). On that bind
  Grafana's own login is what stands between the dashboards and every device on
  the network, so keep `BT_GRAFANA_ANON_ENABLED=false` here — see
  [the one unsafe combination](#the-one-unsafe-combination-lan-bind-and-anonymous-access).
  This is the one place where two individually-safe settings on this page
  combine into an unsafe one.

### Prometheus stays on loopback — it has no login at all

Grafana has an account system; **Prometheus has none**, which is also why the
admin app never proxies it (`apps/api/src/http/grafanaProxy.ts`). Its host port
therefore has its own input, **`BT_PROMETHEUS_BIND_HOST`** (default
`127.0.0.1`), and deliberately does **not** follow `BT_OBS_BIND_HOST` onto the
LAN. Anything that can reach a non-loopback Prometheus port can read every
metric and the whole 15-day TSDB — per-route request volumes, error rates, queue
depth, Postgres and Redis internals — with no credential and no audit trail,
while the admin console gates the same operational data behind an admin session
and 2FA.

Concretely, on a LAN bind:

- **Dashboards on the LAN** — `BT_OBS_BIND_HOST=<LAN IP>` and leave
  `BT_PROMETHEUS_BIND_HOST=127.0.0.1`. Grafana serves the dashboards behind its
  login; it queries Prometheus over the internal docker network, so nothing is
  lost by keeping the Prometheus port on loopback.
- **Ad-hoc PromQL** — use Grafana's **Explore** view (same login), or tunnel:
  `ssh -N -L 9090:127.0.0.1:9090 you@host`.
- **Really want the raw Prometheus UI on the network?** Then say so explicitly:
  `BT_PROMETHEUS_BIND_HOST=<LAN IP>`. That is an unauthenticated metrics server
  for every device that can reach it — only do it on an isolated network.

The service also runs **without `--web.enable-lifecycle` and without
`--web.enable-admin-api`**: those add unauthenticated `POST /-/reload`,
`POST /-/quit` and series-deletion endpoints, so on any exposed bind a single
`curl` could stop or wipe the monitoring stack. Nothing here uses them — the
admin **Monitoring** panel only GETs `/-/healthy`, which Prometheus serves with
or without the flags. `checkProductionCompose` fails if a flag is reintroduced
or if the Prometheus port renders on a non-loopback bind.

### The one unsafe combination: LAN bind and anonymous access

`BT_OBS_BIND_HOST=<LAN IP>` (above) and `BT_GRAFANA_ANON_ENABLED=true` (the
admin-proxy recipe below) are each documented as safe — and each **is** safe on
its own. They must not be set together. `GF_AUTH_ANONYMOUS_ENABLED` is a
**server-wide** Grafana setting, not a per-path one: with both set, Grafana
answers `http://<LAN IP>:3001` with an anonymous Viewer session, so every device
on that network — guest Wi-Fi, IoT, a housemate — reads every dashboard (request
rates, error counts, queue depth, Postgres and Redis internals) with no
credential.

The `grafana` service therefore **refuses to start** on that combination: its
entrypoint compares `GF_AUTH_ANONYMOUS_ENABLED` against `BT_OBS_BIND_HOST` and
exits with the three ways out rather than putting an unauthenticated dashboard
server on the LAN. Nothing new is required for either supported setup — the
default (`127.0.0.1` + anonymous off) and the admin-proxy path (`127.0.0.1` +
anonymous on) both start unchanged.

- Want dashboards **on the LAN**? Keep `BT_GRAFANA_ANON_ENABLED=false` and log
  in with the Grafana admin credential below.
- Want the **admin-proxy path**? Leave `BT_OBS_BIND_HOST=127.0.0.1`; the proxy
  reaches Grafana over the internal docker network, so it needs no LAN bind.
- Really want an unauthenticated LAN Grafana (an isolated lab network, say)?
  Name it: `BT_GRAFANA_ANON_LAN_ACK=true`. Unset by default; nothing else reads
  it.

`checkProductionCompose` covers the same pairing in the rendered compose
contract, including that the entrypoint guard is still wired up.

### No phoning home

Grafana OSS is first-party-only here, matching the rest of the arc (and the
reason a Sentry DSN is rejected outright). The compose service pins off every
call the stock image makes on its own — these are compose literals, not
owner-settable variables, and `checkProductionCompose` fails if one is dropped
or flipped:

| Setting                                 | Stock default | Pinned to | Stops                                                 |
| --------------------------------------- | ------------- | --------- | ----------------------------------------------------- |
| `GF_ANALYTICS_REPORTING_ENABLED`        | `true`        | `false`   | usage statistics to `stats.grafana.org`               |
| `GF_ANALYTICS_CHECK_FOR_UPDATES`        | `true`        | `false`   | Grafana version checks against `grafana.com`          |
| `GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES` | `true`        | `false`   | plugin update checks against `grafana.com`            |
| `GF_ANALYTICS_FEEDBACK_LINKS_ENABLED`   | `true`        | `false`   | grafana.com feedback links in the UI                  |
| `GF_NEWS_NEWS_FEED_ENABLED`             | `true`        | `false`   | the grafana.com news feed on the home page            |
| `GF_SECURITY_DISABLE_GRAVATAR`          | `false`       | `true`    | the server-side avatar proxy to `secure.gravatar.com` |

(The last row is an inverted switch — `true` means "disabled".) What remains is
**admin-initiated only**: opening Grafana's _Plugins_ page queries the
grafana.com plugin catalogue. Nothing calls out in the background, so a bare
`docker compose up` on this stack makes no outbound Grafana request at all.

**Why not an `internal:` docker network instead?** It was considered and
rejected: `internal: true` blocks a network's outbound NAT, but the
observability services share the stack's default network with `api` (Prometheus
scrapes it by service name) and `api` legitimately needs egress for market data,
so an internal network would have to be a second network joined by half the
stack — and published host ports on an internal network are exactly what the
localhost/LAN bind depends on. Pinning the settings above removes the actual
egress these images perform, with no topology change to get wrong.

### The admin login (no default credential, still zero setup)

Grafana ships with **no default password on any interface it binds to** — the
LAN bind above included. The compose service has no inline
`GF_SECURITY_ADMIN_PASSWORD`; its entrypoint seeds
`/var/lib/grafana/.bettertrack-admin-password` inside the persistent
`grafanadata` volume on first boot instead:

- `BT_GRAFANA_ADMIN_PASSWORD` set to a real value → that is the credential.
- unset, blank, `admin`, or left at the `.env` placeholder → a **random 32-char
  password is generated once** into that file. Nothing to do before
  `docker compose up`; nothing to do after it.

Read it back on the deploy host (user = `BT_GRAFANA_ADMIN_USER`, default
`admin`):

```
docker compose -f infra/docker-compose.yml exec grafana cat /var/lib/grafana/.bettertrack-admin-password
```

The file lives and dies with `grafana.db` in the same volume, so the password
survives restarts and re-deploys; wiping the volume regenerates both.

**Upgrading a stack that already booted** (its `grafanadata` volume predates
this change, so `grafana.db` still holds the old `admin`/`admin` account):
nothing to do. Grafana itself honours a bootstrap password only while it
_creates_ the admin user, so the entrypoint applies the credential to the
existing account for you — on the first boot after the upgrade it runs
`grafana cli admin reset-admin-password` with the seeded value and records what
it applied next to the credential file. The read-back command above therefore
always prints the password that actually authenticates, on new and pre-existing
volumes alike. If that apply ever fails the container refuses to start rather
than leave the previous password answering on the bind, and logs the manual
recovery command.

**Rotating it later**: set `BT_GRAFANA_ADMIN_PASSWORD` (or delete the credential
file to get a fresh random one) and restart the service — the entrypoint applies
the new value to the existing account on the next boot. A password changed from
inside the Grafana UI is left alone: the entrypoint only re-applies when the
credential file's own content changes.

`apps/api/src/scripts/checkProductionCompose.ts` fails the build if a hardcoded
or defaulted Grafana admin password is ever reintroduced into the compose file,
if the bootstrap stops refusing the known-unsafe literals, or if it stops
applying the credential to an already-provisioned `grafana.db`.

## Reaching it from outside the LAN (opt-in, authenticated)

Pick **one** path. Both are off until you set them, and **both refuse to expose
anything while `BT_GRAFANA_ADMIN_PASSWORD` is unset** (or left at the
`.env` placeholder) — the app never puts `admin/admin` on a public door.

Common switch for either path:

```
BT_OBS_EXTERNAL_ACCESS=true          # deploy-level opt-in (off by default)
BT_GRAFANA_ADMIN_PASSWORD=<strong>   # required — exposure is refused while unset
```

The auto-generated local credential deliberately does **not** arm this gate: the
api only ever sees `BT_GRAFANA_ADMIN_PASSWORD`, so opening an external door
stays an explicit, owner-chosen act. Set it and restart the grafana service —
the entrypoint applies it to the existing account — before enabling external
access.

There is also a **runtime kill-switch** on the admin Diagnostics page (below):
an admin can cut external reach on the next request with no redeploy. Effective
external access = deploy opt-in **and** password set **and** kill-switch on.

### Primary — proxy through the admin app (inherits admin auth)

Grafana stays on the localhost/LAN bind. The admin API reverse-proxies to it
server-side at `/api/v1/admin/monitoring/grafana`, **behind the existing admin
authentication + mandatory 2FA**. So the only public door is the already-public,
already-auth-gated admin dashboard — matching the "admin dashboard is the single
public management surface" intent while adding external reach. Prometheus is
never proxied.

```
BT_OBS_EXTERNAL_ACCESS=true
BT_GRAFANA_SERVE_FROM_SUB_PATH=true
BT_GRAFANA_ROOT_URL=https://api.<your-domain>/api/v1/admin/monitoring/grafana/
BT_GRAFANA_ANON_ENABLED=true   # the proxy IS the auth; an anon Viewer avoids a 2nd login
                               # ONLY with BT_OBS_BIND_HOST on loopback — see below
```

`BT_GRAFANA_ANON_ENABLED` is safe **on this path only because Grafana's own port
stays on `127.0.0.1`**; the flag itself is server-wide. Setting it while
`BT_OBS_BIND_HOST` is a LAN IP makes an unauthenticated LAN dashboard server and
the grafana service refuses to start —
[the one unsafe combination](#the-one-unsafe-combination-lan-bind-and-anonymous-access).
The proxy talks to Grafana over the internal docker network, so it never needs a
LAN bind.

`BT_GRAFANA_ROOT_URL` + `serve_from_sub_path` make Grafana emit correct URLs
under the proxy path; `BT_GRAFANA_ALLOW_EMBEDDING` (default `true`) lets the
admin dashboard frame it. The proxy strips Grafana's framing headers and scopes
`frame-ancestors` to the admin/web SPA origins. Then the admin **Diagnostics**
page embeds Grafana inline and offers an "open in new tab" link.

Notes / limitations of the proxy path:

- It forwards HTTP (dashboards render via polling); Grafana Live websockets are
  not proxied.
- The proxy sits **before** CSRF + the general rate limiter (Grafana's own POSTs
  carry no `X-Requested-With`, and an embed bursts many requests), but **behind**
  `requireAdmin` + mandatory 2FA + the exposure gate.
- Its `BT_GRAFANA_ANON_ENABLED=true` is **not** scoped to the proxy path: it
  removes Grafana's login on every interface Grafana binds to. That is safe
  while the bind is loopback and unsafe the moment it is a LAN IP, which is why
  the two cannot be combined without `BT_GRAFANA_ANON_LAN_ACK`.

### Alternative — auth-gated subdomain

Front Grafana with the edge reverse proxy (`infra/live/edge/**`) on its own
subdomain with HTTPS, using **Grafana's own login** (keep `BT_GRAFANA_ANON_ENABLED=false`).
Then advertise the public URL so the Diagnostics panel embeds/links it:

```
BT_OBS_EXTERNAL_ACCESS=true
BT_GRAFANA_PUBLIC_URL=https://grafana.<your-domain>
```

More infra (DNS/SSL/edge conf), but Grafana keeps its own auth boundary and the
admin API is not in the request path. Prometheus stays internal.

The `web` front proxy reads the same variable from the shared `.env` and renders
its **origin** into the static `Content-Security-Policy` (`frame-src`) at
container start — that is what allows the browser to embed this host at all.
Give it a plain origin, optionally with a port (`https://grafana.<your-domain>`,
`https://obs.<your-domain>:8443`); a path is accepted and reduced to the origin.
A value that is not `http(s)://host[:port]` fails `web` startup with an explicit
message instead of shipping a corrupted policy.

## Admin Diagnostics panel

Admin → **Diagnostics → Monitoring** (`/admin/monitoring`) shows, all read-only
and degrading gracefully when the stack is down:

- **Reachable / not-reachable** status for Grafana + Prometheus (server-side
  probe; Prometheus is only probed, never surfaced with a client URL).
- The **external-access posture** — deploy opt-in, password set, runtime
  kill-switch — with the runtime kill-switch toggle.
- When external access is effective, an **embedded Grafana** iframe + an "open in
  new tab" link (the admin-proxy path, or the `BT_GRAFANA_PUBLIC_URL` subdomain).

## Security model (summary)

- Default is safe: absent explicit external-access config, everything stays on
  the `BT_OBS_BIND_HOST` bind (loopback by default) behind Grafana's own login —
  with one caveat, below: a LAN bind and anonymous access are safe apart and
  unsafe together, so the service refuses that pair.
- **Anonymous access is server-wide, never per-path** — `BT_GRAFANA_ANON_ENABLED`
  belongs to the admin-proxy recipe, which keeps `BT_OBS_BIND_HOST` on loopback.
  With a LAN bind the grafana service refuses to start unless
  `BT_GRAFANA_ANON_LAN_ACK=true` names the exposure; `checkProductionCompose`
  covers the same pairing and the presence of the runtime guard.
- **Nothing phones home** — usage reporting, version and plugin update checks,
  feedback links, the news feed and the server-side Gravatar proxy are pinned off
  in the compose service, so the stack never calls `grafana.com` /
  `stats.grafana.org` / `secure.gravatar.com` on its own, and
  `checkProductionCompose` keeps it that way. The one remaining grafana.com path
  is admin-initiated: the plugin catalogue behind Grafana's _Plugins_ page.
- **No default credential on any bound interface** — the compose service carries
  no inline `GF_SECURITY_ADMIN_PASSWORD`; an unset/placeholder/`admin` value is
  replaced by a random password generated into the `grafanadata` volume, so the
  documented LAN bind cannot produce an `admin`/`admin` Grafana.
- **Prometheus is never directly public** — it has no auth; only Grafana (login)
  or the admin-auth proxy is reachable.
- **No public exposure without a set Grafana admin password** — enforced in the
  API (`config.observability.grafanaPasswordSet`), which treats blank and the
  known placeholders as unset.
- External exposure is **kill-switchable at runtime** from the admin Diagnostics
  page, independent of the deploy toggle.
- The api reads `BT_GRAFANA_ADMIN_PASSWORD` **only** to compute the gate; the raw
  value is never retained on the resolved config, logged, or sent to a client.

Every knob lives in `infra/.env.production.example`. See also `docs/ops.md`
("Observability") for the deploy-stack context.
