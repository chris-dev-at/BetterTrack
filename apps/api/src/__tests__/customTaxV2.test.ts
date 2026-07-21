import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  cashMovementsResponseSchema,
  taxSettingsResponseSchema,
  taxYearListResponseSchema,
  type CashMovement,
  type CustomTaxParams,
  type TaxYearSummary,
  type UpdateTaxSettingsRequest,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * V5-P4c tax v2 (issue #584) end-to-end over the HTTP surface: the manual
 * mode's configurable default (prefilled server-side where no explicit entry
 * arrives, editable per trade) and the custom rule-built mode — settings
 * round-trips, the AT-parameter-set parity example, per-row parameter
 * freezing with forward-only switches, regime coexistence, append-only
 * delete/re-add settlement, and the FIFO/moving-average divergence. EUR
 * assets throughout, so every cent asserts exactly.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/** AT expressed as a custom parameter set (must reproduce the AT engine). */
const AT_PARAMS: CustomTaxParams = {
  ratePct: 27.5,
  lossOffset: true,
  refund: true,
  yearReset: true,
  carryForward: false,
  costBasis: 'moving-average',
};

const RATE10: CustomTaxParams = { ...AT_PARAMS, ratePct: 10 };

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

async function patchTaxSettings(agent: Agent, body: UpdateTaxSettingsRequest, expected = 200) {
  const res = await agent
    .patch('/api/v1/settings/taxes')
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(expected);
  if (expected === 200) {
    expect(taxSettingsResponseSchema.safeParse(res.body).success).toBe(true);
  }
  return res;
}

async function setup(taxBody?: UpdateTaxSettingsRequest, tag = '') {
  const user = await harness.seedUser(
    tag ? { email: `${tag}@bettertrack.test`, username: `user-${tag}` } : {},
  );
  const agent = await loginAgent(harness.app, user.email, user.password);
  const pid = await defaultPortfolioId(agent);
  const asset = await seedAsset(tag ? `${tag.toUpperCase()}.DE` : undefined);
  if (taxBody) await patchTaxSettings(agent, taxBody);
  return { user, agent, pid, asset };
}

async function trade(agent: Agent, pid: string, body: Record<string, unknown>, expected = 201) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(expected);
  return res;
}

async function cashState(agent: Agent, pid: string) {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash`);
  expect(res.status).toBe(200);
  expect(cashMovementsResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body as { balanceEur: number; movements: CashMovement[] };
}

const taxMovements = (movements: CashMovement[]): CashMovement[] =>
  movements.filter((m) => m.kind === 'tax_withholding' || m.kind === 'tax_refund');

async function yearSummaries(agent: Agent, pid: string): Promise<TaxYearSummary[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years`);
  expect(res.status).toBe(200);
  expect(taxYearListResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body.years as TaxYearSummary[];
}

/** The frozen tax columns of one stored transaction row. */
async function frozenRow(txId: string) {
  const rows = await harness.db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, txId));
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  return {
    taxMode: row.taxMode,
    taxCountry: row.taxCountry,
    taxAmountEur: row.taxAmountEur === null ? null : Number(row.taxAmountEur),
    taxParams: row.taxParams,
  };
}

// ─── Settings: manual default + custom parameter set ─────────────────────────

describe('Settings → Taxes: manual default + custom mode (V5-P4c)', () => {
  it('round-trips the custom parameter set and clears it on a mode switch', async () => {
    const { agent } = await setup();

    const toCustom = await patchTaxSettings(agent, { mode: 'custom', custom: RATE10 });
    expect(toCustom.body).toEqual({ mode: 'custom', country: null, custom: RATE10 });

    const readBack = await agent.get('/api/v1/settings/taxes');
    expect(readBack.body).toEqual({ mode: 'custom', country: null, custom: RATE10 });

    // Switching away drops the params; the response is byte-identical pre-V5-P4.
    await patchTaxSettings(agent, { mode: 'none' });
    const asNone = await agent.get('/api/v1/settings/taxes');
    expect(asNone.body).toEqual({ mode: 'none', country: null });
  });

  it('round-trips the manual default and keeps blank-default responses byte-identical', async () => {
    const { agent } = await setup();

    const blank = await patchTaxSettings(agent, { mode: 'manual_per_trade' });
    expect(blank.body).toEqual({ mode: 'manual_per_trade', country: null });

    const withAmount = await patchTaxSettings(agent, {
      mode: 'manual_per_trade',
      manualDefaultAmountEur: 5,
    });
    expect(withAmount.body).toEqual({
      mode: 'manual_per_trade',
      country: null,
      manualDefaultAmountEur: 5,
    });

    const withRate = await patchTaxSettings(agent, {
      mode: 'manual_per_trade',
      manualDefaultRatePct: 10,
    });
    expect(withRate.body).toEqual({
      mode: 'manual_per_trade',
      country: null,
      manualDefaultRatePct: 10,
    });
  });

  it('rejects inconsistent tuples (contract-validated)', async () => {
    const { agent } = await setup();
    // custom mode requires its params; params reject any other mode.
    await patchTaxSettings(agent, { mode: 'custom' } as UpdateTaxSettingsRequest, 400);
    await patchTaxSettings(
      agent,
      { mode: 'none', custom: RATE10 } as UpdateTaxSettingsRequest,
      400,
    );
    // Manual default: manual mode only, amount OR rate.
    await patchTaxSettings(
      agent,
      { mode: 'none', manualDefaultAmountEur: 5 } as UpdateTaxSettingsRequest,
      400,
    );
    await patchTaxSettings(
      agent,
      {
        mode: 'manual_per_trade',
        manualDefaultAmountEur: 5,
        manualDefaultRatePct: 10,
      } as UpdateTaxSettingsRequest,
      400,
    );
    // Out-of-range custom rate.
    await patchTaxSettings(
      agent,
      { mode: 'custom', custom: { ...RATE10, ratePct: 101 } } as UpdateTaxSettingsRequest,
      400,
    );
  });
});

// ─── Manual default: prefilled server-side, editable per trade ───────────────

describe('manual default applies where no explicit entry arrives (V5-P4c)', () => {
  it('a sell with no entry takes the default amount; an explicit entry wins', async () => {
    const { agent, pid, asset } = await setup({
      mode: 'manual_per_trade',
      manualDefaultAmountEur: 5,
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });

    // No explicit entry → the default freezes onto the row.
    const bare = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    expect(await frozenRow(bare.body.transactions[0].id as string)).toMatchObject({
      taxMode: 'manual_per_trade',
      taxAmountEur: 5,
    });

    // An explicit per-trade entry stays editable — it wins over the default.
    const explicit = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 19,
      executedAt: '2026-03-10T10:00:00.000Z',
      addProceedsToCash: true,
      taxAmountEur: 2,
    });
    expect(await frozenRow(explicit.body.transactions[0].id as string)).toMatchObject({
      taxMode: 'manual_per_trade',
      taxAmountEur: 2,
    });

    // An explicit ZERO overrides the default down to no withholding.
    const zero = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 10,
      price: 19,
      executedAt: '2026-04-10T10:00:00.000Z',
      addProceedsToCash: true,
      taxAmountEur: 0,
    });
    expect(await frozenRow(zero.body.transactions[0].id as string)).toMatchObject({
      taxMode: 'manual_per_trade',
      taxAmountEur: 0,
    });

    const cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-5, -2]);
  });

  it('a rate default applies to the realized gain of an entry-less sell', async () => {
    const { agent, pid, asset } = await setup({
      mode: 'manual_per_trade',
      manualDefaultRatePct: 10,
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // Gain 50·(19−10) = 450 → 10 % default = 45.00.
    const sell = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    expect(await frozenRow(sell.body.transactions[0].id as string)).toMatchObject({
      taxMode: 'manual_per_trade',
      taxAmountEur: 45,
    });
  });

  it('a dividend with no entry takes the default; gross stays net-of-tax in cash', async () => {
    const { agent, pid, asset } = await setup({
      mode: 'manual_per_trade',
      manualDefaultRatePct: 25,
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    const res = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 100, executedAt: '2026-02-01T10:00:00.000Z' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.dividend).toMatchObject({ taxMode: 'manual_per_trade', taxAmountEur: 25 });

    const cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-25]);
    expect(cash.balanceEur).toBe(75);
  });

  it('import-sourced rows never take the default (broker history settled its taxes)', async () => {
    const { user, agent, pid, asset } = await setup({
      mode: 'manual_per_trade',
      manualDefaultAmountEur: 5,
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // The CSV apply path (V4-P8) routes through the same services with its
    // broker source tag — an entry-less imported sell/dividend records NO tax
    // rather than freezing today's default onto already-settled history.
    const [tx] = await harness.ctx.portfolio.createTransactions(
      user.id,
      pid,
      [
        {
          assetId: asset.id,
          side: 'sell',
          quantity: 10,
          price: 19,
          fee: 0,
          executedAt: '2026-02-10T10:00:00.000Z',
          addProceedsToCash: true,
        },
      ],
      { source: 'import:george' },
    );
    expect(await frozenRow(tx!.id)).toMatchObject({
      taxMode: 'manual_per_trade',
      taxAmountEur: null,
    });
    const recorded = await harness.ctx.tax.recordDividend(
      user.id,
      pid,
      { assetId: asset.id, grossAmountEur: 100, executedAt: '2026-03-01T10:00:00.000Z' },
      { source: 'import:george' },
    );
    expect(recorded.dividend.taxAmountEur).toBeNull();
    const cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements)).toHaveLength(0);
  });
});

// ─── Custom mode: the rule-built engine end-to-end ───────────────────────────

describe('custom mode settles end-to-end (V5-P4c)', () => {
  it("an AT-configured parameter set reproduces the owner's AT example exactly", async () => {
    const { agent, pid, asset } = await setup({ mode: 'custom', custom: AT_PARAMS });

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // Gain sell +450 → withhold 27.5 % = 123.75, exactly like AT mode.
    const gain = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    let cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements)).toHaveLength(1);
    expect(taxMovements(cash.movements)[0]).toMatchObject({
      kind: 'tax_withholding',
      amountEur: -123.75,
      taxYear: 2026,
    });

    // Loss sell −100 → refund down to 27.5 % × 350 = 96.25.
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
    expect(settlements.find((m) => m.kind === 'tax_refund')).toMatchObject({
      kind: 'tax_refund',
      amountEur: 27.5,
      taxYear: 2026,
    });

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

    // The mode + full parameter snapshot froze onto the row.
    expect(await frozenRow(gain.body.transactions[0].id as string)).toEqual({
      taxMode: 'custom',
      taxCountry: null,
      taxAmountEur: 123.75,
      taxParams: AT_PARAMS,
    });
  });

  it('parameter changes re-derive the open year under the new set (#635); rows keep their snapshots', async () => {
    const { agent, pid, asset } = await setup({ mode: 'custom', custom: RATE10 });

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // +450 under 10 % → withhold 45.
    const first = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });

    // Parameter change: the OPEN year re-derives in full under the new set
    // (#635 live model — supersedes the forward-only cutover).
    const RATE20: CustomTaxParams = { ...RATE10, ratePct: 20 };
    await patchTaxSettings(agent, { mode: 'custom', custom: RATE20 });

    // A −100 loss under the NEW set. The live pool spans the whole year:
    // existing +450 re-taxes at 20 % (correction −45 on top of the held 45),
    // then the loss shrinks the pool to 350 → 70, refunding 20 on the row.
    const loss = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 25,
      price: 6,
      executedAt: '2026-03-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    let cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-45, 20, -45]);

    // A +200 gain: pool 350 + 200 = 550 → 20 % = 110; marginal 40.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 25,
      price: 18,
      executedAt: '2026-04-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-45, 20, -40, -45]);
    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({ year: 2026, taxNetEur: 110 });

    // Each row still keeps the exact parameter snapshot it recorded under.
    expect(await frozenRow(first.body.transactions[0].id as string)).toMatchObject({
      taxMode: 'custom',
      taxAmountEur: 45,
      taxParams: RATE10,
    });
    expect(await frozenRow(loss.body.transactions[0].id as string)).toMatchObject({
      taxMode: 'custom',
      taxAmountEur: -20,
      taxParams: RATE20,
    });
  });

  it('switching AT→custom re-derives the open year under the custom set (#635)', async () => {
    const { agent, pid, asset } = await setup({ mode: 'country_specific', country: 'AT' });

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // AT: +450 → 123.75 withheld.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });

    await patchTaxSettings(agent, { mode: 'custom', custom: RATE10 });

    // Custom loss −100. The live pool spans the year: +450 at 10 % = 45
    // (correction refunds 78.75 of the AT-era withholding), the loss shrinks
    // the pool to 350 → 35, refunding 10 on the row.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 25,
      price: 6,
      executedAt: '2026-03-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    let cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-123.75, 10, 78.75]);

    // Custom gain +200: pool 350 + 200 = 550 → 10 % = 55; marginal 20.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 25,
      price: 18,
      executedAt: '2026-04-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-123.75, 10, -20, 78.75]);

    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({ year: 2026, taxNetEur: 55 });
  });

  it('settlement stays append-only: delete posts a correction, re-add re-settles', async () => {
    const { agent, pid, asset } = await setup({ mode: 'custom', custom: RATE10 });

    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    // Gain +450 → withhold 45; then loss −100 → pool 350 → refund 10.
    const gainBody = {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 19,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    };
    const gain = await trade(agent, pid, gainBody);
    const gainId = gain.body.transactions[0].id as string;
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 25,
      price: 6,
      executedAt: '2026-03-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    let cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-45, 10]);

    // Delete the GAIN sell: its withholding cascades away, but the loss row
    // keeps its frozen −10 refund — the post-delete year (pool −100, target 0)
    // is short exactly 10, posted as an UNATTACHED correction, never an edit.
    const del = await agent.delete(`/api/v1/portfolios/${pid}/transactions/${gainId}`).set(...XRW);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    cash = await cashState(agent, pid);
    const afterDelete = taxMovements(cash.movements);
    expect(afterDelete.map((m) => m.amountEur)).toEqual([10, -10]);
    expect(afterDelete.find((m) => m.kind === 'tax_withholding')).toMatchObject({
      amountEur: -10,
      taxYear: 2026,
      transactionId: null,
      note: 'Live tax correction (custom rules)',
    });

    // Re-add the same sell: the year re-settles against its corrected held —
    // pool −100 + 450 = 350 → target 35, so the new row withholds exactly 35.
    // (Movements list by executedAt: the re-added Feb sell's withholding
    // precedes the Mar loss's refund and the now-dated correction.)
    await trade(agent, pid, gainBody);
    cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-35, 10, -10]);
    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({
      year: 2026,
      realizedPnlEur: 350,
      taxWithheldEur: 45,
      taxRefundedEur: 10,
      taxNetEur: 35,
    });
  });

  it('FIFO vs moving-average diverge through the cost-basis parameter', async () => {
    const log = async (params: CustomTaxParams, tag: string) => {
      const { agent, pid, asset } = await setup({ mode: 'custom', custom: params }, tag);
      await trade(agent, pid, {
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 100,
        executedAt: '2026-01-05T10:00:00.000Z',
      });
      await trade(agent, pid, {
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 200,
        executedAt: '2026-02-05T10:00:00.000Z',
      });
      await trade(agent, pid, {
        assetId: asset.id,
        side: 'sell',
        quantity: 1,
        price: 300,
        executedAt: '2026-03-05T10:00:00.000Z',
        addProceedsToCash: true,
      });
      const cash = await cashState(agent, pid);
      return taxMovements(cash.movements).map((m) => m.amountEur);
    };
    // FIFO consumes the 100 lot → gain 200 → 10 % = 20.
    expect(await log({ ...RATE10, costBasis: 'fifo' }, 'fifo')).toEqual([-20]);
    // Moving average bases at 150 → gain 150 → 10 % = 15.
    expect(await log(RATE10, 'avg')).toEqual([-15]);
  });

  it('taxes dividends inside the custom pool and re-settles on dividend delete', async () => {
    const { agent, pid, asset } = await setup({ mode: 'custom', custom: RATE10 });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    const res = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 100, executedAt: '2026-02-01T10:00:00.000Z' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.dividend).toMatchObject({
      taxMode: 'custom',
      taxCountry: null,
      taxAmountEur: 10,
    });
    let cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-10]);

    const del = await agent
      .delete(`/api/v1/portfolios/${pid}/dividends/${res.body.dividend.id as string}`)
      .set(...XRW);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements)).toHaveLength(0);
  });

  it('rejects manual per-trade entries while custom mode is active', async () => {
    const { agent, pid, asset } = await setup({ mode: 'custom', custom: RATE10 });
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
        price: 19,
        executedAt: '2026-02-10T10:00:00.000Z',
        taxAmountEur: 3,
      },
      400,
    );
    expect(res.body.error?.code).toBe('TAX_ENTRY_NOT_ALLOWED');
  });
});

// ─── Refund off vs history reshapes: the ratchet gates events, not data
// corrections (§16) ──────────────────────────────────────────────────────────

describe('refund-off reshape reconciliation stays signed on every path (V5-P4c)', () => {
  const RATCHET10: CustomTaxParams = { ...RATE10, refund: false };

  /** Buy 100@10 + 100@30, sell 100@40: avg basis 20 → gain 2000 → 10 % = 200. */
  async function seedRatchetYear() {
    const { agent, pid, asset } = await setup({ mode: 'custom', custom: RATCHET10 });
    const cheapBuy = await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 30,
      executedAt: '2026-01-20T10:00:00.000Z',
    });
    const sell = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 100,
      price: 40,
      executedAt: '2026-02-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    const cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-200]);
    return {
      agent,
      pid,
      asset,
      cheapBuyId: cheapBuy.body.transactions[0].id as string,
      sellId: sell.body.transactions[0].id as string,
    };
  }

  /** The claw-back both reshape paths must land on: held 200 → replay target 100. */
  async function expectClawBackTo100(agent: Agent, pid: string, sellId: string) {
    const cash = await cashState(agent, pid);
    const after = taxMovements(cash.movements);
    expect(after.map((m) => m.amountEur)).toEqual([-200, 100]);
    expect(after.find((m) => m.kind === 'tax_refund')).toMatchObject({
      amountEur: 100,
      taxYear: 2026,
      transactionId: null,
      note: 'Live tax correction (custom rules)',
    });
    // Append-only: the sell keeps its frozen 200 — the claw-back is a
    // correction movement, never an edit.
    expect(await frozenRow(sellId)).toMatchObject({ taxMode: 'custom', taxAmountEur: 200 });
    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({
      year: 2026,
      realizedPnlEur: 1000,
      taxWithheldEur: 200,
      taxRefundedEur: 100,
      taxNetEur: 100,
    });
  }

  it('deleting a buy that reshapes a refund-off gain claws the excess back (data correction)', async () => {
    const { agent, pid, cheapBuyId, sellId } = await seedRatchetYear();
    // Removing the 10-EUR buy lifts the moving-average basis to 30: the
    // group's replay target drops to 10 % × 1000 = 100. The ratchet does NOT
    // gate reconciliation — the year corrects down to the replay target.
    const del = await agent
      .delete(`/api/v1/portfolios/${pid}/transactions/${cheapBuyId}`)
      .set(...XRW);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    await expectClawBackTo100(agent, pid, sellId);
  });

  it('a backdated buy reshaping a refund-off gain posts the same signed correction (write path)', async () => {
    const { agent, pid, asset, sellId } = await seedRatchetYear();
    // A backdated 100@50 buy before the sell lifts the moving-average basis
    // to 30 → the same replay target 100 as the delete repro. The write path
    // must post the SAME −100 correction the delete path does — the same
    // economic reshape yields one outcome regardless of which path settles it.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 50,
      executedAt: '2026-01-25T10:00:00.000Z',
    });
    await expectClawBackTo100(agent, pid, sellId);
  });

  it('a loss event still never refunds: the economic ratchet holds inside the flow', async () => {
    const { agent, pid, asset } = await seedRatchetYear();
    // A loss sell (50 × (10 − 20) = −500) shrinks the pool 2000 → 1500, but
    // with refund off the EVENT posts nothing — held stays at the 200
    // high-water mark. This is the rule the reshape exemption does not touch.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 50,
      price: 10,
      executedAt: '2026-03-10T10:00:00.000Z',
      addProceedsToCash: true,
    });
    const cash = await cashState(agent, pid);
    expect(taxMovements(cash.movements).map((m) => m.amountEur)).toEqual([-200]);
    const years = await yearSummaries(agent, pid);
    expect(years[0]).toMatchObject({ year: 2026, taxWithheldEur: 200, taxNetEur: 200 });
  });
});
