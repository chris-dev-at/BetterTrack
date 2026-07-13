import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
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

/** Count portfolio rows owned by a user directly against the DB. */
async function portfolioCount(h: TestHarness, userId: string): Promise<number> {
  const rows = await h.db
    .select({ id: schema.portfolios.id })
    .from(schema.portfolios)
    .where(eq(schema.portfolios.userId, userId));
  return rows.length;
}

// Every user-app route group is mounted behind `requireUser` (§10). The guard
// runs before any handler, so a bare GET is enough to prove the rejection.
const USER_ENDPOINTS = [
  '/api/v1/portfolios',
  '/api/v1/workboard',
  '/api/v1/search?q=bay',
  '/api/v1/assets/00000000-0000-0000-0000-000000000000',
] as const;

describe('account-kind separation (PROJECTPLAN.md §3, §5.5, §10)', () => {
  it('rejects an admin-kind session on every user endpoint with the admin-area pointer', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    for (const path of USER_ENDPOINTS) {
      const res = await adminAgent.get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code, path).toBe('ADMIN_ACCOUNT_KIND');
      // The copy points the admin at their own area — no bare 404 (they already
      // know it exists), and no user-existence leak.
      expect(res.body.error.message, path).toMatch(/admin area/i);
    }
  });

  it('a user-kind session on an /admin/* route gets 404 — no 403 information leak', async () => {
    await harness.seedUser({ email: 'plain@test.dev', username: 'plain_user' });
    const userAgent = await loginAgent(harness.app, 'plain@test.dev', 'user-strong-password-1');

    const res = await userAgent.get('/api/v1/admin/users');
    expect(res.status).toBe(404);
    // A 403 would confirm the route exists; the guard disguises it entirely.
    expect(res.body.error.code).not.toBe('ADMIN_ACCOUNT_KIND');
  });

  it('anonymous callers get 401 on user endpoints (not the admin-kind pointer)', async () => {
    const res = await request(harness.app).get('/api/v1/portfolios');
    expect(res.status).toBe(401);
  });
});

describe('default-portfolio provisioning by account kind (§5.5)', () => {
  it('gives an admin-created user exactly one default portfolio and an admin none', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    // The seeded first admin is management-only — no portfolio.
    expect(await portfolioCount(harness, admin.id)).toBe(0);

    const createdUser = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'newuser@test.dev', username: 'new_user', role: 'user' });
    expect(createdUser.status).toBe(201);
    expect(await portfolioCount(harness, createdUser.body.user.id)).toBe(1);

    const createdAdmin = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'newadmin@test.dev', username: 'new_admin', role: 'admin' });
    expect(createdAdmin.status).toBe(201);
    expect(await portfolioCount(harness, createdAdmin.body.user.id)).toBe(0);
  });

  it('gives an invite-accepted user exactly one default portfolio', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const invite = await adminAgent
      .post('/api/v1/admin/invites')
      .set(...XRW)
      .send({ email: 'invitee@test.dev' });
    expect(invite.status).toBe(201);
    const token = (invite.body.inviteUrl as string).split('/invite/')[1];

    const accepted = await request(harness.app)
      .post('/api/v1/auth/accept-invite')
      .set(...XRW)
      .send({ token, username: 'invitee', password: 'invitee-strong-pass-1' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.role).toBe('user');
    expect(await portfolioCount(harness, accepted.body.id)).toBe(1);
  });
});
