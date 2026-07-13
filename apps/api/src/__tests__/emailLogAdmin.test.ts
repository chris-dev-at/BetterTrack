import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { emailLogListResponseSchema } from '@bettertrack/contracts';

import { emailLog } from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

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

/** Seed `count` sent-log rows for a recipient/user. */
async function seedLog(userId: string | null, recipient: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    await harness.db.insert(emailLog).values({
      userId,
      recipient,
      template: 'friend_request',
      subject: `Notification ${i}`,
      status: 'sent',
    });
  }
}

describe('admin email-log endpoints (PROJECTPLAN.md §6.10, §6.12, §8)', () => {
  it('GET /admin/emails and /users/:id/emails require an admin session — 404 otherwise', async () => {
    const admin = await harness.seedAdmin();
    const user = await harness.seedUser({ email: 'plain@test.dev', username: 'plain' });
    await seedLog(user.id, user.email, 1);

    const anonGlobal = await request(harness.app).get('/api/v1/admin/emails');
    expect(anonGlobal.status).toBe(404);
    const anonUser = await request(harness.app).get(`/api/v1/admin/users/${user.id}/emails`);
    expect(anonUser.status).toBe(404);

    const userAgent = await loginAgent(harness.app, user.email, user.password);
    expect((await userAgent.get('/api/v1/admin/emails')).status).toBe(404);
    expect((await userAgent.get(`/api/v1/admin/users/${user.id}/emails`)).status).toBe(404);

    const adminAgent = await harness.loginAdmin(admin);
    expect((await adminAgent.get('/api/v1/admin/emails')).status).toBe(200);
    expect((await adminAgent.get(`/api/v1/admin/users/${user.id}/emails`)).status).toBe(200);
  });

  it('global log returns every row, newest first, cursor-paged', async () => {
    const admin = await harness.seedAdmin();
    const user = await harness.seedUser({ email: 'u@test.dev', username: 'u' });
    await seedLog(user.id, user.email, 3);
    await seedLog(null, 'invitee@test.dev', 2); // pre-account invite sends

    const adminAgent = await harness.loginAdmin(admin);

    const first = await adminAgent.get('/api/v1/admin/emails').query({ limit: 3 });
    const firstPage = emailLogListResponseSchema.parse(first.body);
    expect(firstPage.entries).toHaveLength(3);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await adminAgent
      .get('/api/v1/admin/emails')
      .query({ limit: 3, cursor: firstPage.nextCursor! });
    const secondPage = emailLogListResponseSchema.parse(second.body);
    expect(secondPage.entries).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();

    // No overlap across pages; 5 rows total.
    const ids = new Set([...firstPage.entries, ...secondPage.entries].map((e) => e.id));
    expect(ids.size).toBe(5);
  });

  it('per-user log is scoped to that user only', async () => {
    const admin = await harness.seedAdmin();
    const alice = await harness.seedUser({ email: 'alice@test.dev', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@test.dev', username: 'bob' });
    await seedLog(alice.id, alice.email, 2);
    await seedLog(bob.id, bob.email, 3);

    const adminAgent = await harness.loginAdmin(admin);

    const res = await adminAgent.get(`/api/v1/admin/users/${alice.id}/emails`);
    const page = emailLogListResponseSchema.parse(res.body);
    expect(page.entries).toHaveLength(2);
    expect(page.entries.every((e) => e.userId === alice.id)).toBe(true);
  });

  it('per-user log 404s for an unknown user id', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const res = await adminAgent.get(
      '/api/v1/admin/users/00000000-0000-7000-8000-000000000000/emails',
    );
    expect(res.status).toBe(404);
  });
});
