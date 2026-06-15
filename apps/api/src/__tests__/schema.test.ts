import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/** Drizzle `.returning()` yields an array; grab the single inserted row. */
function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error('expected an inserted row');
  return row;
}

const EXECUTED_AT = new Date('2026-06-15T10:00:00Z');

/**
 * Integration coverage for the §5.5 data model: the migrations apply on a fresh
 * PGlite database (createTestApp runs them), and the ON DELETE cascades and
 * CHECK constraints behave as the issue requires.
 */
describe('schema (§5.5)', () => {
  let h: TestHarness;
  let userId: string;
  let assetId: string;

  beforeAll(async () => {
    h = await createTestApp();
    const admin = await h.seedAdmin();
    userId = admin.id;

    const asset = one(
      await h.db
        .insert(schema.assets)
        .values({
          providerId: 'yahoo',
          providerRef: 'BAYN.DE',
          type: 'stock',
          symbol: 'BAYN.DE',
          name: 'Bayer AG',
          currency: 'EUR',
        })
        .returning(),
    );
    assetId = asset.id;
  });

  afterAll(async () => {
    await h.ctx.redis.quit?.();
  });

  it('enforces the transactions CHECK constraints', async () => {
    const portfolio = one(await h.db.insert(schema.portfolios).values({ userId }).returning());

    // Valid transaction is accepted.
    await expect(
      h.db.insert(schema.transactions).values({
        portfolioId: portfolio.id,
        assetId,
        side: 'buy',
        quantity: '1.5',
        price: '25.00',
        executedAt: EXECUTED_AT,
      }),
    ).resolves.toBeDefined();

    // quantity must be > 0.
    await expect(
      h.db.insert(schema.transactions).values({
        portfolioId: portfolio.id,
        assetId,
        side: 'buy',
        quantity: '0',
        price: '25.00',
        executedAt: EXECUTED_AT,
      }),
    ).rejects.toThrow();

    // price must be >= 0.
    await expect(
      h.db.insert(schema.transactions).values({
        portfolioId: portfolio.id,
        assetId,
        side: 'buy',
        quantity: '1',
        price: '-1',
        executedAt: EXECUTED_AT,
      }),
    ).rejects.toThrow();
  });

  it('cascades a conglomerate delete to its positions and share links', async () => {
    const cong = one(
      await h.db
        .insert(schema.conglomerates)
        .values({ ownerId: userId, name: 'BioTech+Defense', status: 'draft' })
        .returning(),
    );
    await h.db.insert(schema.conglomeratePositions).values({
      conglomerateId: cong.id,
      assetId,
      weightPct: '100.000',
      sortOrder: 0,
    });
    await h.db
      .insert(schema.shareLinks)
      .values({ conglomerateId: cong.id, token: 'tok-cascade-test' });

    await h.db.delete(schema.conglomerates).where(eq(schema.conglomerates.id, cong.id));

    const positions = await h.db
      .select()
      .from(schema.conglomeratePositions)
      .where(eq(schema.conglomeratePositions.conglomerateId, cong.id));
    const links = await h.db
      .select()
      .from(schema.shareLinks)
      .where(eq(schema.shareLinks.conglomerateId, cong.id));
    expect(positions).toHaveLength(0);
    expect(links).toHaveLength(0);
  });

  it('cascades a user delete to everything they own', async () => {
    const victim = await h.seedAdmin({
      email: 'victim@bettertrack.test',
      username: 'victim',
    });

    const asset = one(
      await h.db
        .insert(schema.assets)
        .values({
          providerId: 'custom',
          providerRef: `house-${victim.id}`,
          ownerId: victim.id,
          type: 'custom',
          symbol: 'HOUSE',
          name: 'My house',
          currency: 'EUR',
        })
        .returning(),
    );
    await h.db.insert(schema.workboardItems).values({
      userId: victim.id,
      assetId: asset.id,
      sortOrder: 0,
    });
    await h.db.insert(schema.alerts).values({
      userId: victim.id,
      assetId: asset.id,
      kind: 'price_above',
      threshold: '100',
      status: 'active',
    });
    await h.db.insert(schema.priceHistory).values({
      assetId: asset.id,
      date: '2026-06-15',
      close: '500000',
    });
    await h.db.insert(schema.notifications).values({
      userId: victim.id,
      type: 'alert.triggered',
      title: 'hi',
      body: 'there',
    });
    await h.db
      .insert(schema.notificationSettings)
      .values({ userId: victim.id, channel: 'email', enabled: true });
    const portfolio = one(
      await h.db.insert(schema.portfolios).values({ userId: victim.id }).returning(),
    );
    await h.db.insert(schema.transactions).values({
      portfolioId: portfolio.id,
      assetId: asset.id,
      side: 'buy',
      quantity: '1',
      price: '500000',
      executedAt: EXECUTED_AT,
    });
    const cong = one(
      await h.db
        .insert(schema.conglomerates)
        .values({ ownerId: victim.id, name: 'Victim basket', status: 'draft' })
        .returning(),
    );

    await h.db.delete(schema.users).where(eq(schema.users.id, victim.id));

    const tables = [
      { t: schema.assets, col: schema.assets.ownerId },
      { t: schema.workboardItems, col: schema.workboardItems.userId },
      { t: schema.alerts, col: schema.alerts.userId },
      { t: schema.notifications, col: schema.notifications.userId },
      { t: schema.notificationSettings, col: schema.notificationSettings.userId },
      { t: schema.portfolios, col: schema.portfolios.userId },
      { t: schema.conglomerates, col: schema.conglomerates.ownerId },
    ] as const;
    for (const { t, col } of tables) {
      const rows = await h.db.select().from(t).where(eq(col, victim.id));
      expect(rows).toHaveLength(0);
    }
    // price_history and transactions die with their cascaded asset/portfolio.
    const ph = await h.db
      .select()
      .from(schema.priceHistory)
      .where(eq(schema.priceHistory.assetId, asset.id));
    const tx = await h.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.portfolioId, portfolio.id));
    expect(ph).toHaveLength(0);
    expect(tx).toHaveLength(0);
    expect(cong.id).toBeDefined();
  });
});
