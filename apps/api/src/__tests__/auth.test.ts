import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  healthResponseSchema,
  meResponseSchema,
  versionResponseSchema,
} from '@bettertrack/contracts';

import { createUserRepository } from '../data/repositories/userRepository';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

describe('GET /api/v1/health', () => {
  it('returns a contract-valid health payload', async () => {
    const res = await request(harness.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(healthResponseSchema.safeParse(res.body).success).toBe(true);
  });
});

describe('GET /api/v1/version', () => {
  it('returns the deploy marker unauthenticated, with three string fields', async () => {
    // No cookie, no bearer, no CSRF header — the marker is fully public so any
    // script can verify which commit is live.
    const res = await request(harness.app).get('/api/v1/version');
    expect(res.status).toBe(200);
    expect(versionResponseSchema.safeParse(res.body).success).toBe(true);
    expect(typeof res.body.commit).toBe('string');
    expect(typeof res.body.shortCommit).toBe('string');
    expect(typeof res.body.builtAt).toBe('string');
  });
});

describe('POST /api/v1/auth/login', () => {
  it('logs in with valid credentials and establishes a session', async () => {
    const admin = await harness.seedAdmin();
    const agent = request.agent(harness.app);

    const res = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: admin.email, password: admin.password });

    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(res.body).email).toBe(admin.email);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(admin.username);
  });

  it('also accepts username as the identifier', async () => {
    const admin = await harness.seedAdmin();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: admin.username.toUpperCase(), password: admin.password });
    expect(res.status).toBe(200);
  });

  it('rejects a bad password and an unknown user with the same generic error', async () => {
    const admin = await harness.seedAdmin();

    const badPassword = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: admin.email, password: 'definitely-not-it' });

    const unknownUser = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'ghost@nowhere.test', password: 'definitely-not-it' });

    expect(badPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(badPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownUser.body.error.code).toBe('INVALID_CREDENTIALS');
    // No enumeration: identical message regardless of which part was wrong.
    expect(badPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('reveals a disabled account only after the correct password (§6.1, §16)', async () => {
    const user = await harness.seedUser();
    await createUserRepository(harness.db).setStatus(user.id, 'disabled');

    // Correct password + disabled account → distinct, non-generic 403.
    const disabledCorrect = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(disabledCorrect.status).toBe(403);
    expect(disabledCorrect.body.error.code).toBe('ACCOUNT_DISABLED');
    expect(disabledCorrect.body.error.message).toMatch(/suspend/i);

    // Wrong password on the same disabled account → still the generic 401,
    // so the suspended status is not an enumeration oracle.
    const disabledWrong = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: 'definitely-not-it' });
    expect(disabledWrong.status).toBe(401);
    expect(disabledWrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('logs in an active account with the correct password', async () => {
    const user = await harness.seedUser();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(res.body).email).toBe(user.email);
  });

  it('requires the X-Requested-With CSRF header', async () => {
    const admin = await harness.seedAdmin();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ identifier: admin.email, password: admin.password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_HEADER_REQUIRED');
  });

  it('rejects unknown fields in the request body', async () => {
    await harness.seedAdmin();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'a@b.test', password: 'whatever-123', extra: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('ends the session', async () => {
    const admin = await harness.seedAdmin();
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: admin.email, password: admin.password });

    const out = await agent.post('/api/v1/auth/logout').set(...XRW);
    expect(out.status).toBe(200);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(401);
  });
});

// Pulls the raw `bt_sid=...` cookie pair out of a Set-Cookie header so an old
// session id can be replayed after rotation. A single response can carry two
// (loadSession's rolling refresh, then the handler's rotated id) — the last one
// written wins, matching what the browser would store.
function sessionCookie(res: request.Response): string {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  const headers = (setCookie ?? []).filter((c) => c.startsWith('bt_sid='));
  const header = headers.at(-1);
  if (!header) throw new Error('no session cookie set');
  return header.split(';')[0] ?? header;
}

describe('session rotation on login (PROJECTPLAN.md §6.1, §10)', () => {
  it('destroys the pre-login session id when logging in again', async () => {
    const admin = await harness.seedAdmin();
    const agent = request.agent(harness.app);

    const first = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: admin.email, password: admin.password });
    const oldCookie = sessionCookie(first);

    // The old id still resolves before re-login.
    expect(
      (await request(harness.app).get('/api/v1/auth/me').set('Cookie', oldCookie)).status,
    ).toBe(200);

    // Logging in again (carrying the old cookie) rotates to a fresh id.
    const second = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: admin.email, password: admin.password });
    const newCookie = sessionCookie(second);
    expect(newCookie).not.toBe(oldCookie);

    // The rotated-out id is dead; the new one works.
    expect(
      (await request(harness.app).get('/api/v1/auth/me').set('Cookie', oldCookie)).status,
    ).toBe(401);
    expect(
      (await request(harness.app).get('/api/v1/auth/me').set('Cookie', newCookie)).status,
    ).toBe(200);
  });
});

describe('password change invalidates all sessions (PROJECTPLAN.md §6.1, §10)', () => {
  it('kills a second concurrent session and keeps the changing one alive', async () => {
    const admin = await harness.seedAdmin();

    const agentA = request.agent(harness.app);
    const agentB = request.agent(harness.app);
    for (const agent of [agentA, agentB]) {
      const res = await agent
        .post('/api/v1/auth/login')
        .set(...XRW)
        .send({ identifier: admin.email, password: admin.password });
      expect(res.status).toBe(200);
    }
    // Both sessions are live to start.
    expect((await agentA.get('/api/v1/auth/me')).status).toBe(200);
    expect((await agentB.get('/api/v1/auth/me')).status).toBe(200);

    const changed = await agentA
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: admin.password, newPassword: 'admin-rotated-secret-2' });
    expect(changed.status).toBe(200);

    // The other device is logged out instantly; the changing device continues.
    expect((await agentB.get('/api/v1/auth/me')).status).toBe(401);
    expect((await agentA.get('/api/v1/auth/me')).status).toBe(200);
  });
});
