import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  paranoidV1BackupAttestations,
  paranoidV1WipeReceipts,
  paranoidVaults,
  users,
} from '../../../data/schema';
import { createTestApp, type SeededUser, type TestHarness } from '../../../testing/createTestApp';
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
