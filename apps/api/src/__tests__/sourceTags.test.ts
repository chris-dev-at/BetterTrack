import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { eq } from 'drizzle-orm';

import {
  cashMovementsResponseSchema,
  dividendListResponseSchema,
  transactionListResponseSchema,
} from '@bettertrack/contracts';

import { createTransactionRepository } from '../data/repositories/transactionRepository';
import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Source tags (V5-P0c, issue #552). Every transaction / dividend / cash movement
 * carries a `source` recording how it entered the ledger — `manual` for hand
 * entry, `import:<broker>` from the CSV apply path. The tag is **server-assigned
 * only**: a client can never forge a `sync:*` / `import:*` tag on a hand-entered
 * row (the mutation bodies are `.strict()` and carry no `source` field). The
 * list endpoints accept a `?source=` filter that returns exactly the tagged rows.
 * (Import-path tagging per broker is asserted end-to-end in the imports suite.)
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

function tsOffset(offset: number): string {
  const day = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  return `${day}T00:00:00.000Z`;
}

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function defaultPortfolioId(agent: ReturnType<typeof request.agent>): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

async function seedAsset(h: TestHarness) {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: 'BAYN.DE',
      type: 'stock',
      symbol: 'BAYN.DE',
      name: 'Bayer AG',
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

describe('source tags (V5-P0c)', () => {
  it('stamps `manual` on hand-entered transactions, cash movements and dividends', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    const buy = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-5) });
    expect(buy.status).toBe(201);
    expect(buy.body.transactions[0].source).toBe('manual');

    const deposit = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 100 });
    expect(deposit.status).toBe(201);
    expect(deposit.body.movement.source).toBe('manual');

    const dividend = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 12.5, executedAt: tsOffset(-1) });
    expect(dividend.status).toBe(201);
    expect(dividend.body.dividend.source).toBe('manual');
    // The dividend's linked cash inflow inherits the dividend's tag.
    expect(dividend.body.movements.every((m: { source: string }) => m.source === 'manual')).toBe(
      true,
    );

    // And they read back tagged over the list endpoints too.
    const txns = await agent.get(`/api/v1/portfolios/${pid}/transactions`);
    expect(txns.body.items.every((t: { source: string }) => t.source === 'manual')).toBe(true);
    const cash = await agent.get(`/api/v1/portfolios/${pid}/cash`);
    expect(cash.body.movements.every((m: { source: string }) => m.source === 'manual')).toBe(true);
    const divs = await agent.get(`/api/v1/portfolios/${pid}/dividends`);
    expect(divs.body.dividends.every((d: { source: string }) => d.source === 'manual')).toBe(true);
  });

  it('rejects a client attempt to forge the source on a manual write (never suppliable)', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    const forgedTxn = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 10,
        executedAt: tsOffset(-1),
        source: 'sync:parqet',
      });
    // The strict body schema refuses the unknown `source` key outright — a caller
    // cannot pass it, so it can never masquerade as synced data.
    expect(forgedTxn.status).toBe(400);

    const forgedCash = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 50, source: 'import:trade_republic' });
    expect(forgedCash.status).toBe(400);
  });

  it('filters transactions by exact source tag — returns exactly the tagged rows', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    // Two manual buys through the API…
    for (const n of [1, 2]) {
      const res = await agent
        .post(`/api/v1/portfolios/${pid}/transactions`)
        .set(...XRW)
        .send({ assetId: asset.id, side: 'buy', quantity: n, price: 50, executedAt: tsOffset(-n) });
      expect(res.status).toBe(201);
    }
    // …and one row written with an import tag directly (stands in for a prior
    // broker apply — the tag itself is what the filter keys on).
    await harness.db.insert(schema.transactions).values({
      portfolioId: pid,
      assetId: asset.id,
      side: 'buy',
      quantity: '3',
      price: '50',
      fee: '0',
      executedAt: new Date(tsOffset(-10)),
      source: 'import:trade_republic',
    });

    const manual = await agent.get(`/api/v1/portfolios/${pid}/transactions?source=manual`);
    expect(manual.status).toBe(200);
    expect(transactionListResponseSchema.safeParse(manual.body).success).toBe(true);
    expect(manual.body.items).toHaveLength(2);
    expect(manual.body.items.every((t: { source: string }) => t.source === 'manual')).toBe(true);

    const imported = await agent.get(
      `/api/v1/portfolios/${pid}/transactions?source=import:trade_republic`,
    );
    expect(imported.status).toBe(200);
    expect(imported.body.items).toHaveLength(1);
    expect(imported.body.items[0].source).toBe('import:trade_republic');

    // An unused tag matches nothing.
    const none = await agent.get(`/api/v1/portfolios/${pid}/transactions?source=sync:george`);
    expect(none.body.items).toHaveLength(0);

    // A malformed tag is a 400, not a silent all-rows result.
    const bad = await agent.get(`/api/v1/portfolios/${pid}/transactions?source=IMPORT`);
    expect(bad.status).toBe(400);
  });

  it('filters cash movements by source tag while the balance still rolls up the full ledger', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    // A manual deposit materialises Main; grab its source id from the ledger.
    const dep = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 100 });
    expect(dep.status).toBe(201);
    const mainSourceId = dep.body.movement.sourceId as string;

    // An import-tagged deposit written directly against the same source.
    await harness.db.insert(schema.portfolioCashMovements).values({
      portfolioId: pid,
      sourceId: mainSourceId,
      kind: 'deposit',
      amountEur: '250',
      executedAt: new Date(tsOffset(-3)),
      source: 'import:flatex',
    });

    const all = await agent.get(`/api/v1/portfolios/${pid}/cash`);
    expect(all.body.movements).toHaveLength(2);
    expect(all.body.balanceEur).toBeCloseTo(350, 2);

    const imported = await agent.get(`/api/v1/portfolios/${pid}/cash?source=import:flatex`);
    expect(imported.body.movements).toHaveLength(1);
    expect(imported.body.movements[0].source).toBe('import:flatex');
    // The filter is a view — the balance is still the whole ledger, not €250.
    expect(imported.body.balanceEur).toBeCloseTo(350, 2);
  });
});

// ─── Tax corrections inherit the source of the write that caused them ────────

/**
 * V5-P0c, issue #1658 part 1. A tax correction is not something anybody typed:
 * it is the consequence of the rows that shaped the tax year. It therefore
 * carries the source of the write that caused it — the same rule the batch path
 * ("Batch year-correction legs carry the same source as the batch",
 * `portfolioService.ts`) and the dividend path (`taxRepository.insertDividend`)
 * already apply. Before #1658 the four correction paths built their movement
 * with no `source` at all, so the column default silently stamped `manual` and
 * `?source=manual` returned rows in a 100 %-imported portfolio that the user
 * never entered.
 */

const viennaYear = (): number =>
  Number(
    new Intl.DateTimeFormat('en', { timeZone: 'Europe/Vienna', year: 'numeric' }).format(
      new Date(),
    ),
  );

async function setAtTaxMode(agent: ReturnType<typeof request.agent>) {
  const res = await agent
    .patch('/api/v1/settings/taxes')
    .set(...XRW)
    .send({ mode: 'country_specific', country: 'AT' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Write a transaction row straight to the table, standing in for a prior apply. */
async function seedTaggedTrade(
  pid: string,
  assetId: string,
  row: {
    side: 'buy' | 'sell';
    quantity: number;
    price: number;
    executedAt: string;
    source: string;
  },
) {
  const [inserted] = await harness.db
    .insert(schema.transactions)
    .values({
      portfolioId: pid,
      assetId,
      side: row.side,
      quantity: String(row.quantity),
      price: String(row.price),
      fee: '0',
      executedAt: new Date(row.executedAt),
      source: row.source,
    })
    .returning();
  if (!inserted) throw new Error('Failed to seed transaction');
  return inserted;
}

async function cashMovements(
  agent: ReturnType<typeof request.agent>,
  pid: string,
  query = '',
): Promise<LedgerRow[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash?limit=200${query}`);
  expect(res.status).toBe(200);
  return res.body.movements;
}

type LedgerRow = { id: string; kind: string; source: string; amountEur: number };

const taxRows = (movements: LedgerRow[]): LedgerRow[] =>
  movements.filter((m) => m.kind === 'tax_withholding' || m.kind === 'tax_refund');

describe('tax corrections carry their cause (V5-P0c, #1658)', () => {
  it('tags a read-path self-heal correction with the import that caused it, never `manual`', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);
    await setAtTaxMode(agent);
    const year = viennaYear();

    // The user's own money goes in by hand — the only `manual` row here.
    const dep = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 5000 });
    expect(dep.status).toBe(201);

    // A broker apply's rows: a buy and a gaining sell, both `import:trade_republic`.
    await seedTaggedTrade(pid, asset.id, {
      side: 'buy',
      quantity: 10,
      price: 50,
      executedAt: `${year}-01-10T10:00:00.000Z`,
      source: 'import:trade_republic',
    });
    const sell = await seedTaggedTrade(pid, asset.id, {
      side: 'sell',
      quantity: 10,
      price: 80,
      executedAt: `${year}-02-10T10:00:00.000Z`,
      source: 'import:trade_republic',
    });

    // Merely opening the tax report self-heals the year and posts the correction.
    const report = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years`);
    expect(report.status).toBe(200);

    const all = await cashMovements(agent, pid);
    const corrections = taxRows(all);
    expect(corrections.length).toBeGreaterThan(0);
    // 27.5 % KESt on a €300 gain.
    expect(corrections.reduce((sum, m) => sum + m.amountEur, 0)).toBeCloseTo(-82.5, 2);
    expect(corrections.every((m) => m.source === 'import:trade_republic')).toBe(true);

    // The criterion, stated as a filter: the import tag finds every leg the
    // import caused…
    const imported = await cashMovements(agent, pid, '&source=import:trade_republic');
    expect(imported.map((m) => m.id).sort()).toEqual(corrections.map((m) => m.id).sort());
    // …and `manual` returns only the deposit the user actually typed.
    const manual = await cashMovements(agent, pid, '&source=manual');
    expect(manual).toHaveLength(1);
    expect(manual[0]!.kind).toBe('deposit');
    expect(taxRows(manual)).toHaveLength(0);

    // Deleting the imported sell claws the tax back; the refund inherits the
    // deleted row's tag, not `manual`.
    const del = await agent.delete(`/api/v1/portfolios/${pid}/transactions/${sell.id}`).set(...XRW);
    expect(del.status, JSON.stringify(del.body)).toBe(204);

    const afterDelete = await cashMovements(agent, pid);
    const refunds = afterDelete.filter((m) => m.kind === 'tax_refund');
    expect(refunds.length).toBeGreaterThan(0);
    expect(refunds.every((m) => m.source === 'import:trade_republic')).toBe(true);
    expect(taxRows(await cashMovements(agent, pid, '&source=manual'))).toHaveLength(0);
  });

  /**
   * The root cause, pinned at the seam. `findByIdForUser` projected a column
   * list WITHOUT `source` and cast the row to the full select type, so every
   * record it returned carried `source: undefined` behind a `string` type. Two
   * callers read it and silently got `manual`: the delete path's tax correction,
   * and the mirrorchain correction path (`mirrorService`: "the row keeps its tag
   * through a correction"), which retagged a replica row on every corrected
   * update.
   */
  it('reads a transaction back with its source tag over the single-row lookup', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);
    const year = viennaYear();

    const replicated = await seedTaggedTrade(pid, asset.id, {
      side: 'buy',
      quantity: 1,
      price: 10,
      executedAt: `${year}-01-10T10:00:00.000Z`,
      source: 'sync:mirrorchain',
    });

    const repo = createTransactionRepository(harness.db);
    expect(await repo.findByIdForUser(user.id, replicated.id)).toMatchObject({
      id: replicated.id,
      source: 'sync:mirrorchain',
    });
  });

  it("tags a deleted dividend's correction with the dividend's own source", async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);
    await setAtTaxMode(agent);
    const year = viennaYear();

    // A held position (a dividend needs one) and the cash to settle against.
    await seedTaggedTrade(pid, asset.id, {
      side: 'buy',
      quantity: 10,
      price: 50,
      executedAt: `${year}-01-10T10:00:00.000Z`,
      source: 'import:flatex',
    });
    const dep = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 5000 });
    expect(dep.status).toBe(201);

    // An imported dividend, straight to the table like a prior broker apply.
    const [dividend] = await harness.db
      .insert(schema.dividends)
      .values({
        portfolioId: pid,
        assetId: asset.id,
        cashSourceId: dep.body.movement.sourceId as string,
        grossAmountEur: '200',
        executedAt: new Date(`${year}-03-10T10:00:00.000Z`),
        taxMode: 'none',
        source: 'import:flatex',
      })
      .returning();
    if (!dividend) throw new Error('Failed to seed dividend');

    // The read self-heals the year onto the imported dividend…
    expect((await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years`)).status).toBe(200);
    const withheld = taxRows(await cashMovements(agent, pid));
    expect(withheld.length).toBeGreaterThan(0);
    expect(withheld.every((m) => m.source === 'import:flatex')).toBe(true);

    // …and deleting it refunds under the SAME tag, so neither leg escapes the
    // filter that should find it.
    const del = await agent
      .delete(`/api/v1/portfolios/${pid}/dividends/${dividend.id}`)
      .set(...XRW);
    expect(del.status, JSON.stringify(del.body)).toBe(204);

    const afterDelete = taxRows(await cashMovements(agent, pid));
    expect(afterDelete.some((m) => m.kind === 'tax_refund')).toBe(true);
    expect(afterDelete.every((m) => m.source === 'import:flatex')).toBe(true);
    expect(taxRows(await cashMovements(agent, pid, '&source=manual'))).toHaveLength(0);
  });

  it('keeps a correction caused by hand-entered rows `manual`', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);
    const year = viennaYear();

    const dep = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 5000 });
    expect(dep.status).toBe(201);

    // Recorded by hand under `none`, so no tax was frozen on the rows…
    for (const row of [
      { side: 'buy' as const, quantity: 10, price: 50, executedAt: `${year}-01-10T10:00:00.000Z` },
      { side: 'sell' as const, quantity: 10, price: 80, executedAt: `${year}-02-10T10:00:00.000Z` },
    ]) {
      const res = await agent
        .post(`/api/v1/portfolios/${pid}/transactions`)
        .set(...XRW)
        .send({ assetId: asset.id, ...row });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    // …and switching the regime on makes the next report read post the correction.
    await setAtTaxMode(agent);
    const report = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years`);
    expect(report.status).toBe(200);

    const corrections = taxRows(await cashMovements(agent, pid));
    expect(corrections.length).toBeGreaterThan(0);
    expect(corrections.every((m) => m.source === 'manual')).toBe(true);
    // Negative space: the hand-entered correction is NOT reachable under an
    // import tag.
    expect(await cashMovements(agent, pid, '&source=import:trade_republic')).toHaveLength(0);
  });

  it('falls back to `manual` when a tax year mixes sources — no single write caused it', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);
    await setAtTaxMode(agent);
    const year = viennaYear();

    const dep = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 5000 });
    expect(dep.status).toBe(201);

    await seedTaggedTrade(pid, asset.id, {
      side: 'buy',
      quantity: 10,
      price: 50,
      executedAt: `${year}-01-10T10:00:00.000Z`,
      source: 'import:trade_republic',
    });
    await seedTaggedTrade(pid, asset.id, {
      side: 'sell',
      quantity: 10,
      price: 80,
      executedAt: `${year}-02-10T10:00:00.000Z`,
      source: 'import:flatex',
    });

    const report = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years`);
    expect(report.status).toBe(200);

    const corrections = taxRows(await cashMovements(agent, pid));
    expect(corrections.length).toBeGreaterThan(0);
    expect(corrections.every((m) => m.source === 'manual')).toBe(true);
  });
});

// ─── The cash source facet + the filters that hang off it ───────────────────

describe('cash source facet (V5-P0c, #1658)', () => {
  it('returns the portfolio-wide facet, independent of the page and of the row filter', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    const dep = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 100 });
    expect(dep.status).toBe(201);
    const mainSourceId = dep.body.movement.sourceId as string;

    // Two rows the first page can never reach (older than the newest one).
    for (const [index, tag] of ['import:flatex', 'sync:parqet'].entries()) {
      await harness.db.insert(schema.portfolioCashMovements).values({
        portfolioId: pid,
        sourceId: mainSourceId,
        kind: 'deposit',
        amountEur: '10',
        executedAt: new Date(tsOffset(-30 - index)),
        source: tag,
      });
    }

    // A one-row page still answers with every tag in the portfolio.
    const paged = await agent.get(`/api/v1/portfolios/${pid}/cash?limit=1&includeSourceTags=true`);
    expect(paged.status).toBe(200);
    expect(cashMovementsResponseSchema.safeParse(paged.body).success).toBe(true);
    expect(paged.body.movements).toHaveLength(1);
    expect(paged.body.sourceTags).toEqual(['import:flatex', 'manual', 'sync:parqet']);

    // The facet describes the portfolio, not the filtered view.
    const filtered = await agent.get(
      `/api/v1/portfolios/${pid}/cash?source=import:flatex&includeSourceTags=true`,
    );
    expect(filtered.body.movements).toHaveLength(1);
    expect(filtered.body.sourceTags).toEqual(['import:flatex', 'manual', 'sync:parqet']);

    // Not requested → not returned (the transaction facet's contract).
    const plain = await agent.get(`/api/v1/portfolios/${pid}/cash`);
    expect(plain.body.sourceTags).toBeUndefined();
  });

  it('matches source tags exactly — no prefix, no partial', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);

    const dep = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 100 });
    expect(dep.status).toBe(201);
    await harness.db.insert(schema.portfolioCashMovements).values({
      portfolioId: pid,
      sourceId: dep.body.movement.sourceId as string,
      kind: 'deposit',
      amountEur: '250',
      executedAt: new Date(tsOffset(-3)),
      source: 'import:trade_republic',
    });

    // A bare `import:` is not a legal tag at all — 400, never "everything".
    expect((await agent.get(`/api/v1/portfolios/${pid}/cash?source=import:`)).status).toBe(400);
    // A legal tag that is only a PREFIX of a stored one matches nothing.
    const prefix = await agent.get(`/api/v1/portfolios/${pid}/cash?source=import:trade`);
    expect(prefix.status).toBe(200);
    expect(prefix.body.movements).toHaveLength(0);
    // And the exact tag finds exactly its row.
    const exact = await agent.get(`/api/v1/portfolios/${pid}/cash?source=import:trade_republic`);
    expect(exact.body.movements).toHaveLength(1);
  });

  it('filters dividends by exact source tag', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset(harness);

    const buy = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({ assetId: asset.id, side: 'buy', quantity: 10, price: 50, executedAt: tsOffset(-20) });
    expect(buy.status, JSON.stringify(buy.body)).toBe(201);

    const manualDividend = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 12.5, executedAt: tsOffset(-1) });
    expect(manualDividend.status, JSON.stringify(manualDividend.body)).toBe(201);

    const [source] = await harness.db
      .select()
      .from(schema.portfolioCashSources)
      .where(eq(schema.portfolioCashSources.portfolioId, pid))
      .limit(1);
    if (!source) throw new Error('no cash source');
    await harness.db.insert(schema.dividends).values({
      portfolioId: pid,
      assetId: asset.id,
      cashSourceId: source.id,
      grossAmountEur: '40',
      executedAt: new Date(tsOffset(-9)),
      taxMode: 'none',
      source: 'import:flatex',
    });

    const imported = await agent.get(`/api/v1/portfolios/${pid}/dividends?source=import:flatex`);
    expect(imported.status).toBe(200);
    expect(dividendListResponseSchema.safeParse(imported.body).success).toBe(true);
    expect(imported.body.dividends).toHaveLength(1);
    expect(imported.body.dividends[0].source).toBe('import:flatex');

    const manual = await agent.get(`/api/v1/portfolios/${pid}/dividends?source=manual`);
    expect(manual.body.dividends).toHaveLength(1);
    expect(manual.body.dividends[0].id).toBe(manualDividend.body.dividend.id);

    // Negative space: an unused tag, and a prefix of a stored one, match nothing.
    expect(
      (await agent.get(`/api/v1/portfolios/${pid}/dividends?source=sync:george`)).body.dividends,
    ).toHaveLength(0);
    expect(
      (await agent.get(`/api/v1/portfolios/${pid}/dividends?source=import:fla`)).body.dividends,
    ).toHaveLength(0);
  });
});
