import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { notificationListResponseSchema } from '@bettertrack/contracts';

import { AUTO_ARCHIVE_READ_AFTER_DAYS } from '../services/notifications/notificationService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import * as schema from '../data/schema';

/**
 * Issue #437 — notification archive state + hard deletion. Covers the three
 * list views and their default, archive-implies-read, unarchive, the bulk
 * archive-all-read, the auto-archive sweep under a CONTROLLED clock, badge
 * math (unread among ACTIVE only), single + bulk deletion, and strict per-user
 * isolation on every new mutation.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The controlled "now" every clock-sensitive test starts from. */
const T0 = new Date('2026-07-01T12:00:00.000Z');

let harness: TestHarness;
let clock: { now: Date };

beforeEach(async () => {
  clock = { now: T0 };
  harness = await createTestApp({ notificationNow: () => clock.now });
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

/** Drizzle `.returning()` yields an array; grab the single inserted row. */
function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error('expected an inserted row');
  return row;
}

async function seedNotification(
  userId: string,
  overrides: {
    title?: string;
    readAt?: Date | null;
    archivedAt?: Date | null;
    hidden?: boolean;
  } = {},
) {
  return one(
    await harness.db
      .insert(schema.notifications)
      .values({
        userId,
        type: 'friend.request',
        title: overrides.title ?? 'A notification',
        body: 'body',
        readAt: overrides.readAt ?? null,
        archivedAt: overrides.archivedAt ?? null,
        hidden: overrides.hidden ?? false,
      })
      .returning(),
  );
}

async function listNotifications(agent: Agent, query = '') {
  const res = await agent.get(`/api/v1/notifications${query}`);
  expect(res.status).toBe(200);
  const parsed = notificationListResponseSchema.safeParse(res.body);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.flatten())).toBe(true);
  return parsed.success ? parsed.data : { items: [], nextCursor: null, unreadCount: 0 };
}

const archive = (agent: Agent, id: string) =>
  agent.post(`/api/v1/notifications/${id}/archive`).set(...XRW);
const unarchive = (agent: Agent, id: string) =>
  agent.post(`/api/v1/notifications/${id}/unarchive`).set(...XRW);
const archiveAllRead = (agent: Agent) =>
  agent.post('/api/v1/notifications/archive-all-read').set(...XRW);
const deleteOne = (agent: Agent, id: string) =>
  agent.delete(`/api/v1/notifications/${id}`).set(...XRW);
const deleteBulk = (agent: Agent, query: string) =>
  agent.delete(`/api/v1/notifications${query}`).set(...XRW);

async function seedAlice() {
  const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
  const agent = await loginAgent(harness.app, alice.email, alice.password);
  return { alice, agent };
}

describe('GET /api/v1/notifications views (#437)', () => {
  it('defaults to the active view: archived rows disappear for unchanged clients', async () => {
    const { alice, agent } = await seedAlice();
    const active = await seedNotification(alice.id, { title: 'active' });
    const archived = await seedNotification(alice.id, {
      title: 'archived',
      readAt: T0,
      archivedAt: T0,
    });

    const page = await listNotifications(agent);
    expect(page.items.map((n) => n.id)).toEqual([active.id]);
    expect(page.items[0]?.archivedAt).toBeNull();

    const archivedPage = await listNotifications(agent, '?view=archived');
    expect(archivedPage.items.map((n) => n.id)).toEqual([archived.id]);
    expect(archivedPage.items[0]?.archivedAt).not.toBeNull();

    // Newest-first by UUIDv7 id: `archived` was inserted second.
    const allPage = await listNotifications(agent, '?view=all');
    expect(allPage.items.map((n) => n.id)).toEqual([archived.id, active.id]);
  });

  it('rejects an unknown view', async () => {
    const { agent } = await seedAlice();
    const res = await agent.get('/api/v1/notifications?view=trash');
    expect(res.status).toBe(400);
  });

  it('counts unread among ACTIVE rows only — identically in every view', async () => {
    const { alice, agent } = await seedAlice();
    await seedNotification(alice.id, { title: 'unread active 1' });
    await seedNotification(alice.id, { title: 'unread active 2' });
    await seedNotification(alice.id, { title: 'read active', readAt: T0 });
    await seedNotification(alice.id, { title: 'archived read', readAt: T0, archivedAt: T0 });

    expect((await listNotifications(agent)).unreadCount).toBe(2);
    expect((await listNotifications(agent, '?view=archived')).unreadCount).toBe(2);
    expect((await listNotifications(agent, '?view=all')).unreadCount).toBe(2);
  });
});

describe('POST /api/v1/notifications/:id/archive + /unarchive (#437)', () => {
  it('requires authentication', async () => {
    await archive(request.agent(harness.app), MISSING_ID).expect(401);
    await unarchive(request.agent(harness.app), MISSING_ID).expect(401);
  });

  it('archiving an UNREAD row removes it from the bell instantly and marks it read', async () => {
    const { alice, agent } = await seedAlice();
    const row = await seedNotification(alice.id, { title: 'unread' });
    expect((await listNotifications(agent)).unreadCount).toBe(1);

    const res = await archive(agent, row.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const active = await listNotifications(agent);
    expect(active.items).toHaveLength(0);
    // Archive-implies-read: the badge drops to zero, not to a lying "1".
    expect(active.unreadCount).toBe(0);

    const archived = await listNotifications(agent, '?view=archived');
    expect(archived.items.map((n) => n.id)).toEqual([row.id]);
    expect(archived.items[0]?.readAt).not.toBeNull();
    expect(archived.items[0]?.archivedAt).not.toBeNull();
  });

  it('unarchive brings the row back to active (still read); both ops are idempotent', async () => {
    const { alice, agent } = await seedAlice();
    const row = await seedNotification(alice.id, { title: 'row' });

    await archive(agent, row.id).expect(200);
    const stamped = (await listNotifications(agent, '?view=archived')).items[0];
    expect(stamped?.archivedAt).toBe(T0.toISOString());

    // Repeat archive a minute later: 200, and the ORIGINAL stamps survive.
    clock.now = new Date(T0.getTime() + 60_000);
    await archive(agent, row.id).expect(200);
    const again = (await listNotifications(agent, '?view=archived')).items[0];
    expect(again).toEqual(stamped);

    await unarchive(agent, row.id).expect(200);
    await unarchive(agent, row.id).expect(200); // idempotent too
    const active = await listNotifications(agent);
    expect(active.items.map((n) => n.id)).toEqual([row.id]);
    expect(active.items[0]?.archivedAt).toBeNull();
    expect(active.items[0]?.readAt).not.toBeNull(); // read survives the round-trip
    expect(active.unreadCount).toBe(0);
  });

  it("404s on an unknown id and on another user's id — no effect, no leak", async () => {
    const { agent } = await seedAlice();
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const bobsRow = await seedNotification(bob.id, { title: "bob's" });

    await archive(agent, MISSING_ID).expect(404);
    await unarchive(agent, MISSING_ID).expect(404);
    await archive(agent, bobsRow.id).expect(404);
    await unarchive(agent, bobsRow.id).expect(404);

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const bobPage = await listNotifications(bobAgent);
    expect(bobPage.items.map((n) => n.id)).toEqual([bobsRow.id]);
    expect(bobPage.items[0]?.archivedAt).toBeNull();
    expect(bobPage.unreadCount).toBe(1);
  });
});

describe('POST /api/v1/notifications/archive-all-read (#437)', () => {
  it('archives exactly the read, active set — unread stays, archived untouched', async () => {
    const { alice, agent } = await seedAlice();
    const unread = await seedNotification(alice.id, { title: 'unread' });
    const read1 = await seedNotification(alice.id, { title: 'read 1', readAt: T0 });
    const read2 = await seedNotification(alice.id, { title: 'read 2', readAt: T0 });
    const preArchived = await seedNotification(alice.id, {
      title: 'already archived',
      readAt: new Date(T0.getTime() - DAY_MS),
      archivedAt: new Date(T0.getTime() - DAY_MS),
    });

    const res = await archiveAllRead(agent);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const active = await listNotifications(agent);
    expect(active.items.map((n) => n.id)).toEqual([unread.id]);
    expect(active.unreadCount).toBe(1);

    const archived = await listNotifications(agent, '?view=archived');
    expect(archived.items.map((n) => n.id).sort()).toEqual(
      [read1.id, read2.id, preArchived.id].sort(),
    );
    // The pre-archived row keeps its original stamp (no re-archiving).
    const kept = archived.items.find((n) => n.id === preArchived.id);
    expect(kept?.archivedAt).toBe(new Date(T0.getTime() - DAY_MS).toISOString());

    // Idempotent: a second call changes nothing.
    await archiveAllRead(agent).expect(200);
    expect((await listNotifications(agent)).items.map((n) => n.id)).toEqual([unread.id]);
  });

  it("never touches another user's read rows", async () => {
    const { agent } = await seedAlice();
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const bobsRead = await seedNotification(bob.id, { title: "bob's read", readAt: T0 });

    await archiveAllRead(agent).expect(200);

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const bobPage = await listNotifications(bobAgent);
    expect(bobPage.items.map((n) => n.id)).toEqual([bobsRead.id]);
    expect(bobPage.items[0]?.archivedAt).toBeNull();
  });
});

describe(`auto-archive sweep — read > ${AUTO_ARCHIVE_READ_AFTER_DAYS} days ago (controlled clock, #437)`, () => {
  it('a read row older than the threshold leaves the bell and appears under Archived', async () => {
    const { alice, agent } = await seedAlice();
    const thresholdMs = AUTO_ARCHIVE_READ_AFTER_DAYS * DAY_MS;
    const overThreshold = await seedNotification(alice.id, {
      title: 'read 8 days ago',
      readAt: new Date(T0.getTime() - 8 * DAY_MS),
    });
    const underThreshold = await seedNotification(alice.id, {
      title: 'read 6 days ago',
      readAt: new Date(T0.getTime() - 6 * DAY_MS),
    });
    const exactlyThreshold = await seedNotification(alice.id, {
      title: 'read exactly 7 days ago',
      readAt: new Date(T0.getTime() - thresholdMs),
    });
    const oldUnread = await seedNotification(alice.id, { title: 'ancient but unread' });

    const active = await listNotifications(agent);
    // Strictly OLDER than the threshold archives; exactly-at and newer stay.
    // Unread rows are never auto-archived, however old.
    expect(active.items.map((n) => n.id).sort()).toEqual(
      [underThreshold.id, exactlyThreshold.id, oldUnread.id].sort(),
    );

    const archived = await listNotifications(agent, '?view=archived');
    expect(archived.items.map((n) => n.id)).toEqual([overThreshold.id]);
    // The sweep stamps the controlled clock's instant.
    expect(archived.items[0]?.archivedAt).toBe(T0.toISOString());
    expect(archived.items[0]?.readAt).toBe(new Date(T0.getTime() - 8 * DAY_MS).toISOString());
  });

  it('advancing the clock past the threshold archives on the next fetch', async () => {
    const { alice, agent } = await seedAlice();
    const row = await seedNotification(alice.id, { title: 'freshly read', readAt: T0 });

    // Six days later: still active.
    clock.now = new Date(T0.getTime() + 6 * DAY_MS);
    expect((await listNotifications(agent)).items.map((n) => n.id)).toEqual([row.id]);
    expect((await listNotifications(agent, '?view=archived')).items).toHaveLength(0);

    // Seven days + 1ms later: the very next fetch sweeps it out of the bell.
    clock.now = new Date(T0.getTime() + AUTO_ARCHIVE_READ_AFTER_DAYS * DAY_MS + 1);
    const active = await listNotifications(agent);
    expect(active.items).toHaveLength(0);
    expect(active.unreadCount).toBe(0);
    const archived = await listNotifications(agent, '?view=archived');
    expect(archived.items.map((n) => n.id)).toEqual([row.id]);
    expect(archived.items[0]?.archivedAt).toBe(clock.now.toISOString());
  });

  it("the sweep only touches the CALLER's rows", async () => {
    const { agent } = await seedAlice();
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const bobsOld = await seedNotification(bob.id, {
      title: "bob's old read",
      readAt: new Date(T0.getTime() - 30 * DAY_MS),
    });

    await listNotifications(agent); // alice's fetch sweeps alice only

    const [bobsRow] = await harness.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, bobsOld.id));
    expect(bobsRow?.archivedAt).toBeNull();
  });
});

describe('DELETE /api/v1/notifications/:id (#437)', () => {
  it('requires authentication', async () => {
    await deleteOne(request.agent(harness.app), MISSING_ID).expect(401);
  });

  it('hard-deletes the row; a repeat 404s', async () => {
    const { alice, agent } = await seedAlice();
    const row = await seedNotification(alice.id, { title: 'doomed' });

    await deleteOne(agent, row.id).expect(204);
    expect((await listNotifications(agent, '?view=all')).items).toHaveLength(0);

    await deleteOne(agent, row.id).expect(404);
  });

  it("cannot delete another user's row — 404, row survives", async () => {
    const { agent } = await seedAlice();
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const bobsRow = await seedNotification(bob.id, { title: "bob's" });

    await deleteOne(agent, bobsRow.id).expect(404);

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    expect((await listNotifications(bobAgent)).items.map((n) => n.id)).toEqual([bobsRow.id]);
  });
});

describe('DELETE /api/v1/notifications?scope= (#437)', () => {
  it('requires authentication and an explicit scope', async () => {
    await deleteBulk(request.agent(harness.app), '?scope=all').expect(401);

    const { agent } = await seedAlice();
    await deleteBulk(agent, '').expect(400); // no accidental bare-DELETE wipe
    await deleteBulk(agent, '?scope=everything').expect(400);
  });

  it('scope=archived deletes exactly the archived set', async () => {
    const { alice, agent } = await seedAlice();
    const unread = await seedNotification(alice.id, { title: 'unread active' });
    const read = await seedNotification(alice.id, { title: 'read active', readAt: T0 });
    await seedNotification(alice.id, { title: 'archived 1', readAt: T0, archivedAt: T0 });
    await seedNotification(alice.id, { title: 'archived 2', readAt: T0, archivedAt: T0 });

    await deleteBulk(agent, '?scope=archived').expect(204);

    expect((await listNotifications(agent, '?view=archived')).items).toHaveLength(0);
    const all = await listNotifications(agent, '?view=all');
    expect(all.items.map((n) => n.id).sort()).toEqual([unread.id, read.id].sort());
    expect(all.unreadCount).toBe(1);
  });

  it("scope=all empties the user's notifications — and ONLY that user's", async () => {
    const { alice, agent } = await seedAlice();
    await seedNotification(alice.id, { title: 'a1' });
    await seedNotification(alice.id, { title: 'a2', readAt: T0 });
    await seedNotification(alice.id, { title: 'a3', readAt: T0, archivedAt: T0 });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const bobsRow = await seedNotification(bob.id, { title: "bob's" });

    await deleteBulk(agent, '?scope=all').expect(204);

    const all = await listNotifications(agent, '?view=all');
    expect(all.items).toHaveLength(0);
    expect(all.unreadCount).toBe(0);

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const bobPage = await listNotifications(bobAgent);
    expect(bobPage.items.map((n) => n.id)).toEqual([bobsRow.id]);
    expect(bobPage.unreadCount).toBe(1);
  });

  it('hidden dedupe markers survive scope=all (they are infrastructure, not inbox rows)', async () => {
    const { alice, agent } = await seedAlice();
    await seedNotification(alice.id, { title: 'visible' });
    const marker = await seedNotification(alice.id, { title: 'marker', hidden: true });

    await deleteBulk(agent, '?scope=all').expect(204);

    const [markerRow] = await harness.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, marker.id));
    expect(markerRow).toBeDefined();
    // And it stays invisible: the user-facing views remain empty.
    expect((await listNotifications(agent, '?view=all')).items).toHaveLength(0);
  });
});
