import request from 'supertest';
import type { Application } from 'express';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(app: Application, user: SeededUser) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status).toBe(200);
  return agent;
}

async function seedAsset(
  overrides: Partial<typeof schema.assets.$inferInsert> = {},
): Promise<typeof schema.assets.$inferSelect> {
  const [asset] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: overrides.providerId ?? 'yahoo',
      providerRef: overrides.providerRef ?? 'BAYN.DE',
      ownerId: overrides.ownerId,
      type: overrides.type ?? 'stock',
      symbol: overrides.symbol ?? 'BAYN.DE',
      name: overrides.name ?? 'Bayer AG',
      exchange: overrides.exchange ?? 'XETRA',
      currency: overrides.currency ?? 'EUR',
      meta: overrides.meta,
    })
    .returning();
  if (!asset) throw new Error('Failed to seed asset');

  await harness.db.insert(schema.priceHistory).values([
    { assetId: asset.id, date: '2026-01-01', close: '100' },
    { assetId: asset.id, date: '2026-01-02', close: '110' },
  ]);

  return asset;
}

async function seedConglomerate(ownerId: string, status: 'draft' | 'active' = 'draft') {
  const [conglomerate] = await harness.db
    .insert(schema.conglomerates)
    .values({ ownerId, name: `Basket ${randomUUID()}`, status })
    .returning();
  if (!conglomerate) throw new Error('Failed to seed conglomerate');
  return conglomerate;
}

describe('conglomerate asset visibility', () => {
  it.each([
    {
      name: 'global asset',
      owner: null,
      replaceStatus: 200,
      previewStatus: 200,
    },
    {
      name: 'caller-owned custom asset',
      owner: 'self',
      replaceStatus: 200,
      previewStatus: 200,
    },
    {
      name: 'another user custom asset',
      owner: 'other',
      replaceStatus: 400,
      previewStatus: 400,
    },
  ] as const)(
    'applies the global-or-owned rule for $name',
    async ({ owner, replaceStatus, previewStatus }) => {
      const user = await harness.seedUser();
      const other = await harness.seedUser({
        email: 'other@bettertrack.test',
        username: 'otheruser',
      });
      const agent = await loginAgent(harness.app, user);
      const asset = await seedAsset({
        providerId: owner === null ? 'yahoo' : 'manual',
        providerRef: owner === null ? 'NVDA' : `${owner}-custom`,
        ownerId: owner === 'self' ? user.id : owner === 'other' ? other.id : null,
        type: owner === null ? 'stock' : 'custom',
        symbol: owner === null ? 'NVDA' : `${owner.toUpperCase()}-CUSTOM`,
        name: owner === null ? 'NVIDIA Corporation' : `${owner} custom`,
        exchange: owner === null ? 'NASDAQ' : null,
        currency: 'EUR',
      });
      const conglomerate = await seedConglomerate(user.id);

      const replace = await agent
        .put(`/api/v1/conglomerates/${conglomerate.id}/positions`)
        .set(...XRW)
        .send({ positions: [{ assetId: asset.id, weightPct: 100 }] });
      expect(replace.status).toBe(replaceStatus);

      const preview = await agent
        .post('/api/v1/backtest/preview')
        .set(...XRW)
        .send({
          range: '1Y',
          positions: [{ assetId: asset.id, weightPct: 100 }],
        });
      expect(preview.status).toBe(previewStatus);
    },
  );

  it.each([
    {
      name: 'valid 100% replacement',
      weightPct: 100,
      expectedStatus: 200,
      expectedStoredWeight: '100.000',
    },
    {
      name: 'invalid 75% replacement',
      weightPct: 75,
      expectedStatus: 400,
      expectedErrorCode: 'INVALID_WEIGHT_SUM',
      expectedStoredWeight: '100.000',
    },
  ] as const)(
    'enforces active invariants while autosaving $name',
    async ({ weightPct, expectedStatus, expectedErrorCode, expectedStoredWeight }) => {
      const user = await harness.seedUser();
      const agent = await loginAgent(harness.app, user);
      const asset = await seedAsset();
      const conglomerate = await seedConglomerate(user.id, 'active');
      await harness.db.insert(schema.conglomeratePositions).values({
        conglomerateId: conglomerate.id,
        assetId: asset.id,
        weightPct: '100.000',
        sortOrder: 0,
      });

      const res = await agent
        .put(`/api/v1/conglomerates/${conglomerate.id}/positions`)
        .set(...XRW)
        .send({ positions: [{ assetId: asset.id, weightPct }] });

      expect(res.status).toBe(expectedStatus);
      if (expectedErrorCode) {
        expect(res.body.error.code).toBe(expectedErrorCode);
      } else {
        expect(res.body.status).toBe('active');
      }

      const [stored] = await harness.db
        .select({ status: schema.conglomerates.status })
        .from(schema.conglomerates)
        .where(eq(schema.conglomerates.id, conglomerate.id));
      expect(stored?.status).toBe('active');

      const storedPositions = await harness.db
        .select({ weightPct: schema.conglomeratePositions.weightPct })
        .from(schema.conglomeratePositions)
        .where(eq(schema.conglomeratePositions.conglomerateId, conglomerate.id));
      expect(storedPositions).toEqual([{ weightPct: expectedStoredWeight }]);
    },
  );
});
