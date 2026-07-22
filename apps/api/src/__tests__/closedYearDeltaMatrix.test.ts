import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CashMovement, CustomTaxParams } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createCashMovementRepository } from '../data/repositories/cashMovementRepository';
import { createTaxRepository } from '../data/repositories/taxRepository';
import {
  createTransactionRepository,
  type TransactionRecord,
} from '../data/repositories/transactionRepository';
import {
  dePotCategoryForAssetType,
  floorCents,
  realizedSellsEur,
  SUPPORTED_TAX_COUNTRIES,
  type SellRealizationEur,
  type TaxableTransaction,
} from '../domain/tax';
import {
  buildFrozenComponentState,
  frozenTargetForYear,
  heldForYear,
} from '../services/tax/closedSettlement';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * The closed-year ΔF matrix (issue #669) — the structural guard that the
 * #656 whack-a-mole class cannot recur.
 *
 * Invariant pinned per {regime} × {mutation path} cell: whenever a mutation
 * reshapes a CLOSED year, the year's held tax shifts by EXACTLY the change in
 * its standalone frozen decomposition ΣF (`Δheld == ΔΣF`), so the locked
 * residue `held − ΣF` is conserved on every path. A regime/mode branch that
 * skips the centralized settlement leaves held flat while ΣF moves — its cell
 * fails here instead of in a future review round. Each cell also asserts its
 * fixture really moves the decomposition (`ΔΣF ≠ 0` somewhere). A new country
 * added to `SUPPORTED_TAX_COUNTRIES` joins the matrix automatically: unless
 * its settlement and its frozen-component analog in the decomposition agree
 * on every mutation path, its cells break the invariant — the developer is
 * forced through the choke point, not through another review round.
 *
 * The regime axis is built FROM `SUPPORTED_TAX_COUNTRIES` (+ a chained FIFO
 * custom set), so new country modules join the matrix automatically.
 *
 * The fixture spans TWO closed years with cross-year coupling (FIFO lots and
 * DE/custom carry cross the 2025→2026 boundary), so the round-3 class — a
 * mutation in one closed year reshaping another — is exercised in every cell.
 *
 * Also here: the #669 legacy-drift decision tests — pre-#635 drift is
 * PRESERVED as locked residue per Option A (§16 2026-07-22), never healed and
 * never absorbed into later settlements.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;
let clock: number;

beforeEach(async () => {
  clock = Date.parse('2025-07-01T12:00:00.000Z');
  harness = await createTestApp({ taxNow: () => clock });
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

async function setup() {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const pid = await defaultPortfolioId(agent);
  const asset = await seedAsset();
  return { agent, pid, asset };
}

async function patchSettings(agent: Agent, body: Record<string, unknown>) {
  const res = await agent
    .patch('/api/v1/settings/taxes')
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function trade(agent: Agent, pid: string, body: Record<string, unknown>) {
  const res = await agent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res;
}

async function patchTransaction(
  agent: Agent,
  pid: string,
  id: string,
  body: Record<string, unknown>,
) {
  return agent
    .patch(`/api/v1/portfolios/${pid}/transactions/${id}`)
    .set(...XRW)
    .send(body);
}

async function cashMovements(agent: Agent, pid: string): Promise<CashMovement[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash`);
  expect(res.status).toBe(200);
  return res.body.movements as CashMovement[];
}

async function mainSourceId(agent: Agent, pid: string): Promise<string> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash`);
  expect(res.status).toBe(200);
  const main = (res.body.sources as { id: string; isMain: boolean }[]).find((s) => s.isMain);
  expect(main).toBeTruthy();
  return main!.id;
}

// ─── The oracle: held + ΣF recomputed from the DB through the choke module ────

/** Per-year snapshot of the invariant's two sides over the closed years. */
interface DecompositionSnapshot {
  heldEur: Map<number, number>;
  frozenEur: Map<number, number>;
}

const CLOSED_YEARS = [2025, 2026];

async function snapshot(
  pid: string,
  /** Optional row rewrite — a COUNTERFACTUAL decomposition ("what would ΣF
   *  become if this edit landed"), used to prove an edit fixture is a real
   *  reshape threat before asserting how the API answered it. */
  transform?: (t: TransactionRecord) => TransactionRecord,
): Promise<DecompositionSnapshot> {
  const txnRepo = createTransactionRepository(harness.db);
  const taxRepo = createTaxRepository(harness.db);
  const cashRepo = createCashMovementRepository(harness.db);
  const [storedTransactions, dividendRows, movements] = await Promise.all([
    txnRepo.listForPortfolio(pid),
    taxRepo.listForPortfolio(pid),
    cashRepo.listForPortfolio(pid),
  ]);
  const transactions = transform ? storedTransactions.map(transform) : storedTransactions;
  // EUR-only fixtures: the native amounts ARE the EUR taxable view.
  const taxables: TaxableTransaction[] = transactions.map((t) => ({
    id: t.id,
    assetId: t.assetId,
    side: t.side,
    quantity: t.quantity,
    priceEur: t.price,
    feeEur: t.fee,
    executedAt: t.executedAt.toISOString(),
    allowUncovered: t.allowUncovered,
    uncoveredEntryPriceEur: t.uncoveredEntryPrice,
  }));
  const byId = (rs: SellRealizationEur[]) => new Map(rs.map((r) => [r.id, r]));
  // All-true involve flags: a component without rows derives 0, and the
  // oracle must stay regime-agnostic — that is the point of the matrix.
  const state = buildFrozenComponentState({
    transactions,
    dividendRows,
    realizations: byId(realizedSellsEur(taxables, 'moving-average')),
    fifoRealizations: byId(realizedSellsEur(taxables, 'fifo')),
    categoryOf: () => dePotCategoryForAssetType('stock'),
    involveDe: true,
    involveFi: true,
    involveCustom: true,
  });
  const heldEur = new Map<number, number>();
  const frozenEur = new Map<number, number>();
  for (const year of CLOSED_YEARS) {
    heldEur.set(year, heldForYear(transactions, dividendRows, movements, year));
    frozenEur.set(year, frozenTargetForYear(state, year));
  }
  return { heldEur, frozenEur };
}

/** Assert Δheld == ΔΣF for every closed year, and that ΣF moved somewhere. */
function expectDeltaTracked(
  before: DecompositionSnapshot,
  after: DecompositionSnapshot,
  cell: string,
): void {
  let moved = false;
  for (const year of CLOSED_YEARS) {
    const deltaHeld = floorCents(after.heldEur.get(year)! - before.heldEur.get(year)!);
    const deltaFrozen = floorCents(after.frozenEur.get(year)! - before.frozenEur.get(year)!);
    expect(deltaHeld, `${cell}: year ${year} held must shift by exactly ΔF`).toBe(deltaFrozen);
    if (deltaFrozen !== 0) moved = true;
  }
  expect(moved, `${cell}: the fixture must reshape the decomposition (ΔΣF ≠ 0)`).toBe(true);
}

// ─── The regime axis: every supported country + a chained FIFO custom set ─────

const CHAINED_CUSTOM: CustomTaxParams = {
  ratePct: 30,
  lossOffset: true,
  refund: true,
  yearReset: false,
  carryForward: true,
  costBasis: 'fifo',
};

const REGIMES: Array<{ key: string; settings: Record<string, unknown> }> = [
  ...SUPPORTED_TAX_COUNTRIES.map((country) => ({
    key: country,
    settings: { mode: 'country_specific', country },
  })),
  { key: 'custom', settings: { mode: 'custom', custom: CHAINED_CUSTOM } },
];

/** The recording modes a reshaping batch can arrive under (mutation-path axis). */
const RECORDING_MODES = ['engine', 'none', 'manual_per_trade'] as const;

/** The fixture rows the mutation-path cells act on. */
interface FixtureRows {
  buyFirstLot: string;
  sell2025: string;
  sell2026: string;
}

/**
 * Two engine-frozen closed years with cross-year coupling. 2025: lots
 * 100 @ 20 and 100 @ 30, sell 100 @ 40 (FIFO gain 2,000 / avg 1,500).
 * 2026: sell 50 @ 80 (FIFO consumes the € 30 lot → 2,500 / avg 2,750; priced
 * so the DE component clears the € 1,000 Sparer-Pauschbetrag with headroom on
 * both sides of every cell's reshape — an allowance-clamped ΔF of zero would
 * blind the matrix). Rolls the clock to 2027 so both years are closed.
 */
async function buildTwoClosedYears(
  agent: Agent,
  pid: string,
  assetId: string,
): Promise<FixtureRows> {
  const firstLot = await trade(agent, pid, {
    assetId,
    side: 'buy',
    quantity: 100,
    price: 20,
    executedAt: '2025-02-01T10:00:00.000Z',
  });
  await trade(agent, pid, {
    assetId,
    side: 'buy',
    quantity: 100,
    price: 30,
    executedAt: '2025-03-01T10:00:00.000Z',
  });
  const sell2025 = await trade(agent, pid, {
    assetId,
    side: 'sell',
    quantity: 100,
    price: 40,
    executedAt: '2025-05-01T10:00:00.000Z',
    addProceedsToCash: true,
  });
  clock = Date.parse('2026-04-01T12:00:00.000Z');
  const sell2026 = await trade(agent, pid, {
    assetId,
    side: 'sell',
    quantity: 50,
    price: 80,
    executedAt: '2026-04-10T10:00:00.000Z',
    addProceedsToCash: true,
  });
  clock = Date.parse('2027-01-05T12:00:00.000Z');
  return {
    buyFirstLot: firstLot.body.transactions[0].id as string,
    sell2025: sell2025.body.transactions[0].id as string,
    sell2026: sell2026.body.transactions[0].id as string,
  };
}

describe.each(REGIMES)('closed-year ΔF invariant — frozen regime $key', ({ key, settings }) => {
  it.each(RECORDING_MODES)(
    'a backdated buy and its deletion self-adjust by exactly ΔF (recorded under %s)',
    async (mode) => {
      const { agent, pid, asset } = await setup();
      await patchSettings(agent, settings);
      await buildTwoClosedYears(agent, pid, asset.id);
      if (mode !== 'engine') await patchSettings(agent, { mode });

      // Write path: the backdated € 10 lot re-bases BOTH closed years' sells
      // (FIFO lot shift across the year boundary / moving-average re-basing).
      const preWrite = await snapshot(pid);
      const buy = await trade(agent, pid, {
        assetId: asset.id,
        side: 'buy',
        quantity: 100,
        price: 10,
        executedAt: '2025-01-10T10:00:00.000Z',
      });
      const postWrite = await snapshot(pid);
      expectDeltaTracked(preWrite, postWrite, `${key}/write-under-${mode}`);

      // Delete path: removing the lot hands the basis back — the reshape
      // reverses through the same centralized settlement.
      const buyId = buy.body.transactions[0].id as string;
      const del = await agent.delete(`/api/v1/portfolios/${pid}/transactions/${buyId}`).set(...XRW);
      expect(del.status, JSON.stringify(del.body)).toBe(204);
      const postDelete = await snapshot(pid);
      expectDeltaTracked(postWrite, postDelete, `${key}/delete-under-${mode}`);
      // The reversal is exact: held returns to its pre-write level.
      for (const year of CLOSED_YEARS) {
        expect(postDelete.heldEur.get(year)).toBe(preWrite.heldEur.get(year));
      }
    },
  );

  it('deleting an engine-frozen sell settles the attached cascade + cross-year lot shift by exactly ΔF', async () => {
    const { agent, pid, asset } = await setup();
    await patchSettings(agent, settings);
    const rows = await buildTwoClosedYears(agent, pid, asset.id);

    // Deleting the 2025 engine sell exercises BOTH non-write terms of the
    // choke formula at once (#675 review nit): its attached withholding
    // cascades away with the row (the `held_before − held_after` term), and
    // under FIFO-realizing regimes the 2026 frozen sell's consumption shifts
    // onto the freed € 20 lot (a ΔΣF in a year the mutation never wrote to).
    const pre = await snapshot(pid);
    const del = await agent
      .delete(`/api/v1/portfolios/${pid}/transactions/${rows.sell2025}`)
      .set(...XRW);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    const post = await snapshot(pid);
    expectDeltaTracked(pre, post, `${key}/delete-frozen-sell`);
    // The cascade term was live, not a pure reshape: 2025's held really moved.
    expect(post.heldEur.get(2025)).not.toBe(pre.heldEur.get(2025));
  });

  it('the edit door rejects-or-settles — a financial edit can never silently reshape a closed year', async () => {
    const { agent, pid, asset } = await setup();
    await patchSettings(agent, settings);
    const rows = await buildTwoClosedYears(agent, pid, asset.id);

    // Row-own immutability: an engine-frozen sell rejects financial edits in
    // EVERY engine regime — custom included, whose € 0-marginal rows attach
    // no movement, so no downstream guard would catch them (#675 review).
    const preGuards = await snapshot(pid);
    const frozenEdit = await patchTransaction(agent, pid, rows.sell2026, { quantity: 40 });
    expect(frozenEdit.status, JSON.stringify(frozenEdit.body)).toBe(400);
    expect(frozenEdit.body.error.code).toBe('TRANSACTION_TAXED');

    // A buy feeding engine-frozen sells re-bases them in every regime.
    const buyEdit = await patchTransaction(agent, pid, rows.buyFirstLot, { price: 21 });
    expect(buyEdit.status, JSON.stringify(buyEdit.body)).toBe(400);
    expect(buyEdit.body.error.code).toBe('TRANSACTION_AFFECTS_TAXED');
    expect(await snapshot(pid)).toEqual(preGuards);

    // The #675 rounds-1/2 door: an UNTAXED sell between the frozen sells,
    // with a buy AFTER it. Under FIFO-realizing regimes its quantity steers
    // how the 2026 frozen sell straddles the € 30/€ 35 lots; under the
    // moving average it sets the held quantity the later buy re-averages
    // with — so the fixture is a genuine reshape threat in EVERY regime
    // (round 2's ordering, buy first, left average regimes inert and hid
    // that the guard's carve-out was unsound). Recorded buy-first so the
    // sell's own write replays oversell-free; the dates put it before the
    // buy, which is all the chronological replay cares about.
    await patchSettings(agent, { mode: 'none' });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 35,
      executedAt: '2025-08-01T10:00:00.000Z',
    });
    const noneSell = await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 80,
      price: 40,
      executedAt: '2025-06-15T10:00:00.000Z',
    });
    const noneSellId = noneSell.body.transactions[0].id as string;
    const preEdit = await snapshot(pid);
    // The backdated setup writes reshape the closed years themselves — the
    // write path settles them (a sell-write-under-none cell for free).
    expectDeltaTracked(preGuards, preEdit, `${key}/edit-setup-writes`);

    // Counterfactual ΣF if the edit landed: the reject below must answer a
    // real threat in this regime, not vacuous conservatism.
    const counterfactual = await snapshot(pid, (t) =>
      t.id === noneSellId ? { ...t, quantity: 30 } : t,
    );
    const wouldMove = CLOSED_YEARS.some(
      (year) => counterfactual.frozenEur.get(year) !== preEdit.frozenEur.get(year),
    );
    expect(wouldMove, `${key}: the fixture must be a genuine reshape threat`).toBe(true);

    const edit = await patchTransaction(agent, pid, noneSellId, { quantity: 30 });
    const postEdit = await snapshot(pid);
    if (edit.status === 200) {
      // Allowed ⇒ settled: held tracks ΣF exactly (a zero Δ is fine here —
      // the harmless-edit case; a reshape that lands unsettled is not).
      for (const year of CLOSED_YEARS) {
        const deltaHeld = floorCents(postEdit.heldEur.get(year)! - preEdit.heldEur.get(year)!);
        const deltaFrozen = floorCents(
          postEdit.frozenEur.get(year)! - preEdit.frozenEur.get(year)!,
        );
        expect(deltaHeld, `${key}/edit: year ${year} held must shift by exactly ΔF`).toBe(
          deltaFrozen,
        );
      }
    } else {
      // Rejected ⇒ untouched.
      expect(edit.status, JSON.stringify(edit.body)).toBe(400);
      expect(edit.body.error.code).toBe('TRANSACTION_AFFECTS_TAXED');
      expect(postEdit).toEqual(preEdit);
    }
    // Today's contract: edits perform no settlement, so ANY financial edit
    // is rejected while the asset carries engine-frozen sells — no side or
    // regime carve-out is sound (#675 round 2: an untaxed sell steers a
    // later buy's re-average weight even under the moving average). If edits
    // ever gain their own settlement path, drop this line — the
    // reject-or-settle block above is the one that must keep holding.
    expect(edit.status).toBe(400);

    // The reject is scoped to the asset carrying the frozen sells: rows of
    // an asset no engine ever taxed stay as editable as v2, and their edit
    // touches neither side of the decomposition.
    const other = await seedAsset('OTHR.DE');
    await trade(agent, pid, {
      assetId: other.id,
      side: 'buy',
      quantity: 10,
      price: 10,
      executedAt: '2025-06-01T10:00:00.000Z',
    });
    const otherSell = await trade(agent, pid, {
      assetId: other.id,
      side: 'sell',
      quantity: 5,
      price: 12,
      executedAt: '2025-09-01T10:00:00.000Z',
    });
    const otherEdit = await patchTransaction(
      agent,
      pid,
      otherSell.body.transactions[0].id as string,
      { quantity: 4 },
    );
    expect(otherEdit.status, JSON.stringify(otherEdit.body)).toBe(200);
    expect(await snapshot(pid)).toEqual(preEdit);
  });

  it('a backdated dividend and its deletion self-adjust by exactly ΔF', async () => {
    const { agent, pid, asset } = await setup();
    await patchSettings(agent, settings);
    await buildTwoClosedYears(agent, pid, asset.id);

    const preRecord = await snapshot(pid);
    const dividend = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 200, executedAt: '2025-06-01T10:00:00.000Z' });
    expect(dividend.status, JSON.stringify(dividend.body)).toBe(201);
    const postRecord = await snapshot(pid);
    expectDeltaTracked(preRecord, postRecord, `${key}/dividend-record`);

    const del = await agent
      .delete(`/api/v1/portfolios/${pid}/dividends/${dividend.body.dividend.id}`)
      .set(...XRW);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    const postDelete = await snapshot(pid);
    expectDeltaTracked(postRecord, postDelete, `${key}/dividend-delete`);
    for (const year of CLOSED_YEARS) {
      expect(postDelete.heldEur.get(year)).toBe(preRecord.heldEur.get(year));
    }
  });
});

// ─── Legacy drift: preserved per Option A (#669 decision, §16 2026-07-22) ─────

describe('pre-#635 legacy drift is preserved as locked residue, never healed', () => {
  const taxMovements = (movements: CashMovement[]): CashMovement[] =>
    movements.filter((m) => m.kind === 'tax_withholding' || m.kind === 'tax_refund');

  /**
   * One AT-frozen closed year (2026: gain 2,000 → € 550 attached), then
   * fabricated legacy drift: an unattached € 100 refund written straight to
   * the DB, simulating a pre-#635 backdated write that skipped settlement
   * (held 450, decomposition 550 — post hoc indistinguishable from a
   * legitimate open-era refund, which is exactly why it must be preserved).
   */
  async function setupWithDrift() {
    clock = Date.parse('2026-07-01T12:00:00.000Z');
    harness = await createTestApp({ taxNow: () => clock });
    const { agent, pid, asset } = await setup();
    await patchSettings(agent, { mode: 'country_specific', country: 'AT' });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 20,
      executedAt: '2026-02-01T10:00:00.000Z',
    });
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 100,
      price: 40,
      executedAt: '2026-03-01T10:00:00.000Z',
      addProceedsToCash: true,
    });
    await harness.db.insert(schema.portfolioCashMovements).values({
      portfolioId: pid,
      sourceId: await mainSourceId(agent, pid),
      kind: 'tax_refund',
      amountEur: '100',
      executedAt: new Date('2026-06-15T10:00:00.000Z'),
      taxYear: 2026,
      note: 'Legacy drift (pre-#635 fixture)',
    });
    clock = Date.parse('2027-01-05T12:00:00.000Z');
    return { agent, pid, asset };
  }

  it('report reads post nothing — closed years never re-derive onto the decomposition', async () => {
    const { agent, pid } = await setupWithDrift();
    const res = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years`);
    expect(res.status).toBe(200);
    const year2026 = res.body.years.find((y: { year: number }) => y.year === 2026);
    // Held (450) is reported as-is; the € 100 gap to the decomposition (550)
    // is locked residue, not drift to repair.
    expect(year2026).toMatchObject({ locked: true, taxNetEur: 450 });
    expect(taxMovements(await cashMovements(agent, pid))).toHaveLength(2);
  });

  it('mutations settle their own ΔF around the drift; the residue is conserved exactly', async () => {
    const { agent, pid, asset } = await setupWithDrift();

    // Backdated buy: avg basis 20 → 15, gain 2,000 → 2,500, ΣF 550 → 687.50.
    // Held moves 450 → 587.50 (ΔF = +137.50) — the € 100 residue survives,
    // and no movement ever reconciles it away.
    const pre = await snapshot(pid);
    expect(pre.heldEur.get(2026)).toBe(450);
    expect(pre.frozenEur.get(2026)).toBe(550);
    const buy = await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 100,
      price: 10,
      executedAt: '2026-01-10T10:00:00.000Z',
    });
    const post = await snapshot(pid);
    expect(post.heldEur.get(2026)).toBe(587.5);
    expect(post.frozenEur.get(2026)).toBe(687.5);
    expectDeltaTracked(pre, post, 'legacy-drift/write');
    const correction = taxMovements(await cashMovements(agent, pid)).find(
      (m) =>
        m.transactionId === null &&
        m.dividendId === null &&
        m.taxYear === 2026 &&
        m.note !== 'Legacy drift (pre-#635 fixture)',
    );
    expect(correction).toMatchObject({ kind: 'tax_withholding', amountEur: -137.5 });

    // Deleting the buy reverses exactly — back to held 450 on ΣF 550.
    const buyId = buy.body.transactions[0].id as string;
    const del = await agent.delete(`/api/v1/portfolios/${pid}/transactions/${buyId}`).set(...XRW);
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    const reverted = await snapshot(pid);
    expect(reverted.heldEur.get(2026)).toBe(450);
    expect(reverted.frozenEur.get(2026)).toBe(550);
  });
});
