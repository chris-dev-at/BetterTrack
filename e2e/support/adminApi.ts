import type { APIRequestContext } from '@playwright/test';

import { ADMIN_EMAIL, ADMIN_PASSWORD, API_BASE_URL } from './config';

/** Every mutating request needs this header or the API's CSRF guard 403s it. */
const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' };

/**
 * Logs the given request context in as the seeded admin. Test setup only —
 * the happy path itself never touches the admin app.
 */
export async function loginAsAdmin(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API_BASE_URL}/api/v1/auth/login`, {
    headers: CSRF_HEADERS,
    data: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(`Admin login failed: ${res.status()} ${await res.text()}`);
  }
}

/** The four global registration modes (§6.12) — mirrors `@bettertrack/contracts`. */
export type RegistrationMode = 'closed' | 'invite_token' | 'approval' | 'open';

/**
 * Reads the current global registration mode via `GET /admin/settings`, so a
 * spec that flips it can restore the exact prior state afterwards.
 */
export async function getRegistrationMode(request: APIRequestContext): Promise<RegistrationMode> {
  const res = await request.get(`${API_BASE_URL}/api/v1/admin/settings`);
  if (!res.ok()) {
    throw new Error(`Reading app settings failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { registrationMode: RegistrationMode };
  return body.registrationMode;
}

/**
 * Switches the global registration mode via `PATCH /admin/settings` (§6.12,
 * live change — no restart). Test setup only; callers must restore the prior
 * mode so the rest of the suite keeps the seed default.
 */
export async function setRegistrationMode(
  request: APIRequestContext,
  mode: RegistrationMode,
): Promise<void> {
  const res = await request.patch(`${API_BASE_URL}/api/v1/admin/settings`, {
    headers: CSRF_HEADERS,
    data: { registrationMode: mode },
  });
  if (!res.ok()) {
    throw new Error(
      `Setting registration mode ${mode} failed: ${res.status()} ${await res.text()}`,
    );
  }
}

/**
 * Chat-bans (or unbans) a user by username via the admin API (§13.4 V4-P0d):
 * looks the user up in the admin list, then PATCHes `chatBanned`. Test setup
 * only — driving the ban toggle in the admin UI is covered by unit tests.
 */
export async function setChatBanByUsername(
  request: APIRequestContext,
  username: string,
  banned: boolean,
): Promise<void> {
  const list = await request.get(
    `${API_BASE_URL}/api/v1/admin/users?search=${encodeURIComponent(username)}`,
  );
  if (!list.ok()) {
    throw new Error(`Reading admin users failed: ${list.status()} ${await list.text()}`);
  }
  const body = (await list.json()) as { users: Array<{ id: string; username: string }> };
  const target = body.users.find((u) => u.username === username);
  if (!target) throw new Error(`Admin user not found for chat ban: ${username}`);
  const res = await request.patch(`${API_BASE_URL}/api/v1/admin/users/${target.id}`, {
    headers: CSRF_HEADERS,
    data: { chatBanned: banned },
  });
  if (!res.ok()) {
    throw new Error(`Setting chat ban for ${username} failed: ${res.status()} ${await res.text()}`);
  }
}

/**
 * Creates an invite for `email` via the admin API and returns its token, so
 * the spec can drive the real invite-accept page in a browser context. Test
 * setup only — invite *creation* isn't part of the happy path under test.
 */
export async function createInvite(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API_BASE_URL}/api/v1/admin/invites`, {
    headers: CSRF_HEADERS,
    data: { email },
  });
  if (!res.ok()) {
    throw new Error(`Invite creation failed for ${email}: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { inviteUrl: string };
  const token = new URL(body.inviteUrl).pathname.split('/').pop();
  if (!token) throw new Error(`Could not parse invite token from ${body.inviteUrl}`);
  return token;
}
