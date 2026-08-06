import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../data/schema';
import { createCashSourceRepository } from '../data/repositories/cashSourceRepository';
import { createTransactionRepository } from '../data/repositories/transactionRepository';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const BUY_ID = '00000000-0000-7000-8000-000000000001';
const SELL_ID = '00000000-0000-7000-8000-000000000002';
const PRIOR_BUY_ID = '00000000-0000-7000-8000-000000000003';

let harness: TestHarness;

type HeapRow = { id: string };

async function heapOrder(portfolioId: string, assetId: string): Promise<string[]> {
  const result = (await harness.db.execute(sql`
    SELECT id
    FROM transactions
    WHERE portfolio_id = ${portfolioId} AND asset_id = ${assetId}
    ORDER BY ctid
  `)) as unknown as HeapRow[] & { rows?: HeapRow[] };
  return (result.rows ?? result).map((row) => row.id);
}

async function seedAsset(symbol: string) {
  const [asset] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type: 'stock',
      symbol,
      name: `${symbol} Test AG`,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  if (!asset) throw new Error('Failed to seed transaction-ordering asset');
  return asset;
}

async function touchNote(id: string, note: string): Promise<void> {
  await harness.db.update(schema.transactions).set({ note }).where(eq(schema.transactions.id, id));
}

describe('transaction replay ordering', () => {
  beforeEach(async () => {
    harness = await createTestApp();
  });

  it('keeps the oversell gate stable after a note update reverses same-instant heap order', async () => {
    const user = await harness.seedUser();
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const asset = await seedAsset('ORDER-GATE');
    const executedAt = new Date('2026-01-10T00:00:00.000Z');
    await harness.db.insert(schema.transactions).values([
      {
        id: BUY_ID,
        portfolioId,
        assetId: asset.id,
        side: 'buy',
        quantity: '1',
        price: '100',
        fee: '0',
        executedAt,
      },
      {
        id: SELL_ID,
        portfolioId,
        assetId: asset.id,
        side: 'sell',
        quantity: '1',
        price: '150',
        fee: '0',
        executedAt,
      },
    ]);

    const agent = request.agent(harness.app);
    const login = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(await heapOrder(portfolioId, asset.id)).toEqual([BUY_ID, SELL_ID]);

    const before = await agent
      .patch(`/api/v1/portfolios/${portfolioId}/transactions/${SELL_ID}`)
      .set(...XRW)
      .send({ note: 'gate before reshuffle' });
    expect(before.status).toBe(200);

    // Updating the other row creates a new HOT tuple after the sell. A read in
    // physical order is now sell-before-buy even though their logical UUIDv7
    // recording order remains buy-before-sell.
    await touchNote(BUY_ID, 'unrelated note update');
    expect(await heapOrder(portfolioId, asset.id)).toEqual([SELL_ID, BUY_ID]);
    expect(
      (await createTransactionRepository(harness.db).listForAsset(portfolioId, asset.id)).map(
        (row) => row.id,
      ),
    ).toEqual([BUY_ID, SELL_ID]);

    const after = await agent
      .patch(`/api/v1/portfolios/${portfolioId}/transactions/${SELL_ID}`)
      .set(...XRW)
      .send({ note: 'gate after reshuffle' });
    expect(after.status).toBe(before.status);
    expect(after.status).toBe(200);
  });

  it('keeps same-instant tax P/L stable after the heap order flips', async () => {
    const user = await harness.seedUser({
      email: 'tax-order@example.com',
      username: 'tax_order',
    });
    const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(user.id);
    const asset = await seedAsset('ORDER-TAX');
    const sameInstant = new Date('2026-02-10T00:00:00.000Z');
    await harness.db.insert(schema.transactions).values([
      {
        id: PRIOR_BUY_ID,
        portfolioId,
        assetId: asset.id,
        side: 'buy',
        quantity: '1',
        price: '50',
        fee: '0',
        executedAt: new Date('2026-01-10T00:00:00.000Z'),
      },
      {
        id: BUY_ID,
        portfolioId,
        assetId: asset.id,
        side: 'buy',
        quantity: '1',
        price: '100',
        fee: '0',
        executedAt: sameInstant,
      },
      {
        id: SELL_ID,
        portfolioId,
        assetId: asset.id,
        side: 'sell',
        quantity: '1',
        price: '150',
        fee: '0',
        executedAt: sameInstant,
      },
    ]);
    await harness.ctx.tax.updateSettings(user.id, { mode: 'manual_per_trade' });
    const source = await createCashSourceRepository(harness.db).getOrCreateMain(portfolioId);

    const plannedRealizedPnl = async (): Promise<number | null | undefined> => {
      // At a 100% manual rate, the planned tax amount is an exact observable of
      // the pending sell's replayed realized P/L.
      const plan = await harness.ctx.tax.planTransactionTaxes({
        userId: user.id,
        portfolioId,
        inputs: [
          {
            assetId: asset.id,
            side: 'sell',
            quantity: 1,
            price: 200,
            fee: 0,
            executedAt: '2026-03-10T00:00:00.000Z',
            taxRatePct: 100,
          },
        ],
        assetsById: new Map([[asset.id, asset]]),
        resolveSourceId: async () => source.id,
      });
      return plan.rows[0]?.tax?.amountEur;
    };

    const before = await plannedRealizedPnl();
    expect(before).toBe(125);

    await touchNote(BUY_ID, 'unrelated tax note update');
    expect(await heapOrder(portfolioId, asset.id)).toEqual([PRIOR_BUY_ID, SELL_ID, BUY_ID]);
    expect(
      (await createTransactionRepository(harness.db).listForAsset(portfolioId, asset.id)).map(
        (row) => row.id,
      ),
    ).toEqual([PRIOR_BUY_ID, BUY_ID, SELL_ID]);

    const after = await plannedRealizedPnl();
    expect(after).toBe(before);
    expect(after).toBe(125);
  });
});
