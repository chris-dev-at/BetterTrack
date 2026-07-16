/**
 * Shared constants for the e2e boot (playwright.config.ts webServer env) and
 * the specs themselves, so both sides agree on origins/credentials without
 * duplicating them.
 */

export const WEB_BASE_URL = process.env.E2E_WEB_BASE_URL ?? 'http://localhost:5173';
export const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://localhost:3000';
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://bt:bt@localhost:5432/bettertrack';
export const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379';
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
export const GOOGLE_CLIENT_ID = process.env.E2E_GOOGLE_CLIENT_ID ?? 'e2e-google-client-id';
export const GOOGLE_CLIENT_SECRET =
  process.env.E2E_GOOGLE_CLIENT_SECRET ?? 'e2e-google-client-secret';
