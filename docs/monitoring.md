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
                         localhost / LAN bind   +   authenticated external path (opt-in)
```

| Service             | Image                                   | Scrapes / shows                          | Host port                |
| ------------------- | --------------------------------------- | ---------------------------------------- | ------------------------ |
| `prometheus`        | `prom/prometheus`                       | everything below (15-day TSDB)           | `BT_OBS_BIND_HOST:9090`  |
| `grafana`           | `grafana/grafana-oss`                   | dashboards over Prometheus               | `BT_OBS_BIND_HOST:3001`  |
| `node-exporter`     | `prom/node-exporter`                    | host CPU / memory / disk / network       | **none** (internal only) |
| `cadvisor`          | `gcr.io/cadvisor/cadvisor`              | per-container CPU / mem / IO             | **none**                 |
| `postgres-exporter` | `prometheuscommunity/postgres-exporter` | DB connections, cache hit ratio, commits | **none**                 |
| `redis-exporter`    | `oliver006/redis_exporter`              | cache memory, hit rate, evictions        | **none**                 |

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

By default nothing changes from the §16 (2026-07-17) posture: Prometheus and
Grafana bind to **`BT_OBS_BIND_HOST`** (default `127.0.0.1`) and are not routed
by the `web`/nginx front proxy.

- **On the deploy host** — `http://127.0.0.1:3001`.
- **Over SSH** — `ssh -N -L 3001:127.0.0.1:3001 you@host`, then
  `http://localhost:3001`.
- **On your LAN** — set `BT_OBS_BIND_HOST` to the host's LAN IP; **never**
  `0.0.0.0` on a public host.

Log in with `BT_GRAFANA_ADMIN_USER` / `BT_GRAFANA_ADMIN_PASSWORD`.

## Reaching it from outside the LAN (opt-in, authenticated)

Pick **one** path. Both are off until you set them, and **both refuse to expose
anything while `BT_GRAFANA_ADMIN_PASSWORD` is unset** (or left at the
`.env` placeholder) — the app never puts `admin/admin` on a public door.

Common switch for either path:

```
BT_OBS_EXTERNAL_ACCESS=true          # deploy-level opt-in (off by default)
BT_GRAFANA_ADMIN_PASSWORD=<strong>   # required — exposure is refused while unset
```

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
```

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

- Default is safe: absent explicit external-access config, everything stays
  localhost/LAN-only exactly as before.
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
