import { beforeEach, describe, expect, it } from 'vitest';

import {
  ADMIN_LIST_PAGE_SIZE_DEFAULT,
  ADMIN_LIST_PAGE_SIZE_MAX,
  ADMIN_LIST_PAGE_OFFSET_MAX,
  adminApiKeyListResponseSchema,
  adminInviteListResponseSchema,
  registrationRequestListResponseSchema,
  registrationTokenListResponseSchema,
} from '@bettertrack/contracts';

import { apiKeys, invites, registrationRequests, registrationTokens } from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

/**
 * The four secondary admin lists shipped unbounded (#1814): each answered with
 * every row its table had ever held, and none of these tables is pruned. They
 * now carry the users list's window — a `limit ≤ 200`, an `offset ≤ 100_000`,
 * and a `page` block naming where the returned rows sit.
 */
describe('bounded admin lists (§6.12, V5-P2 — #1814)', () => {
  it('returns one bounded page of invites with the window it used', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await harness.db.insert(invites).values(
      Array.from({ length: 5 }, (_, i) => ({
        email: `invitee-${i}@test.dev`,
        tokenHash: `invite-hash-${i}`,
        createdBy: admin.id,
        expiresAt: new Date(Date.UTC(2026, 8, 20)),
        createdAt: new Date(Date.UTC(2026, 8, 1 + i)),
      })),
    );

    const res = await agent.get('/api/v1/admin/invites').query({ limit: 2 });
    expect(res.status).toBe(200);
    const page = adminInviteListResponseSchema.parse(res.body);
    expect(page.invites).toHaveLength(2);
    expect(page.page).toEqual({ total: 5, limit: 2, offset: 0 });

    const second = await agent.get('/api/v1/admin/invites').query({ limit: 2, offset: 2 });
    const secondPage = adminInviteListResponseSchema.parse(second.body);
    expect(secondPage.page.offset).toBe(2);
    expect(
      secondPage.invites.every((row) => !page.invites.some((first) => first.id === row.id)),
    ).toBe(true);
  });

  it('defaults to the shared page size when no window is asked for', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await harness.db.insert(invites).values(
      Array.from({ length: ADMIN_LIST_PAGE_SIZE_DEFAULT + 3 }, (_, i) => ({
        email: `bulk-${i}@test.dev`,
        tokenHash: `bulk-hash-${i}`,
        createdBy: admin.id,
        expiresAt: new Date(Date.UTC(2026, 8, 20)),
      })),
    );

    const res = await agent.get('/api/v1/admin/invites');
    const page = adminInviteListResponseSchema.parse(res.body);
    expect(page.invites).toHaveLength(ADMIN_LIST_PAGE_SIZE_DEFAULT);
    expect(page.page.total).toBe(ADMIN_LIST_PAGE_SIZE_DEFAULT + 3);
  });

  it('returns one bounded page of registration tokens and applications', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await harness.db.insert(registrationTokens).values(
      Array.from({ length: 3 }, (_, i) => ({
        tokenHash: `reg-token-${i}`,
        label: `wave ${i}`,
        maxUses: 1,
        createdBy: admin.id,
      })),
    );
    await harness.db.insert(registrationRequests).values(
      Array.from({ length: 3 }, (_, i) => ({
        email: `applicant-${i}@test.dev`,
        username: `applicant${i}`,
        passwordHash: 'hash',
      })),
    );

    const tokens = registrationTokenListResponseSchema.parse(
      (await agent.get('/api/v1/admin/registration-tokens').query({ limit: 1 })).body,
    );
    expect(tokens.tokens).toHaveLength(1);
    expect(tokens.page).toEqual({ total: 3, limit: 1, offset: 0 });

    const requests = registrationRequestListResponseSchema.parse(
      (await agent.get('/api/v1/admin/registration-requests').query({ limit: 2, offset: 1 })).body,
    );
    expect(requests.requests).toHaveLength(2);
    expect(requests.page).toEqual({ total: 3, limit: 2, offset: 1 });
  });

  it('keeps revoked API keys out of the default window and returns them on request', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const user = await harness.seedUser();
    await harness.db.insert(apiKeys).values([
      { userId: user.id, name: 'live', tokenHash: 'k-live', scopes: ['portfolio:read'] },
      {
        userId: user.id,
        name: 'retired',
        tokenHash: 'k-retired',
        scopes: ['portfolio:read'],
        revokedAt: new Date(),
      },
    ]);

    const live = adminApiKeyListResponseSchema.parse(
      (await agent.get('/api/v1/admin/api-keys')).body,
    );
    expect(live.keys.map((key) => key.name)).toEqual(['live']);
    expect(live.page.total).toBe(1);

    const all = adminApiKeyListResponseSchema.parse(
      (await agent.get('/api/v1/admin/api-keys').query({ includeRevoked: 'true' })).body,
    );
    expect(all.keys.map((key) => key.name).sort()).toEqual(['live', 'retired']);
    expect(all.page.total).toBe(2);
  });

  it('refuses an over-large limit or offset the way the users list does', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    for (const path of [
      '/api/v1/admin/invites',
      '/api/v1/admin/registration-tokens',
      '/api/v1/admin/registration-requests',
      '/api/v1/admin/api-keys',
    ]) {
      const tooMany = await agent
        .get(path)
        .query({ limit: ADMIN_LIST_PAGE_SIZE_MAX + 1 })
        .set(...XRW);
      expect(tooMany.status, path).toBe(400);
      expect(tooMany.body.error.code, path).toBe('VALIDATION_ERROR');

      const tooDeep = await agent
        .get(path)
        .query({ offset: ADMIN_LIST_PAGE_OFFSET_MAX + 1 })
        .set(...XRW);
      expect(tooDeep.status, path).toBe(400);

      const atTheBound = await agent.get(path).query({ limit: ADMIN_LIST_PAGE_SIZE_MAX });
      expect(atTheBound.status, path).toBe(200);
    }
  });
});
