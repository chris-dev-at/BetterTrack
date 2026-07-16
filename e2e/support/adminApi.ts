import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { APIRequestContext, Browser, BrowserContext } from '@playwright/test';

import { ADMIN_EMAIL, ADMIN_PASSWORD, API_BASE_URL, WEB_BASE_URL } from './config';

/** Every mutating request needs this header or the API's CSRF guard 403s it. */
const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' };

/**
 * Cross-process store for the enrolled admin TOTP secret. The mandatory
 * admin-2FA gate (§6.12, #400) 403s every admin route until the admin has a
 * confirmed 2FA method; once enrolled, the API keeps the secret encrypted at
 * rest and never returns the plaintext again, so any later process that hits
 * the login 2FA challenge needs the shared secret from the original enroll.
 * Playwright spawns a fresh worker for a retried spec (issue #515), so an
 * in-process cache alone can't survive the first spec's crash — every follow-on
 * {@link loginAsAdmin} would then die on the challenge branch. A file under
 * `os.tmpdir()` covers BOTH the retry AND the "re-run without resetting the
 * stack" acceptance path: the previous run's enrolled secret is still the DB's
 * secret. The file is a plain base32 string, mode 0600. Override via
 * `E2E_ADMIN_TOTP_FILE` to shard across concurrent stacks on the same host.
 */
const ADMIN_TOTP_SECRET_FILE =
  process.env.E2E_ADMIN_TOTP_FILE ?? join(tmpdir(), 'bettertrack-e2e-admin-totp');

/** In-process mirror of the persisted secret; primed lazily from disk on first read. */
let cachedAdminTotpSecret: string | null = null;

function readAdminTotpSecret(): string | null {
  if (cachedAdminTotpSecret) return cachedAdminTotpSecret;
  try {
    const raw = readFileSync(ADMIN_TOTP_SECRET_FILE, 'utf8').trim();
    if (raw.length > 0) {
      cachedAdminTotpSecret = raw;
      return raw;
    }
  } catch {
    // File doesn't exist yet (fresh boot) — the enroll branch will create it.
  }
  return null;
}

function persistAdminTotpSecret(secret: string): void {
  cachedAdminTotpSecret = secret;
  try {
    mkdirSync(dirname(ADMIN_TOTP_SECRET_FILE), { recursive: true });
    writeFileSync(ADMIN_TOTP_SECRET_FILE, secret, { mode: 0o600 });
  } catch {
    // Best-effort — in-process cache still covers this worker's remaining specs.
  }
}

/** RFC 4648 base32 decode — only what the admin-2FA enroll endpoint returns (uppercase, no padding). */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * The current 6-digit TOTP code for a base32 secret (RFC 6238 defaults: SHA-1,
 * 30-second step, 6 digits). Mirrors the API's own primitive
 * (apps/api/src/services/auth/totp.ts) — vendored here so the e2e specs stay
 * self-contained (no cross-package import into `apps/api/**`).
 */
function generateTotpCode(secret: string, nowMs: number = Date.now()): string {
  const counter = Math.floor(nowMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** 6).toString().padStart(6, '0');
}

/**
 * Logs the given request context in as the seeded admin, transparently
 * handling the mandatory admin-2FA gate (§6.12, #400) so callers only see
 * "authenticated as admin". On a fresh admin the setup-gate-exempt
 * `/admin/security/2fa/totp/*` endpoints enroll a TOTP method and cache the
 * secret; on subsequent logins in the same process the cached secret completes
 * the login 2FA challenge. Test setup only — the happy path itself never
 * touches the admin app.
 */
export async function loginAsAdmin(request: APIRequestContext): Promise<void> {
  const loginRes = await request.post(`${API_BASE_URL}/api/v1/auth/login`, {
    headers: CSRF_HEADERS,
    data: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!loginRes.ok()) {
    throw new Error(`Admin login failed: ${loginRes.status()} ${await loginRes.text()}`);
  }
  const body = (await loginRes.json()) as
    | { twoFactorRequired?: false }
    | { twoFactorRequired: true; pendingToken: string; channels: string[] };

  if ('twoFactorRequired' in body && body.twoFactorRequired) {
    const secret = readAdminTotpSecret();
    if (!secret) {
      throw new Error(
        'Admin login is 2FA-challenged but no TOTP secret is available — the seeded ' +
          'admin already carries a confirmed 2FA method from a prior boot but the ' +
          `shared secret file (${ADMIN_TOTP_SECRET_FILE}) is missing. Reset the ` +
          'compose stack (or `pnpm --filter @bettertrack/api admin:break-glass ' +
          `${ADMIN_EMAIL}\`) so the fresh-boot enrollment path can run again.`,
      );
    }
    const verifyRes = await request.post(`${API_BASE_URL}/api/v1/auth/2fa/verify`, {
      headers: CSRF_HEADERS,
      data: {
        pendingToken: body.pendingToken,
        code: generateTotpCode(secret),
      },
    });
    if (!verifyRes.ok()) {
      throw new Error(`Admin 2FA verify failed: ${verifyRes.status()} ${await verifyRes.text()}`);
    }
    return;
  }

  // Password login succeeded → the session lives in the setup-required state,
  // exempt only for the 2FA management endpoints. Enroll TOTP so this session
  // (and every subsequent one this process makes) can reach every admin route.
  const status = await request.get(`${API_BASE_URL}/api/v1/admin/security/2fa/status`);
  if (!status.ok()) {
    throw new Error(`Reading admin 2FA status failed: ${status.status()} ${await status.text()}`);
  }
  const statusBody = (await status.json()) as { totpEnabled: boolean };
  if (statusBody.totpEnabled) {
    // Password login succeeded (so admin has NO confirmed 2FA at login time)
    // but the status says TOTP is on — a race with a concurrent enroll or a
    // stale interpreter state. Surface the fix instead of pushing a duplicate
    // enroll that would then fail the confirm step.
    throw new Error(
      'Admin already has a confirmed TOTP method but no cached secret in this process. ' +
        `Reset via \`pnpm --filter @bettertrack/api admin:break-glass ${ADMIN_EMAIL}\`.`,
    );
  }
  const enrollRes = await request.post(`${API_BASE_URL}/api/v1/admin/security/2fa/totp/enroll`, {
    headers: CSRF_HEADERS,
  });
  if (!enrollRes.ok()) {
    throw new Error(`Admin TOTP enroll failed: ${enrollRes.status()} ${await enrollRes.text()}`);
  }
  const { secret } = (await enrollRes.json()) as { secret: string };
  persistAdminTotpSecret(secret);
  const confirmRes = await request.post(`${API_BASE_URL}/api/v1/admin/security/2fa/totp/confirm`, {
    headers: CSRF_HEADERS,
    data: { code: generateTotpCode(secret) },
  });
  if (!confirmRes.ok()) {
    throw new Error(`Admin TOTP confirm failed: ${confirmRes.status()} ${await confirmRes.text()}`);
  }
}

/**
 * Opens a fresh browser context signed in as the admin, by lifting the admin
 * session cookie out of {@link loginAsAdmin}'s request context and attaching it
 * to a new browser context. The admin app's session bootstrap (calls
 * `/auth/me` + `/admin/security/2fa/status`) then finds a confirmed admin, so
 * the SPA lands directly on the console — no admin-login UI to drive. Test
 * setup only; the caller owns the returned context and must close it.
 */
export async function newAdminBrowserContext(
  browser: Browser,
  apiRequest: APIRequestContext,
): Promise<BrowserContext> {
  const state = await apiRequest.storageState();
  const sessionCookies = state.cookies.filter((c) => c.name === 'bt_sid');
  if (sessionCookies.length === 0) {
    throw new Error(
      'No bt_sid cookie in the admin API context — did you await loginAsAdmin() first?',
    );
  }
  const context = await browser.newContext({ baseURL: WEB_BASE_URL });
  await context.addCookies(sessionCookies);
  return context;
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

/**
 * Mints a registration access token via the admin API (§13.4 V4-P4a) and
 * returns the raw token — the `invite_token` mode's gate. Distinct from
 * {@link createInvite}: per-email invites are the V1 concept, registration
 * tokens are the #420 admin-managed single/multi-use handshake with expiry.
 * The register URL that carries the raw token is returned by the server
 * exactly once; the spec picks it out of the `?token=` query. Test setup
 * only — driving the admin token form itself is covered by unit tests.
 */
export async function createRegistrationToken(
  request: APIRequestContext,
  options: { maxUses?: number; expiresInDays?: number; label?: string } = {},
): Promise<string> {
  const res = await request.post(`${API_BASE_URL}/api/v1/admin/registration-tokens`, {
    headers: CSRF_HEADERS,
    data: {
      maxUses: options.maxUses ?? 1,
      ...(options.expiresInDays !== undefined ? { expiresInDays: options.expiresInDays } : {}),
      ...(options.label !== undefined ? { label: options.label } : {}),
    },
  });
  if (!res.ok()) {
    throw new Error(`Registration-token creation failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { registerUrl: string };
  const token = new URL(body.registerUrl).searchParams.get('token');
  if (!token) {
    throw new Error(`Could not parse registration token from ${body.registerUrl}`);
  }
  return token;
}
