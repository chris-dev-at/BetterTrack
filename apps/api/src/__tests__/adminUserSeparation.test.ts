import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

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
  return { agent, res };
}

// One representative request per user-app router group. Every group mounts
// `requireUser` at the router root, so any request reaching the router is
// guarded before route matching — a bare GET is enough to prove the rejection.
const USER_ROUTES = [
  '/api/v1/workboard',
  '/api/v1/search?q=bay',
  '/api/v1/assets/00000000-0000-0000-0000-000000000000',
  '/api/v1/portfolios',
  '/api/v1/custom-assets/00000000-0000-0000-0000-000000000000/value-points',
  '/api/v1/conglomerates',
  '/api/v1/backtest',
  '/api/v1/social/requests',
  '/api/v1/notifications',
  '/api/v1/settings/notifications',
] as const;

// Every admin router endpoint sits behind `requireAdmin`, which 404s non-admins
// so the admin surface is undetectable (§6.12). Representative GETs across the
// admin router's endpoint groups.
const ADMIN_ROUTES = [
  '/api/v1/admin/users',
  '/api/v1/admin/invites',
  '/api/v1/admin/stats',
  '/api/v1/admin/settings',
  '/api/v1/admin/email/status',
  '/api/v1/admin/audit',
  '/api/v1/admin/emails',
] as const;

// Admin/user separation (#248, PROJECTPLAN.md §3, §4.6, §6.1). The two account
// kinds authenticate disjointly: the user API rejects admin sessions and the
// admin API rejects user sessions — the "mutual endpoint rejection" that backs
// the origin-level app split so no obscure route can hand out admin rights.
describe('admin/user system separation — mutual endpoint rejection (§3, §6.1)', () => {
  it('rejects an admin-kind session on every user-app route with the admin-area pointer', async () => {
    const admin = await harness.seedAdmin();
    const { agent, res: login } = await loginAgent(harness.app, admin.email, admin.password);
    expect(login.status).toBe(200);
    // The login response carries the account kind so the SPA can route the admin
    // to its own origin rather than trap them in the user app.
    expect(login.body.role).toBe('admin');

    for (const path of USER_ROUTES) {
      const res = await agent.get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code, path).toBe('ADMIN_ACCOUNT_KIND');
      // A clear error naming the correct origin — the admin area — never a 404
      // (an authenticated admin already knows it exists) and no data leak.
      expect(res.body.error.message, path).toMatch(/admin area/i);
    }
  });

  it('rejects a user-kind session on every admin route with a bare 404 — no route disclosure', async () => {
    await harness.seedUser({ email: 'plain@test.dev', username: 'plain_user' });
    const { agent, res: login } = await loginAgent(
      harness.app,
      'plain@test.dev',
      'user-strong-password-1',
    );
    expect(login.status).toBe(200);
    expect(login.body.role).toBe('user');

    for (const path of ADMIN_ROUTES) {
      const res = await agent.get(path);
      expect(res.status, path).toBe(404);
      // A 403 would confirm the route exists; the guard disguises it entirely.
      expect(res.body.error.code, path).not.toBe('ADMIN_ACCOUNT_KIND');
    }
  });

  it('anonymous callers get 401 on user endpoints and 404 on admin endpoints', async () => {
    const userRes = await request(harness.app).get('/api/v1/portfolios');
    expect(userRes.status).toBe(401);

    const adminRes = await request(harness.app).get('/api/v1/admin/users');
    expect(adminRes.status).toBe(404);
  });
});
