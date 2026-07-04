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
