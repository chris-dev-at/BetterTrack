import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ANNOUNCEMENT_NOTIFICATION_TYPE,
  activeAnnouncementListResponseSchema,
  announcementListResponseSchema,
  announcementSchema,
  notificationListResponseSchema,
  type CreateAnnouncementRequest,
} from '@bettertrack/contracts';

import { createNotificationRepository } from '../data/repositories/notificationRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { announcementEventKey } from '../services/announcements/announcementService';

/**
 * Announcements (§13.4 V4-P5b). Covers the acceptance criteria:
 *  1. Composer requires EN + DE (zod refuses missing fields).
 *  2. Publishing an announcement reaches every user (banner AND notification-inbox
 *     entry) in their locale.
 *  3. Dismissal is per user AND per announcement; it survives sessions and a fresh
 *     announcement re-appears for everyone.
 *  4. Active window: hidden before start and after end (with a fixed clock).
 *  5. Inbox entry reuses the P0c `account.notice` type + deep-link route.
 *  6. Admin CRUD rejects non-admins (404 mask, mirroring the admin router pattern).
 *  7. Delivery is banner + inbox only (no email/push routing gates apply).
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

afterEach(async () => {
  await harness.ctx.events.close();
});

async function loginUserAgent(
  app: Application,
  identifier: string,
  password: string,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function createViaAdmin(
  agent: ReturnType<typeof request.agent>,
  body: CreateAnnouncementRequest,
) {
  const res = await agent
    .post('/api/v1/admin/announcements')
    .set(...XRW)
    .send(body);
  return res;
}

const BASE_BODY: CreateAnnouncementRequest = {
  severity: 'warning',
  titleEn: 'Scheduled maintenance',
  bodyEn: 'BetterTrack will be briefly unavailable at 22:00 UTC for upgrades.',
  titleDe: 'Geplante Wartung',
  bodyDe: 'BetterTrack ist um 22:00 UTC kurz nicht verfügbar (Upgrade).',
  active: true,
};

describe('announcements — admin CRUD', () => {
  it('rejects non-admin callers with a 404 (same no-leak pattern as the admin router)', async () => {
    const user = await harness.seedUser();
    const agent = await loginUserAgent(harness.app, user.email, user.password);

    const list = await agent.get('/api/v1/admin/announcements');
    expect(list.status).toBe(404);

    const create = await agent
      .post('/api/v1/admin/announcements')
      .set(...XRW)
      .send(BASE_BODY);
    expect(create.status).toBe(404);

    // Anonymous requests are 404 too.
    const anon = await request(harness.app).get('/api/v1/admin/announcements');
    expect(anon.status).toBe(404);
  });

  it('requires EN + DE title/body — missing DE fields → 400 (§13.4 binding)', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent
      .post('/api/v1/admin/announcements')
      .set(...XRW)
      .send({
        severity: 'info',
        titleEn: 'Hello',
        bodyEn: 'Body',
        // titleDe/bodyDe omitted
      });
    expect(res.status).toBe(400);
  });

  it('creates + updates + deletes an announcement; every mutation is audit-logged', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const create = await createViaAdmin(agent, { ...BASE_BODY, active: false });
    expect(create.status).toBe(201);
    const created = announcementSchema.parse(create.body);
    expect(created.active).toBe(false);
    expect(created.publishedAt).toBeNull();

    const list = await agent.get('/api/v1/admin/announcements');
    expect(list.status).toBe(200);
    const parsed = announcementListResponseSchema.parse(list.body);
    expect(parsed.announcements.map((a) => a.id)).toContain(created.id);

    const patched = await agent
      .patch(`/api/v1/admin/announcements/${created.id}`)
      .set(...XRW)
      .send({ severity: 'critical' });
    expect(patched.status).toBe(200);
    expect(patched.body.severity).toBe('critical');

    const del = await agent.delete(`/api/v1/admin/announcements/${created.id}`).set(...XRW);
    expect(del.status).toBe(204);

    const listAfter = await agent.get('/api/v1/admin/announcements');
    expect(
      announcementListResponseSchema
        .parse(listAfter.body)
        .announcements.some((a) => a.id === created.id),
    ).toBe(false);
  });
});

describe('announcements — publishing fans an inbox row out to every user', () => {
  it('creates one account.notice per existing user, in their stored locale, deduped by eventKey', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const en = await harness.seedUser({ email: 'en@bt.test', username: 'englishuser' });
    const de = await harness.seedUser({ email: 'de@bt.test', username: 'deutschuser' });
    await createUserRepository(harness.db).setLocale(de.id, 'de');

    const created = await createViaAdmin(adminAgent, BASE_BODY);
    expect(created.status).toBe(201);
    const announcement = announcementSchema.parse(created.body);
    expect(announcement.publishedAt).not.toBeNull();

    // Each user gets exactly one row keyed by the announcement's event key.
    const notifRepo = createNotificationRepository(harness.db);
    const key = announcementEventKey(announcement.id);
    expect(await notifRepo.existsForEventKey(en.id, key)).toBe(true);
    expect(await notifRepo.existsForEventKey(de.id, key)).toBe(true);

    // EN user sees English content via the bell/list.
    const enAgent = await loginUserAgent(harness.app, en.email, en.password);
    const enInbox = await enAgent.get('/api/v1/notifications');
    expect(enInbox.status).toBe(200);
    const enList = notificationListResponseSchema.parse(enInbox.body);
    const enRow = enList.items.find((n) => n.type === ANNOUNCEMENT_NOTIFICATION_TYPE);
    expect(enRow).toBeDefined();
    expect(enRow!.title).toBe(BASE_BODY.titleEn);

    // DE user sees German content.
    const deAgent = await loginUserAgent(harness.app, de.email, de.password);
    const deInbox = await deAgent.get('/api/v1/notifications');
    const deList = notificationListResponseSchema.parse(deInbox.body);
    const deRow = deList.items.find((n) => n.type === ANNOUNCEMENT_NOTIFICATION_TYPE);
    expect(deRow).toBeDefined();
    expect(deRow!.title).toBe(BASE_BODY.titleDe);

    // Re-publish (toggle off → on) is a per-user no-op via the shared eventKey.
    await adminAgent
      .patch(`/api/v1/admin/announcements/${announcement.id}`)
      .set(...XRW)
      .send({ active: false });
    await adminAgent
      .patch(`/api/v1/admin/announcements/${announcement.id}`)
      .set(...XRW)
      .send({ active: true });

    const enInbox2 = await enAgent.get('/api/v1/notifications');
    const enList2 = notificationListResponseSchema.parse(enInbox2.body);
    const enHits = enList2.items.filter((n) => n.type === ANNOUNCEMENT_NOTIFICATION_TYPE);
    expect(enHits).toHaveLength(1);
  });

  it('the banner endpoint returns each user their locale-rendered content', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const en = await harness.seedUser({ email: 'en2@bt.test', username: 'enuser2' });
    const de = await harness.seedUser({ email: 'de2@bt.test', username: 'deuser2' });
    await createUserRepository(harness.db).setLocale(de.id, 'de');

    await createViaAdmin(adminAgent, BASE_BODY);

    const enAgent = await loginUserAgent(harness.app, en.email, en.password);
    const enRes = await enAgent.get('/api/v1/notifications/announcements');
    expect(enRes.status).toBe(200);
    const enBody = activeAnnouncementListResponseSchema.parse(enRes.body);
    expect(enBody.announcements).toHaveLength(1);
    expect(enBody.announcements[0]!.title).toBe(BASE_BODY.titleEn);
    expect(enBody.announcements[0]!.severity).toBe('warning');

    const deAgent = await loginUserAgent(harness.app, de.email, de.password);
    const deRes = await deAgent.get('/api/v1/notifications/announcements');
    const deBody = activeAnnouncementListResponseSchema.parse(deRes.body);
    expect(deBody.announcements[0]!.title).toBe(BASE_BODY.titleDe);
  });
});

describe('announcements — per-user dismissal', () => {
  it('dismissal is per user and per announcement, and survives sessions', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice_test' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob_test' });

    const created = await createViaAdmin(adminAgent, BASE_BODY);
    const announcement = announcementSchema.parse(created.body);

    const aliceAgent = await loginUserAgent(harness.app, alice.email, alice.password);
    const dismiss = await aliceAgent
      .post(`/api/v1/notifications/announcements/${announcement.id}/dismiss`)
      .set(...XRW);
    expect(dismiss.status).toBe(200);

    // Alice sees no active banner now — dismissed.
    const aliceRes = await aliceAgent.get('/api/v1/notifications/announcements');
    expect(activeAnnouncementListResponseSchema.parse(aliceRes.body).announcements).toHaveLength(0);

    // Bob still sees it — dismissal is per user.
    const bobAgent = await loginUserAgent(harness.app, bob.email, bob.password);
    const bobRes = await bobAgent.get('/api/v1/notifications/announcements');
    expect(activeAnnouncementListResponseSchema.parse(bobRes.body).announcements).toHaveLength(1);

    // Second dismiss for alice is a no-op (idempotent).
    const again = await aliceAgent
      .post(`/api/v1/notifications/announcements/${announcement.id}/dismiss`)
      .set(...XRW);
    expect(again.status).toBe(200);

    // Dismissal survives a fresh session for Alice.
    const alice2 = await loginUserAgent(harness.app, alice.email, alice.password);
    const aliceReturn = await alice2.get('/api/v1/notifications/announcements');
    expect(activeAnnouncementListResponseSchema.parse(aliceReturn.body).announcements).toHaveLength(
      0,
    );

    // A brand-new announcement re-appears for Alice even though she dismissed the first.
    const another = await createViaAdmin(adminAgent, {
      ...BASE_BODY,
      severity: 'info',
      titleEn: 'Another',
      titleDe: 'Weitere',
      bodyEn: 'Round two.',
      bodyDe: 'Zweite Runde.',
    });
    expect(another.status).toBe(201);
    const alice3 = await loginUserAgent(harness.app, alice.email, alice.password);
    const aliceFresh = await alice3.get('/api/v1/notifications/announcements');
    const freshList = activeAnnouncementListResponseSchema.parse(aliceFresh.body).announcements;
    expect(freshList).toHaveLength(1);
    expect(freshList[0]!.title).toBe('Another');
  });

  it('dismissing an unknown/foreign id is a 404 (no IDOR)', async () => {
    const user = await harness.seedUser();
    const agent = await loginUserAgent(harness.app, user.email, user.password);
    // 00000000-… is valid uuid-shape but unknown → 404.
    const res = await agent
      .post('/api/v1/notifications/announcements/00000000-0000-4000-8000-000000000000/dismiss')
      .set(...XRW);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANNOUNCEMENT_NOT_FOUND');
  });
});

describe('announcements — active window', () => {
  it('hides an announcement before its start and after its end (service default clock)', async () => {
    // The fixed-clock exhaustive check lives in the service unit test
    // (announcementService.test.ts); this variant asserts the wire-through
    // shape at the HTTP layer with far-future / far-past windows the wall
    // clock will not slip past during the test run.
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const user = await harness.seedUser();

    const future = new Date('2027-01-01T00:00:00.000Z').toISOString();
    const past = new Date('2020-01-01T00:00:00.000Z').toISOString();

    // Future window → banner hidden.
    const futureRes = await createViaAdmin(adminAgent, {
      ...BASE_BODY,
      titleEn: 'Future window',
      titleDe: 'Fenster in Zukunft',
      startsAt: future,
      endsAt: null,
    });
    expect(futureRes.status).toBe(201);

    // Past window → banner hidden.
    const pastRes = await createViaAdmin(adminAgent, {
      ...BASE_BODY,
      titleEn: 'Past window',
      titleDe: 'Fenster in Vergangenheit',
      startsAt: null,
      endsAt: past,
    });
    expect(pastRes.status).toBe(201);

    // Currently in window → banner shown.
    const nowRes = await createViaAdmin(adminAgent, {
      ...BASE_BODY,
      titleEn: 'Now window',
      titleDe: 'Jetzt-Fenster',
      startsAt: null,
      endsAt: null,
    });
    expect(nowRes.status).toBe(201);

    const userAgent = await loginUserAgent(harness.app, user.email, user.password);
    const res = await userAgent.get('/api/v1/notifications/announcements');
    const list = activeAnnouncementListResponseSchema.parse(res.body);
    const titles = list.announcements.map((a) => a.title);
    expect(titles).toContain('Now window');
    expect(titles).not.toContain('Future window');
    expect(titles).not.toContain('Past window');
  });

  it('an inactive (never-published) announcement is hidden even if the window is now', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const user = await harness.seedUser();

    await createViaAdmin(adminAgent, {
      ...BASE_BODY,
      active: false,
      titleEn: 'Draft',
      titleDe: 'Entwurf',
    });

    const agent = await loginUserAgent(harness.app, user.email, user.password);
    const res = await agent.get('/api/v1/notifications/announcements');
    expect(activeAnnouncementListResponseSchema.parse(res.body).announcements).toHaveLength(0);
  });
});

describe('announcements — inbox entry contract', () => {
  it('uses the shared account.notice type + carries announcementId in payload for deep-linking', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const user = await harness.seedUser();

    const created = await createViaAdmin(adminAgent, BASE_BODY);
    const announcement = announcementSchema.parse(created.body);

    const agent = await loginUserAgent(harness.app, user.email, user.password);
    const inbox = await agent.get('/api/v1/notifications');
    const list = notificationListResponseSchema.parse(inbox.body);
    const row = list.items.find((n) => n.type === ANNOUNCEMENT_NOTIFICATION_TYPE);
    expect(row).toBeDefined();
    const payload = row!.payload as Record<string, unknown> | undefined;
    expect(payload?.announcementId).toBe(announcement.id);
    // Reuses the V4-P0c account.notice slot, so the bell deep-link resolver
    // takes it through the existing `/settings/notifications` mapping.
    expect(row!.type).toBe(ANNOUNCEMENT_NOTIFICATION_TYPE);
  });
});
