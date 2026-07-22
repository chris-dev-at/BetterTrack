import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MIRROR_CONFLICT,
  MIRROR_OP_VERSION,
  MIRROR_SYNC_STALLED,
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  type MirrorOpPayload,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createCashMovementRepository } from '../data/repositories/cashMovementRepository';
import { createMirrorchainRepository } from '../data/repositories/mirrorchainRepository';
import { ApiError } from '../errors';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * MIRRORCHAIN M2 — the replication core (`docs/mirrorchain-design.md` §§2–3,
 * §8–§9; issue #644). The §12 unit-test list: total-order convergence,
 * idempotent replay, conflict guard, per-copy tax freeze, force-mode solvency,
 * set-balance delta — plus the submit-path invariants (origin catch-up,
 * stall = never skip / never reorder) and the §13.5 "a member's buy appears in
 * every copy, attributed" behavior over real HTTP.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function seedAsset(h: TestHarness, symbol = 'BAYN.DE') {
  const [row] = await h.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: symbol,
      type: 'stock',
      symbol,
      name: `${symbol} Corp`,
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  return row!;
}

let harness: TestHarness;
let mirrorRepo: ReturnType<typeof createMirrorchainRepository>;

beforeEach(async () => {
  harness = await createTestApp();
  mirrorRepo = createMirrorchainRepository(harness.db);
});

/** Owner alice with a converted default portfolio; bob attached with a synced copy. */
async function setupChain() {
  const alice = await harness.seedUser({ email: 'alice@bettertrack.test', username: 'alice' });
  const bob = await harness.seedUser({ email: 'bob@bettertrack.test', username: 'bob' });
  const asset = await seedAsset(harness);
  const aPid = await harness.ctx.portfolio.getDefaultPortfolioId(alice.id);
  const { chain } = await harness.ctx.mirror.convertToChain(alice.id, aPid, { name: 'Family' });
  const { portfolioId: bPid } = await harness.ctx.mirror.attachMemberCopy(chain.id, bob.id);
  await harness.ctx.mirror.replicateChain(chain.id);
  return { alice, bob, asset, aPid, bPid, chain };
}

async function sourceBalances(userId: string, portfolioId: string) {
  const { sources } = await harness.ctx.portfolio.listCashSources(userId, portfolioId, {
    includeArchived: true,
  });
  return sources;
}

async function mirrorAuditRows(portfolioId: string) {
  const rows = await harness.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, 'mirror.op_applied'));
  return rows.filter((r) => (r.meta as { portfolioId?: string })?.portfolioId === portfolioId);
}

describe('mirrorchain M2 — replication core', () => {
  it("a member's buy appears in every copy, attributed and tagged (HTTP; non-chain portfolios untouched)", async () => {
    const { alice, bob, asset, aPid, bPid, chain } = await setupChain();

    const agent = await loginAgent(harness.app, alice.email, alice.password);
    const res = await agent
      .post(`/api/v1/portfolios/${aPid}/transactions`)
      .set(...XRW)
      .send({
        assetId: asset.id,
        side: 'buy',
        quantity: 5,
        price: 100,
        executedAt: new Date().toISOString(),
      });
    expect(res.status).toBe(201);
    await harness.ctx.mirror.replicateChain(chain.id);

    // The origin row keeps its real write-path tag; the replica is sync-tagged.
    const aList = await harness.ctx.portfolio.listTransactions(alice.id, aPid, {});
    const bList = await harness.ctx.portfolio.listTransactions(bob.id, bPid, {});
    expect(aList.items).toHaveLength(1);
    expect(aList.items[0]!.source).toBe('manual');
    expect(bList.items).toHaveLength(1);
    expect(bList.items[0]!.quantity).toBe(5);
    expect(bList.items[0]!.price).toBe(100);
    expect(bList.items[0]!.source).toBe(SOURCE_TAG_SYNC_MIRRORCHAIN);

    // Attribution rides mirror_rows on the replica (design §2/§10).
    const link = await mirrorRepo.findMirrorRowByLocal('transaction', bList.items[0]!.id);
    expect(link?.mirrorId).toBe(aList.items[0]!.id);
    expect(link?.createdByUsername).toBe('alice');

    // One audit row per applied op per copy (§2): the buy on both copies.
    expect((await mirrorAuditRows(aPid)).some((r) => r.actorId === alice.id)).toBe(true);
    expect((await mirrorAuditRows(bPid)).some((r) => r.actorId === alice.id)).toBe(true);

    // A NON-chain portfolio write stays byte-identical: no ops, no links.
    const bobOwnPid = await harness.ctx.portfolio.getDefaultPortfolioId(bob.id);
    const opsBefore = (await mirrorRepo.getChain(chain.id))!.lastSeq;
    await harness.ctx.mirror.submitCashDeposit(bob.id, bobOwnPid, { amountEur: 10 });
    expect((await mirrorRepo.getChain(chain.id))!.lastSeq).toBe(opsBefore);
    expect(await mirrorRepo.listMirrorRowsForPortfolio(bobOwnPid)).toHaveLength(0);
  });

  it('total-order convergence: concurrent edits — one 409 MIRROR_CONFLICT, refetch + re-submit, all copies converge (§3 worked example)', async () => {
    const { alice, bob, asset, aPid, bPid, chain } = await setupChain();
    const [tx] = await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 5,
        price: 100,
        fee: 0,
        executedAt: new Date().toISOString(),
      },
    ]);
    await harness.ctx.mirror.replicateChain(chain.id);
    const mirrorId = tx!.id;
    const bLocal = (await mirrorRepo.findMirrorRow('transaction', mirrorId, bPid))!.localId;
    const baseSeq = (await mirrorRepo.latestOpForEntity(chain.id, mirrorId))!.seq;

    // Alice submits qty 5→6, Bob simultaneously price 100→110, both against
    // the same base version. The chain lock serializes them: exactly one wins
    // the seq race, the other is refused 409 MIRROR_CONFLICT at append.
    const [ra, rb] = await Promise.allSettled([
      harness.ctx.mirror.submitTransactionUpdate(
        alice.id,
        aPid,
        mirrorId,
        { quantity: 6 },
        { baseSeq },
      ),
      harness.ctx.mirror.submitTransactionUpdate(bob.id, bPid, bLocal, { price: 110 }, { baseSeq }),
    ]);
    const rejected = [ra, rb].filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(MIRROR_CONFLICT);
    expect(err.statusCode).toBe(409);

    // The loser refetches (fresh version) and re-submits their intent.
    const freshSeq = (await mirrorRepo.latestOpForEntity(chain.id, mirrorId))!.seq;
    if (ra.status === 'rejected') {
      await harness.ctx.mirror.submitTransactionUpdate(
        alice.id,
        aPid,
        mirrorId,
        { quantity: 6 },
        { baseSeq: freshSeq },
      );
    } else {
      const bLocalNow = (await mirrorRepo.findMirrorRow('transaction', mirrorId, bPid))!.localId;
      await harness.ctx.mirror.submitTransactionUpdate(
        bob.id,
        bPid,
        bLocalNow,
        { price: 110 },
        { baseSeq: freshSeq },
      );
    }
    await harness.ctx.mirror.replicateChain(chain.id);

    // Every copy holds both edits; the oplog shows both actors.
    for (const [userId, pid] of [
      [alice.id, aPid],
      [bob.id, bPid],
    ] as const) {
      const { items } = await harness.ctx.portfolio.listTransactions(userId, pid, {});
      expect(items).toHaveLength(1);
      expect(items[0]!.quantity).toBe(6);
      expect(items[0]!.price).toBe(110);
    }
    const ops = await mirrorRepo.listOpsSince(chain.id, 0);
    const updates = ops.filter((o) => o.kind === 'tx.update');
    expect(updates).toHaveLength(2);
    expect(new Set(updates.map((o) => o.actorUsername))).toEqual(new Set(['alice', 'bob']));
  });

  it('convergence under a bypassed guard: injected same-entity ops resolve whole-op LWW by seq (§3 defense-in-depth)', async () => {
    const { alice, bob, asset, aPid, bPid, chain } = await setupChain();
    const [tx] = await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 5,
        price: 100,
        fee: 0,
        executedAt: new Date().toISOString(),
      },
    ]);
    await harness.ctx.mirror.replicateChain(chain.id);

    const fullState = (
      quantity: number,
      price: number,
    ): Extract<MirrorOpPayload, { kind: 'tx.update' }> => ({
      opVersion: MIRROR_OP_VERSION,
      kind: 'tx.update' as const,
      mirrorId: tx!.id,
      baseSeq: 0, // deliberately stale — the raw append bypasses the guard
      side: 'buy' as const,
      quantity,
      price,
      fee: 0,
      executedAt: new Date(tx!.executedAt).toISOString(),
      note: null,
      allowUncovered: false,
      uncoveredEntryPrice: null,
      payFromCash: false,
      addProceedsToCash: false,
      cashSourceMirrorId: null,
    });
    const actor = { actorUserId: alice.id, actorUsername: 'alice', originPortfolioId: null };
    await mirrorRepo.appendOps(chain.id, [
      { kind: 'tx.update', mirrorId: tx!.id, ...actor, payload: fullState(6, 100) },
      { kind: 'tx.update', mirrorId: tx!.id, ...actor, payload: fullState(5, 110) },
    ]);
    await harness.ctx.mirror.replicateChain(chain.id);

    // The highest-seq op's FULL state wins everywhere — a whole-op win, never
    // a field merge (which would manufacture {6, 110} here).
    for (const [userId, pid] of [
      [alice.id, aPid],
      [bob.id, bPid],
    ] as const) {
      const { items } = await harness.ctx.portfolio.listTransactions(userId, pid, {});
      expect(items[0]!.quantity).toBe(5);
      expect(items[0]!.price).toBe(110);
    }
  });

  it('idempotent replay: re-delivering already-applied ops has no effect (watermark crash-heal, §2)', async () => {
    const { alice, bob, asset, aPid, bPid, chain } = await setupChain();
    await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 2,
        price: 10,
        fee: 0,
        executedAt: new Date().toISOString(),
      },
    ]);
    await harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 100 });
    await harness.ctx.mirror.replicateChain(chain.id);

    const txsBefore = (await harness.ctx.portfolio.listTransactions(bob.id, bPid, {})).items;
    const cashBefore = await harness.ctx.portfolio.getCashMovements(bob.id, bPid);
    const auditBefore = (await mirrorAuditRows(bPid)).length;

    // Simulate a crash between service commit and watermark bump: rewind Bob's
    // watermark to zero and re-deliver the whole log.
    const bMember = await mirrorRepo.findActiveMembershipByPortfolio(bPid);
    await harness.db
      .update(schema.mirrorChainMembers)
      .set({ appliedSeq: 0 })
      .where(eq(schema.mirrorChainMembers.id, bMember!.id));
    await harness.ctx.mirror.replicateChain(chain.id);

    const txsAfter = (await harness.ctx.portfolio.listTransactions(bob.id, bPid, {})).items;
    const cashAfter = await harness.ctx.portfolio.getCashMovements(bob.id, bPid);
    expect(txsAfter).toHaveLength(txsBefore.length);
    expect(cashAfter.movements).toHaveLength(cashBefore.movements.length);
    expect(cashAfter.balanceEur).toBe(cashBefore.balanceEur);
    // Skipped re-applies write no duplicate audit rows.
    expect((await mirrorAuditRows(bPid)).length).toBe(auditBefore);
    const member = await mirrorRepo.findActiveMembershipByPortfolio(bPid);
    expect(member!.appliedSeq).toBe((await mirrorRepo.getChain(chain.id))!.lastSeq);
  });

  it('append guards refuse stale edits, deleted entities and non-members without consuming seqs (§2/§3)', async () => {
    const { alice, bob, asset, aPid, chain } = await setupChain();
    const [tx] = await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: new Date().toISOString(),
      },
    ]);
    const latest = (await mirrorRepo.latestOpForEntity(chain.id, tx!.id))!.seq;
    const seqBefore = (await mirrorRepo.getChain(chain.id))!.lastSeq;
    const deletePayload: Extract<MirrorOpPayload, { kind: 'tx.delete' }> = {
      opVersion: MIRROR_OP_VERSION,
      kind: 'tx.delete',
      mirrorId: tx!.id,
      baseSeq: latest,
    };

    // Stale baseSeq → CONFLICT.
    const conflict = await mirrorRepo.appendOpsChecked(chain.id, bob.id, [
      {
        kind: 'tx.delete',
        mirrorId: tx!.id,
        actorUserId: bob.id,
        actorUsername: 'bob',
        payload: { ...deletePayload, baseSeq: latest - 1 },
        baseSeq: latest - 1,
      },
    ]);
    expect(conflict).toMatchObject({ refused: 'CONFLICT', actualSeq: latest });

    // A non-member (never joined) → NOT_A_MEMBER.
    const carol = await harness.seedUser({ email: 'carol@bettertrack.test', username: 'carol' });
    const nonMember = await mirrorRepo.appendOpsChecked(chain.id, carol.id, [
      {
        kind: 'tx.delete',
        mirrorId: tx!.id,
        actorUserId: carol.id,
        actorUsername: 'carol',
        payload: deletePayload,
        baseSeq: latest,
      },
    ]);
    expect(nonMember).toMatchObject({ refused: 'NOT_A_MEMBER' });

    // Refusals roll the whole append back — no seq was consumed.
    expect((await mirrorRepo.getChain(chain.id))!.lastSeq).toBe(seqBefore);

    // A delete is terminal: any later op targeting the entity → ROW_DELETED.
    await harness.ctx.mirror.submitTransactionDelete(alice.id, aPid, tx!.id);
    const afterDelete = await mirrorRepo.appendOpsChecked(chain.id, alice.id, [
      {
        kind: 'tx.update',
        mirrorId: tx!.id,
        actorUserId: alice.id,
        actorUsername: 'alice',
        payload: deletePayload, // payload shape irrelevant — the guard fires first
        baseSeq: latest + 1,
      },
    ]);
    expect(afterDelete).toMatchObject({ refused: 'ROW_DELETED' });
  });

  it('per-copy tax freeze: a replicated dividend is taxed under the APPLYING copy’s own mode (§9)', async () => {
    const { alice, bob, asset, aPid, bPid, chain } = await setupChain();
    // Bob's book is Austrian; Alice records untaxed.
    await harness.ctx.tax.updateSettings(bob.id, { mode: 'country_specific', country: 'AT' });
    await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 10,
        fee: 0,
        executedAt: new Date().toISOString(),
      },
    ]);
    await harness.ctx.mirror.submitDividendRecord(alice.id, aPid, {
      assetId: asset.id,
      grossAmountEur: 100,
    });
    await harness.ctx.mirror.replicateChain(chain.id);

    const aDividends = (await harness.ctx.tax.listDividends(alice.id, aPid)).dividends;
    const bDividends = (await harness.ctx.tax.listDividends(bob.id, bPid)).dividends;
    expect(aDividends).toHaveLength(1);
    expect(bDividends).toHaveLength(1);
    // Frozen per copy at apply time: none-mode on Alice's copy, the AT engine
    // on Bob's — tax facts never replicate (§9).
    expect(aDividends[0]!.taxMode).toBe('none');
    expect(bDividends[0]!.taxMode).toBe('country_specific');
    expect(bDividends[0]!.taxCountry).toBe('AT');
    expect(bDividends[0]!.source).toBe(SOURCE_TAG_SYNC_MIRRORCHAIN);
    // Alice's copy carries no tax movements at all — Bob's settlement is his own.
    const aCash = await harness.ctx.portfolio.getCashMovements(alice.id, aPid);
    expect(
      aCash.movements.some((m) => m.kind === 'tax_withholding' || m.kind === 'tax_refund'),
    ).toBe(false);
  });

  it('set-balance replicates the origin-computed delta; force mode lets a skewed copy go honestly negative (§2/§8)', async () => {
    const { alice, bob, aPid, bPid, chain } = await setupChain();
    await harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 100 });
    await harness.ctx.mirror.replicateChain(chain.id);

    // Copy-local skew: a tax settlement exists only in Bob's book (§9).
    const cmRepo = createCashMovementRepository(harness.db);
    const bMain = (await sourceBalances(bob.id, bPid)).find((s) => s.isMain)!;
    await cmRepo.insert(bPid, {
      sourceId: bMain.id,
      kind: 'tax_withholding',
      amountEur: -27.5,
      executedAt: new Date(),
      note: null,
      taxYear: new Date().getFullYear(),
    });

    // "Set to 500" on Alice's copy (balance 100) → op carries delta +400.
    const aMain = (await sourceBalances(alice.id, aPid)).find((s) => s.isMain)!;
    const res = await harness.ctx.mirror.submitSetCashBalance(alice.id, aPid, aMain.id, {
      balanceEur: 500,
    });
    expect(res.deltaEur).toBe(400);
    const setOp = (await mirrorRepo.listOpsSince(chain.id, 0)).find(
      (o) => o.kind === 'cash.setBalance',
    );
    expect((setOp!.payload as { deltaEur: number }).deltaEur).toBe(400);
    await harness.ctx.mirror.replicateChain(chain.id);

    // Bob's copy applied the DELTA, not "set to 500" — his book, his truth.
    expect((await sourceBalances(bob.id, bPid)).find((s) => s.isMain)!.balanceEur).toBe(472.5);
    expect((await sourceBalances(alice.id, aPid)).find((s) => s.isMain)!.balanceEur).toBe(500);

    // Alice withdraws her full 500; Bob's skewed copy force-applies and renders
    // its negative balance honestly rather than diverging (§8).
    await harness.ctx.mirror.submitCashWithdraw(alice.id, aPid, { amountEur: 500 });
    await harness.ctx.mirror.replicateChain(chain.id);
    expect((await sourceBalances(alice.id, aPid)).find((s) => s.isMain)!.balanceEur).toBe(0);
    expect((await sourceBalances(bob.id, bPid)).find((s) => s.isMain)!.balanceEur).toBe(-27.5);
  });

  it('origin-first strict-seq apply: a submit catches the writer’s own copy up before their write (§2)', async () => {
    const { alice, bob, aPid, bPid, chain } = await setupChain();
    // Alice's deposit is appended but NOT yet replicated to Bob.
    await harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 40 });
    expect((await harness.ctx.portfolio.getCashMovements(bob.id, bPid)).movements).toHaveLength(0);

    // Bob writes: his copy must first apply Alice's earlier op, in order —
    // which also funds his (origin-validated, non-force) withdrawal.
    await harness.ctx.mirror.submitCashWithdraw(bob.id, bPid, { amountEur: 10 });
    const bCash = await harness.ctx.portfolio.getCashMovements(bob.id, bPid);
    expect(bCash.movements.map((m) => m.kind).sort()).toEqual(['deposit', 'withdrawal']);
    expect(bCash.balanceEur).toBe(30);
    const bMember = await mirrorRepo.findActiveMembershipByPortfolio(bPid);
    expect(bMember!.appliedSeq).toBe((await mirrorRepo.getChain(chain.id))!.lastSeq);

    // Alice's copy sees Bob's withdrawal via the replicate job, attributed.
    await harness.ctx.mirror.replicateChain(chain.id);
    const aCash = await harness.ctx.portfolio.getCashMovements(alice.id, aPid);
    expect(aCash.balanceEur).toBe(30);
    const bWithdrawal = aCash.movements.find((m) => m.kind === 'withdrawal')!;
    expect(bWithdrawal.source).toBe(SOURCE_TAG_SYNC_MIRRORCHAIN);
    const link = await mirrorRepo.findMirrorRowByLocal('cash_movement', bWithdrawal.id);
    expect(link?.createdByUsername).toBe('bob');
  });

  it('a stalled op is never skipped and never reordered: the copy freezes at its watermark and new writes refuse 503 (§2)', async () => {
    const { alice, bob, aPid, bPid, chain } = await setupChain();
    await harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 50 });
    await harness.ctx.mirror.replicateChain(chain.id);
    const stalledAt = (await mirrorRepo.getChain(chain.id))!.lastSeq;

    // A poison op (unknown asset — deterministic apply failure), then a valid
    // op behind it, both injected past the submit path's origin validation.
    const actor = { actorUserId: alice.id, actorUsername: 'alice', originPortfolioId: null };
    await mirrorRepo.appendOps(chain.id, [
      {
        kind: 'tx.create',
        mirrorId: '018f0000-0000-7000-8000-0000000000aa',
        ...actor,
        payload: {
          opVersion: MIRROR_OP_VERSION,
          kind: 'tx.create',
          mirrorId: '018f0000-0000-7000-8000-0000000000aa',
          assetId: '018f0000-0000-7000-8000-0000000000ab', // does not exist
          side: 'buy',
          quantity: 1,
          price: 1,
          fee: 0,
          executedAt: new Date().toISOString(),
          note: null,
          allowUncovered: false,
          uncoveredEntryPrice: null,
          payFromCash: false,
          addProceedsToCash: false,
          cashSourceMirrorId: null,
          settleCashAsOfToday: false,
          originSource: 'manual',
        },
      },
      {
        kind: 'cash.deposit',
        mirrorId: '018f0000-0000-7000-8000-0000000000ac',
        ...actor,
        payload: {
          opVersion: MIRROR_OP_VERSION,
          kind: 'cash.deposit',
          mirrorId: '018f0000-0000-7000-8000-0000000000ac',
          sourceMirrorId: null,
          amountEur: 5,
          executedAt: new Date().toISOString(),
          note: null,
          originSource: 'manual',
        },
      },
    ]);

    // The replicate run throws (→ BullMQ retry → dead-letter → Problems), and
    // every copy freezes at the watermark BEFORE the poison op — the valid op
    // behind it is not applied out of order.
    await expect(harness.ctx.mirror.replicateChain(chain.id)).rejects.toThrow(/stalled/);
    for (const pid of [aPid, bPid]) {
      const member = await mirrorRepo.findActiveMembershipByPortfolio(pid);
      expect(member!.appliedSeq).toBe(stalledAt);
    }
    expect((await harness.ctx.portfolio.getCashMovements(bob.id, bPid)).movements).toHaveLength(1); // the first deposit only — never the one behind the stall

    // New writes refuse rather than apply out of order (§2).
    await expect(
      harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 1 }),
    ).rejects.toMatchObject({ code: MIRROR_SYNC_STALLED, statusCode: 503 });
  });

  it('tax-immutable/cash-linked rows: a financial edit applies per copy via the delete-and-re-add correction path (§2)', async () => {
    const { alice, bob, asset, aPid, bPid, chain } = await setupChain();
    await harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 1000 });
    const [tx] = await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 10,
        price: 50,
        fee: 0,
        executedAt: new Date().toISOString(),
        payFromCash: true,
      },
    ]);
    await harness.ctx.mirror.replicateChain(chain.id);
    const bLocalBefore = (await mirrorRepo.findMirrorRow('transaction', tx!.id, bPid))!.localId;

    // A cash-linked row is financially immutable in place — the chain applies
    // the edit as delete + re-create, re-pointing the mirror link (§2).
    const updated = await harness.ctx.mirror.submitTransactionUpdate(alice.id, aPid, tx!.id, {
      price: 60,
    });
    expect(updated.price).toBe(60);
    expect(updated.id).not.toBe(tx!.id); // re-created on the origin too
    await harness.ctx.mirror.replicateChain(chain.id);

    for (const [userId, pid] of [
      [alice.id, aPid],
      [bob.id, bPid],
    ] as const) {
      const { items } = await harness.ctx.portfolio.listTransactions(userId, pid, {});
      expect(items).toHaveLength(1);
      expect(items[0]!.price).toBe(60);
      const cash = await harness.ctx.portfolio.getCashMovements(userId, pid);
      // The re-derived cash leg follows the new numbers: 1000 − 600.
      expect(cash.balanceEur).toBe(400);
    }
    const bLink = await mirrorRepo.findMirrorRow('transaction', tx!.id, bPid);
    expect(bLink!.localId).not.toBe(bLocalBefore);
  });
});
