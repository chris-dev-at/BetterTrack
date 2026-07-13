import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { meResponseSchema, rememberedDeviceResponseSchema } from '@bettertrack/contracts';

import { REMEMBERED_DEVICE_COOKIE } from '../http/cookies';
import {
  PIN_TOKEN_ACCOUNT_NAMESPACE,
  pinQuickAuthMarkerKey,
  rememberedDeviceKey,
} from '../services/auth/loginThrottle';
import { progressiveKeys } from '../services/security/progressiveLimiter';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * OAuth account memory + PIN quick re-auth (PROJECTPLAN.md §16; owner spec #399
 * §B, V4-P2b). Exercises the server half of the chooser state ladder: the signed
 * `bt_rdid` device binding, PIN-only quick re-auth (probe / verify / ~15-min
 * auto-pass window), the shared per-account PIN limiter, and "forget". The
 * chooser UI itself lives in the web app (LoginPage / OAuthAccountChooser).
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const PIN = '4242';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(email: string, password: string) {
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: email, password });
  expect(res.status).toBe(200);
  return agent;
}

/** The signed `bt_rdid=…` cookie pair from a Set-Cookie header, for replay on agent-less requests. */
function deviceCookie(res: request.Response): string {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  const header = (setCookie ?? [])
    .filter((c) => c.startsWith(`${REMEMBERED_DEVICE_COOKIE}=`))
    .at(-1);
  if (!header) throw new Error('no remembered-device cookie set');
  return header.split(';')[0] ?? header;
}

/** The `bt_sid=…` session cookie pair from a Set-Cookie header. */
function sessionCookie(res: request.Response): string {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  const header = (setCookie ?? []).filter((c) => c.startsWith('bt_sid=')).at(-1);
  if (!header) throw new Error('no session cookie set');
  return header.split(';')[0] ?? header;
}

/** Seed an active user, give it a PIN, remember its device, and return the signed device cookie. */
async function rememberPinUser() {
  const user = await harness.seedUser();
  await harness.ctx.auth.setPin(user.id, PIN);
  const agent = await loginAgent(user.email, user.password);
  const res = await agent.post('/api/v1/auth/remembered-device').set(...XRW);
  expect(res.status).toBe(200);
  return { user, cookie: deviceCookie(res), body: res.body as unknown };
}

describe('POST /auth/remembered-device — remember this device (PIN users only)', () => {
  it('remembers a PIN user, storing only user id + username + avatar (never a token)', async () => {
    const { user, body } = await rememberPinUser();

    // The record the client stores is exactly the three allowed fields.
    const parsed = rememberedDeviceResponseSchema.parse(body);
    expect(parsed).toEqual({ userId: user.id, username: user.username, avatarUrl: null });
    // Assert on the RAW stored shape: no token/scope/anything else leaked in.
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([
      'avatarUrl',
      'userId',
      'username',
    ]);
  });

  it('binds the device to the user in Redis with no TTL (until cleared)', async () => {
    const { user, cookie } = await rememberPinUser();
    // The cookie value is the signed `s:<deviceId>.<sig>` form; derive the raw id
    // from the binding via the plaintext service call instead of parsing the sig.
    const direct = await harness.ctx.auth.rememberDevice(user.id);
    expect(await harness.ctx.redis.get(rememberedDeviceKey(direct.deviceId))).toBe(user.id);
    // No expiry set — "until cleared" (owner). -1 = key exists with no TTL.
    expect(await harness.ctx.redis.ttl(rememberedDeviceKey(direct.deviceId))).toBe(-1);
    expect(cookie).toContain(`${REMEMBERED_DEVICE_COOKIE}=`);
  });

  it('refuses to remember a PIN-less account (only PIN users can be remembered)', async () => {
    const user = await harness.seedUser(); // no PIN
    const agent = await loginAgent(user.email, user.password);
    const res = await agent.post('/api/v1/auth/remembered-device').set(...XRW);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PIN_NOT_ENABLED');
  });

  it('requires a user-kind session (401 when anonymous)', async () => {
    const res = await request(harness.app)
      .post('/api/v1/auth/remembered-device')
      .set(...XRW);
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/pin/quick-auth — PIN-only re-auth for a remembered device', () => {
  it('signs the user in from the PIN alone (no password) and mints a session', async () => {
    const { user, cookie } = await rememberPinUser();

    const res = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ pin: PIN });

    expect(res.status).toBe(200);
    const me = meResponseSchema.parse(res.body);
    expect(me.id).toBe(user.id);
    // A usable session cookie was set — /auth/me works with it, no password used.
    const sid = sessionCookie(res);
    const meRes = await request(harness.app).get('/api/v1/auth/me').set('Cookie', sid);
    expect(meRes.status).toBe(200);
    expect(meRes.body.id).toBe(user.id);
  });

  it('a probe (no PIN) with a closed window asks for the PIN — not an error', async () => {
    const { cookie } = await rememberPinUser();
    const res = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pinRequired: true });
  });

  it('a probe auto-passes while the ~15-min window from a recent PIN entry is open', async () => {
    const { user, cookie } = await rememberPinUser();
    // A correct PIN opens the device-keyed window…
    const first = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ pin: PIN });
    expect(first.status).toBe(200);

    // …so a subsequent probe (no PIN) auto-logs-in without re-entering it.
    const probe = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({});
    expect(probe.status).toBe(200);
    expect(meResponseSchema.parse(probe.body).id).toBe(user.id);
  });

  it('rejects a wrong PIN with 401 INVALID_PIN', async () => {
    const { cookie } = await rememberPinUser();
    const res = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ pin: '0000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_PIN');
  });

  it('returns REMEMBER_DEVICE_UNKNOWN with no device cookie (blank-login fallback)', async () => {
    const res = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .send({ pin: PIN });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REMEMBER_DEVICE_UNKNOWN');
  });

  it('the minted quick-auth session surfaces in the sessions manager', async () => {
    const { cookie } = await rememberPinUser();
    const res = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ pin: PIN });
    const sid = sessionCookie(res);

    const list = await request(harness.app).get('/api/v1/auth/sessions').set('Cookie', sid);
    expect(list.status).toBe(200);
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(1);
    // The session we are calling with (the quick-auth one) is the current marker.
    expect(list.body.sessions.some((s: { current: boolean }) => s.current)).toBe(true);
  });
});

describe('PIN quick re-auth rides the existing progressive PIN limiter', () => {
  it('hammering wrong PINs locks out on the shared per-account schedule', async () => {
    const { user, cookie } = await rememberPinUser();

    let sawTooMany = false;
    for (let i = 0; i < 14 && !sawTooMany; i += 1) {
      const res = await request(harness.app)
        .post('/api/v1/auth/pin/quick-auth')
        .set(...XRW)
        .set('Cookie', cookie)
        .send({ pin: '0001' });
      if (res.status === 429) {
        sawTooMany = true;
        expect(res.body.error.code).toBe('RATE_LIMITED');
      } else {
        expect(res.status).toBe(401);
      }
    }
    expect(sawTooMany).toBe(true);

    // The cooldown lives under the SAME namespace as the bearer PIN verify
    // (`pin_token_account`, keyed by user id) — one lockout, one schedule.
    const cd = progressiveKeys(PIN_TOKEN_ACCOUNT_NAMESPACE, user.id).cooldown;
    expect(await harness.ctx.redis.get(cd)).not.toBeNull();

    // While cooling down even the CORRECT PIN is refused, via quick-auth…
    const correct = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ pin: PIN });
    expect(correct.status).toBe(429);

    // …and via the bearer PIN-verify path, proving the two share the limiter.
    await expect(
      harness.ctx.auth.verifyPinForToken({ userId: user.id, pin: PIN }),
    ).rejects.toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
  });
});

describe('DELETE /auth/remembered-device — "Another account" / forget', () => {
  it('over HTTP: the forgotten device can no longer quick-auth (blank-login fallback)', async () => {
    const { cookie } = await rememberPinUser();

    const del = await request(harness.app)
      .delete('/api/v1/auth/remembered-device')
      .set(...XRW)
      .set('Cookie', cookie);
    expect(del.status).toBe(200);

    // The device the cookie pointed at is no longer remembered → blank login.
    const after = await request(harness.app)
      .post('/api/v1/auth/pin/quick-auth')
      .set(...XRW)
      .set('Cookie', cookie)
      .send({ pin: PIN });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('REMEMBER_DEVICE_UNKNOWN');
  });

  it('clears BOTH the binding and the quick-auth window for the device', async () => {
    const user = await harness.seedUser();
    await harness.ctx.auth.setPin(user.id, PIN);
    const { deviceId } = await harness.ctx.auth.rememberDevice(user.id);
    await harness.ctx.redis.set(pinQuickAuthMarkerKey(deviceId), '1');

    await harness.ctx.auth.forgetDevice(deviceId);

    expect(await harness.ctx.redis.get(rememberedDeviceKey(deviceId))).toBeNull();
    expect(await harness.ctx.redis.get(pinQuickAuthMarkerKey(deviceId))).toBeNull();
  });

  it('is a no-op (200) when the device is not remembered', async () => {
    const res = await request(harness.app)
      .delete('/api/v1/auth/remembered-device')
      .set(...XRW);
    expect(res.status).toBe(200);
  });
});
