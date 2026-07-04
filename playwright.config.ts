import { defineConfig, devices } from '@playwright/test';

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  API_BASE_URL,
  DATABASE_URL,
  REDIS_URL,
  SESSION_SECRET,
  WEB_BASE_URL,
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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
  ],
});
