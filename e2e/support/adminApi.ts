import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  APIRequest,
  APIRequestContext,
  APIResponse,
  Browser,
  BrowserContext,
} from '@playwright/test';

import { ADMIN_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, API_BASE_URL } from './config';

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

/**
 * Cross-process replay cursor for the TOTP secret above. A failed spec is
 * retried in a new Playwright worker, so an in-memory cursor alone can mint the
 * same 30-second code that the previous worker just consumed. Keep the cursor
 * next to the secret by default; deployments that isolate the secret path get
 * an isolated cursor automatically. Reservation is intentionally lock-free
 * while every shard runs one Playwright worker; increasing `workers` requires
 * a cross-process lock around the read/reserve/write sequence below.
 */
const ADMIN_TOTP_STEP_FILE =
  process.env.E2E_ADMIN_TOTP_STEP_FILE ?? `${ADMIN_TOTP_SECRET_FILE}.last-step`;

const TOTP_STEP_MS = 30_000;
const TOTP_BOUNDARY_GRACE_MS = 100;

/** In-process mirror of the persisted secret; primed lazily from disk on first read. */
let cachedAdminTotpSecret: string | null = null;

/** Undefined means "not read yet"; null means the cursor file was absent or invalid. */
let cachedAdminTotpStep: number | null | undefined;

type AdminStorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

/** One setup promise per Playwright worker process; every spec clones its cookie. */
let assuredAdminStorageState: Promise<AdminStorageState> | null = null;

/**
 * A shard can legitimately cross the production-shaped 25/minute login-IP
 * allowance while provisioning many independent scenarios. Honor the
 * limiter's first, short cooldown once instead of turning one 429 into a run of
 * immediate retry failures. The progressive limiter clears its window when it
 * arms that cooldown, so one server-directed wait is sufficient.
 */
async function postAdminAuth(
  request: APIRequestContext,
  path: string,
  data: () => unknown,
): Promise<APIResponse> {
  let response = await request.post(`${API_BASE_URL}${path}`, {
    headers: CSRF_HEADERS,
    data: data(),
  });
  if (response.status() !== 429) return response;

  const retryAfter = Number(response.headers()['retry-after']);
  if (!Number.isFinite(retryAfter) || retryAfter < 1 || retryAfter > 60) return response;

  await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 250));
  response = await request.post(`${API_BASE_URL}${path}`, {
    headers: CSRF_HEADERS,
    data: data(),
  });
  return response;
}

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

function readAdminTotpStep(): number | null {
  if (cachedAdminTotpStep !== undefined) return cachedAdminTotpStep;
  try {
    const parsed = Number(readFileSync(ADMIN_TOTP_STEP_FILE, 'utf8').trim());
    cachedAdminTotpStep = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    cachedAdminTotpStep = null;
  }
  return cachedAdminTotpStep;
}

function persistAdminTotpStep(step: number): void {
  cachedAdminTotpStep = step;
  try {
    mkdirSync(dirname(ADMIN_TOTP_STEP_FILE), { recursive: true });
    writeFileSync(ADMIN_TOTP_STEP_FILE, String(step), { mode: 0o600 });
  } catch {
    // Best-effort — the in-process cursor still protects this worker.
  }
}

const totpStepAt = (nowMs: number): number => Math.floor(nowMs / TOTP_STEP_MS);

/**
 * Mint a code from a step this harness has not already attempted. Persist the
 * reservation before the request so a Playwright worker crash cannot make its
 * retry replay a code that the API accepted just before the crash.
 */
async function freshAdminTotpCode(secret: string): Promise<string> {
  let nowMs = Date.now();
  const lastStep = readAdminTotpStep();
  const currentStep = totpStepAt(nowMs);
  if (lastStep !== null && currentStep <= lastStep) {
    const waitMs = (lastStep + 1) * TOTP_STEP_MS - nowMs + TOTP_BOUNDARY_GRACE_MS;
    // One future step is a valid prior-run reservation and can require just
    // over two step lengths of waiting near a boundary. Anything farther ahead
    // points to a materially different clock.
    if (lastStep > currentStep + 1) {
      throw new Error(
        `Admin TOTP step cursor ${lastStep} is ahead of the local clock; remove ` +
          `${ADMIN_TOTP_STEP_FILE} after fixing the clock skew.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
    nowMs = Date.now();
  }

  const step = totpStepAt(nowMs);
  persistAdminTotpStep(step);
  return generateTotpCode(secret, nowMs);
}

function apiErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'string' ? parsed.error.code : null;
  } catch {
    return null;
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
 * One sign-in attempt. Resolves to `'assured'` when the context now holds a
 * fully assured admin session, or `'enrolled'` when this attempt had to perform
 * the first-boot TOTP enrollment — which deliberately ends the session it ran
 * on, so the caller must attempt again. See {@link loginAsAdmin}.
 */
async function signInAsAdminOnce(request: APIRequestContext): Promise<'assured' | 'enrolled'> {
  // Through the 429-honoring wrapper: a shard's provisioning burst can cross
  // the login-IP allowance, and one server-directed wait beats a hard failure.
  const loginRes = await postAdminAuth(request, '/api/v1/auth/login', () => ({
    identifier: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  }));
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
    let code = await freshAdminTotpCode(secret);
    let verifyRes = await postAdminAuth(request, '/api/v1/auth/2fa/verify', () => ({
      pendingToken: body.pendingToken,
      code,
    }));
    if (!verifyRes.ok()) {
      let verifyBody = await verifyRes.text();
      if (verifyRes.status() === 401 && apiErrorCode(verifyBody) === 'TWO_FACTOR_INVALID_CODE') {
        // The file cursor is best-effort, so the server can know about a step
        // this process did not. Keep the still-valid pending challenge and try
        // exactly once with the next reserved step rather than relying on a
        // Playwright retry worker to recover.
        code = await freshAdminTotpCode(secret);
        verifyRes = await postAdminAuth(request, '/api/v1/auth/2fa/verify', () => ({
          pendingToken: body.pendingToken,
          code,
        }));
        if (verifyRes.ok()) return 'assured';
        verifyBody = await verifyRes.text();
      }
      throw new Error(`Admin 2FA verify failed: ${verifyRes.status()} ${verifyBody}`);
    }
    return 'assured';
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
  const confirmCode = await freshAdminTotpCode(secret);
  const confirmRes = await request.post(`${API_BASE_URL}/api/v1/admin/security/2fa/totp/confirm`, {
    headers: CSRF_HEADERS,
    data: { code: confirmCode },
  });
  if (!confirmRes.ok()) {
    throw new Error(`Admin TOTP confirm failed: ${confirmRes.status()} ${await confirmRes.text()}`);
  }
  return 'enrolled';
}

/**
 * Logs the given request context in as the seeded admin, transparently
 * handling the mandatory admin-2FA gate (§6.12, #400) so callers only see
 * "authenticated as admin". On a fresh admin the setup-gate-exempt
 * `/admin/security/2fa/totp/*` endpoints enroll a TOTP method and cache the
 * secret; on subsequent logins in the same process the cached secret completes
 * the login 2FA challenge. Test setup only — the happy path itself never
 * touches the admin app.
 *
 * Two attempts, because confirming the FIRST admin factor is a security
 * transition: the API bumps the admin's durable security generation and clears
 * the session cookie on the confirm response (#891), so the password-only
 * session that ran the enrollment is dead by the time it returns. A single
 * attempt therefore handed callers a signed-OUT context, and the next admin
 * call hit `requireAdmin`'s deliberate 404 (`NOT_FOUND`) — which is what broke
 * every spec that provisions accounts via {@link createInvite}. The second
 * attempt signs in again through the now-armed TOTP challenge and comes back
 * assured.
 */
async function loginAsAdmin(request: APIRequestContext): Promise<void> {
  if ((await signInAsAdminOnce(request)) === 'assured') return;
  if ((await signInAsAdminOnce(request)) === 'assured') return;
  // The second attempt can only report 'enrolled' if the admin's confirmed
  // factor vanished between the two — never in a healthy stack. Fail loudly
  // rather than return an unauthenticated context that 404s later.
  throw new Error(
    'Admin 2FA enrollment repeated on the second sign-in — the confirmed factor did not ' +
      `stick. Reset via \`pnpm --filter @bettertrack/api admin:break-glass ${ADMIN_EMAIL}\`.`,
  );
}

async function createAssuredAdminStorageState(
  requestFactory: APIRequest,
): Promise<AdminStorageState> {
  const request = await requestFactory.newContext({ baseURL: API_BASE_URL });
  try {
    await loginAsAdmin(request);
    const state = await request.storageState();
    const sessionCookies = state.cookies.filter((cookie) => cookie.name === 'bt_sid');
    if (sessionCookies.length !== 1) {
      throw new Error('Admin sign-in did not produce exactly one bt_sid session cookie.');
    }
    return { cookies: sessionCookies, origins: [] };
  } finally {
    await request.dispose();
  }
}

/**
 * Returns a disposable request context carrying the worker's one assured admin
 * session. Only callers that explicitly request an admin context receive the
 * cached cookie; Playwright's ordinary browser and API contexts remain signed
 * out. Disposing the returned context never destroys the cached server session.
 */
export async function newAdminRequestContext(
  requestFactory: APIRequest,
): Promise<APIRequestContext> {
  if (!assuredAdminStorageState) {
    assuredAdminStorageState = createAssuredAdminStorageState(requestFactory).catch((error) => {
      assuredAdminStorageState = null;
      throw error;
    });
  }
  const storageState = await assuredAdminStorageState;
  return requestFactory.newContext({ baseURL: API_BASE_URL, storageState });
}

/**
 * Opens a fresh browser context signed in as the admin, by lifting the admin
 * session cookie out of {@link newAdminRequestContext}'s request context and attaching it
 * to a new browser context. The admin app's session bootstrap (calls
 * `/auth/me` + `/admin/security/2fa/status`) then finds a confirmed admin, so
 * the SPA lands directly on the console — no admin-login UI to drive. Test
 * setup only; the caller owns the returned context and must close it.
 */
export async function newAdminBrowserContext(
  browser: Browser,
  apiRequest: APIRequestContext,
  // Extra `newContext` options — e.g. the phone viewport the responsive gate
  // (§13.5 V5-P13b) sweeps the console at. `baseURL` stays owned by this helper.
  // `NonNullable` is load-bearing: `newContext`'s parameter is optional, so
  // `Parameters<…>[0]` is `BrowserContextOptions | undefined` and `keyof` that
  // union is `never` — the `Omit` would collapse to `{}` and exclude nothing.
  options: Omit<NonNullable<Parameters<Browser['newContext']>[0]>, 'baseURL' | 'storageState'> = {},
): Promise<BrowserContext> {
  const state = await apiRequest.storageState();
  const sessionCookies = state.cookies.filter((c) => c.name === 'bt_sid');
  if (sessionCookies.length === 0) {
    throw new Error(
      'No bt_sid cookie in the admin API context — did you create it with ' +
        'newAdminRequestContext()?',
    );
  }
  // The ADMIN console's origin, not the user app's: the console is the same SPA
  // in admin mode, and the mode comes from `window.__BT__` — which only the
  // admin origin serves. Against the user origin, `/admin/*` has no route and
  // falls through to the sign-in page. Cookies ignore the port, so the session
  // minted against the API carries over unchanged. (This e2e stack boots a real
  // admin origin, so no config.js stubbing is needed here.)
  const context = await browser.newContext({ ...options, baseURL: ADMIN_BASE_URL });
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
