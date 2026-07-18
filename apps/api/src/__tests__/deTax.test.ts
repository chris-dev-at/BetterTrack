import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createDividendResponseSchema,
  taxYearListResponseSchema,
  taxYearReportResponseSchema,
  type CashMovement,
  type TaxYearReportResponse,
  type TaxYearSummary,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * V5-P4 German tax engine end-to-end (issue #580): the #576 fixture scenarios
 * over the HTTP surface — FIFO lot consumption (provably ≠ moving average),
 * the Sparer-Pauschbetrag walk, the Aktien ring-fence, the Sonstige
 * cross-offset with an intra-year refund, pot carry across the year boundary,
 * the AT→DE mid-year cutover (forward-only, both regimes coexisting in one
 * year), delete-and-re-add re-settlement, and the backdated-loss ripple into
 * a later year's pots. EUR assets throughout, so every cent asserts exactly.
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

/** Seed a global EUR asset row directly; `type` drives the DE pot category. */
async function seedAsset(symbol: string, type: 'stock' | 'etf' = 'stock') {
  const [row] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type,
      symbol,
      name: `${symbol} Test`,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  if (!row) throw new Error('Failed to seed asset');
  return row;
}

/** One logged-in DE-mode user with their default portfolio and a stock asset. */
async function setupDe() {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const pid = await defaultPortfolioId(agent);
  const asset = await seedAsset('BAYN.DE');
  const res = await agent
    .patch('/api/v1/settings/taxes')
    .set(...XRW)
    .send({ mode: 'country_specific', country: 'DE' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ mode: 'country_specific', country: 'DE' });
  return { user, agent, pid, asset };
}

async function trade(agent: Agent, pid: string, body: Record<string, unknown>) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res;
}

async function dividend(agent: Agent, pid: string, body: Record<string, unknown>) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/dividends`)
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(createDividendResponseSchema.safeParse(res.body).success).toBe(true);
  return res;
}

async function cashMovements(agent: Agent, pid: string): Promise<CashMovement[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash`);
  expect(res.status).toBe(200);
  return res.body.movements as CashMovement[];
}

async function yearSummaries(agent: Agent, pid: string): Promise<TaxYearSummary[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years`);
  expect(res.status).toBe(200);
  expect(taxYearListResponseSchema.safeParse(res.body).success, JSON.stringify(res.body)).toBe(
    true,
  );
  return res.body.years as TaxYearSummary[];
}

async function yearReport(agent: Agent, pid: string, year: number): Promise<TaxYearReportResponse> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years/${year}`);
  expect(res.status).toBe(200);
  expect(taxYearReportResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body as TaxYearReportResponse;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

describe('Settings → Taxes accepts Germany (V5-P4)', () => {
  it('round-trips DE and switches AT ↔ DE', async () => {
    const { agent } = await setupDe();

    const readBack = await agent.get('/api/v1/settings/taxes');
    expect(readBack.body).toEqual({ mode: 'country_specific', country: 'DE' });

    const toAt = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'AT' });
    expect(toAt.status).toBe(200);
    expect(toAt.body).toEqual({ mode: 'country_specific', country: 'AT' });

    const backToDe = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'DE' });
    expect(backToDe.status).toBe(200);
    expect(backToDe.body).toEqual({ mode: 'country_specific', country: 'DE' });
  });

  it('rejects manual tax entries in DE mode (the engine owns the computation)', async () => {
    const { agent, pid, asset } = await setupDe();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 100,
      executedAt: '2024-02-05T12:00:00.000Z',
    });
    const res = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'sell',
        quantity: 10,
        price: 600,
        executedAt: '2024-09-12T12:00:00.000Z',
        taxAmountEur: 5,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TAX_ENTRY_NOT_ALLOWED');
  });
});

// ─── #576 S1: simple gain — allowance, then 25 % + Soli ───────────────────────

describe('DE mode: 25 % Abgeltungsteuer + 5.5 % Soli after the €1,000 allowance', () => {
  it('S1: one lot, fees on both legs — €1,052.36 withheld, DE block derived', async () => {
    const { agent, pid, asset } = await setupDe();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 100,
      fee: 5,
      executedAt: '2024-02-05T12:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 600,
      fee: 5,
      executedAt: '2024-09-12T12:00:00.000Z',
      addProceedsToCash: true,
    });

    const movements = await cashMovements(agent, pid);
    const withholding = movements.find((m) => m.kind === 'tax_withholding');
    expect(withholding).toMatchObject({
      amountEur: -1052.36,
      taxYear: 2024,
      note: 'KapESt + Soli withheld (DE)',
    });

    const years = await yearSummaries(agent, pid);
    expect(years).toHaveLength(1);
    expect(years[0]).toMatchObject({
      year: 2024,
      realizedPnlEur: 4990,
      taxWithheldEur: 1052.36,
      taxRefundedEur: 0,
      taxNetEur: 1052.36,
      de: {
        allowanceUsedEur: 1000,
        allowanceRemainingEur: 0,
        aktienPotInEur: 0,
        aktienPotOutEur: 0,
        sonstigePotInEur: 0,
        sonstigePotOutEur: 0,
        kapestEur: 997.5,
        soliEur: 54.86,
      },
    });

    // The drill-down states the FIFO basis (buy fee capitalized, sell fee off
    // the proceeds) next to the frozen row tax.
    const report = await yearReport(agent, pid, 2024);
    expect(report.positions[0]!.sells[0]).toMatchObject({
      proceedsEur: 5995,
      costBasisEur: 1005,
      realizedPnlEur: 4990,
      taxMode: 'country_specific',
      taxAmountEur: 1052.36,
    });
  });

  it('S3: dividends walk the allowance down — 0, then 79.12, then 105.50', async () => {
    const { agent, pid, asset } = await setupDe();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 100,
      executedAt: '2025-01-05T12:00:00.000Z',
    });

    const d1 = await dividend(agent, pid, {
      assetId: asset.id,
      grossAmountEur: 600,
      executedAt: '2025-03-14T12:00:00.000Z',
    });
    expect(d1.body.dividend).toMatchObject({ taxCountry: 'DE', taxAmountEur: 0 });
    expect(d1.body.movements).toHaveLength(1); // gross only — inside the allowance

    const d2 = await dividend(agent, pid, {
      assetId: asset.id,
      grossAmountEur: 700,
      executedAt: '2025-06-16T12:00:00.000Z',
    });
    expect(d2.body.dividend.taxAmountEur).toBe(79.12);

    const d3 = await dividend(agent, pid, {
      assetId: asset.id,
      grossAmountEur: 400,
      executedAt: '2025-09-15T12:00:00.000Z',
    });
    expect(d3.body.dividend.taxAmountEur).toBe(105.5);

    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({
      year: 2025,
      dividendsGrossEur: 1700,
      taxWithheldEur: 184.62,
      taxNetEur: 184.62,
      de: { allowanceUsedEur: 1000, allowanceRemainingEur: 0, kapestEur: 175, soliEur: 9.62 },
    });
  });
});

// ─── #576 S2: FIFO, provably not the moving average ───────────────────────────

describe('DE mode uses FIFO lot consumption (§20 Abs. 4 Satz 7 EStG)', () => {
  it('S2: two lots, partial sells — deltas 1,846.25 and 131.87, never the moving-average 6,000 total', async () => {
    const { agent, pid, asset } = await setupDe();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 100,
      executedAt: '2024-01-10T12:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 200,
      executedAt: '2024-03-15T12:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 100,
      price: 180,
      executedAt: '2024-06-20T12:00:00.000Z',
      addProceedsToCash: true,
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 210,
      executedAt: '2024-11-05T12:00:00.000Z',
      addProceedsToCash: true,
    });

    const report = await yearReport(agent, pid, 2024);
    const sells = report.positions[0]!.sells;
    // The stated realizations are the FIFO ones (+8,000 then +500 — the moving
    // average would say +3,000/+3,000), each frozen with its marginal delta.
    expect(sells.map((s) => s.realizedPnlEur)).toEqual([8000, 500]);
    expect(sells.map((s) => s.taxAmountEur)).toEqual([1846.25, 131.87]);
    expect(report.summary).toMatchObject({ realizedPnlEur: 8500, taxNetEur: 1978.12 });
  });
});

// ─── #576 S4 + S5: the two loss pots ──────────────────────────────────────────

describe('DE loss pots: Aktien ring-fence and Sonstige cross-offset', () => {
  it('S4: an Aktien loss never offsets a dividend — the loss carries out instead', async () => {
    const { agent, pid, asset } = await setupDe();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 300,
      executedAt: '2024-01-08T12:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 150,
      executedAt: '2024-05-20T12:00:00.000Z',
      addProceedsToCash: true,
    });
    // The loss parks in the Aktien pot: no refund, no tax movement at all yet.
    const afterLoss = await cashMovements(agent, pid);
    expect(afterLoss.every((m) => m.kind !== 'tax_withholding' && m.kind !== 'tax_refund')).toBe(
      true,
    );

    const div = await dividend(agent, pid, {
      assetId: asset.id,
      grossAmountEur: 2000,
      executedAt: '2024-07-01T12:00:00.000Z',
    });
    // Ring-fenced: the dividend is taxed over the allowance despite the pot.
    expect(div.body.dividend.taxAmountEur).toBe(263.75);

    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({
      year: 2024,
      taxNetEur: 263.75,
      de: {
        aktienPotOutEur: 1500,
        sonstigePotOutEur: 0,
        allowanceUsedEur: 1000,
        kapestEur: 250,
        soliEur: 13.75,
      },
    });
  });

  it('S5: an ETF (Sonstige) loss offsets dividends AND Aktien gains, refunding mid-year', async () => {
    const { agent, pid, asset } = await setupDe();
    const etf = await seedAsset('IWDA.AS', 'etf');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 100,
      executedAt: '2024-01-05T12:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: etf.id,
      side: 'buy',
      quantity: 20,
      price: 150,
      executedAt: '2024-02-01T12:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 400,
      executedAt: '2024-04-10T12:00:00.000Z',
      addProceedsToCash: true,
    });
    let movements = await cashMovements(agent, pid);
    expect(movements.find((m) => m.kind === 'tax_withholding')).toMatchObject({
      amountEur: -527.5,
      taxYear: 2024,
    });

    const div = await dividend(agent, pid, {
      assetId: asset.id,
      grossAmountEur: 500,
      executedAt: '2024-05-15T12:00:00.000Z',
    });
    expect(div.body.dividend.taxAmountEur).toBe(131.87);

    // The ETF loss lands after €659.37 was withheld → intra-year refund.
    await trade(agent, pid, {
      assetId: etf.id,
      side: 'sell',
      quantity: 20,
      price: 90,
      executedAt: '2024-08-19T12:00:00.000Z',
      addProceedsToCash: true,
    });
    movements = await cashMovements(agent, pid);
    const refund = movements.find((m) => m.kind === 'tax_refund');
    expect(refund).toMatchObject({
      amountEur: 316.5,
      taxYear: 2024,
      note: 'KapESt + Soli refunded (DE)',
    });

    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({
      year: 2024,
      taxWithheldEur: 659.37,
      taxRefundedEur: 316.5,
      taxNetEur: 342.87,
      de: { aktienPotOutEur: 0, sonstigePotOutEur: 0, kapestEur: 325, soliEur: 17.87 },
    });
  });
});

// ─── #576 S7: year boundary — pots carry, the allowance resets ────────────────

describe('DE year boundary: pots carry forward, the Sparer-Pauschbetrag does not', () => {
  it('S7: a pure-loss 2024 feeds 2025 pots; 2025 taxes €79.12 on a fresh allowance', async () => {
    const { agent, pid, asset } = await setupDe();
    const etf = await seedAsset('IWDA.AS', 'etf');
    // 2024: Aktien −800 and Sonstige −300, both parking (deltas 0).
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 200,
      executedAt: '2024-02-12T12:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: etf.id,
      side: 'buy',
      quantity: 10,
      price: 100,
      executedAt: '2024-03-05T12:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 120,
      executedAt: '2024-06-10T12:00:00.000Z',
      addProceedsToCash: true,
    });
    await trade(agent, pid, {
      assetId: etf.id,
      side: 'sell',
      quantity: 10,
      price: 70,
      executedAt: '2024-10-14T12:00:00.000Z',
      addProceedsToCash: true,
    });
    // 2025: +2,000 Aktien gain and a €400 dividend against the carried pots.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 5,
      price: 100,
      executedAt: '2025-01-20T12:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 5,
      price: 500,
      executedAt: '2025-05-11T12:00:00.000Z',
      addProceedsToCash: true,
    });
    // Pot + cross-offset + fresh allowance absorb the gain entirely.
    const afterGain = await cashMovements(agent, pid);
    expect(afterGain.every((m) => m.kind !== 'tax_withholding' && m.kind !== 'tax_refund')).toBe(
      true,
    );
    const div = await dividend(agent, pid, {
      assetId: asset.id,
      grossAmountEur: 400,
      executedAt: '2025-06-15T12:00:00.000Z',
    });
    expect(div.body.dividend.taxAmountEur).toBe(79.12);

    const years = await yearSummaries(agent, pid);
    const y2024 = years.find((y) => y.year === 2024)!;
    const y2025 = years.find((y) => y.year === 2025)!;
    expect(y2024).toMatchObject({
      taxNetEur: 0,
      de: {
        aktienPotOutEur: 800,
        sonstigePotOutEur: 300,
        allowanceUsedEur: 0,
        allowanceRemainingEur: 1000, // unused — and LOST, never carried
      },
    });
    expect(y2025).toMatchObject({
      taxNetEur: 79.12,
      de: {
        aktienPotInEur: 800,
        sonstigePotInEur: 300,
        aktienPotOutEur: 0,
        sonstigePotOutEur: 0,
        allowanceUsedEur: 1000, // a FRESH €1,000, not 2024's leftover on top
        kapestEur: 75,
        soliEur: 4.12,
      },
    });
  });
});

// ─── Cutover: AT → DE mid-year, forward-only (§16) ────────────────────────────

describe('switching AT→DE mid-year applies forward only', () => {
  it('frozen AT rows keep their tax; new rows settle under DE FIFO; one year carries both', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset('BAYN.DE');

    // AT era: +450 gain withholds 27.5 % × 450 = 123.75.
    await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'AT' });
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
    let movements = await cashMovements(agent, pid);
    expect(movements.find((m) => m.kind === 'tax_withholding')).toMatchObject({
      amountEur: -123.75,
      note: 'KESt withheld (AT)',
    });

    // The switch — forward-only by construction.
    const toDe = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'DE' });
    expect(toDe.status).toBe(200);

    // DE era: a second lot at 12, then a partial sell of 100 @ 40.
    // FIFO basis: 50 remaining @ 10 + 50 @ 12 = 1,100 → P/L 2,900 → after the
    // €1,000 allowance: KapESt 475.00 + Soli 26.12 = 501.12. (The moving
    // average would realize 2,866.67 → 492.32 — must NOT happen.)
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 12,
      executedAt: '2026-03-10T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 100,
      price: 40,
      executedAt: '2026-04-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    movements = await cashMovements(agent, pid);
    const deWithholding = movements.find(
      (m) => m.kind === 'tax_withholding' && m.note === 'KapESt + Soli withheld (DE)',
    );
    expect(deWithholding).toMatchObject({ amountEur: -501.12, taxYear: 2026 });

    // The AT row is untouched — its frozen tax sits beside the DE row's.
    const report = await yearReport(agent, pid, 2026);
    const sells = report.positions[0]!.sells;
    expect(sells[0]).toMatchObject({ taxAmountEur: 123.75, realizedPnlEur: 450 }); // AT, Feb
    expect(sells[1]).toMatchObject({ taxAmountEur: 501.12, realizedPnlEur: 2900 }); // DE, Apr (FIFO)

    // One year, both regimes: held = AT target + DE target.
    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({
      year: 2026,
      taxWithheldEur: 624.87,
      taxRefundedEur: 0,
      taxNetEur: 624.87,
      de: { allowanceUsedEur: 1000, kapestEur: 475, soliEur: 26.12 },
    });

    // The switch itself never re-taxed the frozen AT row: no unattached
    // correction movement exists anywhere.
    movements = await cashMovements(agent, pid);
    const corrections = movements.filter(
      (m) => (m.kind === 'tax_withholding' || m.kind === 'tax_refund') && m.transactionId === null,
    );
    expect(corrections).toHaveLength(0);
  });

  it('a DE dividend backdated below a frozen-AT year replays that year for the ripple', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const pid = await defaultPortfolioId(agent);
    const asset = await seedAsset('BAYN.DE');

    // AT era: buy 2025, sell 2026 → frozen AT withholding 27.5 % × 450 = 123.75.
    await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'AT' });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2025-01-10T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });

    await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode: 'country_specific', country: 'DE' });

    // Backdated into 2025 — below the AT sell's year, so the DE ripple visits
    // 2026 and needs that AT sell's realization replayed (this exact shape
    // used to 500 with "Tax engine: no realization for AT sell").
    // 2,000 − 1,000 allowance → KapESt 250.00 + Soli 13.75 = 263.75.
    const div = await dividend(agent, pid, {
      assetId: asset.id,
      grossAmountEur: 2000,
      executedAt: '2025-07-01T12:00:00.000Z',
    });
    expect(div.body.dividend.taxAmountEur).toBe(263.75);

    const movements = await cashMovements(agent, pid);
    const withheld = movements
      .filter((m) => m.kind === 'tax_withholding')
      .map((m) => [m.amountEur, m.taxYear]);
    expect(withheld).toEqual(
      expect.arrayContaining([
        [-263.75, 2025],
        [-123.75, 2026],
      ]),
    );
    // 2026's combined target did not move (its DE component is 0): the ripple
    // settles to a zero delta and posts no unattached correction.
    const unattached = movements.filter(
      (m) =>
        (m.kind === 'tax_withholding' || m.kind === 'tax_refund') &&
        m.transactionId === null &&
        m.dividendId === null,
    );
    expect(unattached).toHaveLength(0);

    const years = await yearSummaries(agent, pid);
    expect(years.find((y) => y.year === 2025)).toMatchObject({
      taxNetEur: 263.75,
      de: { allowanceUsedEur: 1000, kapestEur: 250, soliEur: 13.75 },
    });
    const y2026 = years.find((y) => y.year === 2026)!;
    expect(y2026.taxNetEur).toBe(123.75);
    expect(y2026.de).toBeUndefined();
  });
});

// ─── Delete-and-re-add + the downstream ripple ────────────────────────────────

describe('DE settlements derive append-only from rows + movements', () => {
  it('S8 + delete/re-add: removing the DE gain sell claws the loss refund back; re-adding re-settles', async () => {
    const { agent, pid, asset } = await setupDe();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 20,
      price: 100,
      executedAt: '2025-01-15T12:00:00.000Z',
    });
    const gainBody = {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 300,
      executedAt: '2025-03-10T12:00:00.000Z',
      addProceedsToCash: true,
    };
    const gain = await trade(agent, pid, gainBody);
    let movements = await cashMovements(agent, pid);
    expect(movements.find((m) => m.kind === 'tax_withholding')).toMatchObject({
      amountEur: -263.75,
      taxYear: 2025,
    });

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 25,
      executedAt: '2025-09-22T12:00:00.000Z',
      addProceedsToCash: true,
    });
    // §43a Abs. 3 Satz 2: the later loss refunds already-withheld tax.
    movements = await cashMovements(agent, pid);
    expect(movements.find((m) => m.kind === 'tax_refund')).toMatchObject({
      amountEur: 197.82,
      taxYear: 2025,
      note: 'KapESt + Soli refunded (DE)',
    });

    // Delete the GAIN sell: its withholding cascades away with it, but the
    // surviving loss's 197.82 refund has no basis anymore — the year
    // re-settles to €0 (the loss parks in the pot) via an unattached DE
    // correction clawing the refund back.
    const gainId = gain.body.transactions[0].id as string;
    const del = await agent.delete(`/api/v1/portfolios/${pid}/transactions/${gainId}`).set(...XRW);
    expect(del.status).toBe(204);

    movements = await cashMovements(agent, pid);
    const correction = movements.find(
      (m) => m.kind === 'tax_withholding' && m.transactionId === null,
    );
    expect(correction).toMatchObject({
      amountEur: -197.82,
      taxYear: 2025,
      note: 'Tax year correction (DE)',
    });
    let years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({ taxNetEur: 0 });
    expect(years[0]!.de).toMatchObject({ aktienPotOutEur: 750 });

    // Re-adding the identical gain re-settles against the year as it now is —
    // the loss already offsets it, so the row settles the S8 year target of
    // €65.93 directly, and the year lands exactly there.
    await trade(agent, pid, gainBody);
    years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({
      taxNetEur: 65.93,
      de: { allowanceUsedEur: 1000, kapestEur: 62.5, soliEur: 3.43, aktienPotOutEur: 0 },
    });
  });

  it('a backdated loss into a prior year re-carries the pots and refunds the later year', async () => {
    const { agent, pid, asset } = await setupDe();
    // 2024: one 20 @ 200 lot, one −800 loss → pot out 800.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 20,
      price: 200,
      executedAt: '2024-01-10T12:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 120,
      executedAt: '2024-06-10T12:00:00.000Z',
      addProceedsToCash: true,
    });
    // 2025: +3,000 gain − 800 pot − 1,000 allowance → base 1,200 → 316.50.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 5,
      price: 800,
      executedAt: '2025-04-10T12:00:00.000Z',
      addProceedsToCash: true,
    });
    const beforeBackdate = await cashMovements(agent, pid);
    expect(beforeBackdate.find((m) => m.kind === 'tax_withholding')).toMatchObject({
      amountEur: -316.5,
      taxYear: 2025,
    });

    // NOW record a sell backdated into 2024: another −500 loss. Its own year
    // stays at €0 (delta 0 on the row), but 2024's pot-out grows to 1,300 —
    // and 2025 must re-settle DOWN via an unattached correction:
    // 3,000 − 1,300 − 1,000 = 700 → KapESt 175.00 + Soli 9.62 = 184.62,
    // refunding 316.50 − 184.62 = 131.88.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 5,
      price: 100,
      executedAt: '2024-08-10T12:00:00.000Z',
      addProceedsToCash: true,
    });

    const movements = await cashMovements(agent, pid);
    // The backdated loss row itself settles €0 — no attached tax movement.
    const attachedTax = movements.filter(
      (m) => (m.kind === 'tax_withholding' || m.kind === 'tax_refund') && m.transactionId !== null,
    );
    expect(attachedTax.map((m) => m.amountEur)).toEqual([-316.5]);
    const rippleRefund = movements.find((m) => m.kind === 'tax_refund' && m.transactionId === null);
    expect(rippleRefund).toMatchObject({
      amountEur: 131.88,
      taxYear: 2025,
      note: 'Tax year correction (DE)',
    });

    const years = await yearSummaries(agent, pid);
    const y2024 = years.find((y) => y.year === 2024)!;
    const y2025 = years.find((y) => y.year === 2025)!;
    expect(y2024.de).toMatchObject({ aktienPotOutEur: 1300 });
    expect(y2024.taxNetEur).toBe(0);
    expect(y2025).toMatchObject({ taxNetEur: 184.62 });
    expect(y2025.de).toMatchObject({ aktienPotInEur: 1300, kapestEur: 175, soliEur: 9.62 });
  });

  it('deleting a DE dividend re-settles its year (movements cascade)', async () => {
    const { agent, pid, asset } = await setupDe();
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 100,
      executedAt: '2025-01-05T12:00:00.000Z',
    });
    const div = await dividend(agent, pid, {
      assetId: asset.id,
      grossAmountEur: 1500,
      executedAt: '2025-04-01T12:00:00.000Z',
    });
    // 1,500 − 1,000 allowance → KapESt 125.00 + Soli 6.87 = 131.87.
    expect(div.body.dividend.taxAmountEur).toBe(131.87);

    const del = await agent
      .delete(`/api/v1/portfolios/${pid}/dividends/${div.body.dividend.id}`)
      .set(...XRW);
    expect(del.status).toBe(204);

    const movements = await cashMovements(agent, pid);
    expect(movements).toHaveLength(0);
    const years = await yearSummaries(agent, pid);
    expect(years.find((y) => y.year === 2025)?.taxNetEur ?? 0).toBe(0);
  });
});
