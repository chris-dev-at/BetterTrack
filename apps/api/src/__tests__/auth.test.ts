import { performance } from 'node:perf_hooks';

import { and, eq, gt, isNull } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  healthResponseSchema,
  meResponseSchema,
  versionResponseSchema,
} from '@bettertrack/contracts';

import { createUserRepository } from '../data/repositories/userRepository';
import { emailLog, passwordResetTokens, users, vaults } from '../data/schema';
import { PASSWORD_RESET_RESPONSE_FLOOR_MS } from '../services/auth/authService';
import type { MailTransport, OutgoingMail } from '../services/email/transport';
import { createPasswordHasher, type PasswordHasher } from '../services/password/passwordHasher';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

// Deterministic TEST VECTOR identifiers and public verifier metadata only;
// these values prove a normal v2 account can own vault config without turning
// the legacy MeResponse field into a vault-presence signal.
const ME_VAULT_ID = '018f1412-0000-7000-8000-000000000001';
const ME_VAULT_HEADER_DOC_ID = '018f1412-0000-7000-8000-000000000002';
const ME_VAULT_COMMON_DOC_ID = '018f1412-0000-7000-8000-000000000003';
const ME_VAULT_PROOF_KEY = 'MCowBQYDK2VwAyEA' + 'A'.repeat(27) + '=';

const SMTP_ENV = {
  SMTP_HOST: 'smtp.test.local',
  SMTP_PORT: '587',
  SMTP_USER: 'mailer',
  SMTP_PASS: 'super-secret-smtp-pass',
  SMTP_FROM: 'BetterTrack <no-reply@test.local>',
} satisfies Partial<NodeJS.ProcessEnv>;

function recordingTransport(): MailTransport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

function requestPasswordReset(target: TestHarness, email: string) {
  return request(target.app)
    .post('/api/v1/auth/password-reset/request')
    .set(...XRW)
    .send({ email });
}

function completePasswordReset(target: TestHarness, token: string, newPassword: string) {
  return request(target.app)
    .post('/api/v1/auth/password-reset/complete')
    .set(...XRW)
    .send({ token, newPassword });
}

function tokenFromMail(mail: OutgoingMail): string {
  const token = mail.text.split('/reset/')[1]?.split(/\s/)[0];
  if (!token) throw new Error('reset URL not found in email');
  return token;
}

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

describe('GET /api/v1/auth/me', () => {
  it('keeps privacyMode as legacy-v1 compatibility, not per-portfolio vault state', async () => {
    const normal = await harness.seedUser();
    const paranoid = await harness.seedUser({
      email: 'paranoid@bettertrack.test',
      username: 'paranoid',
    });
    await harness.db
      .update(users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['server'],
        paranoidDriveAttestedVersion: null,
      })
      .where(eq(users.id, paranoid.id));
    await harness.db.insert(vaults).values({
      id: ME_VAULT_ID,
      userId: normal.id,
      name: 'MeResponse semantics vector',
      headerDocId: ME_VAULT_HEADER_DOC_ID,
      commonDocId: ME_VAULT_COMMON_DOC_ID,
      media: ['server'],
      driveConnectionId: null,
      retirementProofPublicKey: ME_VAULT_PROOF_KEY,
      keyFingerprint: 'Abcdef0123456789',
    });

    const normalAgent = request.agent(harness.app);
    const normalLogin = await normalAgent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: normal.email, password: normal.password });
    expect(normalLogin.status).toBe(200);

    const paranoidAgent = request.agent(harness.app);
    const paranoidLogin = await paranoidAgent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: paranoid.email, password: paranoid.password });
    expect(paranoidLogin.status).toBe(200);

    const normalSession = await normalAgent.get('/api/v1/auth/me');
    const paranoidSession = await paranoidAgent.get('/api/v1/auth/me');
    expect(normalSession.status).toBe(200);
    expect(paranoidSession.status).toBe(200);
    // The normal account owns a real new-model vault, yet this compatibility
    // field remains `normal`: clients must use Portfolio.vaultId + GET /vaults.
    expect(meResponseSchema.parse(normalSession.body).privacyMode).toBe('normal');
    expect(meResponseSchema.parse(paranoidSession.body).privacyMode).toBe('paranoid');

    const normalKey = await harness.ctx.apiKeys.create({
      userId: normal.id,
      name: 'normal identity',
      scopes: ['portfolio:read'],
    });
    const paranoidKey = await harness.ctx.apiKeys.create({
      userId: paranoid.id,
      name: 'paranoid identity',
      scopes: ['portfolio:read'],
    });
    const normalBearer = await request(harness.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${normalKey.token}`);
    const paranoidBearer = await request(harness.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${paranoidKey.token}`);

    expect(normalBearer.status).toBe(200);
    expect(paranoidBearer.status).toBe(200);
    expect(meResponseSchema.parse(normalBearer.body).privacyMode).toBe('normal');
    expect(meResponseSchema.parse(paranoidBearer.body).privacyMode).toBe('paranoid');
  });
});

// Pulls the raw `bt_sid=...` cookie pair out of a Set-Cookie header so an old
// session id can be replayed after rotation.
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
  it('kills the changing session and every concurrent sibling', async () => {
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

    // No cookie survives the transition, including the explicitly acting one.
    expect((await agentB.get('/api/v1/auth/me')).status).toBe(401);
    expect((await agentA.get('/api/v1/auth/me')).status).toBe(401);

    const fresh = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: admin.email, password: 'admin-rotated-secret-2' });
    expect(fresh.status).toBe(200);
  });
});

describe('self-service password-reset concurrency', () => {
  it('lets exactly one concurrent completion consume a token before hashing or minting a session', async () => {
    const transport = recordingTransport();
    const baseHasher = createPasswordHasher({ memoryCost: 4096, timeCost: 1 });
    const hashedPasswords: string[] = [];
    const countingHasher: PasswordHasher = {
      async hash(password) {
        hashedPasswords.push(password);
        return baseHasher.hash(password);
      },
      verify: baseHasher.verify,
    };
    harness = await createTestApp({
      env: SMTP_ENV,
      emailTransport: transport,
      passwordHasher: countingHasher,
    });
    const user = await harness.seedUser();

    expect((await requestPasswordReset(harness, user.email)).body).toEqual({ ok: true });
    const token = tokenFromMail(transport.sent[0]!);
    const redisSet = vi.spyOn(harness.ctx.redis, 'set');
    const candidates = ['concurrent-reset-winner-a1', 'concurrent-reset-winner-b2'] as const;

    const responses = await Promise.all(
      candidates.map((newPassword) => completePasswordReset(harness, token, newPassword)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(
      responses.filter((response) => response.status === 400).map((response) => response.body),
    ).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_RESET' }) }),
    ]);
    expect(hashedPasswords).toHaveLength(1);
    expect(candidates).toContain(hashedPasswords[0]);

    const [stored] = await harness.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id));
    expect(await baseHasher.verify(stored!.passwordHash, hashedPasswords[0]!)).toBe(true);
    expect(redisSet.mock.calls.filter(([key]) => String(key).startsWith('sess:'))).toHaveLength(1);
    expect(await harness.ctx.redis.scard(`user_sessions:${user.id}`)).toBe(1);
  });

  it('serializes concurrent issues so exactly one live token remains for the user', async () => {
    const transport = recordingTransport();
    harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport });
    const user = await harness.seedUser();

    const responses = await Promise.all([
      requestPasswordReset(harness, user.email),
      requestPasswordReset(harness, user.email),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.body)).toEqual([{ ok: true }, { ok: true }]);

    const now = new Date();
    const live = await harness.db
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, user.id),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      );
    expect(live).toHaveLength(1);
    expect(
      await harness.db
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.userId, user.id)),
    ).toHaveLength(1);
  });

  it('normalizes concurrent reset-request timing distributions for known and unknown addresses', async () => {
    const user = await harness.seedUser();
    const transactionSpy = vi.spyOn(harness.db, 'transaction');
    const timedRequest = async (email: string) => {
      const startedAt = performance.now();
      const response = await requestPasswordReset(harness, email);
      return { response, elapsedMs: performance.now() - startedAt };
    };
    // Depth is load-bearing twice over. It exercises the per-address
    // serialization distribution rather than one quiet database request whose
    // fixed 250 ms floor can hide the row-lock branch — and it is what gives
    // the tail bound below any outlier tolerance at all (see `tailIndex`).
    const pairCount = 24;

    // Launch N pairs together against the same known and same unknown address.
    const pairs = await Promise.all(
      Array.from({ length: pairCount }, () =>
        Promise.all([timedRequest(user.email), timedRequest('nobody-here@test.dev')]),
      ),
    );
    // Nearest-rank percentile: the smallest sample at or above the fraction.
    const percentile = (samples: readonly number[], fraction: number) =>
      samples[Math.ceil(samples.length * fraction) - 1]!;

    for (const sample of pairs.flat()) {
      expect(sample.response.status).toBe(200);
      expect(sample.response.body).toEqual({ ok: true });
      expect(sample.elapsedMs).toBeGreaterThanOrEqual(PASSWORD_RESET_RESPONSE_FLOOR_MS - 25);
    }
    // Both branches enter at least one repository transaction per probe. Audit
    // or detached-email persistence may legitimately add calls on this shared
    // seam, so only assert the lower bound relevant to equalization.
    expect(transactionSpy.mock.calls.length).toBeGreaterThanOrEqual(pairCount * 2);

    // Compare the branches PAIR BY PAIR rather than ranking each branch's
    // samples independently and differencing equal ranks.
    //
    // Sixteen requests are in flight at once, so each branch's samples spread
    // across a wide band by queue position (~250 ms to ~380 ms at depth 8 when
    // measured here) as they contend for the lock, the pool and the event loop.
    // BOTH branches spread, the band is far wider than the branch difference
    // under test, and differencing rank k against rank k only cancels it while
    // the two orderings stay in step. Let one drift a single position and a
    // whole inter-rank gap is reported as branch divergence — which is how this
    // assertion failed CI at 101 ms against its 100 ms bound on a commit that
    // touched no code on this path.
    //
    // The two members of a pair are launched in the same tick, so differencing
    // them cancels the shared band and any runner-wide stall. What survives is
    // the thing under test: work the known branch does that the unknown branch
    // does not, once it outgrows the response floor that is meant to hide it.
    // The bounds below are the originals, unchanged — only the statistic they
    // are applied to is corrected — and they still trip on an injected
    // known-branch delay that pushes past PASSWORD_RESET_RESPONSE_FLOOR_MS.
    //
    // The pairing above fixed WHICH samples are differenced; the sample COUNT
    // is what makes the tail bound a tail bound. Nearest rank puts the 0.9
    // index at `ceil(n * 0.9) - 1`, which at the previous n = 8 was index 7 of
    // 8 — the plain MAXIMUM. So the "p90 < 100 ms" line tolerated zero
    // outliers and was really asserting that no single one of eight requests
    // ever hit a scheduler stall. It failed CI again on exactly that: deltas of
    // 0.1, 0.2, 9.1, 11.1, 12.0, 14.2, 19.3 and one 124.8 ms straggler, on a
    // commit that touched no code on this path. Seven pairs agreeing inside
    // 20 ms is the branch difference; the eighth is the runner. At n = 24 the
    // index is 21 of 24, so two stragglers are absorbed while a real leak —
    // which shifts every pair, not one — still trips both bounds.
    const pairedDeltas = pairs
      .map(([known, unknown]) => Math.abs(known.elapsedMs - unknown.elapsedMs))
      .sort((a, b) => a - b);
    const observed = `paired |known - unknown| (ms): ${pairedDeltas.map((delta) => delta.toFixed(1)).join(', ')}`;

    // Guard the guard: if `pairCount` is ever lowered, the tail bound must fail
    // here rather than silently decay back into "maximum < 100 ms".
    const tailIndex = Math.ceil(pairCount * 0.9) - 1;
    expect(
      pairCount - 1 - tailIndex,
      'p90 must exclude outliers, not be the max',
    ).toBeGreaterThanOrEqual(2);

    expect(percentile(pairedDeltas, 0.5), observed).toBeLessThan(75);
    expect(percentile(pairedDeltas, 0.9), observed).toBeLessThan(100);
    transactionSpy.mockRestore();
  });

  it('returns the uniform acknowledgement without waiting for a slow email transport', async () => {
    let signalSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const slowTransport: MailTransport = {
      async send() {
        signalSendStarted();
        await sendGate;
      },
    };
    harness = await createTestApp({ env: SMTP_ENV, emailTransport: slowTransport });
    const user = await harness.seedUser();

    const knownRequest = requestPasswordReset(harness, user.email).then((response) => response);
    await sendStarted;
    let timeout: NodeJS.Timeout | undefined;
    const first = await Promise.race([
      knownRequest.then(() => 'response' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), PASSWORD_RESET_RESPONSE_FLOOR_MS + 250);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    releaseSend();

    const known = await knownRequest;
    const unknown = await requestPasswordReset(harness, 'nobody-here@test.dev');
    expect(first).toBe('response');
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ ok: true });
    expect(unknown.body).toEqual(known.body);

    await vi.waitFor(
      async () => {
        const rows = await harness.db
          .select()
          .from(emailLog)
          .where(eq(emailLog.recipient, user.email));
        expect(rows).toEqual([expect.objectContaining({ status: 'sent' })]);
      },
      { timeout: 1_000 },
    );
  });
});
