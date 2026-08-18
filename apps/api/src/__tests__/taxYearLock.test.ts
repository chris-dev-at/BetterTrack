import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  taxYearListResponseSchema,
  taxYearLockStateResponseSchema,
  type CashMovement,
  type TaxYearSummary,
} from '@bettertrack/contracts';

import { eq } from 'drizzle-orm';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Tax year locking (owner directive 2026-08-07, §16): an elapsed Vienna year
 * auto-locks — every mutation dated into it 409s (`TAX_YEAR_LOCKED`) until
 * the password-re-authenticated unlock ritual opens that ONE year for
 * amendments; the owning session and `account:security` bearer share it, and
 * re-locking closes it again. The gate sits strictly in FRONT of the settlement
 * machinery: once unlocked, backdated writes settle cent-exactly through the
 * untouched closed-year ΔF machinery (#635/#669).
 * EUR assets throughout, so every cent asserts exactly.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;
let clock: number;

beforeEach(async () => {
  // Mid-2025 to seed history while the year is open; tests roll into 2026.
  clock = Date.parse('2025-06-01T12:00:00.000Z');
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

async function setup(mode: 'none' | 'country_specific' = 'country_specific') {
  const user = await harness.seedUser();
  const agent = await loginAgent(harness.app, user.email, user.password);
  const pid = await defaultPortfolioId(agent);
  const asset = await seedAsset();
  if (mode !== 'none') {
    const res = await agent
      .patch('/api/v1/settings/taxes')
      .set(...XRW)
      .send({ mode, country: 'AT' });
    expect(res.status).toBe(200);
  }
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

async function yearSummaries(agent: Agent, pid: string): Promise<TaxYearSummary[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/reports/tax-years`);
  expect(res.status).toBe(200);
  expect(taxYearListResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body.years as TaxYearSummary[];
}

async function cashMovements(agent: Agent, pid: string): Promise<CashMovement[]> {
  const res = await agent.get(`/api/v1/portfolios/${pid}/cash?limit=200`);
  expect(res.status).toBe(200);
  return res.body.movements as CashMovement[];
}

async function unlock(agent: Agent, year: number, password: string, expected = 200) {
  const res = await agent
    .post(`/api/v1/settings/taxes/years/${year}/unlock`)
    .set(...XRW)
    .send({ password });
  expect(res.status, JSON.stringify(res.body)).toBe(expected);
  return res;
}

async function relock(agent: Agent, year: number, expected = 200) {
  const res = await agent
    .post(`/api/v1/settings/taxes/years/${year}/relock`)
    .set(...XRW)
    .send({});
  expect(res.status, JSON.stringify(res.body)).toBe(expected);
  return res;
}

async function auditActions(): Promise<string[]> {
  const rows = await harness.db.select({ action: schema.auditLog.action }).from(schema.auditLog);
  return rows.map((r) => r.action);
}

/** Buy 10 @ €100 (2025-03) + sell 5 @ €140 (2025-05): AT tax 27.5 % × 200 = €55. */
async function seed2025History(agent: Agent, pid: string, assetId: string) {
  await trade(agent, pid, {
    assetId,
    side: 'buy',
    quantity: 10,
    price: 100,
    executedAt: '2025-03-01T10:00:00.000Z',
  });
  await trade(agent, pid, {
    assetId,
    side: 'sell',
    quantity: 5,
    price: 140,
    executedAt: '2025-05-01T10:00:00.000Z',
    addProceedsToCash: true,
  });
}

const expectLocked = (res: request.Response, year: number) => {
  expect(res.body.error.code).toBe('TAX_YEAR_LOCKED');
  expect(res.body.error.details.year).toBe(year);
  expect(res.body.error.message).toContain(String(year));
  expect(res.body.error.details.unlockPath).toBe(`/api/v1/settings/taxes/years/${year}/unlock`);
};

// ─── The auto-lock: elapsed years refuse mutations ───────────────────────────

describe('tax year locking — auto-lock at rollover', () => {
  it('refuses every mutation dated into the locked year; open-year writes are untouched', async () => {
    const { agent, pid, asset } = await setup();
    await seed2025History(agent, pid, asset.id);
    const deposit2025 = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 500, executedAt: '2025-04-01T10:00:00.000Z' });
    expect(deposit2025.status).toBe(201);
    const movementId = deposit2025.body.movement.id as string;
    const txns = await agent.get(`/api/v1/portfolios/${pid}/transactions`);
    const sell = txns.body.items.find((t: { side: string }) => t.side === 'sell');

    // Jan 1 passes — 2025 locks by pure clock, no job, no migration data.
    clock = Date.parse('2026-02-01T12:00:00.000Z');

    // Create: transaction, dividend, deposit, transfer — all dated 2025 → 409.
    const backdated = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'sell',
        quantity: 1,
        price: 150,
        executedAt: '2025-08-01T10:00:00.000Z',
        addProceedsToCash: true,
      },
      409,
    );
    expectLocked(backdated, 2025);

    const dividend = await agent
      .post(`/api/v1/portfolios/${pid}/dividends`)
      .set(...XRW)
      .send({ assetId: asset.id, grossAmountEur: 40, executedAt: '2025-07-01T10:00:00.000Z' });
    expect(dividend.status).toBe(409);
    expectLocked(dividend, 2025);

    const deposit = await agent
      .post(`/api/v1/portfolios/${pid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 100, executedAt: '2025-09-01T10:00:00.000Z' });
    expect(deposit.status).toBe(409);
    expectLocked(deposit, 2025);

    // Delete + financial edit of 2025 rows → 409; a note-only edit stays open.
    const del = await agent
      .delete(`/api/v1/portfolios/${pid}/transactions/${sell.id}`)
      .set(...XRW)
      .send({});
    expect(del.status).toBe(409);
    expectLocked(del, 2025);

    const editMovement = await agent
      .patch(`/api/v1/portfolios/${pid}/cash/movements/${movementId}`)
      .set(...XRW)
      .send({ amountEur: 600 });
    expect(editMovement.status).toBe(409);
    expectLocked(editMovement, 2025);

    const noteOnly = await agent
      .patch(`/api/v1/portfolios/${pid}/cash/movements/${movementId}`)
      .set(...XRW)
      .send({ note: 'annotated after rollover' });
    expect(noteOnly.status).toBe(200);

    const delMovement = await agent
      .delete(`/api/v1/portfolios/${pid}/cash/movements/${movementId}`)
      .set(...XRW)
      .send({});
    expect(delMovement.status).toBe(409);
    expectLocked(delMovement, 2025);

    // Open-year (2026) writes are completely unaffected.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 2,
      price: 90,
      executedAt: '2026-01-15T10:00:00.000Z',
    });

    // The report states the policy: 2025 locked, the open year unmarked.
    const years = await yearSummaries(agent, pid);
    expect(years.find((y) => y.year === 2025)).toMatchObject({ locked: true, taxNetEur: 55 });
    expect(years.find((y) => y.year === 2026)?.locked).toBeUndefined();
  });

  it('locks elapsed years regardless of tax mode (none-mode report carries the flag too)', async () => {
    const { agent, pid, asset } = await setup('none');
    await seed2025History(agent, pid, asset.id);
    clock = Date.parse('2026-02-01T12:00:00.000Z');
    const res = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 80,
        executedAt: '2025-10-01T10:00:00.000Z',
      },
      409,
    );
    expectLocked(res, 2025);
    const years = await yearSummaries(agent, pid);
    expect(years.find((y) => y.year === 2025)).toMatchObject({ locked: true });
  });
});

// ─── The unlock ritual ───────────────────────────────────────────────────────

describe('tax year locking — unlock ritual', () => {
  it('re-verifies the password, audits both transitions, and never opens the current year', async () => {
    const { agent, user } = await setup();
    clock = Date.parse('2026-02-01T12:00:00.000Z');

    // Wrong password → 401 + audited failure; nothing unlocks.
    const wrong = await unlock(agent, 2025, 'not-the-password', 401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await auditActions()).toContain('tax_year.unlock_reauth_fail');

    // Correct password → the year opens and the state responds.
    const opened = await unlock(agent, 2025, user.password);
    expect(taxYearLockStateResponseSchema.safeParse(opened.body).success).toBe(true);
    expect(opened.body).toEqual({ currentYear: 2026, unlockedYears: [2025] });
    expect(await auditActions()).toContain('tax_year.unlocked');

    // Idempotent second unlock: state unchanged, no second audit row.
    await unlock(agent, 2025, user.password);
    expect((await auditActions()).filter((a) => a === 'tax_year.unlocked')).toHaveLength(1);

    // The lock-state read agrees.
    const state = await agent.get('/api/v1/settings/taxes/years');
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ currentYear: 2026, unlockedYears: [2025] });

    // The current (open) year is never lockable/unlockable.
    const current = await unlock(agent, 2026, user.password, 400);
    expect(current.body.error.code).toBe('TAX_YEAR_NOT_LOCKABLE');
    const relockCurrent = await relock(agent, 2026, 400);
    expect(relockCurrent.body.error.code).toBe('TAX_YEAR_NOT_LOCKABLE');

    // Re-lock → audited, state empty again.
    const closed = await relock(agent, 2025);
    expect(closed.body).toEqual({ currentYear: 2026, unlockedYears: [] });
    expect(await auditActions()).toContain('tax_year.relocked');
  });

  it('requires account:security from a bearer and preserves cookie-session access', async () => {
    const { agent, user } = await setup();
    clock = Date.parse('2026-02-01T12:00:00.000Z');
    const unrelated = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'full key', scopes: ['portfolio:read', 'portfolio:write', 'social:write'] });
    expect(unrelated.status).toBe(201);
    const unrelatedAuth = `Bearer ${unrelated.body.token as string}`;

    for (const call of [
      request(harness.app)
        .post('/api/v1/settings/taxes/years/2025/unlock')
        .set('Authorization', unrelatedAuth)
        .send({ password: user.password }),
      request(harness.app)
        .post('/api/v1/settings/taxes/years/2025/relock')
        .set('Authorization', unrelatedAuth)
        .send({}),
      request(harness.app).get('/api/v1/settings/taxes/years').set('Authorization', unrelatedAuth),
    ]) {
      const res = await call;
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE');
      expect(res.body.error.message).toContain('account:security');
    }

    const scoped = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'native account security', scopes: ['account:security'] });
    expect(scoped.status).toBe(201);
    const scopedAuth = `Bearer ${scoped.body.token as string}`;
    await request(harness.app)
      .get('/api/v1/settings/taxes/years')
      .set('Authorization', scopedAuth)
      .expect(200);
    await request(harness.app)
      .post('/api/v1/settings/taxes/years/2025/unlock')
      .set('Authorization', scopedAuth)
      .send({ password: user.password })
      .expect(200);
    await request(harness.app)
      .post('/api/v1/settings/taxes/years/2025/relock')
      .set('Authorization', scopedAuth)
      .send({})
      .expect(200);

    // The session remains unchanged alongside the newly admitted bearer.
    const state = await agent.get('/api/v1/settings/taxes/years');
    expect(state.status).toBe(200);
  });
});

// ─── Amendments: unlock → write → re-lock ────────────────────────────────────

describe('tax year locking — amendment round trip', () => {
  it('unlocked writes settle cent-exactly through the closed-year machinery, then re-lock refuses again', async () => {
    const { agent, user, pid, asset } = await setup();
    await seed2025History(agent, pid, asset.id);
    clock = Date.parse('2026-02-01T12:00:00.000Z');

    await unlock(agent, 2025, user.password);
    // The report now states amendment mode: elapsed but locked: false.
    let years = await yearSummaries(agent, pid);
    expect(years.find((y) => y.year === 2025)).toMatchObject({ locked: false });

    // Backdated sell into the unlocked year: 5 @ €160 → gain 300; the AT pool
    // (200 + 300 = 500) targets €137.50, so the marginal +€82.50 freezes onto
    // the row — the untouched ΔF machinery at work.
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 5,
      price: 160,
      executedAt: '2025-09-01T10:00:00.000Z',
      addProceedsToCash: true,
    });
    years = await yearSummaries(agent, pid);
    expect(years.find((y) => y.year === 2025)).toMatchObject({
      locked: false,
      realizedPnlEur: 500,
      taxNetEur: 137.5,
    });
    const settlements = (await cashMovements(agent, pid)).filter(
      (m) => m.kind === 'tax_withholding',
    );
    expect(settlements.map((m) => m.amountEur).sort((a, b) => a - b)).toEqual([-82.5, -55]);

    // Re-lock: the very same write shape 409s again; the report re-states it.
    await relock(agent, 2025);
    const refused = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 100,
        executedAt: '2025-11-01T10:00:00.000Z',
      },
      409,
    );
    expectLocked(refused, 2025);
    years = await yearSummaries(agent, pid);
    expect(years.find((y) => y.year === 2025)).toMatchObject({ locked: true, taxNetEur: 137.5 });
  });

  it('refuses an amendment whose reshape reaches a LATER still-locked year, then allows it once that year is unlocked too', async () => {
    const { agent, user, pid, asset } = await setup();
    // 2024: buy 10 @ €100. 2025: sell 5 @ €140 (avg 100 → gain 200, tax €55).
    clock = Date.parse('2024-06-01T12:00:00.000Z');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 100,
      executedAt: '2024-02-01T10:00:00.000Z',
    });
    clock = Date.parse('2025-06-01T12:00:00.000Z');
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'sell',
      quantity: 5,
      price: 140,
      executedAt: '2025-05-01T10:00:00.000Z',
      addProceedsToCash: true,
    });
    clock = Date.parse('2026-02-01T12:00:00.000Z');

    // Unlock only 2024. A backdated 2024 buy shifts the moving average under
    // the 2025 engine-frozen sell — 2025 is still locked, so the amendment is
    // refused naming 2025 (not 2024).
    await unlock(agent, 2024, user.password);
    const refused = await trade(
      agent,
      pid,
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 10,
        price: 120,
        executedAt: '2024-12-01T10:00:00.000Z',
      },
      409,
    );
    expect(refused.body.error.code).toBe('TAX_YEAR_LOCKED');
    expect(refused.body.error.details).toMatchObject({ year: 2025, amendedYear: 2024 });

    // Unlock 2025 as well → the same amendment lands, and 2025 re-settles
    // append-only: avg (10×100 + 10×120)/20 = 110 → gain 150 → target €41.25,
    // so a €13.75 refund correction posts into year 2025.
    await unlock(agent, 2025, user.password);
    await trade(agent, pid, {
      assetId: asset.id,
      side: 'buy',
      quantity: 10,
      price: 120,
      executedAt: '2024-12-01T10:00:00.000Z',
    });
    const refunds = (await cashMovements(agent, pid)).filter((m) => m.kind === 'tax_refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amountEur: 13.75, taxYear: 2025 });
    const years = await yearSummaries(agent, pid);
    expect(years.find((y) => y.year === 2025)).toMatchObject({ locked: false, taxNetEur: 41.25 });
  });

  it('unlocking lets a locked-year row be deleted and its year re-settle', async () => {
    const { agent, user, pid, asset } = await setup();
    await seed2025History(agent, pid, asset.id);
    const txns = await agent.get(`/api/v1/portfolios/${pid}/transactions`);
    const sell = txns.body.items.find((t: { side: string }) => t.side === 'sell');
    clock = Date.parse('2026-02-01T12:00:00.000Z');

    await unlock(agent, 2025, user.password);
    const del = await agent
      .delete(`/api/v1/portfolios/${pid}/transactions/${sell.id}`)
      .set(...XRW)
      .send({});
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    // The sell, its attached €55 withholding and its proceeds leg cascaded
    // away and the ΔF settlement resolves to exactly zero (held and target
    // both dropped by €55) — nothing tax-related remains in 2025, so the year
    // leaves the report entirely and no stray correction was posted.
    const years = await yearSummaries(agent, pid);
    expect(years.find((y) => y.year === 2025)).toBeUndefined();
    expect(await cashMovements(agent, pid)).toHaveLength(0);
  });
});

// ─── The user boundary ───────────────────────────────────────────────────────

describe('tax year locking — per-user boundary', () => {
  it("one user's unlock never opens another user's years", async () => {
    const { agent: alice, user: aliceUser } = await setup();
    clock = Date.parse('2026-02-01T12:00:00.000Z');
    await unlock(alice, 2025, aliceUser.password);

    const bob = await harness.seedUser({ email: 'bob@example.com', username: 'bob' });
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const bobPid = await defaultPortfolioId(bobAgent);
    const bobDeposit = await bobAgent
      .post(`/api/v1/portfolios/${bobPid}/cash/deposit`)
      .set(...XRW)
      .send({ amountEur: 100, executedAt: '2025-03-01T10:00:00.000Z' });
    expect(bobDeposit.status).toBe(409);
    expect(bobDeposit.body.error.code).toBe('TAX_YEAR_LOCKED');

    const unlockRows = await harness.db
      .select()
      .from(schema.taxYearUnlocks)
      .where(eq(schema.taxYearUnlocks.year, 2025));
    expect(unlockRows).toHaveLength(1);
  });
});
