/**
 * Shared constants for the e2e boot (playwright.config.ts webServer env) and
 * the specs themselves, so both sides agree on origins/credentials without
 * duplicating them.
 */

/**
 * PORTS OF THEIR OWN, off the dev stack's 3000/5173 on purpose.
 *
 * Playwright's `webServer.reuseExistingServer` adopts anything already
 * answering the readiness URL. While these defaulted to the dev ports, a
 * developer's running `pnpm dev` API owned 3000, so every local run silently
 * adopted it, skipped the e2e boot's migrate+seed entirely, and pointed all 51
 * specs at the *dev* database — `E2E_DATABASE_URL` never got a chance to apply,
 * because the e2e API was never the process under test (2026-07-30). Moving the
 * defaults here means the two stacks cannot collide by accident; the paired
 * half of the fix is `reuseExistingServer: false` in playwright.config.ts, so a
 * leftover on THESE ports fails the run loudly instead of being adopted.
 */
export const WEB_BASE_URL = process.env.E2E_WEB_BASE_URL ?? 'http://localhost:5273';
export const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://localhost:3200';

/**
 * The ADMIN console's own origin.
 *
 * The console is the same SPA in admin mode, and the mode is a RUNTIME fact
 * read from `window.__BT__` — which nginx sets per server block in production
 * and `vite.admin.config.mts` sets per origin in dev. So it needs an origin of
 * its own here too: the user dev server answers `/admin/*` with the USER app,
 * which has no such route and falls through to the sign-in page. The
 * approval-mode spec had been failing on exactly that, with no admin origin in
 * the boot to talk to (2026-07-30).
 */
export const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL ?? 'http://localhost:5373';

/**
 * The ports the two dev servers must actually LISTEN on, derived from the URLs
 * above so an `E2E_API_BASE_URL`/`E2E_WEB_BASE_URL` override moves the servers
 * with the specs. Before this, both overrides only redirected the *client* side:
 * the API kept listening on `PORT`'s 3000 default and Vite on its hardcoded
 * 5173, so pointing the suite elsewhere silently tested whatever already owned
 * those ports — including a developer's running dev stack and its database.
 */
export const API_PORT = new URL(API_BASE_URL).port || '3200';
export const WEB_PORT = new URL(WEB_BASE_URL).port || '5273';
export const ADMIN_PORT = new URL(ADMIN_BASE_URL).port || '5373';

/**
 * The ADDRESSES the e2e API and the worker wrapper's health endpoint LISTEN on
 * (#2004), as opposed to the ports above.
 *
 * Until this existed the throwaway API bound every interface. Combined with the
 * seed admin credentials in this repo and `BT_OUTBOUND_DEPLOYMENT_SUBNETS=none`
 * in playwright.config.ts — which relaxes the guard's own-network carve-out so
 * the webhook receiver on this box's LAN address is reachable — any host on the
 * developer's /24 could drive the e2e API as a blind SSRF / port-scan probe for
 * the minutes a suite ran. Nothing needs that reach: the browser, the harness
 * and both Vite servers only ever talk to `localhost`.
 *
 * `127.0.0.1` and not `localhost`: a NAME makes Node resolve and bind the single
 * address getaddrinfo returns first (on macOS `::1`), which would leave every
 * IPv4-only client with nothing to connect to. The literal is deterministic and
 * every client here reaches it — modern Node and Chromium both fall back from
 * `::1` to `127.0.0.1` when resolving `localhost`.
 *
 * Derived from the URLs so an `E2E_API_BASE_URL` override that deliberately
 * moves the stack onto a routable address moves the bind with it instead of
 * silently making the API unreachable; `E2E_API_HOST` overrides that in turn.
 * The capture RECEIVER is NOT covered here — it must stay on a non-loopback
 * private interface or the webhook-URL guard refuses it (see e2e/support/e3.ts).
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function bindHostFor(url: string): string {
  const { hostname } = new URL(url);
  return LOOPBACK_HOSTNAMES.has(hostname) ? '127.0.0.1' : hostname;
}
export const API_HOST = process.env.E2E_API_HOST ?? bindHostFor(API_BASE_URL);

/**
 * The API's Prometheus listener (§13.5 V5-P2). Pinned here so the e2e API never
 * silently contends for the 9464 default with another BetterTrack process on the
 * same host (a dev stack's API binds it) — which means the value must NOT be
 * 9464 itself, as it was until 2026-07-30. The worker's listener stays OFF —
 * see `playwright.config.ts`.
 */
export const METRICS_PORT = process.env.E2E_METRICS_PORT ?? '9564';

/**
 * A DEDICATED database, never the dev one. The default deliberately does NOT
 * match `pnpm dev:infra`'s `bettertrack`: the e2e boot migrates AND seeds
 * whatever this points at, and every spec mints accounts in it, so aiming it at
 * a working dev database corrupts real local data. `bettertrack_e2e` is the same
 * name CI uses (`.github/workflows/e2e-nightly.yml`). Create it once against a
 * dev Postgres with:
 *   `docker exec bettertrack-dev-db-1 createdb -U bt bettertrack_e2e`
 */
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://bt:bt@localhost:5432/bettertrack_e2e';
/**
 * Its own logical Redis DB (`/1`), for the same reason the database is its own:
 * a dev stack's BullMQ worker sits on db0 consuming the very same queue names,
 * so a shared Redis lets the DEV worker pick up an e2e alert job and evaluate
 * it against the DEV database — the spec then waits forever for a notification
 * that was delivered somewhere else. Sessions and rate-limit counters share the
 * keyspace too. ioredis reads the `/N` path as the SELECT index.
 */
export const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379/1';
export const SESSION_SECRET =
  process.env.E2E_SESSION_SECRET ?? 'e2e-local-session-secret-not-for-production-0000000000';
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@bettertrack.local';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'Sup3rSecret!Passw0rd1';
export const ACCOUNT_PASSWORD = 'Sup3rSecret!Passw0rd2';

/**
 * The alerts worker wrapper's health port/url (issue #426, flow 6). The wrapper
 * (`e2e/support/workerServer.mjs`) serves this so Playwright's `webServer` poll
 * can detect the BullMQ worker's boot — the worker itself has no HTTP surface.
 */
export const WORKER_HEALTH_PORT = process.env.E2E_WORKER_HEALTH_PORT ?? '3100';
export const WORKER_HEALTH_URL =
  process.env.E2E_WORKER_HEALTH_URL ?? `http://localhost:${WORKER_HEALTH_PORT}`;
/** Bind address for that health endpoint — loopback, for the reason on API_HOST. */
export const WORKER_HEALTH_HOST =
  process.env.E2E_WORKER_HEALTH_HOST ?? bindHostFor(WORKER_HEALTH_URL);

/**
 * Fake Google IdP (issue #520). A tiny local OAuth/OIDC stand-in
 * (`e2e/support/fakeGoogleIdp.mjs`) that answers the authorize redirect, the
 * token exchange and a JWKS endpoint with a per-run signing key, so the real
 * Google sign-in flow runs end-to-end with zero network. The API's three Google
 * endpoints are pointed at it via the `BT_GOOGLE_*` overrides (test-only,
 * defaulting to the production Google constants when unset). The client id below
 * is the `aud` the fake IdP mints into every id_token — it must match the API's
 * `BT_GOOGLE_CLIENT_ID`.
 */
export const FAKE_GOOGLE_PORT = process.env.E2E_FAKE_GOOGLE_PORT ?? '4545';
export const FAKE_GOOGLE_URL =
  process.env.E2E_FAKE_GOOGLE_URL ?? `http://localhost:${FAKE_GOOGLE_PORT}`;
/**
 * Bind address for the fake IdP — loopback, for the same reason as API_HOST:
 * it mints signed id_tokens with zero authentication, so an all-interfaces
 * listener would hand the developer's LAN a token-minting oracle for the
 * length of a run (#2016). Every dialer (the browser and the e2e API's
 * server-side token/JWKS fetches) is same-box, so this is a no-op for them.
 */
export const FAKE_GOOGLE_HOST = process.env.E2E_FAKE_GOOGLE_HOST ?? bindHostFor(FAKE_GOOGLE_URL);
export const GOOGLE_CLIENT_ID = process.env.E2E_GOOGLE_CLIENT_ID ?? 'e2e-google-client-id';
export const GOOGLE_CLIENT_SECRET =
  process.env.E2E_GOOGLE_CLIENT_SECRET ?? 'e2e-google-client-secret';
