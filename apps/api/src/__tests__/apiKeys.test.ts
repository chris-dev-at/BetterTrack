import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  API_KEY_TOKEN_PREFIX,
  apiKeyListResponseSchema,
  createApiKeyResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { hashToken } from '../services/crypto/tokens';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** Log in as a fresh user and mint a key with the given scopes; returns the token + key id. */
async function mintKey(scopes: string[]): Promise<{ agent: Agent; token: string; id: string }> {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const res = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: 'test key', scopes });
  expect(res.status).toBe(201);
  const parsed = createApiKeyResponseSchema.parse(res.body);
  return { agent, token: parsed.token, id: parsed.key.id };
}

async function auditActions(): Promise<string[]> {
  const rows = await harness.db.select({ action: schema.auditLog.action }).from(schema.auditLog);
  return rows.map((r) => r.action);
}

describe('POST /api/v1/settings/api-keys', () => {
  it('returns the token exactly once and stores only its hash', async () => {
    const { token, id, agent } = await mintKey(['portfolio:read']);

    expect(token.startsWith(API_KEY_TOKEN_PREFIX)).toBe(true);

    const [row] = await harness.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    expect(row).toBeDefined();
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.scopes).toEqual(['portfolio:read']);

    // Re-fetching the key never carries the token (strict schema would reject it).
    const list = await agent.get('/api/v1/settings/api-keys');
    expect(list.status).toBe(200);
    const parsed = apiKeyListResponseSchema.parse(list.body);
    expect(parsed.keys).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it('rejects an unknown scope and an empty scope list', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const bad = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'x', scopes: ['admin:write'] });
    expect(bad.status).toBe(400);
    const none = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'x', scopes: [] });
    expect(none.status).toBe(400);
  });

  it('audit-logs key creation', async () => {
    await mintKey(['portfolio:read']);
    expect(await auditActions()).toContain('api_key.created');
  });
});

describe('bearer scope enforcement', () => {
  it('grants a scoped read but 403s a write and an unscoped module', async () => {
    const { token } = await mintKey(['portfolio:read']);
    const auth = `Bearer ${token}`;

    const read = await request(harness.app).get('/api/v1/portfolios').set('Authorization', auth);
    expect(read.status).toBe(200);

    // Write to the same module → needs portfolio:write.
    const write = await request(harness.app)
      .post('/api/v1/portfolios')
      .set('Authorization', auth)
      .send({ name: 'From API' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('INSUFFICIENT_SCOPE');

    // A module the key has no scope for at all.
    const other = await request(harness.app).get('/api/v1/workboard').set('Authorization', auth);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('INSUFFICIENT_SCOPE');

    expect(await auditActions()).toContain('api_key.scope_denied');
  });

  it('authorizes a write when the key holds the write scope', async () => {
    const { token } = await mintKey(['portfolio:read', 'portfolio:write']);
    const res = await request(harness.app)
      .post('/api/v1/portfolios')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'From API' });
    expect(res.status).toBe(201);
  });
});

describe('bearer auth boundaries', () => {
  it('401s a revoked key', async () => {
    const { token, id, agent } = await mintKey(['portfolio:read']);
    const del = await agent.delete(`/api/v1/settings/api-keys/${id}`).set(...XRW);
    expect(del.status).toBe(204);

    const res = await request(harness.app)
      .get('/api/v1/portfolios')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('API_KEY_INVALID');

    expect(await auditActions()).toContain('api_key.revoked');
  });

  it('401s an unknown / malformed token', async () => {
    const res = await request(harness.app)
      .get('/api/v1/portfolios')
      .set('Authorization', 'Bearer btk_notarealtoken');
    expect(res.status).toBe(401);
    const notBtk = await request(harness.app)
      .get('/api/v1/portfolios')
      .set('Authorization', 'Bearer something-else');
    expect(notBtk.status).toBe(401);
  });

  it('can never reach an admin endpoint (404, regardless of scopes)', async () => {
    const { token } = await mintKey([
      'portfolio:read',
      'portfolio:write',
      'workboard:read',
      'workboard:write',
      'market:read',
      'social:read',
    ]);
    const res = await request(harness.app)
      .get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('cannot manage API keys with an API key (session-only)', async () => {
    const { token } = await mintKey(['social:read']);
    const res = await request(harness.app)
      .get('/api/v1/settings/api-keys')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
  });
});

describe('CSRF exemption', () => {
  it('lets a bearer mutation through without the CSRF header, but not a cookie one', async () => {
    const { token, agent } = await mintKey(['portfolio:read', 'portfolio:write']);

    // Bearer POST with NO X-Requested-With header → not a CSRF rejection.
    const bearer = await request(harness.app)
      .post('/api/v1/portfolios')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'No CSRF header' });
    expect(bearer.status).toBe(201);

    // The same mutation over the cookie session with no header → CSRF rejected.
    const cookie = await agent.post('/api/v1/portfolios').send({ name: 'Needs header' });
    expect(cookie.status).toBe(403);
    expect(cookie.body.error.code).toBe('CSRF_HEADER_REQUIRED');
  });
});
