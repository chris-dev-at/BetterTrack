import { createHash, randomBytes } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  createApiKeyResponseSchema,
  oauthTokenResponseSchema,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { createOAuthRepository } from '../data/repositories/oauthRepository';
import { auditLog, users } from '../data/schema';
import { REMEMBERED_DEVICE_COOKIE } from '../http/cookies';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Credential lifecycle around an administrator password reset (PROJECTPLAN.md
 * §6.1 "Forced password change", §6.12 "reset password", §6.13 personal keys).
 *
 *  1. The reset revokes every personal API key of the account, one
 *     `api_key.revoked` audit row per key with the administrator as actor —
 *     and only that account's keys.
 *  2. While a change is required, `POST /auth/change-password` waives the
 *     current-password proof ONLY for a cookie session that signed in with a
 *     password at the account's current security generation (i.e. with the
 *     temporary password). Every other caller — a personal API key, an OAuth
 *     bearer, a PIN quick-auth session — presents the current password.
 *  3. A voluntary change keeps requiring, and accepting, the current password
 *     for every principal that may call the route.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const PIN = '4242';
const NEW_PASSWORD = 'freshly-chosen-strong-secret-7';
const MOBILE = FIRST_PARTY_CLIENTS.find(
  (client) => client.clientId === 'btc_IbT1mzw_7kBiPHPkGfaE0Q',
)!;

type Agent = ReturnType<typeof request.agent>;
type TestUser = Awaited<ReturnType<TestHarness['seedUser']>>;

let harness: TestHarness;

beforeAll(async () => {
  harness = await createTestApp();
  await seedFirstPartyClients(createOAuthRepository(harness.db));
}, 60_000);

const tag = () => randomBytes(5).toString('hex');

async function seedFreshUser(): Promise<TestUser> {
  const id = tag();
  return harness.seedUser({
    email: `reset-cred-${id}@bettertrack.test`,
    username: `resetcred${id}`,
  });
}

function login(identifier: string, password: string) {
  return request(harness.app)
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
}

async function loginAgent(identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(harness.app);
  const response = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return agent;
}

async function mintPersonalKey(agent: Agent, scopes: readonly ApiKeyScope[]) {
  const response = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: `reset-cred-${tag()}`, scopes });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const parsed = createApiKeyResponseSchema.parse(response.body);
  return { token: parsed.token, id: parsed.key.id };
}

async function mintFirstPartyBearer(agent: Agent, scopes: readonly ApiKeyScope[]) {
  const verifier = randomBytes(32).toString('base64url');
  const approved = await agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send({
      client_id: MOBILE.clientId,
      redirect_uri: MOBILE.redirectUris[0]!,
      scope: scopes.join(' '),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const code = new URL(approved.body.redirectTo as string).searchParams.get('code');
  expect(code).toBeTruthy();
  const exchanged = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: MOBILE.redirectUris[0]!,
    client_id: MOBILE.clientId,
    code_verifier: verifier,
  });
  expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
  const token = oauthTokenResponseSchema.parse(exchanged.body).access_token;
  expect((await harness.ctx.oauth.authenticateToken(token))?.firstParty).toBe(true);
  return token;
}

function cookieFrom(response: request.Response, name: string): string {
  const values = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const header = values.filter((value) => value.startsWith(`${name}=`)).at(-1);
  if (!header) throw new Error(`no ${name} cookie set`);
  return header.split(';')[0] ?? header;
}

/** A cookie session minted by `POST /auth/pin/quick-auth` on a remembered device. */
async function mintPinSessionCookie(user: TestUser, agent: Agent): Promise<string> {
  await harness.ctx.auth.setPin(user.id, PIN);
  const remembered = await agent.post('/api/v1/auth/remembered-device').set(...XRW);
  expect(remembered.status, JSON.stringify(remembered.body)).toBe(200);
  const quickAuth = await request(harness.app)
    .post('/api/v1/auth/pin/quick-auth')
    .set(...XRW)
    .set('Cookie', cookieFrom(remembered, REMEMBERED_DEVICE_COOKIE))
    .send({ pin: PIN });
  expect(quickAuth.status, JSON.stringify(quickAuth.body)).toBe(200);
  return cookieFrom(quickAuth, harness.ctx.config.cookie.name);
}

/**
 * Arm the forced-change flag on the row directly, so a test exercises the
 * change-password rule alone — independent of what else a reset revokes.
 */
async function requirePasswordChange(userId: string): Promise<void> {
  await harness.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, userId));
}

type ChangeBody = { currentPassword?: string; newPassword: string };
type ChangeCaller = (body: ChangeBody) => Promise<request.Response>;

const PRINCIPALS = [
  'password session',
  'personal API key',
  'first-party OAuth bearer',
  'PIN session',
] as const;
type PrincipalKind = (typeof PRINCIPALS)[number];

/** A change-password caller authenticated as `kind`, for a fresh account. */
async function callerFor(kind: PrincipalKind): Promise<{ user: TestUser; change: ChangeCaller }> {
  const user = await seedFreshUser();
  const agent = await loginAgent(user.email, user.password);
  switch (kind) {
    case 'password session':
      return {
        user,
        change: (body) =>
          agent
            .post('/api/v1/auth/change-password')
            .set(...XRW)
            .send(body),
      };
    case 'personal API key': {
      const { token } = await mintPersonalKey(agent, ['account:security']);
      return {
        user,
        change: (body) =>
          request(harness.app)
            .post('/api/v1/auth/change-password')
            .set('Authorization', `Bearer ${token}`)
            .send(body),
      };
    }
    case 'first-party OAuth bearer': {
      const token = await mintFirstPartyBearer(agent, ['account:security']);
      return {
        user,
        change: (body) =>
          request(harness.app)
            .post('/api/v1/auth/change-password')
            .set('Authorization', `Bearer ${token}`)
            .send(body),
      };
    }
    case 'PIN session': {
      const cookie = await mintPinSessionCookie(user, agent);
      return {
        user,
        change: (body) =>
          request(harness.app)
            .post('/api/v1/auth/change-password')
            .set(...XRW)
            .set('Cookie', cookie)
            .send(body),
      };
    }
  }
}

async function adminResetPassword(userId: string): Promise<{ adminId: string; temp: string }> {
  const id = tag();
  const admin = await harness.seedAdmin({
    email: `reset-admin-${id}@test.dev`,
    username: `resetadm${id}`,
  });
  const adminAgent = await harness.loginAdmin(admin);
  const reset = await adminAgent.post(`/api/v1/admin/users/${userId}/reset-password`).set(...XRW);
  expect(reset.status, JSON.stringify(reset.body)).toBe(200);
  return { adminId: admin.id, temp: reset.body.tempPassword as string };
}

describe('administrator password reset revokes the account’s personal API keys', () => {
  it('refuses every existing personal key of the account after the reset, audited per key', async () => {
    const user = await seedFreshUser();
    const agent = await loginAgent(user.email, user.password);
    const readKey = await mintPersonalKey(agent, ['portfolio:read']);
    const securityKey = await mintPersonalKey(agent, ['account:security']);
    const bearer = (token: string) => ['Authorization', `Bearer ${token}`] as const;
    for (const key of [readKey, securityKey]) {
      expect(
        (
          await request(harness.app)
            .get('/api/v1/auth/me')
            .set(...bearer(key.token))
        ).status,
      ).toBe(200);
    }

    const { adminId, temp } = await adminResetPassword(user.id);

    for (const key of [readKey, securityKey]) {
      const me = await request(harness.app)
        .get('/api/v1/auth/me')
        .set(...bearer(key.token));
      expect(me.status, JSON.stringify(me.body)).toBe(401);
      expect(await harness.ctx.apiKeys.authenticate(key.token)).toBeNull();
    }

    const rows = await harness.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'api_key.revoked'),
          inArray(auditLog.targetId, [readKey.id, securityKey.id]),
        ),
      );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        actorId: adminId,
        targetType: 'api_key',
        meta: { reason: 'password_reset', source: 'admin' },
      });
    }

    // The revocation is permanent: completing the forced change does not revive a key.
    const tempAgent = await loginAgent(user.email, temp);
    const changed = await tempAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ newPassword: NEW_PASSWORD });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(
      (
        await request(harness.app)
          .get('/api/v1/auth/me')
          .set(...bearer(readKey.token))
      ).status,
    ).toBe(401);
  });

  it('leaves another account’s personal keys untouched', async () => {
    const target = await seedFreshUser();
    const bystander = await seedFreshUser();
    const bystanderKey = await mintPersonalKey(
      await loginAgent(bystander.email, bystander.password),
      ['portfolio:read'],
    );

    await adminResetPassword(target.id);

    const me = await request(harness.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${bystanderKey.token}`);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.id).toBe(bystander.id);
  });
});

describe('forced password change: only the temporary-password sign-in skips the current password', () => {
  it('a cookie session signed in with the temporary password changes it without the current password', async () => {
    const user = await seedFreshUser();
    const { temp } = await adminResetPassword(user.id);
    const tempAgent = await loginAgent(user.email, temp);

    const changed = await tempAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ newPassword: NEW_PASSWORD });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.mustChangePassword).toBe(false);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it.each(['personal API key', 'first-party OAuth bearer', 'PIN session'] as const)(
    'a %s must present the current password while a change is required',
    async (kind) => {
      const { user, change } = await callerFor(kind);
      await requirePasswordChange(user.id);

      const refused = await change({ newPassword: NEW_PASSWORD });
      expect(refused.status, JSON.stringify(refused.body)).toBe(401);
      expect(refused.body.error.code).toBe('INVALID_CREDENTIALS');
      // The security property itself: the stored password did not change.
      expect((await login(user.email, NEW_PASSWORD)).status).toBe(401);
      expect((await login(user.email, user.password)).status).toBe(200);

      const wrong = await change({
        currentPassword: 'not-the-current-one',
        newPassword: NEW_PASSWORD,
      });
      expect(wrong.status, JSON.stringify(wrong.body)).toBe(401);

      // With the current (temporary) password the same caller completes the change.
      const accepted = await change({ currentPassword: user.password, newPassword: NEW_PASSWORD });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body.mustChangePassword).toBe(false);
      expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    },
  );
});

describe('voluntary password change keeps requiring the current password', () => {
  it.each(PRINCIPALS)('a %s is refused without it and succeeds with it', async (kind) => {
    const { user, change } = await callerFor(kind);

    const missing = await change({ newPassword: NEW_PASSWORD });
    expect(missing.status, JSON.stringify(missing.body)).toBe(401);
    expect(missing.body.error.code).toBe('INVALID_CREDENTIALS');

    const accepted = await change({ currentPassword: user.password, newPassword: NEW_PASSWORD });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });
});
