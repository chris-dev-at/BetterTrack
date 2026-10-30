import { randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createApiKeyResponseSchema,
  twoFactorChallengeResponseSchema,
  twoFactorEnrollResponseSchema,
  twoFactorMethodEnabledResponseSchema,
  twoFactorRecoveryCodesResponseSchema,
  twoFactorStatusResponseSchema,
} from '@bettertrack/contracts';

import { createTwoFactorRepository } from '../data/repositories/twoFactorRepository';
import * as schema from '../data/schema';
import { encryptSecret } from '../services/crypto/secretBox';
import { hashToken } from '../services/crypto/tokens';
import type { MailTransport, OutgoingMail } from '../services/email/transport';
import {
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  normalizeRecoveryCode,
  TOTP_STEP_SECONDS,
} from '../services/auth/totp';
import {
  createTestApp,
  type CreateTestAppOptions,
  type SeededUser,
  type TestHarness,
} from '../testing/createTestApp';

/**
 * R-05 (OpSec PR-5a): second-factor changes, and the in-body step-up on the
 * destructive account routes, require a credential the caller held BEFORE the
 * request — never one the same credential minted moments earlier.
 *
 *  1. Minting or removing a second factor (TOTP enroll/confirm, e-mail
 *     enroll/confirm/disable, recovery-code regeneration) needs `stepUp` in the
 *     body: the current password, or an existing TOTP / recovery code. Cookie
 *     sessions and bearers alike.
 *  2. A credential (cookie session, personal API key, OAuth grant) that issued
 *     second-factor material in the last 24 h cannot satisfy a step-up with a
 *     TOTP or recovery code; it must present the password. Other credentials
 *     are unaffected.
 *
 * The factor fixtures are seeded through the repository, not the routes under
 * test, so every red case fails on the security property itself.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const SELF_ISSUED = 'STEP_UP_PASSWORD_REQUIRED';
const DAY_MS = 24 * 60 * 60 * 1000;

const SMTP_ENV = {
  SMTP_HOST: 'smtp.test.local',
  SMTP_PORT: '587',
  SMTP_USER: 'mailer',
  SMTP_PASS: 'super-secret-smtp-pass',
  SMTP_FROM: 'BetterTrack <no-reply@test.local>',
} satisfies Partial<NodeJS.ProcessEnv>;

type Agent = ReturnType<typeof request.agent>;

let harness: TestHarness;

async function boot(options: CreateTestAppOptions = {}) {
  harness = await createTestApp(options);
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.dispose();
});

function recordingTransport(): MailTransport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function seedFreshUser(): Promise<SeededUser> {
  const tag = randomBytes(5).toString('hex');
  return harness.seedUser({ email: `u-${tag}@bettertrack.test`, username: `user${tag}` });
}

async function loginAgent(user: SeededUser): Promise<Agent> {
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return agent;
}

async function loginWithTotp(user: SeededUser, secret: string, nowMs = Date.now()) {
  const agent = request.agent(harness.app);
  const challenge = twoFactorChallengeResponseSchema.parse(
    (
      await agent
        .post('/api/v1/auth/login')
        .set(...XRW)
        .send({ identifier: user.email, password: user.password })
    ).body,
  );
  const verified = await agent
    .post('/api/v1/auth/2fa/verify')
    .set(...XRW)
    .send({ pendingToken: challenge.pendingToken, code: generateTotpCode(secret, nowMs) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return agent;
}

/** A personal API key holding `account:security`, minted from a cookie session. */
async function mintSecurityKey(user: SeededUser): Promise<string> {
  const agent = await loginAgent(user);
  const res = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: `phone-${randomBytes(3).toString('hex')}`, scopes: ['account:security'] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return createApiKeyResponseSchema.parse(res.body).token;
}

/** Arm TOTP straight through the repository (not through a route under test). */
async function seedTotp(userId: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const repo = createTwoFactorRepository(harness.db);
  const secret = generateTotpSecret();
  const envelope = encryptSecret(secret, harness.ctx.config.recordEncryption);
  const recoveryCodes = generateRecoveryCodes();
  expect(await repo.setProvisionalSecret(userId, envelope)).toBe(true);
  expect(
    await repo.confirmTotp(
      userId,
      envelope,
      new Date(),
      recoveryCodes.map((code) => hashToken(normalizeRecoveryCode(code))),
    ),
  ).not.toBeNull();
  return { secret, recoveryCodes };
}

/** Arm the e-mail method straight through the repository. */
async function seedEmailMethod(userId: string): Promise<string[]> {
  const repo = createTwoFactorRepository(harness.db);
  const recoveryCodes = generateRecoveryCodes();
  expect(
    await repo.confirmEmail(
      userId,
      undefined,
      recoveryCodes.map((code) => hashToken(normalizeRecoveryCode(code))),
    ),
  ).not.toBeNull();
  return recoveryCodes;
}

async function factorState(userId: string) {
  const [row] = await harness.db
    .select({
      secret: schema.users.twoFactorSecret,
      totpEnabled: schema.users.twoFactorEnabled,
      emailEnabled: schema.users.twoFactorEmailEnabled,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row!;
}

async function unusedRecoveryHashes(userId: string): Promise<string[]> {
  const rows = await harness.db
    .select({ hash: schema.twoFactorRecoveryCodes.codeHash })
    .from(schema.twoFactorRecoveryCodes)
    .where(
      and(
        eq(schema.twoFactorRecoveryCodes.userId, userId),
        isNull(schema.twoFactorRecoveryCodes.usedAt),
      ),
    );
  return rows.map((row) => row.hash).sort();
}

async function userExists(userId: string): Promise<boolean> {
  const rows = await harness.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return rows.length === 1;
}

async function seedPasskey(userId: string): Promise<string> {
  const [row] = await harness.db
    .insert(schema.passkeys)
    .values({
      userId,
      name: 'Laptop',
      credentialId: `cred-${randomBytes(6).toString('hex')}`,
      publicKey: 'AQIDBA',
    })
    .returning({ id: schema.passkeys.id });
  return row!.id;
}

async function passkeyExists(id: string): Promise<boolean> {
  const rows = await harness.db
    .select({ id: schema.passkeys.id })
    .from(schema.passkeys)
    .where(eq(schema.passkeys.id, id));
  return rows.length === 1;
}

const nextStepCode = (secret: string, steps = 1) =>
  generateTotpCode(secret, Date.now() + steps * TOTP_STEP_SECONDS * 1000);

describe('R-05 rule 1 — minting or removing a factor needs a step-up credential', () => {
  it('cookie: POST /2fa/recovery-codes refuses a request without the step-up and keeps the set', async () => {
    const user = await seedFreshUser();
    const { secret } = await seedTotp(user.id);
    const agent = await loginWithTotp(user, secret);
    const before = await unusedRecoveryHashes(user.id);

    const bare = await agent.post('/api/v1/auth/2fa/recovery-codes').set(...XRW);
    expect(bare.status).toBe(400);
    expect(bare.body.recoveryCodes).toBeUndefined();

    const wrong = await agent
      .post('/api/v1/auth/2fa/recovery-codes')
      .set(...XRW)
      .send({ stepUp: { password: 'not-the-password' } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await unusedRecoveryHashes(user.id)).toEqual(before);

    // Negative space: the owner's own password still regenerates.
    const ok = await agent
      .post('/api/v1/auth/2fa/recovery-codes')
      .set(...XRW)
      .send({ stepUp: { password: user.password } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(twoFactorRecoveryCodesResponseSchema.parse(ok.body).recoveryCodes).toHaveLength(10);
    expect(await unusedRecoveryHashes(user.id)).not.toEqual(before);
  });

  it('bearer: POST /2fa/recovery-codes refuses an account:security key without the step-up', async () => {
    const user = await seedFreshUser();
    const token = await mintSecurityKey(user);
    await seedTotp(user.id);
    const before = await unusedRecoveryHashes(user.id);

    const bare = await request(harness.app)
      .post('/api/v1/auth/2fa/recovery-codes')
      .set(bearer(token));
    expect(bare.status).toBe(400);
    expect(bare.body.recoveryCodes).toBeUndefined();
    const wrong = await request(harness.app)
      .post('/api/v1/auth/2fa/recovery-codes')
      .set(bearer(token))
      .send({ stepUp: { password: 'not-the-password' } });
    expect(wrong.status).toBe(401);
    expect(await unusedRecoveryHashes(user.id)).toEqual(before);
  });

  it('cookie: POST /2fa/email/disable needs a factor or the password; an existing recovery code works', async () => {
    const user = await seedFreshUser();
    const recoveryCodes = await seedEmailMethod(user.id);
    // E-mail is the only method, so the login challenge takes a recovery code.
    const agent = request.agent(harness.app);
    const challenge = twoFactorChallengeResponseSchema.parse(
      (
        await agent
          .post('/api/v1/auth/login')
          .set(...XRW)
          .send({ identifier: user.email, password: user.password })
      ).body,
    );
    expect(
      (
        await agent
          .post('/api/v1/auth/2fa/verify')
          .set(...XRW)
          .send({ pendingToken: challenge.pendingToken, recoveryCode: recoveryCodes[0] })
      ).status,
    ).toBe(200);

    const bare = await agent.post('/api/v1/auth/2fa/email/disable').set(...XRW);
    expect(bare.status).toBe(400);
    expect((await factorState(user.id)).emailEnabled).toBe(true);

    const wrongCode = await agent
      .post('/api/v1/auth/2fa/email/disable')
      .set(...XRW)
      .send({ stepUp: { recoveryCode: 'AAAA-BBBB-CCCC' } });
    expect(wrongCode.status).toBe(401);
    expect((await factorState(user.id)).emailEnabled).toBe(true);

    const ok = await agent
      .post('/api/v1/auth/2fa/email/disable')
      .set(...XRW)
      .send({ stepUp: { recoveryCode: recoveryCodes[1] } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await factorState(user.id)).emailEnabled).toBe(false);
  });

  for (const caller of ['cookie', 'bearer'] as const) {
    it(`${caller}: /2fa/enroll and /2fa/confirm both refuse a request without the password`, async () => {
      const user = await seedFreshUser();
      const token = caller === 'bearer' ? await mintSecurityKey(user) : null;
      const agent = caller === 'cookie' ? await loginAgent(user) : null;
      const call = (path: string) =>
        token
          ? request(harness.app).post(`/api/v1${path}`).set(bearer(token))
          : agent!.post(`/api/v1${path}`).set(...XRW);

      const bareEnroll = await call('/auth/2fa/enroll');
      expect(bareEnroll.status).toBe(400);
      expect(bareEnroll.body.secret).toBeUndefined();
      expect((await factorState(user.id)).secret).toBeNull();

      const wrongEnroll = await call('/auth/2fa/enroll').send({
        stepUp: { password: 'not-the-password' },
      });
      expect(wrongEnroll.status).toBe(401);
      expect((await factorState(user.id)).secret).toBeNull();

      const enroll = await call('/auth/2fa/enroll').send({ stepUp: { password: user.password } });
      expect(enroll.status, JSON.stringify(enroll.body)).toBe(200);
      const { secret } = twoFactorEnrollResponseSchema.parse(enroll.body);

      // Knowing the new secret is not enough: the confirm mints the factor and
      // needs the credential too.
      const bareConfirm = await call('/auth/2fa/confirm').send({ code: generateTotpCode(secret) });
      expect(bareConfirm.status).toBe(400);
      expect((await factorState(user.id)).totpEnabled).toBe(false);

      const wrongConfirm = await call('/auth/2fa/confirm').send({
        code: generateTotpCode(secret),
        stepUp: { password: 'not-the-password' },
      });
      expect(wrongConfirm.status).toBe(401);
      expect((await factorState(user.id)).totpEnabled).toBe(false);

      const confirm = await call('/auth/2fa/confirm').send({
        code: generateTotpCode(secret),
        stepUp: { password: user.password },
      });
      expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
      expect(twoFactorMethodEnabledResponseSchema.parse(confirm.body).recoveryCodes).toHaveLength(
        10,
      );
      expect((await factorState(user.id)).totpEnabled).toBe(true);
    });
  }

  it('cookie: /2fa/email/enroll and /2fa/email/confirm refuse a request without the step-up', async () => {
    await harness.dispose();
    const transport = recordingTransport();
    await boot({ env: SMTP_ENV, emailTransport: transport });
    const user = await seedFreshUser();
    const agent = await loginAgent(user);

    const bare = await agent.post('/api/v1/auth/2fa/email/enroll').set(...XRW);
    expect(bare.status).toBe(400);
    expect(transport.sent).toHaveLength(0);

    const enroll = await agent
      .post('/api/v1/auth/2fa/email/enroll')
      .set(...XRW)
      .send({ stepUp: { password: user.password } });
    expect(enroll.status, JSON.stringify(enroll.body)).toBe(200);
    const code = transport.sent.at(-1)!.text.match(/\b(\d{6})\b/)![1]!;

    const bareConfirm = await agent
      .post('/api/v1/auth/2fa/email/confirm')
      .set(...XRW)
      .send({ code });
    expect(bareConfirm.status).toBe(400);
    expect((await factorState(user.id)).emailEnabled).toBe(false);

    const confirm = await agent
      .post('/api/v1/auth/2fa/email/confirm')
      .set(...XRW)
      .send({ code, stepUp: { password: user.password } });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    expect((await factorState(user.id)).emailEnabled).toBe(true);
  });

  it('refuses a correct password while the 2FA-management throttle is cooling (peek before verify)', async () => {
    const user = await seedFreshUser();
    const token = await mintSecurityKey(user);
    await seedTotp(user.id);

    let cooled = false;
    for (let attempt = 0; attempt < 15 && !cooled; attempt += 1) {
      const res = await request(harness.app)
        .post('/api/v1/auth/2fa/recovery-codes')
        .set(bearer(token))
        .send({ stepUp: { password: `wrong-${attempt}` } });
      expect([401, 429]).toContain(res.status);
      cooled = res.status === 429;
    }
    expect(cooled).toBe(true);
    const before = await unusedRecoveryHashes(user.id);

    const correct = await request(harness.app)
      .post('/api/v1/auth/2fa/recovery-codes')
      .set(bearer(token))
      .send({ stepUp: { password: user.password } });
    expect(correct.status).toBe(429);
    expect(await unusedRecoveryHashes(user.id)).toEqual(before);
  });
});

describe('R-05 rule 2 — a factor the caller itself just issued cannot pass a step-up', () => {
  it('a key that regenerated the codes cannot spend them on export, deletion, passkeys or vaults', async () => {
    const user = await seedFreshUser();
    const token = await mintSecurityKey(user);
    const otherToken = await mintSecurityKey(user);
    const { secret } = await seedTotp(user.id);
    const passkeyId = await seedPasskey(user.id);

    const regen = await request(harness.app)
      .post('/api/v1/auth/2fa/recovery-codes')
      .set(bearer(token))
      .send({ stepUp: { password: user.password } });
    expect(regen.status, JSON.stringify(regen.body)).toBe(200);
    const fresh = twoFactorRecoveryCodesResponseSchema.parse(regen.body).recoveryCodes;
    const unusedBefore = await unusedRecoveryHashes(user.id);

    const exportRes = await request(harness.app)
      .post('/api/v1/account/export')
      .set(bearer(token))
      .send({ recoveryCode: fresh[0] });
    expect(exportRes.status).toBe(401);
    expect(exportRes.body.error.code).toBe(SELF_ISSUED);
    expect(exportRes.body.downloadToken).toBeUndefined();

    const deletion = await request(harness.app)
      .delete('/api/v1/account')
      .set(bearer(token))
      .send({ confirmUsername: user.username, recoveryCode: fresh[1] });
    expect(deletion.status).toBe(401);
    expect(deletion.body.error.code).toBe(SELF_ISSUED);
    expect(await userExists(user.id)).toBe(true);

    const passkeyDelete = await request(harness.app)
      .delete(`/api/v1/auth/passkeys/${passkeyId}`)
      .set(bearer(token))
      .send({ recoveryCode: fresh[2] });
    expect(passkeyDelete.status).toBe(401);
    expect(passkeyDelete.body.error.code).toBe(SELF_ISSUED);
    expect(await passkeyExists(passkeyId)).toBe(true);

    const vaultDelete = await request(harness.app)
      .delete('/api/v1/vaults/00000000-0000-4000-8000-000000000001')
      .set(bearer(token))
      .send({ stepUp: { recoveryCode: fresh[3] } });
    expect(vaultDelete.status).toBe(401);
    expect(vaultDelete.body.error.code).toBe(SELF_ISSUED);

    const moveIn = await request(harness.app)
      .post('/api/v1/portfolios/00000000-0000-4000-8000-000000000002/vault/move-in')
      .set(bearer(token))
      .send({
        vaultId: '00000000-0000-4000-8000-000000000001',
        docVersion: 1,
        portfolioDataRevision: 'rev-1',
        stepUp: { recoveryCode: fresh[3] },
      });
    expect(moveIn.status).toBe(401);
    expect(moveIn.body.error.code).toBe(SELF_ISSUED);

    // A fresh code cannot buy further 2FA management for its issuer either.
    const reRegen = await request(harness.app)
      .post('/api/v1/auth/2fa/recovery-codes')
      .set(bearer(token))
      .send({ stepUp: { recoveryCode: fresh[5] } });
    expect(reRegen.status).toBe(401);
    expect(reRegen.body.error.code).toBe(SELF_ISSUED);

    // The owner's authenticator is refused for this credential too: the rule
    // keys on the credential that issued factor material, not on the factor.
    const totp = await request(harness.app)
      .delete(`/api/v1/auth/passkeys/${passkeyId}`)
      .set(bearer(token))
      .send({ code: nextStepCode(secret) });
    expect(totp.status).toBe(401);
    expect(totp.body.error.code).toBe(SELF_ISSUED);

    // Nothing was spent by the refusals.
    expect(await unusedRecoveryHashes(user.id)).toEqual(unusedBefore);

    // Negative space: the password still works for the same key...
    const withPassword = await request(harness.app)
      .post('/api/v1/account/export')
      .set(bearer(token))
      .send({ password: user.password });
    expect(withPassword.status, JSON.stringify(withPassword.body)).toBe(200);

    // ...and a different credential may use the very codes the first one minted.
    const other = await request(harness.app)
      .delete(`/api/v1/auth/passkeys/${passkeyId}`)
      .set(bearer(otherToken))
      .send({ recoveryCode: fresh[0] });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(await passkeyExists(passkeyId)).toBe(false);

    // Pinned exception: `/2fa/disable` takes only an existing factor and is not
    // behind the guard (see authRoutes), so the minting key may still use it.
    const disable = await request(harness.app)
      .post('/api/v1/auth/2fa/disable')
      .set(bearer(token))
      .send({ code: fresh[4] });
    expect(disable.status, JSON.stringify(disable.body)).toBe(200);
    expect((await factorState(user.id)).totpEnabled).toBe(false);
  });

  it('a key that enrolled TOTP itself cannot delete the account with that authenticator', async () => {
    const user = await seedFreshUser();
    const token = await mintSecurityKey(user);

    const enroll = await request(harness.app)
      .post('/api/v1/auth/2fa/enroll')
      .set(bearer(token))
      .send({ stepUp: { password: user.password } });
    expect(enroll.status, JSON.stringify(enroll.body)).toBe(200);
    const { secret } = twoFactorEnrollResponseSchema.parse(enroll.body);
    const confirm = await request(harness.app)
      .post('/api/v1/auth/2fa/confirm')
      .set(bearer(token))
      .send({ code: generateTotpCode(secret), stepUp: { password: user.password } });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);

    const deletion = await request(harness.app)
      .delete('/api/v1/account')
      .set(bearer(token))
      .send({ confirmUsername: user.username, code: nextStepCode(secret) });
    expect(deletion.status).toBe(401);
    expect(deletion.body.error.code).toBe(SELF_ISSUED);
    expect(await userExists(user.id)).toBe(true);

    // A fresh cookie login (password + that TOTP) is a different credential.
    const owner = await loginWithTotp(user, secret);
    const status = twoFactorStatusResponseSchema.parse(
      (await owner.get('/api/v1/auth/2fa/status')).body,
    );
    expect(status.totpEnabled).toBe(true);
  });

  it('a key that minted codes may use a factor again once the 24-hour hold has passed', async () => {
    const user = await seedFreshUser();
    const token = await mintSecurityKey(user);
    await seedTotp(user.id);
    const passkeyId = await seedPasskey(user.id);

    const regen = await request(harness.app)
      .post('/api/v1/auth/2fa/recovery-codes')
      .set(bearer(token))
      .send({ stepUp: { password: user.password } });
    expect(regen.status).toBe(200);
    const fresh = twoFactorRecoveryCodesResponseSchema.parse(regen.body).recoveryCodes;

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + DAY_MS + 60_000);

    const later = await request(harness.app)
      .delete(`/api/v1/auth/passkeys/${passkeyId}`)
      .set(bearer(token))
      .send({ recoveryCode: fresh[0] });
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    expect(await passkeyExists(passkeyId)).toBe(false);
  });

  it('a key that issued nothing keeps using factors (no regression for the ordinary step-up)', async () => {
    const user = await seedFreshUser();
    const token = await mintSecurityKey(user);
    const { recoveryCodes } = await seedTotp(user.id);
    const passkeyId = await seedPasskey(user.id);

    const res = await request(harness.app)
      .delete(`/api/v1/auth/passkeys/${passkeyId}`)
      .set(bearer(token))
      .send({ recoveryCode: recoveryCodes[0] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
