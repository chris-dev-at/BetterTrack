import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { healthResponseSchema, meResponseSchema } from '@bettertrack/contracts';

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
