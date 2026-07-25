import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { newId } from '../../../data/ids';
import type { Database } from '../../../data/db';
import * as schema from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { replayRestoredTaxState } from '../replay';

const CUSTOM_PARAMS = {
  ratePct: 10,
  lossOffset: true,
  refund: true,
  yearReset: true,
  carryForward: false,
  costBasis: 'moving-average',
} as const;

const NOW = new Date('2026-07-25T12:00:00.000Z');
const toEur = async (amount: number, currency: string): Promise<number> => {
  if (currency !== 'EUR') throw new Error(`Unexpected test currency ${currency}`);
  return amount;
};

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ taxNow: () => NOW.getTime() });
});

interface EngineFixture {
  name: string;
  mode: 'country_specific' | 'custom';
  country: 'AT' | 'DE' | 'FI' | null;
  override?: unknown;
  sellPrice: number;
  sellTaxEur: number;
  dividendGrossEur?: number;
  dividendTaxEur?: number;
  closedAtResidue?: boolean;
}

async function seedEngineFixture(
  userId: string,
  fixture: EngineFixture,
): Promise<{ portfolioId: string; sourceId: string; assetId: string }> {
  const portfolioId = newId();
  const sourceId = newId();
  const assetId = newId();
  await harness.db.insert(schema.portfolios).values({
    id: portfolioId,
    userId,
    name: fixture.name,
    visibility: 'private',
  });
  await harness.db.insert(schema.portfolioCashSources).values({
    id: sourceId,
    portfolioId,
    name: 'Main',
    type: 'cash',
    isMain: true,
  });
  await harness.db.insert(schema.assets).values({
    id: assetId,
    providerId: 'yahoo',
    providerRef: `${fixture.name}.TEST`,
    type: 'stock',
    symbol: fixture.name,
    name: `${fixture.name} fixture`,
    currency: 'EUR',
  });
  if (fixture.override !== undefined) {
    await harness.db.insert(schema.portfolioSettings).values({
      portfolioId,
      key: 'tax',
      value: fixture.override,
    });
  }

  const years = fixture.closedAtResidue ? [2025, 2026] : [2026];
  for (const year of years) {
    const buyId = newId();
    const sellId = newId();
    await harness.db.insert(schema.transactions).values([
      {
        id: buyId,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '100',
        price: '10',
        fee: '0',
        executedAt: new Date(`${year}-01-10T10:00:00.000Z`),
        taxMode: null,
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        source: 'manual',
      },
      {
        id: sellId,
        portfolioId,
        assetId,
        side: 'sell',
        quantity: '100',
        price: String(fixture.sellPrice),
        fee: '0',
        executedAt: new Date(`${year}-02-10T10:00:00.000Z`),
        taxMode: fixture.mode,
        taxCountry: fixture.country,
        taxAmountEur: String(fixture.sellTaxEur),
        taxParams: fixture.mode === 'custom' ? CUSTOM_PARAMS : null,
        source: 'manual',
      },
    ]);
    await harness.db.insert(schema.portfolioCashMovements).values({
      portfolioId,
      sourceId,
      kind: 'tax_withholding',
      amountEur: String(-fixture.sellTaxEur),
      transactionId: sellId,
      taxYear: year,
      executedAt: new Date(`${year}-02-10T10:00:00.000Z`),
      note: 'fixture settlement',
      source: 'manual',
    });
  }

  if (fixture.dividendGrossEur !== undefined && fixture.dividendTaxEur !== undefined) {
    const dividendId = newId();
    await harness.db.insert(schema.dividends).values({
      id: dividendId,
      portfolioId,
      assetId,
      cashSourceId: sourceId,
      grossAmountEur: String(fixture.dividendGrossEur),
      executedAt: new Date('2026-03-10T10:00:00.000Z'),
      taxMode: fixture.mode,
      taxCountry: fixture.country,
      taxAmountEur: String(fixture.dividendTaxEur),
      taxParams: fixture.mode === 'custom' ? CUSTOM_PARAMS : null,
      source: 'manual',
    });
    await harness.db.insert(schema.portfolioCashMovements).values([
      {
        portfolioId,
        sourceId,
        kind: 'dividend',
        amountEur: String(fixture.dividendGrossEur),
        dividendId,
        executedAt: new Date('2026-03-10T10:00:00.000Z'),
        note: null,
        source: 'manual',
      },
      {
        portfolioId,
        sourceId,
        kind: 'tax_withholding',
        amountEur: String(-fixture.dividendTaxEur),
        dividendId,
        taxYear: 2026,
        executedAt: new Date('2026-03-10T10:00:00.000Z'),
        note: 'fixture dividend settlement',
        source: 'manual',
      },
    ]);
  }

  await harness.db.insert(schema.portfolioCashMovements).values({
    portfolioId,
    sourceId,
    kind: 'deposit',
    amountEur: '10000',
    executedAt: new Date('2025-01-01T10:00:00.000Z'),
    note: 'fixture funding',
    source: 'manual',
  });
  if (fixture.closedAtResidue) {
    await harness.db.insert(schema.portfolioCashMovements).values({
      portfolioId,
      sourceId,
      kind: 'tax_refund',
      amountEur: '25',
      taxYear: 2025,
      executedAt: new Date('2026-01-02T10:00:00.000Z'),
      note: 'locked open-era residue',
      source: 'manual',
    });
  }
  return { portfolioId, sourceId, assetId };
}

async function seedUntaxedOpenFixture(
  userId: string,
  options: { mainFundingEur?: number; otherSourceFundingEur?: number } = {},
): Promise<{ portfolioId: string; sourceId: string }> {
  const mainFundingEur = options.mainFundingEur ?? 1000;
  const otherSourceFundingEur = options.otherSourceFundingEur ?? 0;
  const portfolioId = newId();
  const sourceId = newId();
  const assetId = newId();
  await harness.db.insert(schema.portfolios).values({
    id: portfolioId,
    userId,
    name: `Untaxed ${portfolioId}`,
    visibility: 'private',
  });
  await harness.db.insert(schema.portfolioCashSources).values({
    id: sourceId,
    portfolioId,
    name: 'Main',
    type: 'cash',
    isMain: true,
  });
  await harness.db.insert(schema.assets).values({
    id: assetId,
    providerId: 'yahoo',
    providerRef: `UNTAXED-${portfolioId}`,
    type: 'stock',
    symbol: 'UNTAXED',
    name: 'Untaxed open-year fixture',
    currency: 'EUR',
  });
  await harness.db.insert(schema.transactions).values([
    {
      id: newId(),
      portfolioId,
      assetId,
      side: 'buy',
      quantity: '100',
      price: '10',
      fee: '0',
      executedAt: new Date('2026-01-10T10:00:00.000Z'),
      taxMode: null,
      source: 'manual',
    },
    {
      id: newId(),
      portfolioId,
      assetId,
      side: 'sell',
      quantity: '100',
      price: '20',
      fee: '0',
      executedAt: new Date('2026-02-10T10:00:00.000Z'),
      taxMode: 'none',
      source: 'manual',
    },
  ]);
  if (mainFundingEur > 0) {
    await harness.db.insert(schema.portfolioCashMovements).values({
      portfolioId,
      sourceId,
      kind: 'deposit',
      amountEur: String(mainFundingEur),
      executedAt: new Date('2026-01-01T10:00:00.000Z'),
      note: null,
      source: 'manual',
    });
  }
  if (otherSourceFundingEur > 0) {
    const otherSourceId = newId();
    await harness.db.insert(schema.portfolioCashSources).values({
      id: otherSourceId,
      portfolioId,
      name: 'Broker cash',
      type: 'bank',
      isMain: false,
    });
    await harness.db.insert(schema.portfolioCashMovements).values({
      portfolioId,
      sourceId: otherSourceId,
      kind: 'deposit',
      amountEur: String(otherSourceFundingEur),
      executedAt: new Date('2026-01-01T10:00:00.000Z'),
      note: null,
      source: 'manual',
    });
  }
  return { portfolioId, sourceId };
}

async function setAtUserDefault(userId: string): Promise<void> {
  await harness.db.insert(schema.userTaxSettings).values({
    userId,
    mode: 'country_specific',
    country: 'AT',
    customParams: null,
  });
}

describe('transaction-bound restored tax replay', () => {
  it('reconstructs AT, DE, FI, custom, override/default, open-year, and closed state', async () => {
    const user = await harness.seedUser();
    await setAtUserDefault(user.id);
    const at = await seedEngineFixture(user.id, {
      name: 'AT default',
      mode: 'country_specific',
      country: 'AT',
      sellPrice: 20,
      sellTaxEur: 275,
      dividendGrossEur: 100,
      dividendTaxEur: 27.5,
      closedAtResidue: true,
    });
    const de = await seedEngineFixture(user.id, {
      name: 'DE override',
      mode: 'country_specific',
      country: 'DE',
      override: { mode: 'country_specific', country: 'DE' },
      sellPrice: 30,
      sellTaxEur: 263.75,
      dividendGrossEur: 1000,
      dividendTaxEur: 263.75,
    });
    const fi = await seedEngineFixture(user.id, {
      name: 'FI override',
      mode: 'country_specific',
      country: 'FI',
      override: { mode: 'country_specific', country: 'FI' },
      sellPrice: 20,
      sellTaxEur: 300,
    });
    const custom = await seedEngineFixture(user.id, {
      name: 'Custom override',
      mode: 'custom',
      country: null,
      override: { mode: 'custom', custom: CUSTOM_PARAMS },
      sellPrice: 20,
      sellTaxEur: 100,
      dividendGrossEur: 100,
      dividendTaxEur: 10,
    });
    // Manual facts coexist with engine rows but are never re-derived/refunded.
    const manualDividendId = newId();
    await harness.db.insert(schema.dividends).values({
      id: manualDividendId,
      portfolioId: at.portfolioId,
      assetId: at.assetId,
      cashSourceId: at.sourceId,
      grossAmountEur: '50',
      executedAt: new Date('2026-04-10T10:00:00.000Z'),
      taxMode: 'manual_per_trade',
      taxCountry: null,
      taxAmountEur: '5',
      taxParams: null,
      source: 'manual',
    });
    await harness.db.insert(schema.portfolioCashMovements).values([
      {
        portfolioId: at.portfolioId,
        sourceId: at.sourceId,
        kind: 'dividend',
        amountEur: '50',
        dividendId: manualDividendId,
        executedAt: new Date('2026-04-10T10:00:00.000Z'),
        note: null,
        source: 'manual',
      },
      {
        portfolioId: at.portfolioId,
        sourceId: at.sourceId,
        kind: 'tax_withholding',
        amountEur: '-5',
        dividendId: manualDividendId,
        taxYear: 2026,
        executedAt: new Date('2026-04-10T10:00:00.000Z'),
        note: 'manual fixture settlement',
        source: 'manual',
      },
    ]);

    const state = await harness.db.transaction((tx) =>
      replayRestoredTaxState(tx as unknown as Database, {
        userId: user.id,
        portfolioIds: [at.portfolioId, de.portfolioId, fi.portfolioId, custom.portfolioId],
        now: NOW,
        toEur,
      }),
    );
    const byRegime = new Map(
      state.portfolios.map((portfolio) => [portfolio.effectiveRegime, portfolio]),
    );

    const atState = byRegime.get('AT')!;
    expect(atState.portfolioId).toBe(at.portfolioId);
    expect(atState.years).toEqual([
      {
        year: 2025,
        lifecycle: 'closed',
        derivation: 'frozen',
        heldEur: 250,
        targetEur: 250,
        frozenTargetEur: 275,
        lockedResidueEur: -25,
        de: null,
      },
      {
        year: 2026,
        lifecycle: 'open',
        derivation: 'live',
        heldEur: 302.5,
        targetEur: 302.5,
        frozenTargetEur: 302.5,
        lockedResidueEur: null,
        de: null,
      },
    ]);

    const deYear = byRegime.get('DE')!.years[0]!;
    expect(deYear).toMatchObject({
      year: 2026,
      derivation: 'live',
      heldEur: 527.5,
      targetEur: 527.5,
      frozenTargetEur: 527.5,
      de: {
        allowanceUsedEur: 1000,
        allowanceRemainingEur: 0,
        kapestEur: 500,
        soliEur: 27.5,
      },
    });
    expect(byRegime.get('FI')!.years[0]).toMatchObject({
      heldEur: 300,
      targetEur: 300,
      frozenTargetEur: 300,
    });
    expect(byRegime.get('custom')!.years[0]).toMatchObject({
      heldEur: 110,
      targetEur: 110,
      frozenTargetEur: 110,
    });
  });

  it('is deterministic and idempotent when the same restored source set is replayed twice', async () => {
    const user = await harness.seedUser();
    await setAtUserDefault(user.id);
    const fixture = await seedUntaxedOpenFixture(user.id);

    await harness.db.transaction(async (tx) => {
      const executor = tx as unknown as Database;
      const replay = () =>
        replayRestoredTaxState(executor, {
          userId: user.id,
          portfolioIds: [fixture.portfolioId],
          now: NOW,
          toEur,
        });
      const first = await replay();
      const second = await replay();
      expect(second).toEqual(first);

      const settlements = await executor
        .select()
        .from(schema.portfolioCashMovements)
        .where(
          and(
            eq(schema.portfolioCashMovements.portfolioId, fixture.portfolioId),
            inArray(schema.portfolioCashMovements.kind, ['tax_withholding', 'tax_refund']),
          ),
        );
      expect(settlements).toHaveLength(1);
      expect(settlements[0]).toMatchObject({
        kind: 'tax_withholding',
        amountEur: '-275.000000',
        transactionId: null,
        dividendId: null,
        taxYear: 2026,
        note: 'Live tax correction (AT)',
      });
    });
  });

  it('defers an insolvent Main withholding even when another source can cover it', async () => {
    const user = await harness.seedUser();
    await setAtUserDefault(user.id);
    const noCash = await seedUntaxedOpenFixture(user.id, { mainFundingEur: 0 });
    const otherSourceOnly = await seedUntaxedOpenFixture(user.id, {
      mainFundingEur: 0,
      otherSourceFundingEur: 1000,
    });

    const state = await harness.db.transaction((tx) =>
      replayRestoredTaxState(tx as unknown as Database, {
        userId: user.id,
        portfolioIds: [noCash.portfolioId, otherSourceOnly.portfolioId],
        now: NOW,
        toEur,
      }),
    );

    for (const portfolio of state.portfolios) {
      expect(portfolio.years).toEqual([
        expect.objectContaining({
          year: 2026,
          heldEur: 0,
          targetEur: 275,
        }),
      ]);
      const settlements = await harness.db
        .select({ id: schema.portfolioCashMovements.id })
        .from(schema.portfolioCashMovements)
        .where(
          and(
            eq(schema.portfolioCashMovements.portfolioId, portfolio.portfolioId),
            inArray(schema.portfolioCashMovements.kind, ['tax_withholding', 'tax_refund']),
          ),
        );
      expect(settlements).toHaveLength(0);
    }
  });

  it('uses UUIDv7 recording order for equal-timestamp transaction tax replay', async () => {
    const user = await harness.seedUser();
    await setAtUserDefault(user.id);
    const portfolioId = newId();
    const sourceId = newId();
    const assetId = newId();
    const at = new Date('2026-02-10T10:00:00.000Z');
    const firstBuyId = '01980000-0000-7000-8000-000000000001';
    const sellId = '01980000-0000-7000-8000-000000000002';
    const lastBuyId = '01980000-0000-7000-8000-000000000003';
    await harness.db.insert(schema.portfolios).values({
      id: portfolioId,
      userId: user.id,
      name: 'Equal-time replay',
      visibility: 'private',
    });
    await harness.db.insert(schema.portfolioCashSources).values({
      id: sourceId,
      portfolioId,
      name: 'Main',
      type: 'cash',
      isMain: true,
    });
    await harness.db.insert(schema.assets).values({
      id: assetId,
      providerId: 'yahoo',
      providerRef: 'EQUAL.TEST',
      type: 'stock',
      symbol: 'EQUAL',
      name: 'Equal-time fixture',
      currency: 'EUR',
    });
    // Deliberately restore in a different physical order. UUIDv7 order is the
    // normal write order: €10 buy → €30 sell → €100 buy, yielding a €200 gain.
    await harness.db.insert(schema.transactions).values([
      {
        id: lastBuyId,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '10',
        price: '100',
        fee: '0',
        executedAt: at,
        taxMode: null,
        source: 'manual',
      },
      {
        id: firstBuyId,
        portfolioId,
        assetId,
        side: 'buy',
        quantity: '10',
        price: '10',
        fee: '0',
        executedAt: at,
        taxMode: null,
        source: 'manual',
      },
      {
        id: sellId,
        portfolioId,
        assetId,
        side: 'sell',
        quantity: '10',
        price: '30',
        fee: '0',
        executedAt: at,
        taxMode: 'none',
        source: 'manual',
      },
    ]);
    await harness.db.insert(schema.portfolioCashMovements).values({
      portfolioId,
      sourceId,
      kind: 'deposit',
      amountEur: '100',
      executedAt: new Date('2026-01-01T10:00:00.000Z'),
      note: null,
      source: 'manual',
    });

    const state = await harness.db.transaction((tx) =>
      replayRestoredTaxState(tx as unknown as Database, {
        userId: user.id,
        portfolioIds: [portfolioId],
        now: NOW,
        toEur,
      }),
    );

    expect(state.portfolios[0]?.years).toEqual([
      expect.objectContaining({
        year: 2026,
        heldEur: 55,
        targetEur: 55,
      }),
    ]);
  });

  it('never commits independently and leaves no derived rows when the caller aborts', async () => {
    const user = await harness.seedUser();
    await setAtUserDefault(user.id);
    const fixture = await seedUntaxedOpenFixture(user.id);

    await expect(
      harness.db.transaction(async (tx) => {
        const executor = tx as unknown as Database;
        const nestedTransaction = vi.spyOn(executor, 'transaction');
        await replayRestoredTaxState(executor, {
          userId: user.id,
          portfolioIds: [fixture.portfolioId],
          now: NOW,
          toEur,
        });
        expect(nestedTransaction).not.toHaveBeenCalled();
        const inside = await executor
          .select({ id: schema.portfolioCashMovements.id })
          .from(schema.portfolioCashMovements)
          .where(
            and(
              eq(schema.portfolioCashMovements.portfolioId, fixture.portfolioId),
              eq(schema.portfolioCashMovements.kind, 'tax_withholding'),
            ),
          );
        expect(inside).toHaveLength(1);
        throw new Error('abort caller transaction');
      }),
    ).rejects.toThrow('abort caller transaction');

    const afterAbort = await harness.db
      .select({ id: schema.portfolioCashMovements.id })
      .from(schema.portfolioCashMovements)
      .where(
        and(
          eq(schema.portfolioCashMovements.portfolioId, fixture.portfolioId),
          inArray(schema.portfolioCashMovements.kind, ['tax_withholding', 'tax_refund']),
        ),
      );
    expect(afterAbort).toHaveLength(0);
  });
});
