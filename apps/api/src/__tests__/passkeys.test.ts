import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { eq } from 'drizzle-orm';

import * as schema from '../data/schema';
import type { PasskeyWebAuthnEngine } from '../services/auth/passkeyService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Passkeys / WebAuthn (PROJECTPLAN.md §13.4 V4-P4). Fixture-driven: the
 * `@simplewebauthn` crypto is replaced by a scripted {@link fakeEngine} so the
 * whole register/login lifecycle runs with no real authenticator, browser, or
 * network — exactly what the issue asks for. The acceptance criteria are the
 * point: multiple named passkeys with rename/delete; add + delete are re-auth-
 * gated; a verified passkey issues a session through the SAME path as password
 * login and raises no follow-up 2FA challenge (§16); challenges are single-use
 * and short-lived; a counter regression is rejected + audited; deleting a
 * credential kills its login path and the last one may be removed.
 *
 * The scripted engine derives its result from the `response` blob each request
 * sends, so a test scripts the ceremony outcome purely from the payload:
 *   - `response.id`         → the credential id to register / look up on login
 *   - `response._counter`   → the counter stored at registration
 *   - `response._newCounter`→ the counter an assertion presents (clone detection)
 *   - `response._throw`     → make verification throw (bad signature)
 *   - `response._verified`  → force `verified: false`
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

interface ScriptedResponse {
  id?: string;
  transports?: string[];
  _counter?: number;
  _newCounter?: number;
  _throw?: boolean;
  _verified?: boolean;
}

const fakeEngine: PasskeyWebAuthnEngine = {
  async generateRegistrationOptions(options) {
    return {
      challenge: 'reg-challenge',
      rp: { id: options.rpID, name: options.rpName },
      user: { id: 'dXNlcg', name: options.userName, displayName: options.userName },
      pubKeyCredParams: [],
      excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
        id: c.id,
        type: 'public-key',
      })),
    } as unknown as Awaited<ReturnType<PasskeyWebAuthnEngine['generateRegistrationOptions']>>;
  },
  async verifyRegistrationResponse(options) {
    const r = options.response as unknown as ScriptedResponse;
    if (r._verified === false) {
      return { verified: false } as Awaited<
        ReturnType<PasskeyWebAuthnEngine['verifyRegistrationResponse']>
      >;
    }
    return {
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: {
          id: r.id ?? 'cred-default',
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: r._counter ?? 0,
          transports: r.transports,
        },
        credentialType: 'public-key',
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: options.expectedOrigin as string,
      },
    } as unknown as Awaited<ReturnType<PasskeyWebAuthnEngine['verifyRegistrationResponse']>>;
  },
  async generateAuthenticationOptions(options) {
    return {
      challenge: 'login-challenge',
      rpId: options.rpID,
      allowCredentials: [],
      userVerification: 'required',
    } as unknown as Awaited<ReturnType<PasskeyWebAuthnEngine['generateAuthenticationOptions']>>;
  },
  async verifyAuthenticationResponse(options) {
    const r = options.response as unknown as ScriptedResponse;
    if (r._throw) throw new Error('bad signature');
    return {
      verified: r._verified ?? true,
      authenticationInfo: {
        credentialID: options.credential.id,
        newCounter: r._newCounter ?? options.credential.counter + 1,
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: options.expectedOrigin as string,
        rpID: (Array.isArray(options.expectedRPID)
          ? options.expectedRPID[0]
          : options.expectedRPID) as string,
      },
    } as unknown as Awaited<ReturnType<PasskeyWebAuthnEngine['verifyAuthenticationResponse']>>;
  },
};

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ passkeyEngine: fakeEngine });
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

/** Register a passkey end to end (options → verify) with the given name + credential id. */
async function registerPasskey(
  agent: Agent,
  name: string,
  credentialId: string,
  password: string,
  extra: Partial<ScriptedResponse> = {},
): Promise<request.Response> {
  const opts = await agent
    .post('/api/v1/auth/passkeys/register/options')
    .set(...XRW)
    .send();
  expect(opts.status).toBe(200);
  return agent
    .post('/api/v1/auth/passkeys/register/verify')
    .set(...XRW)
    .send({ name, response: { id: credentialId, ...extra }, password });
}

/** Drive a public passkey login (options → verify) for a credential id. */
async function loginWithPasskey(
  app: Application,
  credentialId: string,
  scripted: Partial<ScriptedResponse> = {},
): Promise<{ agent: Agent; res: request.Response }> {
  const agent = request.agent(app);
  const opts = await agent
    .post('/api/v1/auth/passkeys/login/options')
    .set(...XRW)
    .send();
  expect(opts.status).toBe(200);
  const res = await agent
    .post('/api/v1/auth/passkeys/login/verify')
    .set(...XRW)
    .send({ challengeId: opts.body.challengeId, response: { id: credentialId, ...scripted } });
  return { agent, res };
}

describe('passkeys — registration & management', () => {
  it('registers multiple named passkeys; the list shows name/created/last-used', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const first = await registerPasskey(agent, 'Laptop', 'cred-a', user.password);
    expect(first.status).toBe(201);
    expect(first.body.name).toBe('Laptop');
    expect(first.body.lastUsedAt).toBeNull();

    const second = await registerPasskey(agent, 'Phone', 'cred-b', user.password);
    expect(second.status).toBe(201);

    const list = await agent.get('/api/v1/auth/passkeys');
    expect(list.status).toBe(200);
    expect(list.body.passkeys).toHaveLength(2);
    const names = list.body.passkeys.map((p: { name: string }) => p.name);
    expect(names).toContain('Laptop');
    expect(names).toContain('Phone');
    for (const p of list.body.passkeys) {
      expect(typeof p.createdAt).toBe('string');
      expect(p).toHaveProperty('lastUsedAt');
    }
  });

  it('renames a passkey', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await registerPasskey(agent, 'Old name', 'cred-a', user.password);
    expect(created.status).toBe(201);

    const renamed = await agent
      .patch(`/api/v1/auth/passkeys/${created.body.id}`)
      .set(...XRW)
      .send({ name: 'New name' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('New name');

    const list = await agent.get('/api/v1/auth/passkeys');
    expect(list.body.passkeys[0].name).toBe('New name');
  });

  it('rejects re-registering an already-registered credential id', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    expect((await registerPasskey(agent, 'A', 'cred-a', user.password)).status).toBe(201);
    const dup = await registerPasskey(agent, 'B', 'cred-a', user.password);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PASSKEY_ALREADY_REGISTERED');
  });
});

describe('passkeys — re-auth gating on add + delete', () => {
  it('adding a passkey requires a correct re-auth (fresh password)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    // A challenge is minted, but a WRONG password is rejected.
    await agent
      .post('/api/v1/auth/passkeys/register/options')
      .set(...XRW)
      .send();
    const wrong = await agent
      .post('/api/v1/auth/passkeys/register/verify')
      .set(...XRW)
      .send({ name: 'X', response: { id: 'cred-a' }, password: 'not-my-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    // No re-auth field at all is a validation rejection.
    const none = await agent
      .post('/api/v1/auth/passkeys/register/verify')
      .set(...XRW)
      .send({ name: 'X', response: { id: 'cred-a' } });
    expect(none.status).toBe(400);
  });

  it('deleting a passkey requires a correct re-auth (fresh password)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await registerPasskey(agent, 'Laptop', 'cred-a', user.password);
    expect(created.status).toBe(201);

    const wrong = await agent
      .delete(`/api/v1/auth/passkeys/${created.body.id}`)
      .set(...XRW)
      .send({ password: 'not-my-password' });
    expect(wrong.status).toBe(401);

    // Still present after the failed re-auth.
    const list = await agent.get('/api/v1/auth/passkeys');
    expect(list.body.passkeys).toHaveLength(1);

    const ok = await agent
      .delete(`/api/v1/auth/passkeys/${created.body.id}`)
      .set(...XRW)
      .send({ password: user.password });
    expect(ok.status).toBe(200);
  });

  it('allows deleting the LAST passkey (password login remains)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await registerPasskey(agent, 'Only one', 'cred-a', user.password);

    const del = await agent
      .delete(`/api/v1/auth/passkeys/${created.body.id}`)
      .set(...XRW)
      .send({ password: user.password });
    expect(del.status).toBe(200);
    const list = await agent.get('/api/v1/auth/passkeys');
    expect(list.body.passkeys).toHaveLength(0);
  });

  it('requires a session for management endpoints', async () => {
    const anon = request.agent(harness.app);
    const res = await anon.get('/api/v1/auth/passkeys');
    expect(res.status).toBe(401);
  });
});

describe('passkeys — login', () => {
  it('issues a session through the same path as password login (me + session manager)', async () => {
    const user = await harness.seedUser();
    const setup = await loginAgent(harness.app, user.email, user.password);
    expect((await registerPasskey(setup, 'Laptop', 'cred-a', user.password)).status).toBe(201);

    const { agent, res } = await loginWithPasskey(harness.app, 'cred-a');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);

    // The session cookie works exactly like a password login's.
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(user.id);

    // The new session appears in the session manager, and a LoginSuccess audit
    // records the passkey channel.
    const sessions = await agent.get('/api/v1/auth/sessions');
    expect(sessions.body.sessions.length).toBeGreaterThanOrEqual(1);
    const audits = await harness.db.select().from(schema.auditLog);
    const success = audits.find(
      (a) =>
        a.action === 'login.success' &&
        a.targetId === user.id &&
        (a.meta as { via?: string } | null)?.via === 'passkey',
    );
    expect(success).toBeTruthy();

    // The credential's last-used stamp + counter advanced.
    const [row] = await harness.db
      .select()
      .from(schema.passkeys)
      .where(eq(schema.passkeys.credentialId, 'cred-a'));
    expect(row?.lastUsedAt).not.toBeNull();
    expect(row?.counter).toBe(1);
  });

  it('a user-verified passkey login raises NO follow-up 2FA challenge (§16)', async () => {
    const user = await harness.seedUser();
    const setup = await loginAgent(harness.app, user.email, user.password);
    expect((await registerPasskey(setup, 'Laptop', 'cred-a', user.password)).status).toBe(201);

    // Arm 2FA: a password login would now return a challenge instead of a session.
    await harness.db
      .update(schema.users)
      .set({ twoFactorEnabled: true, twoFactorSecret: 'enc:dummy' })
      .where(eq(schema.users.id, user.id));

    const { res } = await loginWithPasskey(harness.app, 'cred-a');
    expect(res.status).toBe(200);
    // A real signed-in user view — not a `{ twoFactorRequired: true }` challenge.
    expect(res.body.id).toBe(user.id);
    expect(res.body.twoFactorRequired).toBeUndefined();
  });

  it('rejects a signature-counter regression (cloned authenticator) and audits it', async () => {
    const user = await harness.seedUser();
    const setup = await loginAgent(harness.app, user.email, user.password);
    expect((await registerPasskey(setup, 'Laptop', 'cred-a', user.password)).status).toBe(201);

    // First login advances the stored counter to 5.
    const first = await loginWithPasskey(harness.app, 'cred-a', { _newCounter: 5 });
    expect(first.res.status).toBe(200);

    // A later assertion presenting a counter that did not advance is a clone signal.
    const replay = await loginWithPasskey(harness.app, 'cred-a', { _newCounter: 3 });
    expect(replay.res.status).toBe(401);
    expect(replay.res.body.error.code).toBe('PASSKEY_COUNTER_REGRESSION');

    const audits = await harness.db.select().from(schema.auditLog);
    const regression = audits.find(
      (a) =>
        a.action === 'passkey.login_fail' &&
        (a.meta as { reason?: string } | null)?.reason === 'counter_regression',
    );
    expect(regression).toBeTruthy();

    // The stored counter is unchanged (the regression never advanced it).
    const [row] = await harness.db
      .select()
      .from(schema.passkeys)
      .where(eq(schema.passkeys.credentialId, 'cred-a'));
    expect(row?.counter).toBe(5);
  });

  it('fails a login whose assertion cannot be verified (bad signature)', async () => {
    const user = await harness.seedUser();
    const setup = await loginAgent(harness.app, user.email, user.password);
    expect((await registerPasskey(setup, 'Laptop', 'cred-a', user.password)).status).toBe(201);

    const { res } = await loginWithPasskey(harness.app, 'cred-a', { _throw: true });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('PASSKEY_VERIFICATION_FAILED');
  });

  it('fails a login for an unknown credential', async () => {
    const { res } = await loginWithPasskey(harness.app, 'never-registered');
    expect(res.status).toBe(401);
  });

  it('deleting a credential kills its login path', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const created = await registerPasskey(agent, 'Laptop', 'cred-a', user.password);

    // Works before deletion…
    expect((await loginWithPasskey(harness.app, 'cred-a')).res.status).toBe(200);

    const del = await agent
      .delete(`/api/v1/auth/passkeys/${created.body.id}`)
      .set(...XRW)
      .send({ password: user.password });
    expect(del.status).toBe(200);

    // …and is dead afterwards.
    expect((await loginWithPasskey(harness.app, 'cred-a')).res.status).toBe(401);
  });
});

describe('passkeys — challenges are single-use and short-lived', () => {
  it('a consumed registration challenge cannot be replayed', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    await agent
      .post('/api/v1/auth/passkeys/register/options')
      .set(...XRW)
      .send();
    const first = await agent
      .post('/api/v1/auth/passkeys/register/verify')
      .set(...XRW)
      .send({ name: 'Laptop', response: { id: 'cred-a' }, password: user.password });
    expect(first.status).toBe(201);

    // Replaying the verify (without a fresh options call) finds no challenge.
    const replay = await agent
      .post('/api/v1/auth/passkeys/register/verify')
      .set(...XRW)
      .send({ name: 'Laptop 2', response: { id: 'cred-b' }, password: user.password });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('PASSKEY_CHALLENGE_INVALID');
  });

  it('a login challenge is single-use', async () => {
    const user = await harness.seedUser();
    const setup = await loginAgent(harness.app, user.email, user.password);
    expect((await registerPasskey(setup, 'Laptop', 'cred-a', user.password)).status).toBe(201);

    const agent = request.agent(harness.app);
    const opts = await agent
      .post('/api/v1/auth/passkeys/login/options')
      .set(...XRW)
      .send();
    const body = { challengeId: opts.body.challengeId, response: { id: 'cred-a' } };
    const first = await agent
      .post('/api/v1/auth/passkeys/login/verify')
      .set(...XRW)
      .send(body);
    expect(first.status).toBe(200);
    const replay = await agent
      .post('/api/v1/auth/passkeys/login/verify')
      .set(...XRW)
      .send(body);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('PASSKEY_CHALLENGE_INVALID');
  });

  it('an expired (gone) login challenge fails', async () => {
    const user = await harness.seedUser();
    const setup = await loginAgent(harness.app, user.email, user.password);
    expect((await registerPasskey(setup, 'Laptop', 'cred-a', user.password)).status).toBe(201);

    const agent = request.agent(harness.app);
    const opts = await agent
      .post('/api/v1/auth/passkeys/login/options')
      .set(...XRW)
      .send();
    // Simulate the short TTL lapsing before verify.
    await harness.ctx.redis.del(`passkey_login_chal:${opts.body.challengeId}`);
    const res = await agent
      .post('/api/v1/auth/passkeys/login/verify')
      .set(...XRW)
      .send({ challengeId: opts.body.challengeId, response: { id: 'cred-a' } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('PASSKEY_CHALLENGE_INVALID');
  });
});
