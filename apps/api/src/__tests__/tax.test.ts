import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  cashMovementsResponseSchema,
  createDividendResponseSchema,
  dividendListResponseSchema,
  taxSettingsResponseSchema,
  taxYearListResponseSchema,
  taxYearReportResponseSchema,
  type CashMovement,
  type TaxYearReportResponse,
  type TaxYearSummary,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * V3-P4 realized P/L & AT tax engine (issue #331): tax modes end-to-end over
 * the HTTP surface — the owner's required KESt example, the hard Jan-1 reset,
 * the `none` regression, manual per-trade entries, dividends landing in cash
 * sources, per-year reports, mode-switch cutover semantics, and backdated
 * trades settling append-only. EUR assets throughout, so no FX/provider stubs
 * are involved and every cent asserts exactly.
 */

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

type Agent = ReturnType<typeof request.agent>;

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  expect(def).toBeTruthy();
  return def.id as string;
}

/** Seed a global EUR asset row directly (transactions need no provider). */
async function seedAsset(symbol = 'BAYN.DE') {
  const [row] = await harness.db
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
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

/** One logged-in user with their default portfolio and one EUR asset. */
async function setup(mode?: 'manual_per_trade' | 'country_specific') {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const pid = await defaultPortfolioId(agent);
  const asset = await seedAsset();
  if (mode) {
    const res = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send(mode === 'country_specific' ? { mode, country: 'AT' } : { mode });
    expect(res.status).toBe(200);
  }
  return { user, agent, pid, asset };
}

async function trade(
  agent: Agent,
  pid: string,
  body: Record<string, unknown>,
  expectedStatus = 201,
) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(expectedStatus);
  return res;
}

async function cashState(agent: Agent, pid: string) {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash`);
  expect(res.status).toBe(200);
  expect(cashMovementsResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body as {
    balanceEur: number;
    movements: CashMovement[];
    sources: { id: string; isMain: boolean; balanceEur: number }[];
  };
}

async function yearSummaries(agent: Agent, pid: string): Promise<TaxYearSummary[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years`);
  expect(res.status).toBe(200);
  expect(taxYearListResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body.years as TaxYearSummary[];
}

async function yearReport(agent: Agent, pid: string, year: number): Promise<TaxYearReportResponse> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years/${year}`);
  expect(res.status).toBe(200);
  expect(taxYearReportResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body as TaxYearReportResponse;
}

const taxMovements = (movements: CashMovement[]): CashMovement[] =>
  movements.filter((m) => m.kind === 'tax_withholding' || m.kind === 'tax_refund');

// ─── Settings → Taxes ─────────────────────────────────────────────────────────

describe('Settings → Taxes (V3-P4b)', () => {
  it('defaults to none and round-trips mode changes', async () => {
    const { agent } = await setup();

    const initial = await agent.get('/api/v1/settings/taxes');
    expect(initial.status).toBe(200);
    expect(taxSettingsResponseSchema.safeParse(initial.body).success).toBe(true);
    expect(initial.body).toEqual({ mode: 'none', country: null });

    const toAt = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'AT' });
    expect(toAt.status).toBe(200);
    expect(toAt.body).toEqual({ mode: 'country_specific', country: 'AT' });

    const readBack = await agent.get('/api/v1/settings/taxes');
    expect(readBack.body).toEqual({ mode: 'country_specific', country: 'AT' });

    const toManual = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'manual_per_trade' });
    expect(toManual.status).toBe(200);
    expect(toManual.body).toEqual({ mode: 'manual_per_trade', country: null });
  });

  it('rejects an inconsistent mode/country pair (contract-validated)', async () => {
    const { agent } = await setup();

    const missingCountry = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific' });
    expect(missingCountry.status).toBe(400);

    const strayCountry = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'manual_per_trade', country: 'AT' });
    expect(strayCountry.status).toBe(400);

    // Germany became a valid country in V5-P4 (#580) — probe with a genuinely
    // unshipped one to keep pinning the unknown-country rejection.
    const unknownCountry = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'FR' });
    expect(unknownCountry.status).toBe(400);
  });
});

// ─── none mode: the v2 regression ─────────────────────────────────────────────

describe('none mode is v2 behavior (regression)', () => {
  it('records buys/sells with zero tax artifacts', async () => {
    const { agent, pid, asset } = await setup();

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    const sell = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    // The wire shape is exactly v2's: no tax keys on transactions.
    expect(sell.body.transactions[0]).not.toHaveProperty('taxMode');
    expect(sell.body.transactions[0]).not.toHaveProperty('taxAmountEur');

    const cash = await cashState(agent, pid);
    // Only the sell_proceeds movement — never a tax settlement.
    expect(cash.movements.map((m) => m.kind)).toEqual(['sell_proceeds']);
    expect(cash.balanceEur).toBe(950);

    // The year report exists but holds zero tax.
    const years = await yearSummaries(agent, pid);
    expect(years).toHaveLength(1);
    expect(years[0]).toMatchObject({
      year: 2026,
      realizedPnlEur: 450,
      taxWithheldEur: 0,
      taxRefundedEur: 0,
      taxNetEur: 0,
    });
  });

  it('rejects manual tax entries and a bare cash source id, as v2 did', async () => {
    const { agent, pid, asset } = await setup();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });

    const withEntry = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'sell',
        quantity: 5,
        price: 12,
        executedAt: '2026-02-10T10:00:00.000Z',
        taxAmountEur: 5,
      },
      400,
    );
    expect(withEntry.body.error.code).toBe('TAX_ENTRY_NOT_ALLOWED');

    const main = (await cashState(agent, pid)).sources.find((s) => s.isMain)!;
    const bareSource = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'sell',
        quantity: 5,
        price: 12,
        executedAt: '2026-02-10T10:00:00.000Z',
        cashSourceId: main.id,
      },
      400,
    );
    expect(bareSource.body.error.code).toBe('CASH_FLAG_MISMATCH');
  });
});

// ─── country_specific (AT) ────────────────────────────────────────────────────

describe('AT mode: flat KESt with same-year offset (V3-P4b)', () => {
  it("owner's example: +450 € taxed, then a −100 € loss ⇒ year total = 27.5 % × 350 €, refund visible", async () => {
    const { agent, pid, asset } = await setup('country_specific');

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // Gain sell: 50·(19−10) = +450 → withhold 27.5 % = 123.75.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    let cash = await cashState(agent, pid);
    const withholding = taxMovements(cash.movements);
    expect(withholding).toHaveLength(1);
    expect(withholding[0]).toMatchObject({
      kind: 'tax_withholding',
      amountEur: -123.75,
      taxYear: 2026,
    });
    expect(cash.balanceEur).toBe(950 - 123.75);

    // Loss sell: 50·(8−10) = −100 → the year's net is 350, so the refund is
    // exactly 123.75 − 96.25 = 27.50, posted into the trade's cash source.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 8,
      executedAt: '2026-03-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    cash = await cashState(agent, pid);
    const settlements = taxMovements(cash.movements);
    expect(settlements).toHaveLength(2);
    const refund = settlements.find((m) => m.kind === 'tax_refund');
    expect(refund).toMatchObject({ kind: 'tax_refund', amountEur: 27.5, taxYear: 2026 });

    // Year total tax held = 27.5 % × 350 € = 96.25 €, to the cent.
    const years = await yearSummaries(agent, pid);
    expect(years).toEqual([
      {
        year: 2026,
        realizedPnlEur: 350,
        dividendsGrossEur: 0,
        taxWithheldEur: 123.75,
        taxRefundedEur: 27.5,
        taxNetEur: 96.25,
      },
    ]);

    // Reconciliation (§14): every balance is exactly the sum of movements.
    const expectedBalance = 950 - 123.75 + 400 + 27.5;
    expect(cash.balanceEur).toBe(expectedBalance);
    const main = cash.sources.find((s) => s.isMain)!;
    expect(main.balanceEur).toBe(expectedBalance);
    const bySum = cash.movements.reduce((sum, m) => sum + m.amountEur, 0);
    expect(Math.round(bySum * 100) / 100).toBe(expectedBalance);
  });

  it('November gain + February loss ⇒ NO offset (hard Jan-1 reset)', async () => {
    const { agent, pid, asset } = await setup('country_specific');

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2025-06-01T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2025-11-20T10:00:00.000Z',
      addProceedsToCash: true,
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 8,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });

    const cash = await cashState(agent, pid);
    const settlements = taxMovements(cash.movements);
    // The November withholding stands; the February loss refunds NOTHING.
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      kind: 'tax_withholding',
      amountEur: -123.75,
      taxYear: 2025,
    });

    const years = await yearSummaries(agent, pid);
    expect(years).toEqual([
      {
        year: 2026,
        realizedPnlEur: -100,
        dividendsGrossEur: 0,
        taxWithheldEur: 0,
        taxRefundedEur: 0,
        taxNetEur: 0,
      },
      {
        year: 2025,
        realizedPnlEur: 450,
        dividendsGrossEur: 0,
        taxWithheldEur: 123.75,
        taxRefundedEur: 0,
        taxNetEur: 123.75,
      },
    ]);
  });

  it('loss first parks in the pool: later same-year gains are taxed on the net', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-05T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 8,
      executedAt: '2026-02-05T10:00:00.000Z',
      addProceedsToCash: true,
    });
    // No tax held, nothing to refund.
    expect(taxMovements((await cashState(agent, pid)).movements)).toHaveLength(0);

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-03-05T10:00:00.000Z',
      addProceedsToCash: true,
    });
    const settlements = taxMovements((await cashState(agent, pid)).movements);
    // 27.5 % × (450 − 100) — the January loss offsets the March gain.
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ kind: 'tax_withholding', amountEur: -96.25 });
  });

  it('a sell without cash flags settles tax against Main (or the named source)', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // Fund Main so the withholding is solvent even though the proceeds stay
    // outside the ledger.
    const main = (await cashState(agent, pid)).sources.find((s) => s.isMain)!;
    await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 200, executedAt: '2026-01-15T10:00:00.000Z' });

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      cashSourceId: main.id,
    });
    const cash = await cashState(agent, pid);
    expect(cash.movements.map((m) => m.kind).sort()).toEqual(['deposit', 'tax_withholding']);
    expect(cash.balanceEur).toBe(200 - 123.75);

    // Without cash to withhold from, the sell is rejected — never negative.
    const insolvent = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'sell',
        quantity: 50,
        price: 19,
        executedAt: '2026-02-11T10:00:00.000Z',
      },
      400,
    );
    expect(insolvent.body.error.code).toBe('INSUFFICIENT_CASH');
  });

  it('backdated sells join THAT year’s pool and settle append-only', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2025-05-01T10:00:00.000Z',
    });
    // Recorded today, trade-dated last year: joins the 2025 pool.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2025-08-01T10:00:00.000Z',
      addProceedsToCash: true,
    });
    // A second backdated sell at a loss refunds within 2025.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 8,
      executedAt: '2025-09-01T10:00:00.000Z',
      addProceedsToCash: true,
    });

    const settlements = taxMovements((await cashState(agent, pid)).movements);
    expect(settlements.map((m) => [m.kind, m.amountEur, m.taxYear])).toEqual([
      ['tax_withholding', -123.75, 2025],
      ['tax_refund', 27.5, 2025],
    ]);
    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({ year: 2025, taxNetEur: 96.25 });
  });

  it('a backdated buy re-shapes an AT gain and posts an unattached correction', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    // Backdated buy BEFORE the sell lifts the average from 10 to 16.66…:
    // the sell's gain drops from 450 to 116.66…, target 32.08, so the year
    // refunds 123.75 − 32.08 = 91.67 as an unattached correction.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 50,
      price: 30,
      executedAt: '2026-01-20T10:00:00.000Z',
    });

    const cash = await cashState(agent, pid);
    const correction = cash.movements.find(
      (m) => m.kind === 'tax_refund' && m.transactionId === null && m.dividendId === null,
    );
    expect(correction).toMatchObject({ amountEur: 91.67, taxYear: 2026 });

    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({
      year: 2026,
      taxWithheldEur: 123.75,
      taxRefundedEur: 91.67,
      taxNetEur: 32.08,
    });
  });

  it('deleting a taxed sell re-settles its year with a correction', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    const gainSell = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 8,
      executedAt: '2026-03-10T10:00:00.000Z',
      addProceedsToCash: true,
    });

    // Deleting the gain sell cascades its proceeds + withholding; the loss
    // sell's earlier 27.50 refund no longer has a basis, so the year settles
    // back to €0.00 by clawing it back from Main.
    const gainSellId = gainSell.body.transactions[0].id as string;
    const del = await agent
      .delete(`/api/v1/portfolios/${pid}/transactions/${gainSellId}`)
      .set(...XRW);
    expect(del.status).toBe(204);

    const cash = await cashState(agent, pid);
    const correction = cash.movements.find(
      (m) => m.kind === 'tax_withholding' && m.transactionId === null,
    );
    expect(correction).toMatchObject({ amountEur: -27.5, taxYear: 2026 });

    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({
      year: 2026,
      realizedPnlEur: -100,
      taxWithheldEur: 27.5,
      taxRefundedEur: 27.5,
      taxNetEur: 0,
    });
  });

  it('rejects financial edits of taxed rows and of buys feeding taxed sells', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    const buy = await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    const sell = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    const sellId = sell.body.transactions[0].id as string;
    const buyId = buy.body.transactions[0].id as string;

    const editSell = await agent
      .patch(`/api/v1/portfolios/${pid}/transactions/${sellId}`)
      .set(...XRW)
      .send({ quantity: 40 });
    expect(editSell.status).toBe(400);
    expect(editSell.body.error.code).toBe('TRANSACTION_TAXED');

    const editBuy = await agent
      .patch(`/api/v1/portfolios/${pid}/transactions/${buyId}`)
      .set(...XRW)
      .send({ price: 11 });
    expect(editBuy.status).toBe(400);
    expect(editBuy.body.error.code).toBe('TRANSACTION_AFFECTS_TAXED');

    // Note-only edits stay allowed on both.
    const noteEdit = await agent
      .patch(`/api/v1/portfolios/${pid}/transactions/${sellId}`)
      .set(...XRW)
      .send({ note: 'sold before earnings' });
    expect(noteEdit.status).toBe(200);
  });

  it('rejects manual tax entries in AT mode (the engine owns the computation)', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    const res = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'sell',
        quantity: 5,
        price: 20,
        executedAt: '2026-02-10T10:00:00.000Z',
        addProceedsToCash: true,
        taxRatePct: 10,
      },
      400,
    );
    expect(res.body.error.code).toBe('TAX_ENTRY_NOT_ALLOWED');
  });
});

// ─── manual_per_trade ─────────────────────────────────────────────────────────

describe('manual per trade: recorded + reported, zero automation (V3-P4b)', () => {
  it('records an absolute amount and posts its withholding', async () => {
    const { agent, pid, asset } = await setup('manual_per_trade');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
      taxAmountEur: 12.34,
    });

    const cash = await cashState(agent, pid);
    const settlements = taxMovements(cash.movements);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      kind: 'tax_withholding',
      amountEur: -12.34,
      taxYear: 2026,
    });
    expect(cash.balanceEur).toBe(950 - 12.34);

    const report = await yearReport(agent, pid, 2026);
    expect(report.summary.taxNetEur).toBe(12.34);
    expect(report.positions[0]!.sells[0]).toMatchObject({
      taxMode: 'manual_per_trade',
      taxAmountEur: 12.34,
      realizedPnlEur: 450,
    });
  });

  it('applies a rate to the realized gain; a loss records €0.00 and no automation ever refunds', async () => {
    const { agent, pid, asset } = await setup('manual_per_trade');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // 10 % of the 450 gain.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
      taxRatePct: 10,
    });
    // A rate on a loss sell records zero tax and posts nothing.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 8,
      executedAt: '2026-03-10T10:00:00.000Z',
      addProceedsToCash: true,
      taxRatePct: 10,
    });

    const settlements = taxMovements((await cashState(agent, pid)).movements);
    expect(settlements.map((m) => m.amountEur)).toEqual([-45]);

    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({ taxWithheldEur: 45, taxRefundedEur: 0, taxNetEur: 45 });
  });

  it('records nothing when nothing was entered', async () => {
    const { agent, pid, asset } = await setup('manual_per_trade');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 5,
      price: 20,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    expect(taxMovements((await cashState(agent, pid)).movements)).toHaveLength(0);
    const report = await yearReport(agent, pid, 2026);
    expect(report.positions[0]!.sells[0]).toMatchObject({
      taxMode: 'manual_per_trade',
      taxAmountEur: null,
    });
  });

  it('rejects an entry on a buy and rejects amount+rate together', async () => {
    const { agent, pid, asset } = await setup('manual_per_trade');
    const onBuy = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 10,
        price: 10,
        executedAt: '2026-01-10T10:00:00.000Z',
        taxAmountEur: 5,
      },
      400,
    );
    expect(onBuy.body.error.code).toBe('TAX_ENTRY_INVALID');

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // Both amount and rate → contract-level 400.
    const both = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'sell',
        quantity: 5,
        price: 20,
        executedAt: '2026-02-10T10:00:00.000Z',
        taxAmountEur: 5,
        taxRatePct: 5,
      },
      400,
    );
    expect(both.status).toBe(400);
  });
});

// ─── Dividends ────────────────────────────────────────────────────────────────

describe('dividends land in a chosen cash source, tax-mode aware (V3-P4c)', () => {
  async function holdAsset(agent: Agent, pid: string, assetId: string) {
    await trade(agent, pid, {
      assetId,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
  }

  it('AT mode: the gross lands in the source and 27.5 % is withheld beside it', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    await holdAsset(agent, pid, asset.id);

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        grossAmountEur: 100,
        executedAt: '2026-04-01T10:00:00.000Z',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(createDividendResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.dividend).toMatchObject({
      taxMode: 'country_specific',
      taxCountry: 'AT',
      taxAmountEur: 27.5,
      grossAmountEur: 100,
    });
    expect(res.body.movements).toHaveLength(2);
    expect(res.body.sourceBalanceEur).toBe(72.5);
    expect(res.body.balanceEur).toBe(72.5);

    // Both movements sit in the source's history, linked to the dividend.
    const cash = await cashState(agent, pid);
    const dividendMovements = cash.movements.filter((m) => m.dividendId !== null);
    expect(dividendMovements.map((m) => [m.kind, m.amountEur])).toEqual([
      ['dividend', 100],
      ['tax_withholding', -27.5],
    ]);

    // …and the year report carries the dividend.
    const report = await yearReport(agent, pid, 2026);
    expect(report.summary).toMatchObject({
      dividendsGrossEur: 100,
      taxWithheldEur: 27.5,
      taxNetEur: 27.5,
    });
    expect(report.positions[0]!.dividends[0]).toMatchObject({
      grossAmountEur: 100,
      taxAmountEur: 27.5,
    });

    // The dividend list endpoint returns it, newest first.
    const list = await agent.get(`/api/v1/portfolios/${pid}/dividends`);
    expect(list.status).toBe(200);
    expect(dividendListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.dividends).toHaveLength(1);
  });

  it('a same-year realized loss offsets dividend tax (one pool)', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    await holdAsset(agent, pid, asset.id);
    // Loss of −100 parks in the 2026 pool.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 8,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    const res = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 60, executedAt: '2026-04-01T10:00:00.000Z' });
    expect(res.status).toBe(201);
    // Pool −100 + 60 = −40 → target €0.00 → no withholding at all.
    expect(res.body.dividend.taxAmountEur).toBe(0);
    expect(res.body.movements).toHaveLength(1);
    expect(res.body.movements[0].kind).toBe('dividend');
  });

  it('manual mode: the optional entry is recorded verbatim', async () => {
    const { agent, pid, asset } = await setup('manual_per_trade');
    await holdAsset(agent, pid, asset.id);
    const res = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        grossAmountEur: 80,
        executedAt: '2026-04-01T10:00:00.000Z',
        taxRatePct: 25,
      });
    expect(res.status).toBe(201);
    expect(res.body.dividend.taxAmountEur).toBe(20);
    expect(res.body.sourceBalanceEur).toBe(60);
  });

  it('none mode: the gross lands with zero tax artifacts', async () => {
    const { agent, pid, asset } = await setup();
    await holdAsset(agent, pid, asset.id);
    const res = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 100, executedAt: '2026-04-01T10:00:00.000Z' });
    expect(res.status).toBe(201);
    expect(res.body.dividend).toMatchObject({ taxMode: 'none', taxAmountEur: null });
    expect(res.body.movements).toHaveLength(1);
  });

  it('a named cash source receives the dividend; unheld assets are rejected', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    await holdAsset(agent, pid, asset.id);
    const created = await agent
      .post(`/api/v1/portfolios/${pid}/cash/sources`)
      .set(...XRW)
      .send({ name: 'Broker', type: 'bank' });
    expect(created.status).toBe(201);
    const sourceId = created.body.source.id as string;

    const res = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        grossAmountEur: 100,
        cashSourceId: sourceId,
        executedAt: '2026-04-01T10:00:00.000Z',
      });
    expect(res.status).toBe(201);
    const cash = await cashState(agent, pid);
    for (const movement of cash.movements) {
      expect(movement.sourceId).toBe(sourceId);
    }

    const unheld = await seedAsset('SAP.DE');
    const rejected = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: unheld.id, grossAmountEur: 100 });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('DIVIDEND_ASSET_NOT_HELD');
  });

  it('deleting an AT dividend cascades its movements and re-settles the year', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    await holdAsset(agent, pid, asset.id);
    const res = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 100, executedAt: '2026-04-01T10:00:00.000Z' });
    expect(res.status).toBe(201);
    const dividendId = res.body.dividend.id as string;

    const del = await agent.delete(`/api/v1/portfolios/${pid}/dividends/${dividendId}`).set(...XRW);
    expect(del.status).toBe(204);

    const cash = await cashState(agent, pid);
    expect(cash.movements).toHaveLength(0);
    expect(cash.balanceEur).toBe(0);
    const years = await yearSummaries(agent, pid);
    expect(years.find((y) => y.year === 2026)?.taxNetEur ?? 0).toBe(0);
  });
});

// ─── Mode-switch cutover (§16 2026-07-08) ─────────────────────────────────────

describe('mode switches apply forward only (cutover semantics)', () => {
  it('never rewrites rows recorded under an earlier mode', async () => {
    const { agent, pid, asset } = await setup();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // Recorded under none: never taxed, even retroactively.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });

    const toAt = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'AT' });
    expect(toAt.status).toBe(200);

    // The switch alone re-taxes nothing.
    expect(taxMovements((await cashState(agent, pid)).movements)).toHaveLength(0);

    // A new sell (gain 50·(12−10) = 100) is taxed — but the pool contains
    // ONLY it: the pre-switch +450 gain never enters (27.5 % × 100 = 27.50).
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 12,
      executedAt: '2026-03-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    const settlements = taxMovements((await cashState(agent, pid)).movements);
    expect(settlements.map((m) => m.amountEur)).toEqual([-27.5]);

    // The year report shows the full financial truth (550 realized) next to
    // the tax truth (only the AT-recorded row settled).
    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({ realizedPnlEur: 550, taxNetEur: 27.5 });

    // Switching back to none stops taxing new sells; history stands.
    const toNone = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'none' });
    expect(toNone.status).toBe(200);
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 10,
      executedAt: '2026-04-01T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 15,
      executedAt: '2026-04-02T10:00:00.000Z',
      addProceedsToCash: true,
    });
    expect(taxMovements((await cashState(agent, pid)).movements)).toHaveLength(1);
  });
});

// ─── Uncovered sell (issue #369) ──────────────────────────────────────────────

/** The held quantity of one asset from the portfolio overview (0 when closed). */
async function heldQuantity(agent: Agent, pid: string, assetId: string): Promise<number> {
  const res = await agent.get(`/api/v1/portfolios/${pid}`);
  expect(res.status).toBe(200);
  const holdings = res.body.holdings as Array<{ asset: { id: string }; quantity: number }>;
  return holdings.find((h) => h.asset.id === assetId)?.quantity ?? 0;
}

describe('uncovered sell — sell a stock you do not hold (issue #369)', () => {
  it('rejects an oversell without the acknowledgment (unchanged OVERSELL guard)', async () => {
    const { agent, pid, asset } = await setup();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 2,
      price: 40,
      executedAt: '2026-01-01T10:00:00.000Z',
    });
    const res = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'sell',
        quantity: 10,
        price: 100,
        executedAt: '2026-01-02T10:00:00.000Z',
      },
      400,
    );
    expect(res.body.error.code).toBe('OVERSELL');
  });

  it('accepts an acknowledged uncovered sell: closes at 0, books full proceeds to cash', async () => {
    const { agent, pid, asset } = await setup();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 2,
      price: 40,
      executedAt: '2026-01-01T10:00:00.000Z',
    });
    const res = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 100,
      executedAt: '2026-01-02T10:00:00.000Z',
      allowUncovered: true,
      addProceedsToCash: true,
    });
    // The stored row carries the acknowledgment; option A leaves the basis null.
    expect(res.body.transactions[0]).toMatchObject({
      allowUncovered: true,
      uncoveredEntryPrice: null,
    });
    // No shorts: the position closes at exactly 0.
    expect(await heldQuantity(agent, pid, asset.id)).toBe(0);
    // Cash added normally: the full proceeds (10·100) land in the ledger.
    expect((await cashState(agent, pid)).balanceEur).toBe(1000);
  });

  it('AT mode, option A (0 %): a zero-holding uncovered sell books NO phantom gain or tax', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    // Sell 100 with nothing held, counted at 0 % → basis = sale price → 0 gain.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 100,
      price: 100,
      executedAt: '2026-05-10T10:00:00.000Z',
      allowUncovered: true,
      addProceedsToCash: true,
    });
    // The AT ledger must not misreport a fabricated gain: no withholding at all.
    const cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements)).toHaveLength(0);
    expect(cash.balanceEur).toBe(10000);

    const years = await yearSummaries(agent, pid);
    expect(years).toEqual([
      {
        year: 2026,
        realizedPnlEur: 0,
        dividendsGrossEur: 0,
        taxWithheldEur: 0,
        taxRefundedEur: 0,
        taxNetEur: 0,
      },
    ]);
    const report = await yearReport(agent, pid, 2026);
    // The report prices the uncovered shares at their proceeds → 0 realized.
    expect(report.positions[0]!.sells[0]).toMatchObject({
      proceedsEur: 10000,
      costBasisEur: 10000,
      realizedPnlEur: 0,
    });
  });

  it('AT mode, option B: a user-supplied buy-in price is taxed as a real gain', async () => {
    const { agent, pid, asset } = await setup('country_specific');
    // Sell 100 @ 100 uncovered, user states a 60 buy-in → gain 100·(100−60)=4000.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 100,
      price: 100,
      executedAt: '2026-06-10T10:00:00.000Z',
      allowUncovered: true,
      uncoveredEntryPrice: 60,
      addProceedsToCash: true,
    });
    const cash = await cashState(agent, pid);
    const withholding = taxMovements(cash.movements);
    expect(withholding).toHaveLength(1);
    // 27.5 % × 4000 = 1100.
    expect(withholding[0]).toMatchObject({
      kind: 'tax_withholding',
      amountEur: -1100,
      taxYear: 2026,
    });

    const years = await yearSummaries(agent, pid);
    expect(years).toEqual([
      {
        year: 2026,
        realizedPnlEur: 4000,
        dividendsGrossEur: 0,
        taxWithheldEur: 1100,
        taxRefundedEur: 0,
        taxNetEur: 1100,
      },
    ]);
    // Cash = 10000 proceeds − 1100 tax.
    expect(cash.balanceEur).toBe(10000 - 1100);
  });

  it('rejects the uncovered fields on a buy (contract-guarded)', async () => {
    const { agent, pid, asset } = await setup();
    const res = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 10,
        executedAt: '2026-01-01T10:00:00.000Z',
        allowUncovered: true,
      },
      400,
    );
    expect(res.body.error.code).toBeDefined();
  });
});
