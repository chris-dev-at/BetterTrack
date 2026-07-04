import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { notificationListResponseSchema } from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';
import * as schema from '../data/schema';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

type Agent = ReturnType<typeof request.agent>;

/** Drizzle `.returning()` yields an array; grab the single inserted row. */
function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error('expected an inserted row');
  return row;
}

async function seedNotification(
  h: TestHarness,
  userId: string,
  overrides: { type?: string; title?: string; body?: string; readAt?: Date } = {},
) {
  return one(
    await h.db
      .insert(schema.notifications)
      .values({
        userId,
        type: overrides.type ?? 'friend.request',
        title: overrides.title ?? 'New friend request',
        body: overrides.body ?? 'alice sent you a friend request.',
        readAt: overrides.readAt ?? null,
      })
      .returning(),
  );
}

async function listNotifications(agent: Agent, query = '') {
  const res = await agent.get(`/api/v1/notifications${query}`);
  expect(res.status).toBe(200);
  const parsed = notificationListResponseSchema.safeParse(res.body);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : { items: [], nextCursor: null, unreadCount: 0 };
}

function markRead(agent: Agent, body: Record<string, unknown>) {
  return agent
    .post('/api/v1/notifications/mark-read')
    .set(...XRW)
    .send(body);
}

describe('GET /api/v1/notifications', () => {
  it('requires authentication', async () => {
    const res = await request.agent(harness.app).get('/api/v1/notifications');
    expect(res.status).toBe(401);
  });

  it('returns the session user notifications newest-first with unreadCount', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const first = await seedNotification(harness, alice.id, { title: 'first' });
    const second = await seedNotification(harness, alice.id, { title: 'second' });

    const page = await listNotifications(agent);
    expect(page.items.map((n) => n.id)).toEqual([second.id, first.id]);
    expect(page.unreadCount).toBe(2);
    expect(page.nextCursor).toBeNull();
  });

  it('never returns another user notification', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    await seedNotification(harness, bob.id, { title: "bob's" });

    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const page = await listNotifications(aliceAgent);
    expect(page.items).toHaveLength(0);
    expect(page.unreadCount).toBe(0);
  });

  it('paginates newest-first with a cursor', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const n0 = await seedNotification(harness, alice.id, { title: 'n0' });
    const n1 = await seedNotification(harness, alice.id, { title: 'n1' });
    const n2 = await seedNotification(harness, alice.id, { title: 'n2' });

    const first = await listNotifications(agent, '?limit=2');
    expect(first.items.map((n) => n.id)).toEqual([n2.id, n1.id]);
    expect(first.nextCursor).toBe(n1.id);

    const second = await listNotifications(agent, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((n) => n.id)).toEqual([n0.id]);
    expect(second.nextCursor).toBeNull();
  });
});

describe('POST /api/v1/notifications/mark-read', () => {
  it('requires authentication', async () => {
    const res = await markRead(request.agent(harness.app), { all: true });
    expect(res.status).toBe(401);
  });

  it('marks exactly the given ids read, idempotently, lowering unreadCount', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);
    const a = await seedNotification(harness, alice.id, { title: 'a' });
    const b = await seedNotification(harness, alice.id, { title: 'b' });

    const res = await markRead(agent, { ids: [a.id] });
    expect(res.status).toBe(200);

    const page = await listNotifications(agent);
    expect(page.unreadCount).toBe(1);
    const readRow = page.items.find((n) => n.id === a.id);
    const unreadRow = page.items.find((n) => n.id === b.id);
    expect(readRow?.readAt).not.toBeNull();
    expect(unreadRow?.readAt).toBeNull();

    // Idempotent: repeating the same mark-read is a no-op, not an error.
    const again = await markRead(agent, { ids: [a.id] });
    expect(again.status).toBe(200);
    const pageAgain = await listNotifications(agent);
    expect(pageAgain.unreadCount).toBe(1);
  });

  it('{all:true} marks every unread row for the user read', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);
    await seedNotification(harness, alice.id, { title: 'a' });
    await seedNotification(harness, alice.id, { title: 'b' });

    const res = await markRead(agent, { all: true });
    expect(res.status).toBe(200);

    const page = await listNotifications(agent);
    expect(page.unreadCount).toBe(0);
    expect(page.items.every((n) => n.readAt !== null)).toBe(true);

    const again = await markRead(agent, { all: true });
    expect(again.status).toBe(200);
  });

  it('cannot mark-read another user notification — no effect, no leak', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const bobsNotification = await seedNotification(harness, bob.id, { title: "bob's" });

    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const res = await markRead(aliceAgent, { ids: [bobsNotification.id] });
    expect(res.status).toBe(200);

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const bobPage = await listNotifications(bobAgent);
    expect(bobPage.unreadCount).toBe(1);
    expect(bobPage.items[0]?.readAt).toBeNull();
  });

  it('rejects an unknown/malformed body', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const agent = await loginAgent(harness.app, alice.email, alice.password);

    const res = await markRead(agent, { ids: [MISSING_ID], all: true });
    expect(res.status).toBe(400);
  });
});
