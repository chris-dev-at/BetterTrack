import { eq } from 'drizzle-orm';
import postgres from 'postgres';
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
import { withExclusiveParanoidTransitionTestLock } from '../data/repositories/paranoidEnforcementRepository';
import { ApiError } from '../errors';
import type { DispatchableEvent } from '../services/notifications/notificationDispatcher';
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
const REAL_DATABASE_URL = process.env.TEST_DATABASE_URL;
const FORCE_DELETE_PAUSE_LOCK = [1128, 1] as const;

// Deterministic TEST VECTOR ids and verifier-shaped strings are public fixtures,
// not credentials or production retirement material.
const VAULTED_REPLAY_TEST_VECTOR = {
  vaultId: '019c8600-0000-7000-8000-000000000001',
  headerDocId: '019c8600-0000-7000-8000-000000000002',
  commonDocId: '019c8600-0000-7000-8000-000000000003',
  retirementProofPublicKey: 'TEST VECTOR mirror replay public verifier',
  keyFingerprint: 'TEST-VECTOR-MIRROR-REPLAY-0001',
} as const;

interface DatabaseLockWait {
  pid: number;
  query: string;
  waitEvent: string | null;
}

async function waitForAdvisoryWait(
  observer: ReturnType<typeof postgres>,
  predicate: (row: DatabaseLockWait) => boolean,
  description: string,
): Promise<DatabaseLockWait> {
  const deadline = Date.now() + 5_000;
  let observed: DatabaseLockWait[] = [];
  while (Date.now() < deadline) {
    observed = await observer<DatabaseLockWait[]>`
      SELECT pid, query, wait_event AS "waitEvent"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `;
    const match = observed.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${description}; observed ${JSON.stringify(
      observed.map(({ pid, query, waitEvent }) => ({ pid, query, waitEvent })),
    )}`,
  );
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

async function startWinningParanoidTransition(userId: string): Promise<{
  finish(): Promise<void>;
}> {
  let releaseTransition!: () => void;
  let transitionLocked!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    transitionLocked = resolve;
  });
  const transition = withExclusiveParanoidTransitionTestLock(harness.db, userId, async () => {
    await harness.db
      .update(schema.users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 1,
      })
      .where(eq(schema.users.id, userId));
    transitionLocked();
    await release;
  });
  await locked;
  return {
    async finish() {
      releaseTransition();
      await transition;
    },
  };
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

  it.skipIf(!REAL_DATABASE_URL)(
    'serializes replica force-delete against a direct withdrawal so the ledger never goes negative',
    async () => {
      const { alice, bob, aPid, bPid, chain } = await setupChain();
      await harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 100 });
      await harness.ctx.mirror.replicateChain(chain.id);

      const movementRepo = createCashMovementRepository(harness.db);
      const funding = (await movementRepo.listForPortfolio(bPid)).find(
        (movement) => movement.kind === 'deposit' && movement.amountEur === 100,
      );
      if (!funding) throw new Error('Replica funding movement was not applied');

      let controller: ReturnType<typeof postgres> | undefined;
      let observer: ReturnType<typeof postgres> | undefined;
      let releasePause: (() => void) | undefined;
      let deletion: Promise<unknown> | undefined;
      let withdrawalSettled: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let pauseOwner: Promise<unknown> | undefined;
      let bodyFailed = false;
      let bodyFailure: unknown;
      const cleanupFailures: unknown[] = [];

      try {
        controller = postgres(REAL_DATABASE_URL!, { max: 1 });
        observer = postgres(REAL_DATABASE_URL!, { max: 1 });
        let pauseOwned!: () => void;
        const release = new Promise<void>((resolve) => {
          releasePause = resolve;
        });
        const owned = new Promise<void>((resolve) => {
          pauseOwned = resolve;
        });

        // This trigger is global to the shared table. The integration config's
        // singleFork is therefore part of this harness contract, and the finally
        // cleanup below is load-bearing: no later test may inherit the pause.
        await observer.unsafe(`
          CREATE OR REPLACE FUNCTION bt_test_pause_force_cash_delete()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            PERFORM pg_advisory_xact_lock(${FORCE_DELETE_PAUSE_LOCK[0]}, ${FORCE_DELETE_PAUSE_LOCK[1]});
            RETURN OLD;
          END;
          $$
        `);
        await observer.unsafe(
          'DROP TRIGGER IF EXISTS bt_test_pause_force_cash_delete ON portfolio_cash_movements',
        );
        await observer.unsafe(`
          CREATE TRIGGER bt_test_pause_force_cash_delete
          BEFORE DELETE ON portfolio_cash_movements
          FOR EACH ROW
          EXECUTE FUNCTION bt_test_pause_force_cash_delete()
        `);

        pauseOwner = controller.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(${FORCE_DELETE_PAUSE_LOCK[0]}, ${FORCE_DELETE_PAUSE_LOCK[1]})`;
          pauseOwned();
          await release;
        });

        // The rejection path is load-bearing: a failed BEGIN must not leave the
        // harness waiting for a readiness signal that can no longer arrive.
        await Promise.race([
          owned,
          pauseOwner.then(() => {
            throw new Error('Pause owner completed before signalling readiness');
          }),
        ]);
        // This is the exact PortfolioService force call used by replica apply.
        // The HTTP/mirror seam also admits member withdrawals; its chain mutex
        // normally orders replay and submit, while this lower-level regression
        // proves the cash boundary remains safe if those calls overlap.
        deletion = harness.ctx.portfolio.deleteCashMovement(bob.id, bPid, funding.id, {
          force: true,
        });
        const deleteWait = await waitForAdvisoryWait(
          observer,
          (row) =>
            row.waitEvent === 'advisory' &&
            /delete\s+from\s+"?portfolio_cash_movements"?/iu.test(row.query),
          'the replica force-delete to pause inside its trigger',
        );

        const withdrawal = harness.ctx.portfolio.withdrawCash(bob.id, bPid, {
          amountEur: 75,
          sourceId: funding.sourceId,
          executedAt: new Date(Date.now() + 1_000).toISOString(),
        });
        // Attach the rejection observer immediately: the delete can finish as
        // soon as the pause is released, before the later ledger assertions.
        withdrawalSettled = Promise.allSettled([withdrawal]);
        await waitForAdvisoryWait(
          observer,
          (row) =>
            row.pid !== deleteWait.pid &&
            row.waitEvent === 'advisory' &&
            /pg_advisory_xact_lock/iu.test(row.query),
          'the direct withdrawal to wait behind the replica force-delete',
        );

        releasePause?.();
        await pauseOwner;
        await deletion;
        const [withdrawalResult] = await withdrawalSettled;
        expect(withdrawalResult).toMatchObject({
          status: 'rejected',
          reason: { code: 'INSUFFICIENT_CASH' },
        });

        let running = 0;
        for (const movement of await movementRepo.listForPortfolio(bPid)) {
          if (movement.sourceId !== funding.sourceId) continue;
          running += movement.amountEur;
          expect(running).toBeGreaterThanOrEqual(0);
        }
        expect(running).toBe(0);
      } catch (error) {
        bodyFailed = true;
        bodyFailure = error;
      } finally {
        releasePause?.();
        await pauseOwner?.catch(() => undefined);
        await deletion?.catch(() => undefined);
        await withdrawalSettled?.catch(() => undefined);
        // Retain this structural guard so later additions to trigger cleanup
        // cannot prevent either client from being closed.
        try {
          if (observer) {
            for (const statement of [
              'DROP TRIGGER IF EXISTS bt_test_pause_force_cash_delete ON portfolio_cash_movements',
              'DROP FUNCTION IF EXISTS bt_test_pause_force_cash_delete()',
            ]) {
              try {
                await observer.unsafe(statement);
              } catch (error) {
                cleanupFailures.push(error);
              }
            }
          }
        } finally {
          const endResults = await Promise.allSettled(
            [controller, observer].map(async (client) => {
              await client?.end({ timeout: 1 });
            }),
          );
          for (const result of endResults) {
            if (result.status === 'rejected') cleanupFailures.push(result.reason);
          }
        }
      }

      if (bodyFailed) {
        if (cleanupFailures.length > 0) {
          console.warn(
            'Pause harness cleanup also failed; preserving the original body failure',
            cleanupFailures,
          );
        }
        throw bodyFailure;
      }
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      if (cleanupFailures.length > 1) {
        throw new AggregateError(cleanupFailures, 'Pause harness cleanup failed');
      }
    },
    15_000,
  );

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

  it('the sync_stalled notice fires only off the PERMANENT-stall path (notifyChainStalled), never from replicateChain itself (design §2/§11)', async () => {
    // A capture harness: replicateChain runs synchronously here, so if it emitted
    // sync_stalled on its own (as it used to) a transient blip would notify on
    // attempt 1 of 3. The job now fires notifyChainStalled off the exhausted-
    // retries path instead — so replicateChain's throw must NOT emit.
    const events: DispatchableEvent[] = [];
    const h = await createTestApp({
      notificationEnqueue: async (e) => {
        events.push(e);
      },
    });
    const repo = createMirrorchainRepository(h.db);
    const alice = await h.seedUser({ email: 'alice@bettertrack.test', username: 'alice' });
    const bob = await h.seedUser({ email: 'bob@bettertrack.test', username: 'bob' });
    const aPid = await h.ctx.portfolio.getDefaultPortfolioId(alice.id);
    const { chain } = await h.ctx.mirror.convertToChain(alice.id, aPid, { name: 'Family' });
    await h.ctx.mirror.attachMemberCopy(chain.id, bob.id);
    await h.ctx.mirror.replicateChain(chain.id);

    // A poison op (unknown asset — deterministic apply failure) freezes every copy.
    await repo.appendOps(chain.id, [
      {
        kind: 'tx.create',
        mirrorId: '018f0000-0000-7000-8000-0000000000ba',
        actorUserId: alice.id,
        actorUsername: 'alice',
        originPortfolioId: null,
        payload: {
          opVersion: MIRROR_OP_VERSION,
          kind: 'tx.create',
          mirrorId: '018f0000-0000-7000-8000-0000000000ba',
          assetId: '018f0000-0000-7000-8000-0000000000bb', // does not exist
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
    ]);

    // The replicate run throws (→ retry → dead-letter) but emits NOTHING itself.
    await expect(h.ctx.mirror.replicateChain(chain.id)).rejects.toThrow(/stalled/);
    expect(events.filter((e) => e.type === 'mirror.sync_stalled')).toHaveLength(0);

    // The permanent-stall notice (fired by the job once retries are exhausted):
    // every copy still behind last_seq is stuck, so its member AND the owner hear.
    await h.ctx.mirror.notifyChainStalled(chain.id);
    const keyOf = (e: DispatchableEvent) => `${e.userId}:${(e as { refId: string }).refId}`;
    const stalledEvents = () => events.filter((e) => e.type === 'mirror.sync_stalled');
    const recipients = new Set(stalledEvents().map((e) => e.userId));
    expect(recipients.has(bob.id)).toBe(true); // the lagging member
    expect(recipients.has(alice.id)).toBe(true); // the owner (also a stalled copy)
    const firstKeys = new Set(stalledEvents().map(keyOf));

    // Deduped per copy watermark (design §2): calling again while every copy is
    // still frozen re-uses the SAME (recipient, refId) keys, so the downstream
    // dispatcher collapses them to one delivered notice per stall episode.
    await h.ctx.mirror.notifyChainStalled(chain.id);
    expect(new Set(stalledEvents().map(keyOf))).toEqual(firstKeys);
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

  it('tx.update heals the correction path’s crash window (link present, row gone) by re-creating from the full-state payload (§2)', async () => {
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
    const bLocalBefore = (await mirrorRepo.findMirrorRow('transaction', tx!.id, bPid))!.localId;

    // Simulate the correction path dying between its delete-commit and its
    // re-create on Bob's copy: the local row is gone, the mirror link (still
    // pointing at the dead id) and the pre-update watermark survive.
    await harness.db.delete(schema.transactions).where(eq(schema.transactions.id, bLocalBefore));
    await harness.ctx.mirror.submitTransactionUpdate(alice.id, aPid, tx!.id, { price: 120 });
    await harness.ctx.mirror.replicateChain(chain.id);

    // The copy re-creates the row from the op's full state instead of silently
    // dropping it (which would advance the watermark past a lost row).
    const healed = (await harness.ctx.portfolio.listTransactions(bob.id, bPid, {})).items;
    expect(healed).toHaveLength(1);
    expect(healed[0]!.price).toBe(120);
    expect(healed[0]!.quantity).toBe(5);
    const bLink = await mirrorRepo.findMirrorRow('transaction', tx!.id, bPid);
    expect(bLink!.localId).toBe(healed[0]!.id);
    expect(bLink!.localId).not.toBe(bLocalBefore);
  });

  it('one applier per copy: a replicate run and a concurrent submit never double-apply an op (the per-chain lock)', async () => {
    const { alice, bob, asset, aPid, bPid, chain } = await setupChain();
    await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 5,
        price: 100,
        fee: 0,
        executedAt: new Date().toISOString(),
      },
    ]);

    // Widen the race window: every service-level create yields for 25 ms, so an
    // UNSERIALIZED replicate + submit catch-up would both pass the create
    // idempotency check before either inserts — the double-apply the per-chain
    // lock exists to prevent.
    type CreateTxns = typeof harness.ctx.portfolio.createTransactions;
    const realCreate = harness.ctx.portfolio.createTransactions.bind(
      harness.ctx.portfolio,
    ) as CreateTxns;
    harness.ctx.portfolio.createTransactions = (async (...args: Parameters<CreateTxns>) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return realCreate(...args);
    }) as CreateTxns;

    // Bob writes (his origin catch-up must apply Alice's pending buy) while the
    // replicate job replays the very same op onto his copy.
    await Promise.all([
      harness.ctx.mirror.replicateChain(chain.id),
      harness.ctx.mirror.submitCashDeposit(bob.id, bPid, { amountEur: 10 }),
    ]);
    await harness.ctx.mirror.replicateChain(chain.id);

    // Exactly one materialization of the buy on Bob's copy — never two.
    const bTxs = (await harness.ctx.portfolio.listTransactions(bob.id, bPid, {})).items;
    expect(bTxs).toHaveLength(1);
    expect(bTxs[0]!.quantity).toBe(5);
    // And the concurrent submit itself succeeded + replicated to Alice.
    const aliceMoves = await createCashMovementRepository(harness.db).listForPortfolio(aPid);
    expect(aliceMoves.filter((m) => m.kind === 'deposit' && m.amountEur === 10)).toHaveLength(1);
  });

  it('a cash `fee` replicates AS A FEE to every copy, never as a withdrawal (§16 2026-07-30)', async () => {
    // A fee is TWR-INTERNAL but ORIGIN-entered: a member typed it, so it must
    // replicate like a deposit/withdrawal — and it must arrive as kind `fee`. If a
    // replica booked it as a withdrawal, that copy would divide the fee back out of
    // its own performance curve and silently diverge from the origin's, restoring
    // the exact misreport the kind exists to fix on every copy but one.
    const { alice, bob, aPid, bPid, chain } = await setupChain();
    await harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 1000 });
    const charged = await harness.ctx.mirror.submitCashFee(alice.id, aPid, {
      amountEur: 25,
      note: 'Custody fee',
    });
    expect(charged.movement.kind).toBe('fee');
    await harness.ctx.mirror.replicateChain(chain.id);

    // Bob's copy carries a `fee`, not a `withdrawal`, with the same amount.
    const bCash = await harness.ctx.portfolio.getCashMovements(bob.id, bPid);
    expect(bCash.movements.map((m) => m.kind).sort()).toEqual(['deposit', 'fee']);
    const bFee = bCash.movements.find((m) => m.kind === 'fee')!;
    expect(bFee.amountEur).toBe(-25);
    expect(bCash.balanceEur).toBe(975);
    // Replica rows are sync-tagged and attributed to the member who typed it.
    expect(bFee.source).toBe(SOURCE_TAG_SYNC_MIRRORCHAIN);
    const link = await mirrorRepo.findMirrorRowByLocal('cash_movement', bFee.id);
    expect(link?.mirrorId).toBe(charged.movement.id);
    expect(link?.createdByUsername).toBe('alice');

    // The op itself is a `cash.fee`, so the oplog stays self-describing forever.
    const ops = await mirrorRepo.listOpsSince(chain.id, 0);
    const feeOp = ops.find((op) => op.kind === 'cash.fee');
    expect(feeOp).toBeTruthy();
    expect((feeOp!.payload as MirrorOpPayload).kind).toBe('cash.fee');

    // Replay is idempotent: a second pass adds no second fee.
    await harness.ctx.mirror.replicateChain(chain.id);
    expect(
      (await harness.ctx.portfolio.getCashMovements(bob.id, bPid)).movements.filter(
        (m) => m.kind === 'fee',
      ),
    ).toHaveLength(1);
  });

  it('converting a portfolio that already has fees carries them into the chain (§1 genesis)', async () => {
    // The genesis bootstrap replicates HAND-ENTERED movements, a predicate that is
    // deliberately NOT `EXTERNAL_CASH_MOVEMENT_KINDS` — a fee is hand-entered but
    // TWR-internal, so it is exactly the row where the two notions differ. Omitting
    // it would drop every recorded fee the moment a portfolio became shared,
    // silently LIFTING the shared copy's reported return.
    const alice = await harness.seedUser({ email: 'ann@bettertrack.test', username: 'ann' });
    const carol = await harness.seedUser({ email: 'carol@bettertrack.test', username: 'carol' });
    const aPid = await harness.ctx.portfolio.getDefaultPortfolioId(alice.id);
    // Pre-existing private history, fees included, BEFORE the portfolio is shared.
    await harness.ctx.portfolio.depositCash(alice.id, aPid, { amountEur: 500 });
    await harness.ctx.portfolio.chargeCashFee(alice.id, aPid, { amountEur: 30 });

    const { chain } = await harness.ctx.mirror.convertToChain(alice.id, aPid, { name: 'Shared' });
    const { portfolioId: cPid } = await harness.ctx.mirror.attachMemberCopy(chain.id, carol.id);
    await harness.ctx.mirror.replicateChain(chain.id);

    const cCash = await harness.ctx.portfolio.getCashMovements(carol.id, cPid);
    expect(cCash.movements.map((m) => m.kind).sort()).toEqual(['deposit', 'fee']);
    expect(cCash.movements.find((m) => m.kind === 'fee')!.amountEur).toBe(-30);
    // Balances reconcile to the cent across copies — the fee is not lost or doubled.
    expect(cCash.balanceEur).toBe(470);
    expect((await harness.ctx.portfolio.getCashMovements(alice.id, aPid)).balanceEur).toBe(470);
  });

  it('does not rename a chain when a non-actor member transition wins first', async () => {
    const { alice, bob, chain } = await setupChain();
    const opCountBefore = (await mirrorRepo.listActivity(chain.id, { limit: 100 })).length;

    const transition = await startWinningParanoidTransition(bob.id);
    const rename = harness.ctx.mirror.renameChain(alice.id, chain.id, 'Must not land');
    let settled = false;
    void rename
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await transition.finish();
    await expect(rename).rejects.toMatchObject({ code: 'PARANOID_MODE' });
    expect((await mirrorRepo.getChain(chain.id))?.name).toBe('Family');
    expect(await mirrorRepo.listActivity(chain.id, { limit: 100 })).toHaveLength(opCountBefore);
  });

  it('skips a stale queued op when its author entered paranoid mode before replay', async () => {
    const { alice, bob, aPid, bPid, chain } = await setupChain();
    await harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 125 });
    const bobMembershipBefore = await mirrorRepo.findActiveMembership(chain.id, bob.id);
    const bobAuditBefore = (await mirrorAuditRows(bPid)).length;
    expect((await sourceBalances(bob.id, bPid)).find((source) => source.isMain)?.balanceEur).toBe(
      0,
    );

    await withExclusiveParanoidTransitionTestLock(harness.db, alice.id, async () => {
      await harness.db
        .update(schema.users)
        .set({
          privacyMode: 'paranoid',
          paranoidMediaSet: ['drive'],
          paranoidDriveAttestedVersion: 1,
        })
        .where(eq(schema.users.id, alice.id));
    });

    const result = await harness.ctx.mirror.replicateChain(chain.id);
    const bobMembershipAfter = await mirrorRepo.findActiveMembership(chain.id, bob.id);
    expect(result.applied).toBe(0);
    expect(result.lagging).toBeGreaterThan(0);
    expect(bobMembershipAfter?.appliedSeq).toBe(bobMembershipBefore?.appliedSeq);
    expect((await sourceBalances(bob.id, bPid)).find((source) => source.isMain)?.balanceEur).toBe(
      0,
    );
    expect((await mirrorAuditRows(bPid)).length).toBe(bobAuditBefore);
  });

  it('quarantines a chain with a stale vaulted member before replay and remains an idempotent no-op', async () => {
    const { alice, bob, aPid, bPid, chain } = await setupChain();
    await harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 125 });
    const membershipBefore = await mirrorRepo.findActiveMembership(chain.id, bob.id);
    const rowsBefore = await harness.db
      .select()
      .from(schema.portfolioCashMovements)
      .where(eq(schema.portfolioCashMovements.portfolioId, bPid));

    // This state bypasses the normal move-in precondition deliberately: it is
    // the stale active membership that a delayed replicate job must fail closed.
    await harness.db.insert(schema.vaults).values({
      id: VAULTED_REPLAY_TEST_VECTOR.vaultId,
      userId: bob.id,
      name: 'TEST VECTOR replay vault',
      headerDocId: VAULTED_REPLAY_TEST_VECTOR.headerDocId,
      commonDocId: VAULTED_REPLAY_TEST_VECTOR.commonDocId,
      media: ['server'],
      retirementProofPublicKey: VAULTED_REPLAY_TEST_VECTOR.retirementProofPublicKey,
      keyFingerprint: VAULTED_REPLAY_TEST_VECTOR.keyFingerprint,
    });
    await harness.db
      .update(schema.portfolios)
      .set({
        vaultId: VAULTED_REPLAY_TEST_VECTOR.vaultId,
        vaultAlias: 'TEST VECTOR locked replay stub',
      })
      .where(eq(schema.portfolios.id, bPid));

    await expect(harness.ctx.mirror.replicateChain(chain.id)).resolves.toEqual({
      applied: 0,
      lagging: 0,
      skipped: 0,
      advanced: 0,
      stagnant: 0,
    });
    await expect(harness.ctx.mirror.replicateChain(chain.id)).resolves.toEqual({
      applied: 0,
      lagging: 0,
      skipped: 0,
      advanced: 0,
      stagnant: 0,
    });

    const membershipAfter = await mirrorRepo.findActiveMembership(chain.id, bob.id);
    const rowsAfter = await harness.db
      .select()
      .from(schema.portfolioCashMovements)
      .where(eq(schema.portfolioCashMovements.portfolioId, bPid));
    expect(membershipAfter?.appliedSeq).toBe(membershipBefore?.appliedSeq);
    expect(rowsAfter).toEqual(rowsBefore);
  });
});

/**
 * V5-P7 #1611 — the recovery path for a copy that stops advancing. A member who
 * can never be replayed (an op author who LEFT the chain and later enabled
 * paranoid mode: leaving clears the paranoid blocker, but the guard set is built
 * from every op author since the copy's watermark) is reported as a SKIP, not a
 * failure — so the run returns normally, nothing retries, nothing dead-letters
 * and nothing notifies. These tests pin the three things that must now happen
 * instead: the pass reports zero forward progress, the escalation marks the copy
 * stalled exactly once, and "Retry sync" resumes it from its watermark.
 */
describe('mirrorchain — no-progress escalation + retry sync (#1611)', () => {
  let h: TestHarness;
  let repo: ReturnType<typeof createMirrorchainRepository>;
  let events: DispatchableEvent[];

  beforeEach(async () => {
    events = [];
    h = await createTestApp({
      notificationEnqueue: async (event) => {
        events.push(event);
      },
    });
    repo = createMirrorchainRepository(h.db);
  });

  const stalledEvents = () => events.filter((event) => event.type === 'mirror.sync_stalled');

  async function makeParanoid(userId: string) {
    await withExclusiveParanoidTransitionTestLock(h.db, userId, async () => {
      await h.db
        .update(schema.users)
        .set({
          privacyMode: 'paranoid',
          paranoidMediaSet: ['drive'],
          paranoidDriveAttestedVersion: 1,
        })
        .where(eq(schema.users.id, userId));
    });
  }

  /** Owner alice + member bob, both caught up. */
  async function simpleChain() {
    const alice = await h.seedUser({ email: 'a1611@bettertrack.test', username: 'a1611' });
    const bob = await h.seedUser({ email: 'b1611@bettertrack.test', username: 'b1611' });
    const aPid = await h.ctx.portfolio.getDefaultPortfolioId(alice.id);
    const { chain } = await h.ctx.mirror.convertToChain(alice.id, aPid, { name: 'Retry' });
    const { portfolioId: bPid } = await h.ctx.mirror.attachMemberCopy(chain.id, bob.id);
    await h.ctx.mirror.replicateChain(chain.id);
    return { alice, bob, aPid, bPid, chain };
  }

  /**
   * The permanently-unreplayable chain: carol writes an op, LEAVES (keeping her
   * fork, which clears the paranoid membership blocker) and then goes paranoid.
   * Every remaining copy is behind an op she authored, so every replay attempt
   * is refused by the privacy guard — forever.
   */
  async function chainBlockedByDepartedParanoidAuthor() {
    const base = await simpleChain();
    const carol = await h.seedUser({ email: 'c1611@bettertrack.test', username: 'c1611' });
    const { portfolioId: cPid } = await h.ctx.mirror.attachMemberCopy(base.chain.id, carol.id);
    await h.ctx.mirror.replicateChain(base.chain.id);
    await h.ctx.mirror.submitCashDeposit(carol.id, cPid, { amountEur: 50 });
    await h.ctx.mirror.leaveChain(carol.id, base.chain.id);
    await makeParanoid(carol.id);
    return { ...base, carol };
  }

  it('reports a permanently-unreplayable copy as skipped with zero forward progress', async () => {
    const { chain } = await chainBlockedByDepartedParanoidAuthor();

    const result = await h.ctx.mirror.replicateChain(chain.id);

    // Every remaining copy was refused, so nothing applied and no watermark
    // moved — the signal the job needs to stop chaining another identical pass.
    expect(result.applied).toBe(0);
    expect(result.advanced).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.lagging).toBe(2);
    // Both copies were ALREADY behind when the pass began — a genuine stall,
    // not lag that appeared mid-pass, so the job may escalate on it.
    expect(result.stagnant).toBe(2);
    // Idempotent: a second pass is just as fruitless, and just as quiet.
    await expect(h.ctx.mirror.replicateChain(chain.id)).resolves.toEqual(result);
  });

  it('escalates the no-progress chain exactly once: members marked stalled, notice fired once', async () => {
    const { bob, chain } = await chainBlockedByDepartedParanoidAuthor();
    await h.ctx.mirror.replicateChain(chain.id);
    expect(stalledEvents()).toHaveLength(0);

    const first = await h.ctx.mirror.escalateStalledChain(chain.id);
    expect(first).toEqual({ escalated: true, stalled: 2 });
    const firedOnce = stalledEvents().length;
    expect(firedOnce).toBeGreaterThan(0);

    // Nothing changed, so a later sweep re-marks but must not nag again.
    const second = await h.ctx.mirror.escalateStalledChain(chain.id);
    expect(second).toEqual({ escalated: false, stalled: 2 });
    expect(stalledEvents()).toHaveLength(firedOnce);

    // The copy now READS stalled — distinct from "Syncing…" — on both surfaces
    // the client renders: the member sheet and the switcher summary.
    const sheet = await h.ctx.mirror.getMemberList(bob.id, chain.id);
    const self = sheet.members.find((member) => member.isSelf)!;
    expect(self.sync).toMatchObject({ synced: false, stalled: true });
    const [summary] = await h.ctx.mirror.listChainsForUser(bob.id);
    expect(summary!.sync.stalled).toBe(true);
  });

  it('a copy that is merely behind is never marked stalled', async () => {
    const { alice, bob, aPid, chain } = await simpleChain();
    await h.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 10 });

    const sheet = await h.ctx.mirror.getMemberList(bob.id, chain.id);
    const self = sheet.members.find((member) => member.isSelf)!;
    expect(self.sync).toMatchObject({ synced: false, stalled: false });
  });

  it('retry sync resumes the caller own copy from its watermark', async () => {
    const { alice, bob, aPid, bPid, chain } = await simpleChain();
    await h.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 25 });
    const before = await repo.findActiveMembership(chain.id, bob.id);
    expect(before!.appliedSeq).toBeLessThan((await repo.getChain(chain.id))!.lastSeq);

    const result = await h.ctx.mirror.retrySync(bob.id, chain.id);

    expect(result.status).toBe('synced');
    expect(result.applied).toBeGreaterThan(0);
    expect(result.sync).toMatchObject({ synced: true, stalled: false });
    // Resumed, not replayed from zero: the money landed exactly once.
    expect((await h.ctx.portfolio.getCashMovements(bob.id, bPid)).balanceEur).toBe(25);
    expect((await repo.findActiveMembership(chain.id, bob.id))!.appliedSeq).toBe(
      (await repo.getChain(chain.id))!.lastSeq,
    );
  });

  it('retry sync refuses a caught-up copy and a non-member', async () => {
    const { bob, chain } = await simpleChain();
    const stranger = await h.seedUser({ email: 's1611@bettertrack.test', username: 's1611' });

    await expect(h.ctx.mirror.retrySync(bob.id, chain.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'MIRROR_NOT_STALLED',
    });
    await expect(h.ctx.mirror.retrySync(stranger.id, chain.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'MIRROR_CHAIN_NOT_FOUND',
    });
  });

  it('retry sync on a copy that still cannot advance answers stalled, and keeps saying so', async () => {
    const { bob, chain } = await chainBlockedByDepartedParanoidAuthor();
    await h.ctx.mirror.replicateChain(chain.id);
    await h.ctx.mirror.escalateStalledChain(chain.id);

    const result = await h.ctx.mirror.retrySync(bob.id, chain.id);

    expect(result.status).toBe('stalled');
    expect(result.applied).toBe(0);
    expect(result.sync.stalled).toBe(true);
    // The affordance survives a failed retry — the copy has not silently
    // fallen back to pretending it is syncing.
    const sheet = await h.ctx.mirror.getMemberList(bob.id, chain.id);
    expect(sheet.members.find((member) => member.isSelf)!.sync.stalled).toBe(true);
  });

  it('over HTTP, retry sync is members-only and returns the copy state', async () => {
    const { alice, bob, aPid, chain } = await simpleChain();
    await h.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 40 });
    const stranger = await h.seedUser({ email: 's2-1611@bettertrack.test', username: 's21611' });

    const bobAgent = await loginAgent(h.app, bob.email, bob.password);
    const ok = await bobAgent
      .post(`/api/v1/mirrorchain/chains/${chain.id}/retry-sync`)
      .set(...XRW)
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'synced', sync: { synced: true, stalled: false } });

    const strangerAgent = await loginAgent(h.app, stranger.email, stranger.password);
    const denied = await strangerAgent
      .post(`/api/v1/mirrorchain/chains/${chain.id}/retry-sync`)
      .set(...XRW)
      .send({});
    expect(denied.status).toBe(404);
  });
});
