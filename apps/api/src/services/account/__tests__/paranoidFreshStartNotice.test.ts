import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  meResponseSchema,
  oauthTokenResponseSchema,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { createOAuthRepository } from '../../../data/repositories/oauthRepository';
import {
  auditLog,
  paranoidV1BackupAttestations,
  paranoidV1WipeReceipts,
  paranoidVaults,
  users,
} from '../../../data/schema';
import { ACCOUNT_SECURITY_SCOPE } from '../../../http/middleware/bearerAuth';
import { createTestApp, type SeededUser, type TestHarness } from '../../../testing/createTestApp';
import {
  BETTERTRACK_MOBILE_CLIENT_ID,
  FIRST_PARTY_CLIENTS,
  seedFirstPartyClients,
} from '../../oauth/firstPartyClients';
import { wipeParanoidV1Account } from '../paranoidV1WipeService';
import { paranoidV1AccountDigestQuery, resultRows } from '../paranoidV1TransitionSql';

/**
 * §17 step 3 — the one-time fresh-start notice.
 *
 *   "Notice: affected accounts get a one-time in-app notice at next login —
 *    'Paranoid mode has a new shape; the old paranoid data was retired with the
 *    old system' — with the create-a-vault CTA. No conversion ceremony, no
 *    legacy passphrase prompt."
 *
 * "One-time" and "affected accounts" are the two testable claims, and both are
 * structural rather than conditional: the notice is owed exactly while a
 * `paranoid_v1_wipe_receipts` row has a null `notice_acknowledged_at`, and only a
 * wiped account ever has such a row. An account that was always `normal` cannot
 * be shown it because there is nothing to read.
 *
 * The E10-A8 arc drives the same two claims through the browser.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function login(user: SeededUser): Promise<Agent> {
  const agent = request.agent(harness.app);
  const response = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(response.status).toBe(200);
  return agent;
}

/** Put an account through the real §17 wipe, gate and all — never by faking the receipt. */
async function wipeThroughTheRealGate(user: SeededUser): Promise<void> {
  await harness.db
    .update(users)
    .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
    .where(eq(users.id, user.id));
  await harness.db.insert(paranoidVaults).values({
    userId: user.id,
    version: 3,
    formatVersion: 1,
    sizeBytes: 3,
    blob: Buffer.from('ABC'),
  });

  const digest = resultRows<{ digest: string }>(
    await harness.db.execute(paranoidV1AccountDigestQuery(user.id)),
  )[0]!.digest;

  await harness.db.insert(paranoidV1BackupAttestations).values({
    id: randomUUID(),
    archiveFile: `/backups/${user.id}.json`,
    archiveSha256: 'a'.repeat(64),
    rowCounts: {},
    userDigests: { [user.id]: digest },
    createdBy: 'owner',
    offsiteConfirmedAt: new Date(),
    offsiteConfirmedSha256: 'a'.repeat(64),
  });

  const outcome = await wipeParanoidV1Account(harness.db, user.id);
  expect(outcome.ok).toBe(true);
}

describe('fresh-start notice — §17 step 3', () => {
  it('is owed to a wiped account, exactly once', async () => {
    const user = await harness.seedUser();
    await wipeThroughTheRealGate(user);
    const agent = await login(user);

    // The session payload itself carries the bit — §17's "at next login".
    const first = await agent.get('/api/v1/auth/me');
    expect(first.status).toBe(200);
    expect(first.body.paranoidFreshStartPending).toBe(true);

    const ack = await agent.post('/api/v1/auth/fresh-start-notice/acknowledge').set(...XRW);
    expect(ack.status).toBe(200);
    expect(ack.body.paranoidFreshStartPending).toBe(false);

    // Every later session payload agrees: the notice is spent.
    const second = await agent.get('/api/v1/auth/me');
    expect(second.body.paranoidFreshStartPending).toBe(false);
  });

  it('is never owed to an account that was always normal', async () => {
    const user = await harness.seedUser({
      email: 'e9-normal@example.test',
      username: 'e9normal',
    });
    const agent = await login(user);

    const status = await agent.get('/api/v1/auth/me');
    expect(status.status).toBe(200);
    expect(status.body.paranoidFreshStartPending).toBe(false);
  });

  it('acknowledging is idempotent and set-once — a replay never moves the timestamp', async () => {
    const user = await harness.seedUser();
    await wipeThroughTheRealGate(user);
    const agent = await login(user);

    const ack1 = await agent.post('/api/v1/auth/fresh-start-notice/acknowledge').set(...XRW);
    expect(ack1.status).toBe(200);
    const firstAck = (
      await harness.db
        .select()
        .from(paranoidV1WipeReceipts)
        .where(eq(paranoidV1WipeReceipts.userId, user.id))
    )[0]!.noticeAcknowledgedAt;

    const ack2 = await agent.post('/api/v1/auth/fresh-start-notice/acknowledge').set(...XRW);
    expect(ack2.status).toBe(200);
    const secondAck = (
      await harness.db
        .select()
        .from(paranoidV1WipeReceipts)
        .where(eq(paranoidV1WipeReceipts.userId, user.id))
    )[0]!.noticeAcknowledgedAt;

    expect(firstAck).not.toBeNull();
    expect(secondAck).toEqual(firstAck);
  });

  it('is scoped to the caller: acknowledging never touches another account', async () => {
    const mine = await harness.seedUser({ email: 'e9-mine@example.test', username: 'e9mine' });
    const theirs = await harness.seedUser({
      email: 'e9-theirs@example.test',
      username: 'e9theirs',
    });
    await wipeThroughTheRealGate(mine);
    await wipeThroughTheRealGate(theirs);

    const agent = await login(mine);
    const ack = await agent.post('/api/v1/auth/fresh-start-notice/acknowledge').set(...XRW);
    expect(ack.status).toBe(200);
    expect(ack.body.paranoidFreshStartPending).toBe(false);

    // There is no id in the payload — the handler can only ever reach the caller's
    // own row — so the other account's notice is still owed.
    const theirReceipt = (
      await harness.db
        .select()
        .from(paranoidV1WipeReceipts)
        .where(eq(paranoidV1WipeReceipts.userId, theirs.id))
    )[0]!;
    expect(theirReceipt.noticeAcknowledgedAt).toBeNull();
    // ...and mine really was acknowledged, so the assertion above is a contrast,
    // not two nulls agreeing with each other.
    const myReceipt = (
      await harness.db
        .select()
        .from(paranoidV1WipeReceipts)
        .where(eq(paranoidV1WipeReceipts.userId, mine.id))
    )[0]!;
    expect(myReceipt.noticeAcknowledgedAt).not.toBeNull();
  });

  it('every session payload carries the flag — none may silently clear it', () => {
    // The SPA adopts a MeResponse by spreading it over the current user
    // (`setUser(current => ({ ...current, ...me }))`). A handler that returns a
    // MeResponse WITHOUT this field would therefore overwrite a pending `true`
    // with `undefined` and make the notice vanish mid-session — e.g. a wiped user
    // toggling discreet mode or setting a PIN before ever reading the notice.
    const routes = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../http/routes/authRoutes.ts',
      ),
      'utf8',
    );
    const responses = [...routes.matchAll(/res\.json\(([^;]*?toMeResponse[^;]*?)\);/gu)].map(
      (m) => m[1]!,
    );
    // Guard the extractor: a regex that matched nothing would be vacuous.
    expect(responses.length).toBeGreaterThan(5);
    expect(responses.filter((r) => !r.includes('withFreshStartNotice'))).toEqual([]);
  });

  it('requires authentication', async () => {
    const anonymous = request.agent(harness.app);
    expect(
      (await anonymous.post('/api/v1/auth/fresh-start-notice/acknowledge').set(...XRW)).status,
    ).toBe(401);
  });

  it('rides on the login response too, so the notice shows without a reload', async () => {
    const user = await harness.seedUser({ email: 'e9-login@example.test', username: 'e9login' });
    await wipeThroughTheRealGate(user);

    const login = await request
      .agent(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });

    expect(login.status).toBe(200);
    expect(login.body.paranoidFreshStartPending).toBe(true);
  });
});

/**
 * The native half of §17 step 3. The phone reads `paranoidFreshStartPending`
 * off `GET /auth/me` like the SPA does, so it must also be able to SPEND the
 * notice — otherwise a wiped account that only ever signs in on the phone is
 * shown it forever. `resolveAuthPolicy` widens exactly this POST to a bearer
 * holding `account:security` (the scope the official mobile client already
 * carries); everything else about the contract — caller-scoped, set-once,
 * idempotent, no session minted — must hold on the bearer path unchanged.
 */
describe('fresh-start notice — bearer acknowledgement (native client)', () => {
  const ACK = '/api/v1/auth/fresh-start-notice/acknowledge';
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function receiptOf(userId: string) {
    return (
      await harness.db
        .select()
        .from(paranoidV1WipeReceipts)
        .where(eq(paranoidV1WipeReceipts.userId, userId))
    )[0]!;
  }

  /** A delegated token from the SEEDED official mobile client — the real consumer. */
  async function mobileToken(user: SeededUser, scopes: ApiKeyScope[]): Promise<string> {
    const mobile = FIRST_PARTY_CLIENTS.find((c) => c.clientId === BETTERTRACK_MOBILE_CLIENT_ID)!;
    expect(mobile.public).toBe(true);
    await seedFirstPartyClients(createOAuthRepository(harness.db));
    const agent = await login(user);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const approval = await agent
      .post('/api/v1/oauth/authorize')
      .set(...XRW)
      .send({
        client_id: mobile.clientId,
        redirect_uri: mobile.redirectUris[0],
        scope: scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    const code = new URL(approval.body.redirectTo as string).searchParams.get('code');
    const exchanged = await request(harness.app).post('/api/v1/oauth/token').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: mobile.redirectUris[0],
      client_id: mobile.clientId,
      code_verifier: verifier,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    return oauthTokenResponseSchema.parse(exchanged.body).access_token;
  }

  async function personalKey(user: SeededUser, scopes: ApiKeyScope[]): Promise<string> {
    return (await harness.ctx.apiKeys.create({ userId: user.id, name: 'phone', scopes })).token;
  }

  it.each(['oauth', 'personal'] as const)(
    'a %s bearer holding account:security spends the notice, exactly once',
    async (kind) => {
      const tag = randomBytes(4).toString('hex');
      const user = await harness.seedUser({
        email: `e9-bearer-${tag}@example.test`,
        username: `e9bearer${tag}`,
      });
      // The phone was signed in BEFORE the owner ran the wipe — the realistic
      // order, and proof the wipe does not strand an existing native session.
      const token =
        kind === 'oauth'
          ? await mobileToken(user, [ACCOUNT_SECURITY_SCOPE])
          : await personalKey(user, [ACCOUNT_SECURITY_SCOPE]);
      await wipeThroughTheRealGate(user);

      const before = await request(harness.app).get('/api/v1/auth/me').set(bearer(token));
      expect(before.status, JSON.stringify(before.body)).toBe(200);
      expect(meResponseSchema.parse(before.body).paranoidFreshStartPending).toBe(true);

      const ack = await request(harness.app).post(ACK).set(bearer(token));
      expect(ack.status, JSON.stringify(ack.body)).toBe(200);
      const me = meResponseSchema.parse(ack.body);
      expect(me.id).toBe(user.id);
      expect(me.paranoidFreshStartPending).toBe(false);
      // A bearer acknowledgement never mints or refreshes a browser session.
      expect(ack.headers['set-cookie']).toBeUndefined();

      const after = await request(harness.app).get('/api/v1/auth/me').set(bearer(token));
      expect(meResponseSchema.parse(after.body).paranoidFreshStartPending).toBe(false);

      const stamped = (await receiptOf(user.id)).noticeAcknowledgedAt;
      expect(stamped).not.toBeNull();
      // Replay (a retried request from a flaky mobile network): same answer,
      // same timestamp — the `IS NULL` guard is the idempotency key.
      const replay = await request(harness.app).post(ACK).set(bearer(token));
      expect(replay.status).toBe(200);
      expect(replay.body.paranoidFreshStartPending).toBe(false);
      expect((await receiptOf(user.id)).noticeAcknowledgedAt).toEqual(stamped);

      // The browser sees the same spent notice — one receipt, both front ends.
      const browser = await login(user);
      expect((await browser.get('/api/v1/auth/me')).body.paranoidFreshStartPending).toBe(false);
    },
  );

  it('a mobile token WITHOUT account:security is refused, audited, and leaves the notice owed', async () => {
    const tag = randomBytes(4).toString('hex');
    const user = await harness.seedUser({
      email: `e9-unscoped-${tag}@example.test`,
      username: `e9unscoped${tag}`,
    });
    const token = await mobileToken(user, ['portfolio:read']);
    await wipeThroughTheRealGate(user);

    const denied = await request(harness.app).post(ACK).set(bearer(token));
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(denied.body.error.message).toContain(ACCOUNT_SECURITY_SCOPE);

    expect((await receiptOf(user.id)).noticeAcknowledgedAt).toBeNull();
    const me = await request(harness.app).get('/api/v1/auth/me').set(bearer(token));
    expect(me.body.paranoidFreshStartPending).toBe(true);

    // The refusal lands on the shared denial rail with the existing vocabulary,
    // attributed to the delegated grant — no new event name.
    const denials = await harness.db
      .select({ meta: auditLog.meta, targetType: auditLog.targetType })
      .from(auditLog)
      .where(and(eq(auditLog.actorId, user.id), eq(auditLog.action, 'api_key.scope_denied')));
    expect(denials).toHaveLength(1);
    expect(denials[0]?.targetType).toBe('oauth_grant');
    expect(denials[0]?.meta).toMatchObject({
      requiredScope: ACCOUNT_SECURITY_SCOPE,
      reason: 'insufficient-scope',
      method: 'POST',
      path: '/auth/fresh-start-notice/acknowledge',
      kind: 'oauth',
    });
  });

  it('a bearer acknowledgement is caller-scoped: another wiped account stays owed', async () => {
    const tag = randomBytes(4).toString('hex');
    const mine = await harness.seedUser({
      email: `e9-bmine-${tag}@example.test`,
      username: `e9bmine${tag}`,
    });
    const theirs = await harness.seedUser({
      email: `e9-btheirs-${tag}@example.test`,
      username: `e9btheirs${tag}`,
    });
    const token = await personalKey(mine, [ACCOUNT_SECURITY_SCOPE]);
    await wipeThroughTheRealGate(mine);
    await wipeThroughTheRealGate(theirs);

    expect((await request(harness.app).post(ACK).set(bearer(token))).status).toBe(200);
    expect((await receiptOf(mine.id)).noticeAcknowledgedAt).not.toBeNull();
    expect((await receiptOf(theirs.id)).noticeAcknowledgedAt).toBeNull();
  });
});
