import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildRouteTable } from '../scripts/checkOpenapiCoverage';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const ADMIN_PREFIX = '/api/v1/admin';

/**
 * §6.12 kill list, the two prohibitions that had no server-side assertion: "no
 * impersonation" and "no admin-triggered export download". The web test that
 * used to stand in for them matched `/impersonat/i` against rendered labels,
 * which the admin SPA itself already documents as insufficient — a working
 * "Terminate all sessions" button passed a `/revoke/i` check happily.
 */
const IMPERSONATION =
  /impersonat|masquerad|log[-_]?in[-_]?as|sign[-_]?in[-_]?as|act[-_]?as|on[-_]?behalf|sudo|become/i;
const EXPORT_DOWNLOAD = /export|download|archive|bundle|dump|takeout/i;

/**
 * Every mounted per-account admin surface. Frozen deliberately: the vocabulary
 * checks cannot catch a route that avoids those words, so a new `/admin/users*`
 * route — `POST /admin/users/{id}/data-archive` labelled "Fetch account bundle"
 * being the exact case — has to be added here, where it gets weighed against the
 * kill list instead of shipping green.
 */
const ADMIN_USER_SURFACES = [
  'DELETE /api/v1/admin/users/{id}',
  'DELETE /api/v1/admin/users/{id}/notes/{noteId}',
  'GET /api/v1/admin/users',
  'GET /api/v1/admin/users/{id}',
  'GET /api/v1/admin/users/{id}/access',
  'GET /api/v1/admin/users/{id}/audit',
  'GET /api/v1/admin/users/{id}/emails',
  'GET /api/v1/admin/users/{id}/notes',
  'GET /api/v1/admin/users/{id}/sharing',
  'GET /api/v1/admin/users/{id}/support',
  'PATCH /api/v1/admin/users/{id}',
  'POST /api/v1/admin/users',
  'POST /api/v1/admin/users/bulk',
  'POST /api/v1/admin/users/{id}/notes',
  'POST /api/v1/admin/users/{id}/reset-password',
] as const;

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

  it('does not offer impersonation or an admin-triggered export download (§6.12 kill list)', () => {
    const adminSurfaces = buildRouteTable().filter((surface) =>
      surface.path.startsWith(ADMIN_PREFIX),
    );
    expect(adminSurfaces.length).toBeGreaterThan(0);

    // Structural, not label-coupled: this reads the real Express mount table, so
    // a route exists here whether or not any SPA renders a button for it.
    for (const surface of adminSurfaces) {
      expect(surface.path, surface.path).not.toMatch(IMPERSONATION);
    }

    const userSurfaces = adminSurfaces
      .filter((surface) => surface.path.startsWith(`${ADMIN_PREFIX}/users`))
      .map((surface) =>
        surface.kind === 'route' ? `${surface.method} ${surface.path}` : surface.path,
      );
    for (const surface of userSurfaces) {
      expect(surface, surface).not.toMatch(EXPORT_DOWNLOAD);
    }

    // The vocabulary checks above cannot catch a route that simply avoids those
    // words, so the per-account surface is enumerated in full: adding one means
    // adding it here, which is the moment to weigh it against the kill list.
    expect(userSurfaces.sort()).toEqual([...ADMIN_USER_SURFACES].sort());
  });

  it('anonymous callers get 401 on user endpoints and 404 on admin endpoints', async () => {
    const userRes = await request(harness.app).get('/api/v1/portfolios');
    expect(userRes.status).toBe(401);

    const adminRes = await request(harness.app).get('/api/v1/admin/users');
    expect(adminRes.status).toBe(404);
  });
});
