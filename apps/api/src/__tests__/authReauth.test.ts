import { and, eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApiKeyScope } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { openApiPathTemplateAcceptsBearer, pathAcceptsBearer } from '../http/middleware/bearerAuth';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

/**
 * `POST /auth/reauth` — the generic session step-up verifier.
 *
 * Relocated here from `vaultsV2.test.ts` when the per-portfolio vault v2 surface
 * was removed (owner ruling 2026-08-19, PROJECTPLAN §16). The route itself
 * SURVIVES: it was built as the repo's first generic re-authentication verifier
 * — every earlier step-up rode on the destructive endpoint it protected — so it
 * outlives the QR handoff that first needed it, and it must keep its own tests.
 *
 * The invariants: it verifies the CURRENT session user's password, mints
 * nothing, audits both outcomes, fails closed for bearer tokens on every scope,
 * throttles per account, and treats `purpose` as an opaque bounded label that
 * can never change what is verified.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;
let sequence = 0;

beforeEach(async () => {
  harness = await createTestApp();
  sequence = 0;
});

type Agent = ReturnType<typeof request.agent>;

async function seedUser(prefix: string): Promise<SeededUser> {
  sequence += 1;
  return harness.seedUser({
    email: `${prefix}-${sequence}@bettertrack.test`,
    username: `${prefix}${sequence}`,
  });
}

async function loginAgent(app: Application, user: SeededUser): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return agent;
}

async function mintToken(
  user: SeededUser,
  scopes: ApiKeyScope[],
  name = 'reauth',
): Promise<string> {
  const key = await harness.ctx.apiKeys.create({ userId: user.id, name, scopes });
  return key.token;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('auth — generic session step-up (POST /auth/reauth)', () => {
  it('verifies the current session user’s password and mints nothing', async () => {
    const user = await seedUser('reauth');
    const agent = await loginAgent(harness.app, user);

    const ok = await agent
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: user.password, purpose: 'account.sensitive_reveal' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);
    expect(ok.body).toEqual({});
    // No cookie is set or rotated: a 204 is an assertion about this instant,
    // never a credential the caller can carry.
    expect(ok.headers['set-cookie']).toBeUndefined();

    const audited = await harness.db
      .select({ action: schema.auditLog.action, meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.actorId, user.id), eq(schema.auditLog.action, 'auth.reauth')));
    expect(audited).toHaveLength(1);
    expect(audited[0]!.meta).toMatchObject({ purpose: 'account.sensitive_reveal' });
  });

  it('401s a wrong password with the generic credential error and audits the failure', async () => {
    const user = await seedUser('reauthbad');
    const agent = await loginAgent(harness.app, user);

    const res = await agent
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: 'definitely-not-the-password', purpose: 'account.sensitive_reveal' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const failures = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.actorId, user.id), eq(schema.auditLog.action, 'auth.reauth_fail')),
      );
    expect(failures).toHaveLength(1);
    expect(failures[0]!.meta).toMatchObject({ purpose: 'account.sensitive_reveal' });

    // The session survives a failed step-up — this is a verifier, not a logout.
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
  });

  it('requires a session and is unreachable with a bearer token', async () => {
    const user = await seedUser('reauthbearer');

    const anonymous = await request(harness.app)
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: user.password });
    expect(anonymous.status).toBe(401);

    // Every scope a token can hold, including the account-security scope that
    // gates the rest of the security surface: the route is session-only, so the
    // bearer policy refuses it before routing.
    for (const scopes of [['account:security'], ['vault:sync'], ['portfolio:write']] as const) {
      const token = await mintToken(user, [...scopes] as ApiKeyScope[], `reauth-${scopes[0]}`);
      const res = await request(harness.app)
        .post('/api/v1/auth/reauth')
        .set(bearer(token))
        .send({ password: user.password });
      expect(res.status, `scope ${scopes[0]}`).toBe(403);
      expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
    }

    // Pinned at the policy layer too, so a future carve-out has to be deliberate.
    expect(pathAcceptsBearer('/auth/reauth', 'POST')).toBe(false);
    expect(openApiPathTemplateAcceptsBearer('/auth/reauth', 'POST')).toBe(false);
  });

  it('throttles repeated failures per account and keeps a correct password out while cooling', async () => {
    const user = await seedUser('reauththrottle');
    const agent = await loginAgent(harness.app, user);

    let sawThrottle = false;
    for (let attempt = 0; attempt < 12 && !sawThrottle; attempt += 1) {
      const res = await agent
        .post('/api/v1/auth/reauth')
        .set(...XRW)
        .send({ password: `wrong-${attempt}` });
      if (res.status === 429) sawThrottle = true;
      else expect(res.status).toBe(401);
    }
    expect(sawThrottle, 'the per-account throttle never engaged').toBe(true);

    // The CORRECT password is refused while cooling: a blocked retry must not
    // ride through, or the throttle would be decorative.
    const correct = await agent
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: user.password });
    expect(correct.status).toBe(429);
  });

  it('validates the purpose without letting it change what is verified', async () => {
    const user = await seedUser('reauthpurpose');
    const agent = await loginAgent(harness.app, user);

    const tooLong = await agent
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: user.password, purpose: 'p'.repeat(65) });
    expect(tooLong.status).toBe(400);

    // A wrong password is still 401 no matter what purpose is claimed.
    const spoofed = await agent
      .post('/api/v1/auth/reauth')
      .set(...XRW)
      .send({ password: 'nope', purpose: 'admin.override' });
    expect(spoofed.status).toBe(401);
  });
});
