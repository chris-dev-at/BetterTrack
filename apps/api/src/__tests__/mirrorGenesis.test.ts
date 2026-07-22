import { beforeEach, describe, expect, it } from 'vitest';

import { SOURCE_TAG_SYNC_MIRRORCHAIN } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { eq } from 'drizzle-orm';
import { createMirrorchainRepository } from '../data/repositories/mirrorchainRepository';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * MIRRORCHAIN M2 — genesis + join replay (`docs/mirrorchain-design.md` §2, §8;
 * issue #644). Converting a portfolio synthesizes genesis ops so the oplog is
 * complete from seq 1; a join creates an empty auto-named copy (Main
 * pre-linked, §8) and the SAME replicate replay used for steady-state sync
 * materializes the full history — one code path, no row copying.
 */

let harness: TestHarness;
let mirrorRepo: ReturnType<typeof createMirrorchainRepository>;

beforeEach(async () => {
  harness = await createTestApp();
  mirrorRepo = createMirrorchainRepository(harness.db);
});

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

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

describe('mirrorchain M2 — genesis + join replay', () => {
  it('convert synthesizes a complete oplog; a join replays it into an identical copy (§2, §8)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bettertrack.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bettertrack.test', username: 'bob' });
    const asset = await seedAsset(harness);
    const aPid = await harness.ctx.portfolio.getDefaultPortfolioId(alice.id);

    // Pre-chain history: cash in, a named + an archived source, a transfer, a
    // pay-from-cash buy, a withdrawal, and a dividend BACKDATED before the buy
    // (the replay-order edge: the held-asset guard is date-blind).
    await harness.ctx.portfolio.depositCash(alice.id, aPid, {
      amountEur: 1000,
      executedAt: daysAgo(20),
    });
    const broker = await harness.ctx.portfolio.createCashSource(alice.id, aPid, {
      name: 'Broker',
      type: 'bank',
    });
    const old = await harness.ctx.portfolio.createCashSource(alice.id, aPid, {
      name: 'Old',
      type: 'custom',
    });
    await harness.ctx.portfolio.archiveCashSource(alice.id, aPid, old.id);
    await harness.ctx.portfolio.transferCash(alice.id, aPid, {
      fromSourceId: (await harness.ctx.portfolio.listCashSources(alice.id, aPid)).sources.find(
        (s) => s.isMain,
      )!.id,
      toSourceId: broker.id,
      amountEur: 200,
      executedAt: daysAgo(15),
    });
    await harness.ctx.portfolio.createTransactions(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 10,
        price: 50,
        fee: 0,
        executedAt: daysAgo(5),
        payFromCash: true,
      },
    ]);
    await harness.ctx.tax.recordDividend(alice.id, aPid, {
      assetId: asset.id,
      grossAmountEur: 30,
      executedAt: daysAgo(10), // before the buy — must still replay
    });
    await harness.ctx.portfolio.withdrawCash(alice.id, aPid, {
      amountEur: 50,
      executedAt: daysAgo(2),
    });

    const { chain, member: owner } = await harness.ctx.mirror.convertToChain(alice.id, aPid);
    // The origin's content pre-exists genesis: its watermark starts complete.
    expect(owner.appliedSeq).toBe((await mirrorRepo.getChain(chain.id))!.lastSeq);
    const ops = await mirrorRepo.listOpsSince(chain.id, 0);
    expect(ops[0]!.kind).toBe('chain.genesis');
    expect(ops.filter((o) => o.kind === 'source.create')).toHaveLength(3); // Main, Broker, Old
    expect(ops.filter((o) => o.kind === 'source.archive')).toHaveLength(1);
    expect(ops.filter((o) => o.kind === 'tx.create')).toHaveLength(1);
    expect(ops.filter((o) => o.kind === 'dividend.record')).toHaveLength(1);
    expect(ops.filter((o) => o.kind === 'cash.deposit')).toHaveLength(1);
    expect(ops.filter((o) => o.kind === 'cash.withdraw')).toHaveLength(1);
    expect(ops.filter((o) => o.kind === 'cash.transfer')).toHaveLength(1);

    // Join: the copy exists immediately (auto-named around Bob's own "Main"),
    // and the standard replicate replay materializes the history.
    const { member, portfolioId: bPid } = await harness.ctx.mirror.attachMemberCopy(
      chain.id,
      bob.id,
    );
    expect(member.appliedSeq).toBe(0);
    const result = await harness.ctx.mirror.replicateChain(chain.id);
    expect(result.lagging).toBe(0);

    // Holdings + ledgers match the origin, derived through Bob's own services.
    const bTxs = (await harness.ctx.portfolio.listTransactions(bob.id, bPid, {})).items;
    expect(bTxs).toHaveLength(1);
    expect(bTxs[0]!.quantity).toBe(10);
    expect(bTxs[0]!.source).toBe(SOURCE_TAG_SYNC_MIRRORCHAIN);
    expect((await harness.ctx.tax.listDividends(bob.id, bPid)).dividends).toHaveLength(1);

    // Sources: exactly one Main (the chain Main mapped onto the copy's own,
    // §8 — never a duplicate), the named source, and the archived one.
    const bSources = (
      await harness.ctx.portfolio.listCashSources(bob.id, bPid, { includeArchived: true })
    ).sources;
    expect(bSources.filter((s) => s.isMain)).toHaveLength(1);
    expect(bSources.map((s) => s.name).sort()).toEqual(['Broker', 'Main', 'Old']);
    expect(bSources.find((s) => s.name === 'Old')!.archivedAt).not.toBeNull();

    // Balances converge exactly (both copies tax `none` — zero skew): Main
    // 1000 − 200 − 500 + 30 − 50 = 280, Broker 200.
    const balance = (name: string, list: typeof bSources) =>
      list.find((s) => s.name === name)!.balanceEur;
    expect(balance('Main', bSources)).toBe(280);
    expect(balance('Broker', bSources)).toBe(200);
    const aSources = (
      await harness.ctx.portfolio.listCashSources(alice.id, aPid, { includeArchived: true })
    ).sources;
    expect(balance('Main', aSources)).toBe(280);
    expect(balance('Broker', aSources)).toBe(200);

    // Attribution survives on every replicated row; the per-copy audit trail is
    // complete — exactly one `mirror.op_applied` row per op applied to the copy.
    const links = await mirrorRepo.listMirrorRowsForPortfolio(bPid);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.createdByUsername === 'alice')).toBe(true);
    const auditRows = (
      await harness.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'mirror.op_applied'))
    ).filter((r) => (r.meta as { portfolioId?: string })?.portfolioId === bPid);
    expect(auditRows).toHaveLength(result.applied);
    for (const row of auditRows) {
      expect(row.actorId).toBe(alice.id);
      expect((row.meta as { actorUsername?: string }).actorUsername).toBe('alice');
      expect((row.meta as { chainId?: string }).chainId).toBe(chain.id);
    }

    // Re-running the replay is a no-op (idempotent join, §2).
    const again = await harness.ctx.mirror.replicateChain(chain.id);
    expect(again.applied).toBe(0);
    expect((await harness.ctx.portfolio.listTransactions(bob.id, bPid, {})).items).toHaveLength(1);
  });

  it('convert refuses a portfolio holding custom-asset rows before any chain row exists (§10 — a genesis op for one would stall every join)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bettertrack.test', username: 'alice' });
    const aPid = await harness.ctx.portfolio.getDefaultPortfolioId(alice.id);
    const [custom] = await harness.db
      .insert(schema.assets)
      .values({
        providerId: 'manual',
        providerRef: `custom:${alice.id}:art`,
        type: 'custom',
        symbol: 'ART',
        name: 'Art collection',
        currency: 'EUR',
        ownerId: alice.id,
      })
      .returning();
    await harness.ctx.portfolio.createTransactions(alice.id, aPid, [
      {
        assetId: custom!.id,
        side: 'buy',
        quantity: 1,
        price: 500,
        fee: 0,
        executedAt: daysAgo(3),
      },
    ]);

    await expect(harness.ctx.mirror.convertToChain(alice.id, aPid)).rejects.toMatchObject({
      code: 'MIRROR_ASSET_NOT_SYNCABLE',
    });
    // Refused BEFORE the chain was created — no half-built chain to clean up.
    expect(await harness.db.select().from(schema.mirrorChains)).toHaveLength(0);
    expect(await harness.db.select().from(schema.mirrorChainMembers)).toHaveLength(0);
  });

  it('convert refuses an already-synced portfolio; join refuses double membership', async () => {
    const alice = await harness.seedUser({ email: 'alice@bettertrack.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bettertrack.test', username: 'bob' });
    const aPid = await harness.ctx.portfolio.getDefaultPortfolioId(alice.id);
    const { chain } = await harness.ctx.mirror.convertToChain(alice.id, aPid);
    await expect(harness.ctx.mirror.convertToChain(alice.id, aPid)).rejects.toMatchObject({
      code: 'MIRROR_ALREADY_SYNCED',
    });
    await harness.ctx.mirror.attachMemberCopy(chain.id, bob.id);
    await expect(harness.ctx.mirror.attachMemberCopy(chain.id, bob.id)).rejects.toMatchObject({
      code: 'MIRROR_ALREADY_MEMBER',
    });
  });
});
