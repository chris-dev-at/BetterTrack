import { randomUUID } from 'node:crypto';

import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMirrorchainRepository } from '../data/repositories/mirrorchainRepository';
import * as schema from '../data/schema';
import { createMirrorConsistencySweepJob } from '../jobs/definitions';
import type { JobContext } from '../jobs/types';
import type { Logger } from '../logger';
import type { DispatchableEvent } from '../services/notifications/notificationDispatcher';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * MIRRORCHAIN M4 — deletion succession + repair (`docs/mirrorchain-design.md`
 * §2 (a)/(b), §7; issue #684). The §7 worked examples write these tests: owner
 * deletion → transfer to the oldest manager (or dissolution with none), the
 * non-owner path, the owner-leave / owner-copy-delete endpoints that M3 refused
 * now succeeding, the deterministic tie-break, the hook running BEFORE the user
 * row in both delete pipelines, and the defense-in-depth repair sweep (ownerless
 * chains + the two crash residuals surfacing on the admin Problems page).
 */

let seq = 0;
function uu(prefix: string): { email: string; username: string } {
  seq += 1;
  return { email: `${prefix}-m4-${seq}@bettertrack.test`, username: `${prefix}m4${seq}` };
}

// Deterministic TEST VECTOR ids and verifier-shaped strings are public fixtures,
// not credentials or production retirement material.
const VAULTED_SWEEP_TEST_VECTOR = {
  vaultId: '019c8610-0000-7000-8000-000000000001',
  headerDocId: '019c8610-0000-7000-8000-000000000002',
  commonDocId: '019c8610-0000-7000-8000-000000000003',
  danglingMirrorId: '019c8610-0000-7000-8000-000000000004',
  retirementProofPublicKey: 'TEST VECTOR mirror sweep public verifier',
  keyFingerprint: 'TEST-VECTOR-MIRROR-SWEEP-0001',
} as const;

const repoOf = (h: TestHarness) => createMirrorchainRepository(h.db);

/** Owner O with a converted (empty) chain; returns O + chainId + O's copy id. */
async function ownerChain(h: TestHarness) {
  const owner = await h.seedUser(uu('owner'));
  const portfolioId = await h.ctx.portfolio.getDefaultPortfolioId(owner.id);
  const { chain } = await h.ctx.mirror.convertToChain(owner.id, portfolioId);
  return { owner, chainId: chain.id, ownerPortfolioId: portfolioId };
}

/** Attach a fresh member/manager; returns the seeded user + copy id. */
async function join(h: TestHarness, chainId: string, role: 'manager' | 'member') {
  const user = await h.seedUser(uu(role));
  const { portfolioId } = await h.ctx.mirror.attachMemberCopy(chainId, user.id, { role });
  return { user, portfolioId };
}

/** Pin a member's join time (there is no other way to make ordering deterministic). */
async function setJoinedAt(h: TestHarness, chainId: string, userId: string, at: Date) {
  await h.db
    .update(schema.mirrorChainMembers)
    .set({ joinedAt: at })
    .where(
      and(
        eq(schema.mirrorChainMembers.chainId, chainId),
        eq(schema.mirrorChainMembers.userId, userId),
      ),
    );
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

/** The tombstone membership row for a (now possibly account-deleted) user. */
async function tombstone(h: TestHarness, chainId: string, username: string) {
  const [row] = await h.db
    .select()
    .from(schema.mirrorChainMembers)
    .where(
      and(
        eq(schema.mirrorChainMembers.chainId, chainId),
        eq(schema.mirrorChainMembers.username, username),
      ),
    );
  return row!;
}

interface OwnerTransferredPayload {
  via?: string;
  fromUserId: string | null;
  toUserId: string;
}

// ── §7 worked example: owner deletion → oldest-manager succession ─────────────

describe('mirrorchain M4 — §7 deletion succession (worked example)', () => {
  it('owner deletes → the earliest-joined manager becomes owner (via account_deletion); the copy cascades, the chain + other copies stay intact', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const o = await h.seedUser(uu('o'));
    const oPid = await h.ctx.portfolio.getDefaultPortfolioId(o.id);
    const { chain } = await h.ctx.mirror.convertToChain(o.id, oPid);
    const chainId = chain.id;
    const m1 = await join(h, chainId, 'manager');
    const m2 = await join(h, chainId, 'manager');
    const b = await join(h, chainId, 'member');
    // M1 joined Jan 5, M2 Mar 2 — M1 is the earliest-joined active manager (§7).
    await setJoinedAt(h, chainId, m1.user.id, new Date('2026-01-05T00:00:00Z'));
    await setJoinedAt(h, chainId, m2.user.id, new Date('2026-03-02T00:00:00Z'));

    // O deletes via the real V4-P2c self-serve pipeline — the §7 hook runs
    // synchronously BEFORE the user row is removed.
    await h.ctx.accountDeletion.deleteAccount({
      userId: o.id,
      body: { confirmUsername: o.username, password: o.password },
    });

    // C is still active: owner M1, manager M2, member B.
    expect((await repo.getChain(chainId))!.status).toBe('active');
    const members = await repo.listActiveMembers(chainId);
    expect(members).toHaveLength(3);
    expect(members.find((m) => m.userId === m1.user.id)!.role).toBe('owner');
    expect(members.find((m) => m.userId === m2.user.id)!.role).toBe('manager');
    expect(members.find((m) => m.userId === b.user.id)!.role).toBe('member');

    // O's membership ended account_deleted; O's user row + copy cascaded away.
    const oTomb = await tombstone(h, chainId, o.username);
    expect(oTomb.status).toBe('account_deleted');
    expect(oTomb.userId).toBeNull(); // SET NULL on the user-row delete
    expect(oTomb.portfolioId).toBeNull(); // O's copy cascaded → SET NULL

    // Every other copy survives as a working portfolio (sync intact).
    expect(await h.ctx.portfolio.listCashSources(m1.user.id, m1.portfolioId)).toBeTruthy();
    expect(await h.ctx.portfolio.listCashSources(b.user.id, b.portfolioId)).toBeTruthy();

    // The oplog shows owner.transferred (via account_deletion) THEN member.left.
    const ops = await repo.listActivity(chainId, { limit: 200 });
    const transfer = ops.find((op) => op.kind === 'owner.transferred')!;
    expect(transfer).toBeTruthy();
    const payload = transfer.payload as OwnerTransferredPayload;
    expect(payload.via).toBe('account_deletion');
    expect(payload.fromUserId).toBe(o.id);
    expect(payload.toUserId).toBe(m1.user.id);
    const left = ops.find((op) => op.kind === 'member.left' && op.actorUsername === o.username)!;
    expect(left).toBeTruthy();
    expect(left.seq).toBeGreaterThan(transfer.seq); // transfer FIRST, then the tombstone op
  });

  it('variant — no managers: owner deletion dissolves the chain, every copy forks, members are notified', async () => {
    const events: DispatchableEvent[] = [];
    const h = await createTestApp({
      notificationEnqueue: async (e) => {
        events.push(e);
      },
    });
    const repo = repoOf(h);
    const { owner, chainId } = await ownerChain(h);
    // M1, M2, B were never granted manager — all plain members (§7 variant).
    const m1 = await join(h, chainId, 'member');
    const m2 = await join(h, chainId, 'member');
    const b = await join(h, chainId, 'member');

    await h.ctx.mirror.handleAccountDeletion(owner.id);

    expect((await repo.getChain(chainId))!.status).toBe('dissolved');
    // O ends account_deleted; every other membership ends dissolved (→ fork §6).
    expect((await tombstone(h, chainId, owner.username)).status).toBe('account_deleted');
    for (const m of [m1, m2, b]) {
      expect((await tombstone(h, chainId, m.user.username)).status).toBe('dissolved');
      // The copy is still an ordinary, fully-working portfolio.
      expect(await h.ctx.portfolio.listCashSources(m.user.id, m.portfolioId)).toBeTruthy();
    }
    // mirror.chain_dissolved reaches every former member but the departing owner.
    const dissolved = events
      .filter((e) => e.type === 'mirror.chain_dissolved')
      .map((e) => e.userId);
    expect(dissolved).toEqual(expect.arrayContaining([m1.user.id, m2.user.id, b.user.id]));
    expect(dissolved).not.toContain(owner.id);
    // The oplog records the succession-driven dissolution reason.
    const ops = await repo.listActivity(chainId, { limit: 200 });
    const dissolveOp = ops.find((op) => op.kind === 'chain.dissolved')!;
    expect((dissolveOp.payload as { reason: string }).reason).toBe('no_manager_succession');
  });

  it('non-owner deletion: the membership ends, the copy dies, the chain is untouched, past rows stay attributed "B (account deleted)"', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { owner, chainId, ownerPortfolioId } = await ownerChain(h);
    const b = await h.seedUser(uu('b'));
    const { portfolioId: bPid } = await h.ctx.mirror.attachMemberCopy(chainId, b.id, {
      role: 'member',
    });
    // B writes into the shared book; it replicates to O's copy, attributed to B.
    await h.ctx.mirror.submitCashDeposit(b.id, bPid, { amountEur: 50 });
    await h.ctx.mirror.replicateChain(chainId);
    const before = (await repo.listMirrorRowsForPortfolio(ownerPortfolioId)).find(
      (r) => r.kind === 'cash_movement' && r.createdByUsername === b.username,
    );
    expect(before).toBeTruthy();
    expect(before!.createdBy).toBe(b.id);

    // B deletes their account (V4-P2c pipeline → §7 hook runs pre-delete).
    await h.ctx.accountDeletion.deleteAccount({
      userId: b.id,
      body: { confirmUsername: b.username, password: b.password },
    });

    // The chain is untouched: still active, O still the sole owner.
    expect((await repo.getChain(chainId))!.status).toBe('active');
    const members = await repo.listActiveMembers(chainId);
    expect(members).toHaveLength(1);
    expect(members[0]!.userId).toBe(owner.id);
    expect(members[0]!.role).toBe('owner');
    // B's membership ended account_deleted; B's copy cascaded away.
    const bTomb = await tombstone(h, chainId, b.username);
    expect(bTomb.status).toBe('account_deleted');
    expect(bTomb.portfolioId).toBeNull();
    // B's past row survives on O's copy, now attributed "B (account deleted)".
    const after = (await repo.listMirrorRowsForPortfolio(ownerPortfolioId)).find(
      (r) => r.createdByUsername === b.username,
    );
    expect(after).toBeTruthy();
    expect(after!.createdBy).toBeNull(); // SET NULL — the username keeps rendering
  });

  it('deterministic tie-break: equal joined_at → the lowest user id is promoted', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { owner, chainId } = await ownerChain(h);
    const mgrA = await join(h, chainId, 'manager');
    const mgrB = await join(h, chainId, 'manager');
    const same = new Date('2026-02-02T00:00:00Z');
    await setJoinedAt(h, chainId, mgrA.user.id, same);
    await setJoinedAt(h, chainId, mgrB.user.id, same);
    const lowest = mgrA.user.id < mgrB.user.id ? mgrA.user.id : mgrB.user.id;

    await h.ctx.mirror.handleAccountDeletion(owner.id);

    const newOwner = (await repo.listActiveMembers(chainId)).find((m) => m.role === 'owner')!;
    expect(newOwner.userId).toBe(lowest);
  });
});

// ── Owner-leave / owner-copy-delete now succeed (M3 stopgap removed) ──────────

describe('mirrorchain M4 — owner-leave / owner-copy-delete via succession', () => {
  it('owner leave now succeeds: the manager is promoted; the owner keeps their copy as a fork', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { owner, chainId, ownerPortfolioId } = await ownerChain(h);
    const mgr = await join(h, chainId, 'manager');

    await h.ctx.mirror.leaveChain(owner.id, chainId); // was 409 MIRROR_OWNER_TRANSFER_REQUIRED in M3

    expect(
      (await repo.listActiveMembers(chainId)).find((m) => m.userId === mgr.user.id)!.role,
    ).toBe('owner');
    expect(await repo.findActiveMembership(chainId, owner.id)).toBeNull();
    expect((await tombstone(h, chainId, owner.username)).status).toBe('left');
    // The old owner's copy survives as a working fork.
    expect(await h.ctx.portfolio.listCashSources(owner.id, ownerPortfolioId)).toBeTruthy();
  });

  it('owner copy-delete now succeeds: the manager is promoted and the owner copy is deleted', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { owner, chainId, ownerPortfolioId } = await ownerChain(h);
    const mgr = await join(h, chainId, 'manager');
    // The copy must not be the owner's ONLY portfolio (the ordinary
    // last-portfolio guard is unrelated to the chain), so give them another.
    await h.ctx.portfolio.createPortfolio(owner.id, { name: 'Solo' });

    await h.ctx.mirror.submitPortfolioDelete(owner.id, ownerPortfolioId); // was 409 in M3

    expect(await repo.findActiveMembership(chainId, owner.id)).toBeNull();
    expect(
      (await repo.listActiveMembers(chainId)).find((m) => m.userId === mgr.user.id)!.role,
    ).toBe('owner');
    await expect(h.ctx.portfolio.listCashSources(owner.id, ownerPortfolioId)).rejects.toBeTruthy(); // the copy is gone
  });

  it('owner leave with no manager dissolves the chain (the owner keeps their fork)', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { owner, chainId } = await ownerChain(h);
    const member = await join(h, chainId, 'member');

    await h.ctx.mirror.leaveChain(owner.id, chainId);

    expect((await repo.getChain(chainId))!.status).toBe('dissolved');
    expect((await tombstone(h, chainId, owner.username)).status).toBe('left');
    expect((await tombstone(h, chainId, member.user.username)).status).toBe('dissolved');
  });
});

// ── The pre-delete hook runs in BOTH delete pipelines ────────────────────────

describe('mirrorchain M4 — the §7 hook runs before the user-row delete (both pipelines)', () => {
  it('admin delete runs the succession hook synchronously before removing the user row', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const actor = await h.seedAdmin();
    const o = await h.seedUser(uu('o'));
    const oPid = await h.ctx.portfolio.getDefaultPortfolioId(o.id);
    const { chain } = await h.ctx.mirror.convertToChain(o.id, oPid);
    const mgr = await join(h, chain.id, 'manager');

    await h.ctx.admin.deleteUser(o.id, o.username, { id: actor.id, ip: null });

    // Succession ran (manager crowned) and O's row is gone (tombstone SET NULL) —
    // proving the hook fired BEFORE the delete cascaded O's copy away.
    expect(
      (await repo.listActiveMembers(chain.id)).find((m) => m.userId === mgr.user.id)!.role,
    ).toBe('owner');
    const oTomb = await tombstone(h, chain.id, o.username);
    expect(oTomb.status).toBe('account_deleted');
    expect(oTomb.userId).toBeNull();
    expect(oTomb.portfolioId).toBeNull();
  });

  it('deleting a member with no chains is a no-op for the hook', async () => {
    const h = await createTestApp();
    const solo = await h.seedUser(uu('solo'));
    await expect(h.ctx.mirror.handleAccountDeletion(solo.id)).resolves.toBeUndefined();
  });
});

// ── The repair-sweep queries (design §2 (a)/(b), §7 (0)) ─────────────────────

describe('mirrorchain M4 — repair-sweep queries', () => {
  it('listOwnerlessActiveChains finds an active chain with no active owner', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { owner, chainId } = await ownerChain(h);
    await join(h, chainId, 'manager');
    expect(await repo.listOwnerlessActiveChains()).toHaveLength(0);

    // A bypass leaves the chain active with zero active owners (never via service).
    await h.db
      .update(schema.mirrorChainMembers)
      .set({ status: 'account_deleted' })
      .where(
        and(
          eq(schema.mirrorChainMembers.chainId, chainId),
          eq(schema.mirrorChainMembers.userId, owner.id),
        ),
      );
    const found = await repo.listOwnerlessActiveChains();
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(chainId);
  });

  it('listDanglingOriginRows finds an origin link whose mirror_id has no op (residual a)', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { chainId, ownerPortfolioId } = await ownerChain(h);
    // The genesis links all carry ops → none dangling yet.
    expect(await repo.listDanglingOriginRows(500)).toHaveLength(0);

    const danglingId = randomUUID();
    await repo.insertMirrorRow({
      chainId,
      kind: 'transaction',
      mirrorId: danglingId,
      portfolioId: ownerPortfolioId,
      localId: danglingId,
      createdBy: null,
      createdByUsername: 'ghost',
    });
    const found = await repo.listDanglingOriginRows(500);
    expect(found).toHaveLength(1);
    expect(found[0]!.mirrorId).toBe(danglingId);
  });

  it('listOrphanedSyncedTransactions finds a synced-copy tx with no link, and excludes forks (residual b)', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { owner, chainId, ownerPortfolioId } = await ownerChain(h);
    const asset = await seedAsset(h);
    expect(await repo.listOrphanedSyncedTransactions(500)).toHaveLength(0);

    const [tx] = await h.db
      .insert(schema.transactions)
      .values({
        portfolioId: ownerPortfolioId,
        assetId: asset.id,
        side: 'buy',
        quantity: '1',
        price: '10',
        executedAt: new Date(),
      })
      .returning();
    const found = await repo.listOrphanedSyncedTransactions(500);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(tx!.id);
    expect(found[0]!.portfolioId).toBe(ownerPortfolioId);

    // Dissolve → the copy becomes a fork (membership no longer active) → excluded.
    await h.ctx.mirror.dissolveChain(owner.id, chainId);
    expect(await repo.listOrphanedSyncedTransactions(500)).toHaveLength(0);
  });

  it('excludes a stale vaulted member from owner repair and both content-residual scans', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { owner, chainId } = await ownerChain(h);
    const manager = await join(h, chainId, 'manager');
    const asset = await seedAsset(h, 'VAULT-SWEEP.DE');

    await h.db.insert(schema.vaults).values({
      id: VAULTED_SWEEP_TEST_VECTOR.vaultId,
      userId: manager.user.id,
      name: 'TEST VECTOR sweep vault',
      headerDocId: VAULTED_SWEEP_TEST_VECTOR.headerDocId,
      commonDocId: VAULTED_SWEEP_TEST_VECTOR.commonDocId,
      media: ['server'],
      retirementProofPublicKey: VAULTED_SWEEP_TEST_VECTOR.retirementProofPublicKey,
      keyFingerprint: VAULTED_SWEEP_TEST_VECTOR.keyFingerprint,
    });
    await h.db
      .update(schema.portfolios)
      .set({
        vaultId: VAULTED_SWEEP_TEST_VECTOR.vaultId,
        vaultAlias: 'TEST VECTOR locked sweep stub',
      })
      .where(eq(schema.portfolios.id, manager.portfolioId));
    await repo.insertMirrorRow({
      chainId,
      kind: 'transaction',
      mirrorId: VAULTED_SWEEP_TEST_VECTOR.danglingMirrorId,
      portfolioId: manager.portfolioId,
      localId: VAULTED_SWEEP_TEST_VECTOR.danglingMirrorId,
      createdBy: null,
      createdByUsername: 'TEST VECTOR ghost',
    });
    await h.db.insert(schema.transactions).values({
      portfolioId: manager.portfolioId,
      assetId: asset.id,
      side: 'buy',
      quantity: '1',
      price: '10',
      executedAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    // Create an ownerless chain behind the service. The remaining manager is a
    // stale vaulted member, so succession must not write through that chain.
    await h.db
      .update(schema.mirrorChainMembers)
      .set({ status: 'account_deleted' })
      .where(
        and(
          eq(schema.mirrorChainMembers.chainId, chainId),
          eq(schema.mirrorChainMembers.userId, owner.id),
        ),
      );

    expect(await repo.listOwnerlessActiveChains()).toEqual([]);
    expect(await repo.listDanglingOriginRows(500)).toEqual([]);
    expect(await repo.listOrphanedSyncedTransactions(500)).toEqual([]);
    await expect(h.ctx.mirror.runConsistencySweep()).resolves.toEqual({
      ownerlessRepaired: [],
      danglingOriginRows: [],
      orphanedLocalRows: [],
      divergentMissingRows: [],
      divergentTransactionRows: [],
    });
    expect((await repo.getChain(chainId))?.status).toBe('active');
    expect((await repo.findActiveMembership(chainId, manager.user.id))?.role).toBe('manager');
  });
});

// ── The repair sweep job (repairs + surfaces on the admin Problems page) ──────

const silentLogger = pino({ level: 'silent' }) as unknown as Logger;

function sweepCtx(): JobContext {
  return {
    events: {
      publish: async () => {},
      subscribe: async () => async () => {},
      close: async () => {},
    },
    deadLetter: {} as JobContext['deadLetter'],
    redis: {} as JobContext['redis'],
    logger: silentLogger,
  };
}

async function runSweep(h: TestHarness): Promise<void> {
  const job = createMirrorConsistencySweepJob({ mirror: h.ctx.mirror, problems: h.ctx.problems });
  await job.handler({ data: {} } as Job<Record<string, never>>, sweepCtx());
  await h.ctx.problems.flush();
}

describe('mirrorchain M4 — repair sweep', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await createTestApp();
  });

  it('repairs an ownerless active chain via §7 succession and surfaces it on the Problems page', async () => {
    const repo = repoOf(h);
    const { owner, chainId } = await ownerChain(h);
    const mgr = await join(h, chainId, 'manager');
    // Inject the ownerless state directly (bypassing the service, e.g. manual SQL).
    await h.db
      .update(schema.mirrorChainMembers)
      .set({ status: 'account_deleted' })
      .where(
        and(
          eq(schema.mirrorChainMembers.chainId, chainId),
          eq(schema.mirrorChainMembers.userId, owner.id),
        ),
      );
    expect(await repo.listOwnerlessActiveChains()).toHaveLength(1);

    await runSweep(h);

    // The oldest manager was crowned; the chain is no longer ownerless.
    expect(
      (await repo.listActiveMembers(chainId)).find((m) => m.userId === mgr.user.id)!.role,
    ).toBe('owner');
    expect(await repo.listOwnerlessActiveChains()).toHaveLength(0);
    // The anomaly surfaced on the admin Problems page.
    const { problems } = await h.ctx.problems.list({ limit: 100 });
    expect(problems.some((p) => p.title.includes('ownerless chain repaired'))).toBe(true);
  });

  it('dissolves an ownerless chain with no manager and surfaces it', async () => {
    const repo = repoOf(h);
    const { owner, chainId } = await ownerChain(h);
    await join(h, chainId, 'member');
    await h.db
      .update(schema.mirrorChainMembers)
      .set({ status: 'account_deleted' })
      .where(
        and(
          eq(schema.mirrorChainMembers.chainId, chainId),
          eq(schema.mirrorChainMembers.userId, owner.id),
        ),
      );

    await runSweep(h);

    expect((await repo.getChain(chainId))!.status).toBe('dissolved');
    const { problems } = await h.ctx.problems.list({ limit: 100 });
    expect(problems.some((p) => p.title.includes('ownerless chain repaired'))).toBe(true);
  });

  it('surfaces both crash residuals (a) and (b) on the Problems page', async () => {
    const repo = repoOf(h);
    const { chainId, ownerPortfolioId } = await ownerChain(h);
    const asset = await seedAsset(h);
    // (a) an origin link with no op.
    const danglingId = randomUUID();
    await repo.insertMirrorRow({
      chainId,
      kind: 'transaction',
      mirrorId: danglingId,
      portfolioId: ownerPortfolioId,
      localId: danglingId,
      createdBy: null,
      createdByUsername: 'ghost',
    });
    // (b) a synced-copy tx with no link.
    await h.db.insert(schema.transactions).values({
      portfolioId: ownerPortfolioId,
      assetId: asset.id,
      side: 'buy',
      quantity: '2',
      price: '5',
      executedAt: new Date(),
    });

    await runSweep(h);

    const { problems } = await h.ctx.problems.list({ limit: 100 });
    expect(problems.some((p) => p.title.includes('origin row without op'))).toBe(true);
    expect(problems.some((p) => p.title.includes('orphaned synced transaction'))).toBe(true);
  });

  /**
   * (c)/(d) — the crash window the create-shaped detectors structurally cannot
   * see (#1611). The origin applies its local effect and COMMITS before the op
   * is appended, so a crash in between leaves exactly the states seeded below:
   * a delete that took the local row and its link with it (nothing left for (a)
   * to find), and an update that changed the money while leaving every link
   * intact. Both are permanent, silent money divergence without a detector.
   */
  async function syncedTransaction(h: TestHarness) {
    const { owner, chainId, ownerPortfolioId } = await ownerChain(h);
    const member = await join(h, chainId, 'member');
    const asset = await seedAsset(h);
    const [tx] = await h.ctx.mirror.submitTransactionsCreate(owner.id, ownerPortfolioId, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 5,
        price: 100,
        fee: 0,
        executedAt: new Date('2026-03-02T10:00:00.000Z').toISOString(),
      },
    ]);
    await h.ctx.mirror.replicateChain(chainId);
    return { owner, chainId, ownerPortfolioId, member, mirrorId: tx!.id };
  }

  it('detects a lost tx.delete — the entity is alive in the oplog but gone from a caught-up copy', async () => {
    const { chainId, ownerPortfolioId, mirrorId } = await syncedTransaction(h);
    const repo = repoOf(h);
    // The committed half of `submitTransactionDelete`, with the append lost.
    await h.db.delete(schema.transactions).where(eq(schema.transactions.id, mirrorId));
    await repo.deleteMirrorRow('transaction', mirrorId, ownerPortfolioId);

    const result = await h.ctx.mirror.runConsistencySweep();

    expect(result.divergentMissingRows).toEqual([
      expect.objectContaining({ chainId, portfolioId: ownerPortfolioId, mirrorId }),
    ]);
    // The create-shaped residual scans stay silent on it — that is the gap.
    expect(result.danglingOriginRows).toEqual([]);
    await runSweep(h);
    const { problems } = await h.ctx.problems.list({ limit: 100 });
    expect(problems.some((p) => p.title.includes('missing from a caught-up copy'))).toBe(true);
  });

  it('detects a lost tx.update — a copy money that contradicts its own latest op', async () => {
    const { chainId, ownerPortfolioId, mirrorId } = await syncedTransaction(h);
    // The committed half of `submitTransactionUpdate` (quantity 5 → 6), with the
    // append lost: the origin holds 6, every other copy still holds 5.
    await h.db
      .update(schema.transactions)
      .set({ quantity: '6' })
      .where(eq(schema.transactions.id, mirrorId));

    const result = await h.ctx.mirror.runConsistencySweep();

    expect(result.divergentTransactionRows).toEqual([
      expect.objectContaining({
        chainId,
        portfolioId: ownerPortfolioId,
        mirrorId,
        localId: mirrorId,
      }),
    ]);
    expect(result.divergentMissingRows).toEqual([]);
    await runSweep(h);
    const { problems } = await h.ctx.problems.list({ limit: 100 });
    expect(problems.some((p) => p.title.includes('diverges from its op'))).toBe(true);
  });

  it('a faithfully replicated chain is not a finding, and neither is an ordinary lagging copy', async () => {
    const { chainId, owner, ownerPortfolioId } = await syncedTransaction(h);
    // A second write that only the origin has applied so far: the joiner is
    // BEHIND, not divergent — the detectors must not confuse the two.
    await h.ctx.mirror.submitCashDeposit(owner.id, ownerPortfolioId, { amountEur: 10 });

    const result = await h.ctx.mirror.runConsistencySweep();

    expect(result.divergentMissingRows).toEqual([]);
    expect(result.divergentTransactionRows).toEqual([]);
    expect((await repoOf(h).getChain(chainId))!.lastSeq).toBeGreaterThan(0);
  });

  it('pages past the row limit instead of re-reporting the same residuals forever', async () => {
    const repo = repoOf(h);
    const { chainId, ownerPortfolioId } = await ownerChain(h);
    // Three (a)-residuals, one page of two: the tail must surface on the NEXT
    // run rather than the first page repeating until an admin fixes it by hand.
    const seeded: string[] = [];
    for (let i = 0; i < 3; i++) {
      const mirrorId = randomUUID();
      seeded.push(mirrorId);
      await repo.insertMirrorRow({
        chainId,
        kind: 'transaction',
        mirrorId,
        portfolioId: ownerPortfolioId,
        localId: mirrorId,
        createdBy: null,
        createdByUsername: 'ghost',
      });
    }

    const first = await h.ctx.mirror.runConsistencySweep({ limit: 2 });
    const second = await h.ctx.mirror.runConsistencySweep({ limit: 2 });
    const third = await h.ctx.mirror.runConsistencySweep({ limit: 2 });

    const ids = (rows: { mirrorId: string }[]) => rows.map((r) => r.mirrorId);
    expect(first.danglingOriginRows).toHaveLength(2);
    expect(second.danglingOriginRows).toHaveLength(1);
    // Disjoint pages: run two surfaced the tail, not the same rows again.
    expect(
      ids(second.danglingOriginRows).some((id) => ids(first.danglingOriginRows).includes(id)),
    ).toBe(false);
    expect([...ids(first.danglingOriginRows), ...ids(second.danglingOriginRows)].sort()).toEqual(
      [...seeded].sort(),
    );
    // The short page wrapped the cursor, so the scan keeps covering the set.
    expect(ids(third.danglingOriginRows)).toEqual(ids(first.danglingOriginRows));
  });

  it('a clean database yields no Problems', async () => {
    const { chainId } = await ownerChain(h);
    await join(h, chainId, 'manager');

    await runSweep(h);

    const { problems } = await h.ctx.problems.list({ limit: 100 });
    expect(problems).toHaveLength(0);
  });
});
