import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  cashDeletionResponseSchema,
  cashMovementResponseSchema,
  cashMovementsResponseSchema,
  cashTagListResponseSchema,
  type CashMovement,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * CORRECTING A HAND-ENTERED CASH MOVEMENT (V5 cash fusion, §16 2026-07-31).
 *
 * The cash ledger was append-only until now: the only way to fix a mis-keyed
 * amount was to post an offsetting movement, which left the history reading like
 * two real events instead of one mistake. `PATCH`/`DELETE
 * /portfolios/:id/cash/movements/:movementId` close that, and this file pins the
 * three things that make them safe rather than merely possible:
 *
 *  1. **Only what a person typed.** deposit / withdrawal / fee are correctable;
 *     a trade's cash leg, a dividend inflow, a tax settlement and a transfer leg
 *     are 409s that name the parent to edit instead. A derived leg edited on its
 *     own would leave the ledger disagreeing with the books.
 *  2. **Solvency by REPLAY, not by today's balance.** Raising a past withdrawal
 *     is refused when it would have overdrawn back then, even if the source is
 *     comfortably funded now; deleting a deposit that funded later spending is
 *     refused for the mirror reason.
 *  3. **Labels survive a correction.** The row keeps its id, so a user's own
 *     tags stay put — but the SYSTEM tag follows the kind, so a withdrawal
 *     reclassified as a fee stops wearing "Withdrawal" and starts wearing "Fees".
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function newUserAgent(email: string, username: string): Promise<Agent> {
  const user = await harness.seedUser({ email, username });
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status).toBe(200);
  return agent;
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  expect(def).toBeTruthy();
  return def.id as string;
}

async function post(
  agent: Agent,
  portfolioId: string,
  path: 'deposit' | 'withdraw' | 'fee',
  body: Record<string, unknown>,
): Promise<CashMovement> {
  const res = await agent
    .post(`/api/v1/portfolios/${portfolioId}/cash/${path}`)
    .set(...XRW)
    .send(body);
  expect(res.status).toBe(201);
  return cashMovementResponseSchema.parse(res.body).movement;
}

function patch(agent: Agent, portfolioId: string, movementId: string, body: object) {
  return agent
    .patch(`/api/v1/portfolios/${portfolioId}/cash/movements/${movementId}`)
    .set(...XRW)
    .send(body);
}

function remove(agent: Agent, portfolioId: string, movementId: string) {
  return agent
    .delete(`/api/v1/portfolios/${portfolioId}/cash/movements/${movementId}`)
    .set(...XRW)
    .send({});
}

async function seedAsset(symbol: string) {
  const [row] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type: 'stock',
      symbol,
      name: `Asset ${symbol}`,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  return row!;
}

async function ledger(agent: Agent, portfolioId: string): Promise<CashMovement[]> {
  const res = await agent.get(`/api/v1/portfolios/${portfolioId}/cash`);
  expect(res.status).toBe(200);
  return cashMovementsResponseSchema.parse(res.body).movements;
}

/** The name of every tag currently on one movement, sorted. */
async function tagNamesOf(
  agent: Agent,
  portfolioId: string,
  movementId: string,
): Promise<string[]> {
  const tagsRes = await agent.get('/api/v1/cash/tags');
  const byId = new Map(
    cashTagListResponseSchema.parse(tagsRes.body).tags.map((tag) => [tag.id, tag.name]),
  );
  const movement = (await ledger(agent, portfolioId)).find((m) => m.id === movementId);
  expect(movement).toBeTruthy();
  return [...(movement!.tags ?? [])]
    .map((id) => byId.get(id) ?? id)
    .sort((a, b) => a.localeCompare(b));
}

describe('PATCH /portfolios/:id/cash/movements/:movementId', () => {
  it('corrects the amount, the date and the note in one pass', async () => {
    const agent = await newUserAgent('edit@bettertrack.test', 'editor');
    const pid = await defaultPortfolioId(agent);
    await post(agent, pid, 'deposit', {
      amountEur: 1000,
      executedAt: '2026-07-01T12:00:00.000Z',
    });
    const spend = await post(agent, pid, 'withdraw', {
      amountEur: 40,
      note: 'Groceris',
      executedAt: '2026-07-10T12:00:00.000Z',
    });

    const res = await patch(agent, pid, spend.id, {
      amountEur: 42.5,
      note: 'Groceries',
      executedAt: '2026-07-11T12:00:00.000Z',
    });

    expect(res.status).toBe(200);
    const body = cashMovementResponseSchema.parse(res.body);
    // The magnitude goes in positive; the sign belongs to the kind.
    expect(body.movement.amountEur).toBeCloseTo(-42.5, 6);
    expect(body.movement.note).toBe('Groceries');
    expect(body.movement.executedAt).toBe('2026-07-11T12:00:00.000Z');
    expect(body.balanceEur).toBeCloseTo(957.5, 6);
    // Corrected in place: still ONE spend on the ledger, not an offsetting pair.
    const rows = await ledger(agent, pid);
    expect(rows.filter((m) => m.kind === 'withdrawal')).toHaveLength(1);
  });

  it('keeps its id — and therefore the tags somebody put on it', async () => {
    const agent = await newUserAgent('tagkeep@bettertrack.test', 'tagkeeper');
    const pid = await defaultPortfolioId(agent);
    await post(agent, pid, 'deposit', { amountEur: 500 });
    const spend = await post(agent, pid, 'withdraw', { amountEur: 20, note: 'Lunch' });

    const created = await agent
      .post('/api/v1/cash/tags')
      .set(...XRW)
      .send({ name: 'Eating out', color: '#22c55e' });
    expect(created.status).toBe(201);
    const tagId = created.body.tag.id as string;
    const put = await agent
      .put(`/api/v1/cash/movements/${spend.id}/tags`)
      .set(...XRW)
      .send({ tagIds: [tagId] });
    expect(put.status).toBe(200);

    const res = await patch(agent, pid, spend.id, { amountEur: 24 });
    expect(res.status).toBe(200);
    expect(res.body.movement.id).toBe(spend.id);
    expect(await tagNamesOf(agent, pid, spend.id)).toContain('Eating out');
  });

  it('moves the system tag when the kind changes, and nothing else', async () => {
    const agent = await newUserAgent('kindflip@bettertrack.test', 'kindflipper');
    const pid = await defaultPortfolioId(agent);
    await post(agent, pid, 'deposit', { amountEur: 500 });
    const spend = await post(agent, pid, 'withdraw', { amountEur: 30, note: 'Custody' });
    expect(await tagNamesOf(agent, pid, spend.id)).toContain('Withdrawal');

    // "Count into performance": the same money, reclassified as a cost of holding.
    const res = await patch(agent, pid, spend.id, { kind: 'fee' });
    expect(res.status).toBe(200);
    expect(res.body.movement.kind).toBe('fee');
    expect(res.body.movement.amountEur).toBeCloseTo(-30, 6);

    const names = await tagNamesOf(agent, pid, spend.id);
    expect(names).toContain('Fees');
    expect(names).not.toContain('Withdrawal');
  });

  it('flips a direction, and the sign follows the new kind', async () => {
    const agent = await newUserAgent('flip@bettertrack.test', 'flipper');
    const pid = await defaultPortfolioId(agent);
    const wrong = await post(agent, pid, 'deposit', { amountEur: 200, note: 'Refund' });

    const res = await patch(agent, pid, wrong.id, { kind: 'withdrawal', amountEur: 200 });
    // 200 out of an empty ledger is an overdraw — the gate does not care that
    // the same row used to fund it, because after the edit it no longer does.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INSUFFICIENT_CASH');
  });

  it('refuses a raise that would have overdrawn BACK THEN, not just today', async () => {
    const agent = await newUserAgent('replay@bettertrack.test', 'replayer');
    const pid = await defaultPortfolioId(agent);
    await post(agent, pid, 'deposit', { amountEur: 100, executedAt: '2026-07-01T12:00:00.000Z' });
    const early = await post(agent, pid, 'withdraw', {
      amountEur: 50,
      executedAt: '2026-07-02T12:00:00.000Z',
    });
    // A much later deposit leaves the source comfortably funded TODAY.
    await post(agent, pid, 'deposit', { amountEur: 5_000, executedAt: '2026-07-20T12:00:00.000Z' });

    const res = await patch(agent, pid, early.id, { amountEur: 900 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INSUFFICIENT_CASH');
    // Refused means refused: the stored row is untouched.
    const stored = (await ledger(agent, pid)).find((m) => m.id === early.id);
    expect(stored!.amountEur).toBeCloseTo(-50, 6);
  });

  it('409s a movement derived from a trade, naming what to edit instead', async () => {
    const agent = await newUserAgent('derived@bettertrack.test', 'derivedone');
    const pid = await defaultPortfolioId(agent);
    await post(agent, pid, 'deposit', {
      amountEur: 5_000,
      executedAt: '2026-07-01T12:00:00.000Z',
    });
    const asset = await seedAsset('VWCE');
    const buy = await agent
      .post(`/api/v1/portfolios/${pid}/transactions`)
      .set(...XRW)
      .send({
        transactions: [
          {
            assetId: asset.id,
            side: 'buy',
            quantity: 10,
            price: 100,
            fee: 0,
            executedAt: '2026-07-05T12:00:00.000Z',
            payFromCash: true,
          },
        ],
      });
    expect(buy.status).toBe(201);

    const leg = (await ledger(agent, pid)).find((m) => m.kind === 'buy');
    expect(leg).toBeTruthy();

    const res = await patch(agent, pid, leg!.id, { amountEur: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CASH_MOVEMENT_NOT_EDITABLE');
    expect(res.body.error.message).toMatch(/trade/i);

    const del = await remove(agent, pid, leg!.id);
    expect(del.status).toBe(409);
  });

  it('rejects an empty patch rather than reporting a successful no-op', async () => {
    const agent = await newUserAgent('empty@bettertrack.test', 'emptyone');
    const pid = await defaultPortfolioId(agent);
    const dep = await post(agent, pid, 'deposit', { amountEur: 10 });

    const res = await patch(agent, pid, dep.id, {});
    expect(res.status).toBe(400);
  });

  it('404s another account’s movement without confirming it exists', async () => {
    const owner = await newUserAgent('owner@bettertrack.test', 'ownerone');
    const pid = await defaultPortfolioId(owner);
    const dep = await post(owner, pid, 'deposit', { amountEur: 10 });

    const stranger = await newUserAgent('stranger@bettertrack.test', 'strangerone');
    const theirPid = await defaultPortfolioId(stranger);

    const res = await patch(stranger, theirPid, dep.id, { amountEur: 999 });
    expect(res.status).toBe(404);
    // Nothing was written through the foreign path.
    const stored = (await ledger(owner, pid)).find((m) => m.id === dep.id);
    expect(stored!.amountEur).toBeCloseTo(10, 6);
  });
});

describe('DELETE /portfolios/:id/cash/movements/:movementId', () => {
  it('removes the row and answers with the balances that are left', async () => {
    const agent = await newUserAgent('del@bettertrack.test', 'deleter');
    const pid = await defaultPortfolioId(agent);
    await post(agent, pid, 'deposit', { amountEur: 300 });
    const spend = await post(agent, pid, 'withdraw', { amountEur: 100 });

    const res = await remove(agent, pid, spend.id);

    expect(res.status).toBe(200);
    const body = cashDeletionResponseSchema.parse(res.body);
    expect(body.balanceEur).toBeCloseTo(300, 6);
    expect(body.sourceBalanceEur).toBeCloseTo(300, 6);
    expect((await ledger(agent, pid)).some((m) => m.id === spend.id)).toBe(false);
  });

  it('refuses to delete a deposit that later spending still depends on', async () => {
    const agent = await newUserAgent('strand@bettertrack.test', 'strander');
    const pid = await defaultPortfolioId(agent);
    const funding = await post(agent, pid, 'deposit', {
      amountEur: 100,
      executedAt: '2026-07-01T12:00:00.000Z',
    });
    await post(agent, pid, 'withdraw', { amountEur: 90, executedAt: '2026-07-05T12:00:00.000Z' });

    const res = await remove(agent, pid, funding.id);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INSUFFICIENT_CASH');
    expect((await ledger(agent, pid)).some((m) => m.id === funding.id)).toBe(true);
  });

  it('404s a second delete of the same movement', async () => {
    const agent = await newUserAgent('twice@bettertrack.test', 'twicedeleter');
    const pid = await defaultPortfolioId(agent);
    const dep = await post(agent, pid, 'deposit', { amountEur: 25 });

    expect((await remove(agent, pid, dep.id)).status).toBe(200);
    expect((await remove(agent, pid, dep.id)).status).toBe(404);
  });
});
