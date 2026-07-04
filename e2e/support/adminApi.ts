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
