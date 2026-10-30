import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ANNOUNCEMENT_RECEIPTS_CSV_COLUMNS,
  announcementListResponseSchema,
  announcementReceiptsResponseSchema,
  announcementSchema,
  announcementStatsResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * The admin side of announcements v2 (PROJECTPLAN §6.19.4, §6.19.9; contract
 * §7): drafts, the publish / unpublish / archive transitions and each of their
 * refusals, the field locks per kind and state, the text rules on every save,
 * and the acknowledgement log — stats, keyset receipts with the rows of deleted
 * accounts last, and the audited CSV.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const DAY = 24 * 60 * 60 * 1000;
type Agent = ReturnType<typeof request.agent>;

let harness: TestHarness;
let agent: Agent;
let adminId: string;

beforeEach(async () => {
  harness = await createTestApp();
  const admin = await harness.seedAdmin();
  adminId = admin.id;
  agent = await harness.loginAdmin(admin);
});

const ORIGINAL_GATE = process.env.BT_ANNOUNCEMENT_ACK_GATE_BEARER;
afterEach(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.BT_ANNOUNCEMENT_ACK_GATE_BEARER;
  else process.env.BT_ANNOUNCEMENT_ACK_GATE_BEARER = ORIGINAL_GATE;
});

const NOTICE = { severity: 'info', titleEn: 'Maintenance', bodyEn: 'Tonight **22:00**.' } as const;
const ACK = {
  kind: 'ack_required',
  severity: 'critical',
  titleEn: 'Terms',
  bodyEn: 'Please read the [terms](/legal/terms).',
  titleDe: 'AGB',
  bodyDe: 'Bitte lesen Sie die [AGB](/legal/terms).',
} as const;

const base = '/api/v1/admin/announcements';
const create = (body: Record<string, unknown>) =>
  agent
    .post(base)
    .set(...XRW)
    .send(body);
const transition = (id: string, name: 'publish' | 'unpublish' | 'archive') =>
  agent.post(`${base}/${id}/${name}`).set(...XRW);
const patch = (id: string, body: Record<string, unknown>) =>
  agent
    .patch(`${base}/${id}`)
    .set(...XRW)
    .send(body);

async function draft(body: Record<string, unknown>): Promise<string> {
  const res = await create(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function published(body: Record<string, unknown>): Promise<string> {
  const id = await draft(body);
  const res = await transition(id, 'publish');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return id;
}

async function auditRows(action: string, id: string) {
  return harness.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.targetId, id)));
}

describe('create — always a draft (contract §7.3)', () => {
  it('defaults kind/audience/e-mail fields, accepts English only, and refuses the retired `active`', async () => {
    const res = await create(NOTICE);
    expect(res.status).toBe(201);
    expect(announcementSchema.parse(res.body)).toMatchObject({
      kind: 'notice',
      audience: 'everyone',
      lifecycle: 'draft',
      active: false,
      deliveryState: 'draft',
      bodyFormat: 'markdown',
      titleDe: null,
      bodyDe: null,
      releasedAt: null,
      audienceCutoffAt: null,
      notifyByEmail: false,
      notifyByEmailAfterDays: 7,
      emailPassRecordedAt: null,
    });
    expect((await create({ ...NOTICE, active: true })).status).toBe(400);
  });

  it('the e-mail toggle and its delay belong to ack_required alone; the delay is 0–365', async () => {
    const field = async (body: Record<string, unknown>) => {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      return Object.keys(res.body.error.details.fieldErrors);
    };
    expect(await field({ ...NOTICE, notifyByEmail: true })).toEqual(['notifyByEmail']);
    expect(await field({ ...NOTICE, kind: 'once', notifyByEmailAfterDays: 3 })).toEqual([
      'notifyByEmailAfterDays',
    ]);
    expect(await field({ ...ACK, notifyByEmailAfterDays: 366 })).toEqual([
      'notifyByEmailAfterDays',
    ]);

    const ok = await create({ ...ACK, notifyByEmail: true, notifyByEmailAfterDays: 0 });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ notifyByEmail: true, notifyByEmailAfterDays: 0 });
  });

  it('every save applies the text rules: control/bidi characters, link targets, the kind limit', async () => {
    const bidi = await create({ ...NOTICE, titleEn: 'Pay ‮evil' });
    expect(bidi.status).toBe(400);
    expect(bidi.body.error).toMatchObject({
      code: 'ANNOUNCEMENT_TEXT_INVALID',
      details: { field: 'titleEn', codePoint: 'U+202E', line: 1, column: 5 },
    });

    const link = await create({ ...NOTICE, bodyEn: 'Line one\nSee [here](javascript:alert(1)).' });
    expect(link.status).toBe(400);
    expect(link.body.error.code).toBe('ANNOUNCEMENT_BODY_INVALID');
    expect(link.body.error.details.issues).toEqual([
      expect.objectContaining({ field: 'bodyEn', code: 'link_target', line: 2, column: 12 }),
    ]);

    const long = 'x'.repeat(2001);
    const tooLong = await create({ ...NOTICE, bodyEn: long });
    expect(tooLong.body.error.details.issues[0]).toMatchObject({ code: 'too_long' });
    // A `once` body may run to 10 000 characters.
    expect((await create({ ...NOTICE, kind: 'once', bodyEn: long })).status).toBe(201);
  });
});

describe('publish / unpublish / archive (contract §7.2)', () => {
  it('publish validates, stamps the release and freezes the cutoff at the later of now and startsAt', async () => {
    const noDe = await draft({ ...ACK, titleDe: null, bodyDe: null });
    const incomplete = await transition(noDe, 'publish');
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error).toMatchObject({
      code: 'ANNOUNCEMENT_INCOMPLETE',
      details: { missing: ['titleDe', 'bodyDe'] },
    });

    const ended = await draft({ ...NOTICE, endsAt: new Date(Date.now() - DAY).toISOString() });
    expect((await transition(ended, 'publish')).body.error.code).toBe(
      'INVALID_ANNOUNCEMENT_WINDOW',
    );

    const startsAt = new Date(Date.now() + 2 * DAY);
    const scheduled = await draft({
      ...ACK,
      audience: 'existing_at_publish',
      startsAt: startsAt.toISOString(),
    });
    const res = await transition(scheduled, 'publish');
    expect(res.status).toBe(200);
    const row = announcementSchema.parse(res.body);
    expect(row).toMatchObject({ lifecycle: 'published', active: true, deliveryState: 'scheduled' });
    expect(row.audienceCutoffAt).toBe(startsAt.toISOString());
    expect(row.releasedAt).not.toBeNull();

    const open = await published(NOTICE);
    const openRow = announcementSchema.parse(
      (await agent.get(base)).body.announcements.find((a: { id: string }) => a.id === open),
    );
    expect(openRow.audienceCutoffAt).toBe(openRow.releasedAt);

    const again = await transition(open, 'publish');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ANNOUNCEMENT_NOT_DRAFT');

    const [release] = await auditRows('announcement.release', scheduled);
    expect(release?.meta).toMatchObject({
      kind: 'ack_required',
      audience: 'existing_at_publish',
      audienceCutoffAt: startsAt.toISOString(),
      notifyByEmail: false,
      notifyByEmailAfterDays: 7,
      audienceSize: 0,
    });
  });

  it('unpublish only before the window opens; archive is terminal and idempotent', async () => {
    const scheduled = await published({
      ...NOTICE,
      startsAt: new Date(Date.now() + DAY).toISOString(),
    });
    const back = await transition(scheduled, 'unpublish');
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({
      lifecycle: 'draft',
      releasedAt: null,
      audienceCutoffAt: null,
    });
    expect((await transition(scheduled, 'unpublish')).body.error.code).toBe(
      'ANNOUNCEMENT_NOT_PUBLISHED',
    );

    const live = await published(NOTICE);
    const tooLate = await transition(live, 'unpublish');
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.error.code).toBe('ANNOUNCEMENT_ALREADY_LIVE');

    const notYet = await draft(NOTICE);
    expect((await transition(notYet, 'archive')).body.error.code).toBe(
      'ANNOUNCEMENT_NOT_PUBLISHED',
    );

    const archived = await transition(live, 'archive');
    expect(archived.body).toMatchObject({
      lifecycle: 'archived',
      deliveryState: 'archived',
      active: false,
    });
    expect((await transition(live, 'archive')).status).toBe(200);
    expect(await auditRows('announcement.archive', live)).toHaveLength(1);
    expect((await transition(live, 'publish')).body.error.code).toBe('ANNOUNCEMENT_NOT_DRAFT');
  });

  it('archive of an ack_required records who was still pending', async () => {
    const reader = await harness.seedUser({ email: 'r@bt.test', username: 'reader' });
    await harness.seedUser({ email: 'p@bt.test', username: 'pending' });
    const id = await published(ACK);
    await harness.db.insert(schema.announcementReceipts).values({
      userId: reader.id,
      announcementId: id,
      acknowledgedAt: new Date(),
      acknowledgedVia: 'web_session',
      acknowledgedLocale: 'en',
      acknowledgedContentSha256: 'a'.repeat(64),
    });
    await transition(id, 'archive').expect(200);
    const [row] = await auditRows('announcement.archive', id);
    expect(row?.meta).toMatchObject({ kind: 'ack_required', pendingAtArchive: 1 });
  });

  it('DELETE takes drafts only — with their plain receipts — and refuses anything published', async () => {
    const legacy = await draft(NOTICE);
    const user = await harness.seedUser({ email: 'd@bt.test', username: 'dismisser' });
    await harness.db
      .insert(schema.announcementReceipts)
      .values({ userId: user.id, announcementId: legacy, dismissedAt: new Date() });
    await agent
      .delete(`${base}/${legacy}`)
      .set(...XRW)
      .expect(204);

    const live = await published(NOTICE);
    const refused = await agent.delete(`${base}/${live}`).set(...XRW);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ANNOUNCEMENT_NOT_DRAFT');
    await transition(live, 'archive').expect(200);
    expect((await agent.delete(`${base}/${live}`).set(...XRW)).status).toBe(409);
  });
});

describe('field locks (contract §7.3)', () => {
  it('a published notice keeps kind/audience/startsAt/e-mail locked but takes content and endsAt', async () => {
    const startsAt = new Date(Date.now() - DAY).toISOString();
    const id = await published({ ...NOTICE, startsAt });
    for (const [field, value] of [
      ['kind', 'once'],
      ['audience', 'existing_at_publish'],
      ['startsAt', new Date(Date.now() - 2 * DAY).toISOString()],
    ] as const) {
      const res = await patch(id, { [field]: value });
      expect(res.status, field).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'ANNOUNCEMENT_FIELD_LOCKED',
        details: { fields: [field] },
      });
    }
    // Re-sending the current value is not a change.
    expect((await patch(id, { startsAt, kind: 'notice' })).status).toBe(200);

    const edited = await patch(id, {
      bodyEn: 'Tonight 23:00.',
      endsAt: new Date(Date.now() + DAY).toISOString(),
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const [update] = (await auditRows('announcement.update', id)).slice(-1);
    expect(update?.meta).toMatchObject({
      fields: ['bodyEn', 'endsAt'],
      contentSha256Before: { en: expect.stringMatching(/^[0-9a-f]{64}$/) },
      contentSha256After: { en: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
  });

  it('a published ack_required takes only endsAt — a future one — and nothing once ended or archived', async () => {
    const id = await published(ACK);
    const text = await patch(id, { titleEn: 'Changed terms', severity: 'info' });
    expect(text.status).toBe(409);
    expect(text.body.error.details.fields).toEqual(['severity', 'titleEn']);
    expect(
      (await patch(id, { endsAt: new Date(Date.now() - 1000).toISOString() })).body.error.code,
    ).toBe('INVALID_ANNOUNCEMENT_WINDOW');
    expect((await patch(id, { endsAt: new Date(Date.now() + DAY).toISOString() })).status).toBe(
      200,
    );
    expect((await patch(id, { endsAt: null })).status).toBe(200);

    await harness.db
      .update(schema.announcements)
      .set({ endsAt: new Date(Date.now() - 1000) })
      .where(eq(schema.announcements.id, id));
    const ended = await patch(id, { endsAt: new Date(Date.now() + DAY).toISOString() });
    expect(ended.status).toBe(409);
    expect(ended.body.error.code).toBe('ANNOUNCEMENT_ENDED');
    await transition(id, 'archive').expect(200);
    expect((await patch(id, { endsAt: null })).body.error.code).toBe('ANNOUNCEMENT_ENDED');
  });

  it('a draft takes anything; leaving ack_required clears the e-mail fields', async () => {
    const id = await draft({ ...ACK, notifyByEmail: true, notifyByEmailAfterDays: 3 });
    const res = await patch(id, { kind: 'once' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'once',
      notifyByEmail: false,
      notifyByEmailAfterDays: 7,
    });
    const refused = await patch(id, { notifyByEmail: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('the acknowledgement log (contract §7.4, §7.5)', () => {
  it('stats and keyset receipts: audience accounts by id, then deleted accounts by token; CSV audited', async () => {
    const cutoffTime = Date.now() - DAY;
    const users = [];
    for (const name of ['acked', 'lapsed', 'seen', 'silent']) {
      const u = await harness.seedUser({ email: `${name}@bt.test`, username: name });
      await harness.db
        .update(schema.users)
        .set({ createdAt: new Date(cutoffTime - 1000) })
        .where(eq(schema.users.id, u.id));
      users.push(u);
    }
    const late = await harness.seedUser({ email: 'late@bt.test', username: 'late' });
    const [acked, lapsed, seen] = users;
    const id = await draft({ ...ACK, audience: 'existing_at_publish' });
    await harness.db
      .update(schema.announcements)
      .set({
        lifecycle: 'published',
        active: true,
        releasedAt: new Date(cutoffTime),
        audienceCutoffAt: new Date(cutoffTime),
      })
      .where(eq(schema.announcements.id, id));
    expect(late.id).toBeTruthy();
    const sha = 'b'.repeat(64);
    await harness.db.insert(schema.announcementReceipts).values([
      {
        userId: acked!.id,
        announcementId: id,
        seenAt: new Date(),
        acknowledgedAt: new Date(),
        acknowledgedVia: 'web_session',
        acknowledgedLocale: 'de',
        acknowledgedContentSha256: sha,
      },
      { userId: lapsed!.id, announcementId: id, lapsedAt: new Date(), lapseReason: 'ended' },
      { userId: seen!.id, announcementId: id, seenAt: new Date() },
      ...['e', 'd'].map((c) => ({
        userId: null,
        announcementId: id,
        acknowledgedAt: new Date(),
        acknowledgedContentSha256: sha,
        subjectToken: c.repeat(64),
        subjectKeyId: 'k1',
        pseudonymizedAt: new Date(),
      })),
    ]);

    const stats = announcementStatsResponseSchema.parse(
      (await agent.get(`${base}/${id}/stats`)).body,
    );
    expect(stats).toMatchObject({
      kind: 'ack_required',
      audience: 4,
      seen: 2,
      acknowledged: 1,
      acknowledgedByDeletedAccounts: 2,
      lapsed: 1,
      pending: 2,
      lapseRecorded: false,
    });

    // Page through `all` two at a time: 4 live accounts, then 2 deleted ones.
    const seenIds: Array<string | null> = [];
    const states: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await agent
        .get(`${base}/${id}/receipts`)
        .query({ state: 'all', limit: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const page = announcementReceiptsResponseSchema.parse(res.body);
      for (const item of page.items) {
        seenIds.push(item.userId ?? item.subjectToken);
        states.push(`${item.accountStatus}:${item.state}`);
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    const liveIds = users.map((u) => u.id).sort();
    expect(seenIds).toEqual([...liveIds, 'd'.repeat(64), 'e'.repeat(64)]);
    expect(states.slice(4)).toEqual(['deleted:acknowledged', 'deleted:acknowledged']);
    expect(seenIds).not.toContain(late.id);

    const tab = async (state: string) =>
      announcementReceiptsResponseSchema
        .parse((await agent.get(`${base}/${id}/receipts`).query({ state })).body)
        .items.map((i) => i.username ?? 'deleted');
    expect((await tab('pending')).sort()).toEqual(['seen', 'silent']);
    expect((await tab('acknowledged')).sort()).toEqual(['acked', 'deleted', 'deleted']);
    expect(await tab('lapsed')).toEqual(['lapsed']);
    expect((await tab('unseen')).sort()).toEqual(['lapsed', 'silent']);

    const csv = await agent.get(`${base}/${id}/receipts.csv`).query({ state: 'all' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/^attachment; filename=/);
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toBe(ANNOUNCEMENT_RECEIPTS_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(7);
    expect(csv.text).not.toMatch(/@bt\.test/);
    const [exported] = await auditRows('announcement.receipts_export', id);
    expect(exported).toMatchObject({ actorId: adminId });
    expect(exported?.meta).toEqual({ state: 'all', rows: 6 });
  });

  it('a draft reports its audience as if published now; an unknown id is 404', async () => {
    await harness.seedUser({ email: 'one@bt.test', username: 'one' });
    const id = await draft(NOTICE);
    const stats = announcementStatsResponseSchema.parse(
      (await agent.get(`${base}/${id}/stats`)).body,
    );
    expect(stats).toMatchObject({ kind: 'notice', audience: 1, pending: null });
    const missing = await agent.get(`${base}/00000000-0000-4000-8000-000000000000/stats`);
    expect(missing.status).toBe(404);
    const badCursor = await agent.get(`${base}/${id}/receipts`).query({ cursor: 'nope' });
    expect(badCursor.status).toBe(400);
  });
});

describe('bearerAckGate — read-only deployment state (Chief ruling 2026-10-30)', () => {
  it.each([
    [undefined, 'off'],
    ['off', 'off'],
    ['first_party', 'first_party'],
    ['all', 'off'],
  ] as const)('BT_ANNOUNCEMENT_ACK_GATE_BEARER=%s → %s', async (value, expected) => {
    if (value === undefined) delete process.env.BT_ANNOUNCEMENT_ACK_GATE_BEARER;
    else process.env.BT_ANNOUNCEMENT_ACK_GATE_BEARER = value;
    const res = await agent.get(base);
    expect(announcementListResponseSchema.parse(res.body).bearerAckGate).toBe(expected);
  });
});
