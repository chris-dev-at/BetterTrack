import { defineConfig, devices } from '@playwright/test';

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API_BASE_URL,
  DATABASE_URL,
  FAKE_GOOGLE_PORT,
  FAKE_GOOGLE_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIS_URL,
  SESSION_SECRET,
  WEB_BASE_URL,
  WORKER_HEALTH_PORT,
  WORKER_HEALTH_URL,
} from './e2e/support/config';

/**
 * Root-level Playwright config for the single §12 nightly happy-path spec
 * (`e2e/**`). NOT wired into `pnpm test` / per-commit CI — run explicitly via
 * `pnpm test:e2e`, or by the scheduled `.github/workflows/e2e-nightly.yml`.
 * Boots the real api + web dev servers against Postgres/Redis (see README
 * "End-to-end (Playwright)").
 */
const apiEnv = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL,
  REDIS_URL,
  SESSION_SECRET,
  BT_API_ORIGIN: API_BASE_URL,
  BT_WEB_ORIGIN: WEB_BASE_URL,
  BT_ADMIN_ORIGIN: WEB_BASE_URL,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  // Google sign-in against the fake IdP (issue #520). The client id/secret turn
  // the feature ON; the three endpoint overrides point the API's Google flow at
  // the local fake IdP (test-only — unset in every real deploy, where the
  // production Google constants apply). See e2e/support/fakeGoogleIdp.mjs.
  BT_GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID,
  BT_GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT_SECRET,
  BT_GOOGLE_AUTHORIZE_ENDPOINT: `${FAKE_GOOGLE_URL}/authorize`,
  BT_GOOGLE_TOKEN_ENDPOINT: `${FAKE_GOOGLE_URL}/token`,
  BT_GOOGLE_JWKS_URI: `${FAKE_GOOGLE_URL}/jwks`,
};

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: WEB_BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command:
        'pnpm --filter @bettertrack/api db:migrate && pnpm --filter @bettertrack/api db:seed && pnpm --filter @bettertrack/api dev',
      url: `${API_BASE_URL}/api/v1/health`,
      env: apiEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @bettertrack/web dev',
      url: WEB_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    // The BullMQ worker (issue #426, flow 6): the alerts evaluator only runs
    // here, so without it no price alert can fire under Playwright. Started via
    // a thin wrapper that exposes a health port for the readiness poll — the
    // worker itself has no HTTP surface. Test-infra wiring only, no app source.
    {
      command: 'node e2e/support/workerServer.mjs',
      url: WORKER_HEALTH_URL,
      env: { ...apiEnv, E2E_WORKER_HEALTH_PORT: WORKER_HEALTH_PORT },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    // Fake Google IdP (issue #520): a local OAuth/OIDC stand-in so the real
    // Google sign-in redirect chain runs network-free. It bounces the browser
    // back to the callback on the WEB origin (proxied) so the host-only
    // `bt_goog_state` cookie survives the round-trip. Test infra only.
    {
      command: 'node e2e/support/fakeGoogleIdp.mjs',
      url: `${FAKE_GOOGLE_URL}/health`,
      env: {
        ...process.env,
        E2E_FAKE_GOOGLE_PORT: FAKE_GOOGLE_PORT,
        BT_GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID,
        E2E_GOOGLE_CALLBACK_ORIGIN: WEB_BASE_URL,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
