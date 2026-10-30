import { createHmac, hkdfSync } from 'node:crypto';

import request from 'supertest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { newId } from '../data/ids';
import { createAnnouncementReceiptRepository } from '../data/repositories/announcementReceiptRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import { createReceiptPseudonymizer } from '../services/crypto/receiptPseudonym';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Account deletion keeps acknowledgement evidence, pseudonymised (PROJECTPLAN
 * §6.19.5, contract §7.5; Chief rulings 2026-10-29 / 2026-10-30), on BOTH
 * deletion paths: self-service `DELETE /account` and the admin console's
 * `deleteUser`. Receipts without an acknowledgement are deleted; acknowledged
 * ones lose every column that could point back at the person and gain the
 * keyed HMAC token; the `user.deleted` audit row counts what was kept.
 *
 * There is no acknowledge route yet (§6.19.14 T2-A, second PR), so the
 * acknowledged receipts are written straight into the table — exactly the row
 * shape that route will write, which the table's CHECKs enforce either way.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const SHA_EN = 'e'.repeat(64);
const SHA_DE = 'd'.repeat(64);

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function seedAnnouncement(kind: 'notice' | 'once' | 'ack_required'): Promise<string> {
  const id = newId();
  await harness.db.insert(schema.announcements).values({
    id,
    kind,
    titleEn: `${kind} title`,
    bodyEn: `${kind} body`,
    titleDe: `${kind} Titel`,
    bodyDe: `${kind} Text`,
    active: true,
    lifecycle: 'published',
    releasedAt: new Date('2026-10-01T00:00:00Z'),
    audienceCutoffAt: new Date('2026-10-01T00:00:00Z'),
  });
  return id;
}

interface Fixture {
  ackWeb: string;
  ackApp: string;
  notice: string;
  once: string;
  lapsedAck: string;
  grantId: string;
}

/** Five receipts of `userId`: two acknowledgements, a dismissal, a seen-only and a lapse. */
async function seedReceipts(userId: string, fixture?: Fixture): Promise<Fixture> {
  const f = fixture ?? {
    ackWeb: await seedAnnouncement('ack_required'),
    ackApp: await seedAnnouncement('ack_required'),
    notice: await seedAnnouncement('notice'),
    once: await seedAnnouncement('once'),
    lapsedAck: await seedAnnouncement('ack_required'),
    grantId: newId(),
  };
  const at = new Date('2026-10-02T09:00:00Z');
  await harness.db.insert(schema.announcementReceipts).values([
    {
      userId,
      announcementId: f.ackWeb,
      seenAt: at,
      acknowledgedAt: at,
      acknowledgedVia: 'web_session',
      acknowledgedLocale: 'de',
      acknowledgedContentSha256: SHA_DE,
    },
    {
      userId,
      announcementId: f.ackApp,
      seenAt: at,
      acknowledgedAt: new Date('2026-10-03T09:00:00Z'),
      acknowledgedVia: 'first_party_oauth',
      acknowledgedGrantId: f.grantId,
      acknowledgedLocale: 'en',
      acknowledgedContentSha256: SHA_EN,
    },
    { userId, announcementId: f.notice, seenAt: at, dismissedAt: at },
    { userId, announcementId: f.once, seenAt: at },
    { userId, announcementId: f.lapsedAck, lapsedAt: at, lapseReason: 'ended' },
  ]);
  return f;
}

/** The token as §6.19.5 defines it, recomputed here from the harness's own record key. */
function expectedToken(userId: string): string {
  const active = harness.ctx.config.recordEncryption.active;
  const key = Buffer.from(
    hkdfSync('sha256', active.key, Buffer.alloc(0), 'bt-announcement-receipt-pseudonym-v1', 32),
  );
  return createHmac('sha256', key).update(userId, 'utf8').digest('hex');
}

async function receiptsOf(announcementIds: string[]) {
  return harness.db
    .select()
    .from(schema.announcementReceipts)
    .where(inArray(schema.announcementReceipts.announcementId, announcementIds));
}

async function assertPseudonymised(userId: string, f: Fixture, survivorId: string): Promise<void> {
  // Nothing keyed to the person survives…
  expect(
    await harness.db
      .select()
      .from(schema.announcementReceipts)
      .where(eq(schema.announcementReceipts.userId, userId)),
  ).toEqual([]);
  // …the un-acknowledged receipts are gone…
  const gone = await receiptsOf([f.notice, f.once, f.lapsedAck]);
  expect(gone.filter((r) => r.userId !== survivorId)).toEqual([]);
  // …and the acknowledgements are kept, reduced to announcement + instant + hash + token.
  const kept = (await receiptsOf([f.ackWeb, f.ackApp]))
    .filter((r) => r.userId === null)
    .sort((a, b) => a.acknowledgedAt!.getTime() - b.acknowledgedAt!.getTime());
  expect(kept).toHaveLength(2);
  const token = expectedToken(userId);
  for (const row of kept) {
    expect(row.subjectToken).toBe(token);
    expect(row.subjectKeyId).toBe(harness.ctx.config.recordEncryption.active.id);
    expect(row.pseudonymizedAt).toBeInstanceOf(Date);
    expect(row.createdAt.getTime()).toBe(row.pseudonymizedAt!.getTime());
    expect(row.updatedAt.getTime()).toBe(row.pseudonymizedAt!.getTime());
    expect(row).toMatchObject({
      userId: null,
      acknowledgedVia: null,
      acknowledgedGrantId: null,
      acknowledgedLocale: null,
      seenAt: null,
      dismissedAt: null,
      lapsedAt: null,
      lapseReason: null,
    });
  }
  expect(
    kept.map((r) => [
      r.announcementId,
      r.acknowledgedAt!.toISOString(),
      r.acknowledgedContentSha256,
    ]),
  ).toEqual([
    [f.ackWeb, '2026-10-02T09:00:00.000Z', SHA_DE],
    [f.ackApp, '2026-10-03T09:00:00.000Z', SHA_EN],
  ]);
  // The token is not the raw id and carries no part of it.
  expect(token).not.toContain(userId.replace(/-/g, '').slice(0, 8));
}

/** The repository exactly as the app context wires it. */
function wiredUsers() {
  return createUserRepository(harness.db, {
    receiptPseudonymizer: createReceiptPseudonymizer(harness.ctx.config.recordEncryption.active),
  });
}

async function userExists(userId: string): Promise<boolean> {
  const rows = await harness.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return rows.length === 1;
}

async function deletionAudit(userId: string) {
  const entries = await harness.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.targetId, userId), eq(schema.auditLog.action, 'user.deleted')));
  return entries[0];
}

describe('account deletion keeps acknowledgements pseudonymised (§6.19.5)', () => {
  it('self-service DELETE /account: un-acknowledged receipts deleted, acknowledged ones pseudonymised and counted', async () => {
    const doomed = await harness.seedUser({ email: 'doomed@bt.test', username: 'doomed' });
    const survivor = await harness.seedUser({ email: 'survivor@bt.test', username: 'survivor' });
    const f = await seedReceipts(doomed.id);
    await seedReceipts(survivor.id, f);

    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: doomed.email, password: doomed.password })
      .expect(200);
    const res = await agent
      .delete('/api/v1/account')
      .set(...XRW)
      .send({ confirmUsername: doomed.username, password: doomed.password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await assertPseudonymised(doomed.id, f, survivor.id);
    // The other account's receipts are untouched, all five of them.
    const theirs = await harness.db
      .select()
      .from(schema.announcementReceipts)
      .where(eq(schema.announcementReceipts.userId, survivor.id));
    expect(theirs).toHaveLength(5);
    expect(theirs.every((r) => r.subjectToken === null)).toBe(true);

    const audit = await deletionAudit(doomed.id);
    expect(audit?.meta).toEqual({ via: 'self', acknowledgementsKept: 2 });
    expect(JSON.stringify(audit?.meta)).not.toContain(doomed.username);
  });

  it('admin deleteUser: the same pseudonymisation, and its own audit row carries the count', async () => {
    const actor = await harness.seedAdmin();
    const target = await harness.seedUser({ email: 'target@bt.test', username: 'target' });
    const survivor = await harness.seedUser({ email: 'bystander@bt.test', username: 'bystander' });
    const f = await seedReceipts(target.id);
    await seedReceipts(survivor.id, f);

    await harness.ctx.admin.deleteUser(target.id, target.username, { id: actor.id });

    await assertPseudonymised(target.id, f, survivor.id);
    const audit = await deletionAudit(target.id);
    expect(audit?.meta).toEqual({ via: 'admin', acknowledgementsKept: 2 });
  });

  it('an account with receipts but no acknowledgement deletes cleanly and keeps nothing', async () => {
    const user = await harness.seedUser({ email: 'plain@bt.test', username: 'plain' });
    const notice = await seedAnnouncement('notice');
    await harness.db.insert(schema.announcementReceipts).values({
      userId: user.id,
      announcementId: notice,
      seenAt: new Date(),
      dismissedAt: new Date(),
    });

    const result = await wiredUsers().remove(user.id);

    expect(result).toEqual({ acknowledgementsKept: 0 });
    expect(await receiptsOf([notice])).toEqual([]);
    expect(await userExists(user.id)).toBe(false);
  });

  it('without a pseudonymizer an acknowledged receipt refuses the delete instead of losing it', async () => {
    const bare = createUserRepository(harness.db);
    const user = await harness.seedUser({ email: 'kept@bt.test', username: 'kept' });
    const f = await seedReceipts(user.id);

    await expect(bare.remove(user.id)).rejects.toThrow(/receipt pseudonymizer/);
    // Rolled back whole: the account and all five receipts are still there.
    expect(await userExists(user.id)).toBe(true);
    expect(
      await harness.db
        .select()
        .from(schema.announcementReceipts)
        .where(eq(schema.announcementReceipts.userId, user.id)),
    ).toHaveLength(5);
    expect(await receiptsOf([f.ackWeb])).toHaveLength(1);
  });

  it('a raw DELETE FROM users with a receipt left is refused by the RESTRICT key', async () => {
    const user = await harness.seedUser({ email: 'raw@bt.test', username: 'raw' });
    await seedReceipts(user.id);
    await expect(
      harness.db.delete(schema.users).where(eq(schema.users.id, user.id)),
    ).rejects.toThrow();
    expect(await userExists(user.id)).toBe(true);
  });

  it('a half-pseudonymised row (user id dropped, nothing else) is refused by the CHECKs', async () => {
    const user = await harness.seedUser({ email: 'half@bt.test', username: 'half' });
    const f = await seedReceipts(user.id);
    await expect(
      harness.db
        .update(schema.announcementReceipts)
        .set({ userId: null })
        .where(eq(schema.announcementReceipts.announcementId, f.ackWeb)),
    ).rejects.toThrow();
    // Token and key id set, but the locale kept: still refused.
    await expect(
      harness.db
        .update(schema.announcementReceipts)
        .set({
          userId: null,
          subjectToken: 'f'.repeat(64),
          subjectKeyId: 'k',
          pseudonymizedAt: new Date(),
          acknowledgedVia: null,
          seenAt: null,
        })
        .where(eq(schema.announcementReceipts.announcementId, f.ackWeb)),
    ).rejects.toThrow();
    expect(
      await harness.db
        .select()
        .from(schema.announcementReceipts)
        .where(
          and(
            eq(schema.announcementReceipts.announcementId, f.ackWeb),
            isNull(schema.announcementReceipts.userId),
          ),
        ),
    ).toEqual([]);
  });
});

describe('receipts on the existing banner routes (0122 rename)', () => {
  it('dismiss is idempotent first-write-wins on the receipt, and also stamps seen', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const created = await adminAgent
      .post('/api/v1/admin/announcements')
      .set(...XRW)
      .send({
        severity: 'info',
        titleEn: 'Hello',
        bodyEn: 'World',
        titleDe: 'Hallo',
        bodyDe: 'Welt',
        active: true,
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const user = await harness.seedUser({ email: 'dismisser@bt.test', username: 'dismisser' });
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password })
      .expect(200);

    await agent
      .post(`/api/v1/notifications/announcements/${id}/dismiss`)
      .set(...XRW)
      .expect(200);
    const [first] = await receiptsOf([id]);
    expect(first).toMatchObject({ userId: user.id });
    expect(first!.dismissedAt).toBeInstanceOf(Date);
    expect(first!.seenAt!.getTime()).toBe(first!.dismissedAt!.getTime());

    await agent
      .post(`/api/v1/notifications/announcements/${id}/dismiss`)
      .set(...XRW)
      .expect(200);
    const after = await receiptsOf([id]);
    expect(after).toHaveLength(1);
    expect(after[0]!.dismissedAt!.getTime()).toBe(first!.dismissedAt!.getTime());
    expect(after[0]!.updatedAt.getTime()).toBe(first!.updatedAt.getTime());

    const list = await agent.get('/api/v1/notifications/announcements');
    expect(list.body.announcements).toEqual([]);
  });

  it('the composer `active` toggle keeps lifecycle in lockstep; deleting drops plain receipts', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const created = await adminAgent
      .post('/api/v1/admin/announcements')
      .set(...XRW)
      .send({
        severity: 'info',
        titleEn: 'Toggle',
        bodyEn: 'Body',
        titleDe: 'Umschalten',
        bodyDe: 'Text',
        active: false,
      });
    const id = created.body.id as string;
    const row = async () =>
      (
        await harness.db.select().from(schema.announcements).where(eq(schema.announcements.id, id))
      )[0]!;

    expect(await row()).toMatchObject({
      active: false,
      lifecycle: 'draft',
      releasedAt: null,
      bodyFormat: 'plain',
    });

    await adminAgent
      .patch(`/api/v1/admin/announcements/${id}`)
      .set(...XRW)
      .send({ active: true })
      .expect(200);
    const live = await row();
    expect(live).toMatchObject({ active: true, lifecycle: 'published', archivedAt: null });
    expect(live.releasedAt).toBeInstanceOf(Date);
    expect(live.audienceCutoffAt).toBeInstanceOf(Date);

    // Someone dismisses it; switching it off now archives (it was seen).
    const user = await harness.seedUser({ email: 'seer@bt.test', username: 'seer' });
    await createAnnouncementReceiptRepository(harness.db).markDismissed(user.id, id, new Date());
    await adminAgent
      .patch(`/api/v1/admin/announcements/${id}`)
      .set(...XRW)
      .send({ active: false })
      .expect(200);
    const off = await row();
    expect(off).toMatchObject({ active: false, lifecycle: 'archived' });
    expect(off.releasedAt!.getTime()).toBe(live.releasedAt!.getTime());
    expect(off.audienceCutoffAt!.getTime()).toBe(live.audienceCutoffAt!.getTime());

    // Back on: published again, the frozen instants unmoved.
    await adminAgent
      .patch(`/api/v1/admin/announcements/${id}`)
      .set(...XRW)
      .send({ active: true })
      .expect(200);
    const again = await row();
    expect(again).toMatchObject({ active: true, lifecycle: 'published', archivedAt: null });
    expect(again.audienceCutoffAt!.getTime()).toBe(live.audienceCutoffAt!.getTime());

    // The legacy composer's delete still works: the dismissal goes with it.
    await adminAgent
      .delete(`/api/v1/admin/announcements/${id}`)
      .set(...XRW)
      .expect(204);
    expect(await receiptsOf([id])).toEqual([]);
  });
});
