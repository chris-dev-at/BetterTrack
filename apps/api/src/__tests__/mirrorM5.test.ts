import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { MIRROR_CONFLICT, MIRROR_STRIPPED_ATTRIBUTION_USERNAME } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createMirrorchainRepository } from '../data/repositories/mirrorchainRepository';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * MIRRORCHAIN M5 — the UI-facing wire integration (V5-P7 M5, issue #685):
 * baseSeq wired through the HTTP edit contracts + `mirror` overlay on ledger
 * DTOs + chain badge / fork provenance on portfolio summaries + the design §10
 * attribution-stripping overlay used for non-member shared reads. The M2 tests
 * already cover the service seam; this file exercises the M5 boundary.
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

beforeEach(async () => {
  harness = await createTestApp();
});

/** Alice as owner with a converted default portfolio; Bob attached with a synced copy. */
async function setupChain() {
  const alice = await harness.seedUser({
    email: 'alice-m5@bettertrack.test',
    username: 'aliceM5',
  });
  const bob = await harness.seedUser({ email: 'bob-m5@bettertrack.test', username: 'bobM5' });
  const asset = await seedAsset(harness);
  const aPid = await harness.ctx.portfolio.getDefaultPortfolioId(alice.id);
  const { chain } = await harness.ctx.mirror.convertToChain(alice.id, aPid, {
    name: 'Family M5',
  });
  const { portfolioId: bPid } = await harness.ctx.mirror.attachMemberCopy(chain.id, bob.id);
  await harness.ctx.mirror.replicateChain(chain.id);
  return { alice, bob, asset, aPid, bPid, chain };
}

describe('mirrorchain M5 — baseSeq wired end-to-end (design §3)', () => {
  it('PATCH /portfolios/:id/transactions/:txId with a stale baseSeq → 409 MIRROR_CONFLICT', async () => {
    const { alice, bob, asset, aPid, bPid, chain } = await setupChain();
    const mirrorRepo = createMirrorchainRepository(harness.db);

    // Alice creates a transaction; both copies converge.
    const [aliceTx] = await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
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

    // Alice edits the row first (locks in seq N+1).
    const link = await mirrorRepo.findMirrorRowByLocal('transaction', aliceTx!.id);
    const staleBaseSeq = (await mirrorRepo.latestOpForEntity(chain.id, link!.mirrorId))!.seq;
    await harness.ctx.mirror.submitTransactionUpdate(
      alice.id,
      aPid,
      aliceTx!.id,
      { quantity: 6 },
      { baseSeq: staleBaseSeq },
    );

    // Bob's client opened the row when its version was `staleBaseSeq` and now
    // hits PATCH with that stale baseSeq — the wire request must surface as
    // 409 MIRROR_CONFLICT (the M5 mandate the M2 seam has always enforced).
    const bobLink = await mirrorRepo.findMirrorRowByLocal('transaction', aliceTx!.id);
    // We take the mirror_id from Alice's link and resolve Bob's LOCAL id.
    const bobLocal = (await mirrorRepo.findMirrorRow('transaction', bobLink!.mirrorId, bPid))!
      .localId;

    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const res = await bobAgent
      .patch(`/api/v1/portfolios/${bPid}/transactions/${bobLocal}`)
      .set(...XRW)
      .send({ price: 110, baseSeq: staleBaseSeq });
    expect(res.status).toBe(409);
    expect(res.body?.error?.code).toBe(MIRROR_CONFLICT);
  });

  it('DELETE /portfolios/:id/transactions/:txId body { baseSeq } propagates the guard', async () => {
    const { alice, aPid, chain, asset } = await setupChain();
    const mirrorRepo = createMirrorchainRepository(harness.db);
    const [tx] = await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 3,
        price: 50,
        fee: 0,
        executedAt: new Date().toISOString(),
      },
    ]);
    await harness.ctx.mirror.replicateChain(chain.id);

    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const link = await mirrorRepo.findMirrorRowByLocal('transaction', tx!.id);
    const latest = (await mirrorRepo.latestOpForEntity(chain.id, link!.mirrorId))!.seq;

    // A stale baseSeq on DELETE is refused with 409 MIRROR_CONFLICT.
    const stale = await aliceAgent
      .delete(`/api/v1/portfolios/${aPid}/transactions/${tx!.id}`)
      .set(...XRW)
      .send({ baseSeq: latest - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body?.error?.code).toBe(MIRROR_CONFLICT);

    // The fresh baseSeq deletes cleanly (204).
    const fresh = await aliceAgent
      .delete(`/api/v1/portfolios/${aPid}/transactions/${tx!.id}`)
      .set(...XRW)
      .send({ baseSeq: latest });
    expect(fresh.status).toBe(204);
  });

  it('GET /portfolios/:id/transactions on a synced copy carries the `mirror` overlay', async () => {
    const { alice, aPid, chain, asset } = await setupChain();
    await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 2,
        price: 25,
        fee: 0,
        executedAt: new Date().toISOString(),
      },
    ]);
    await harness.ctx.mirror.replicateChain(chain.id);

    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const res = await aliceAgent.get(`/api/v1/portfolios/${aPid}/transactions`).set(...XRW);
    expect(res.status).toBe(200);
    const [row] = res.body.items;
    expect(row.mirror).toBeDefined();
    expect(row.mirror.version).toBeGreaterThan(0);
    expect(row.mirror.addedBy.username).toBe('aliceM5');
  });

  it('GET /portfolios on a chain user carries the `mirror` badge (design §11)', async () => {
    const { alice, bob, bPid, chain } = await setupChain();
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const res = await bobAgent.get('/api/v1/portfolios').set(...XRW);
    expect(res.status).toBe(200);
    const badge = res.body.portfolios.find((p: { id: string }) => p.id === bPid);
    expect(badge.mirror).toBeDefined();
    expect(badge.mirror.chainId).toBe(chain.id);
    expect(badge.mirror.chainName).toBe('Family M5');
    expect(badge.mirror.role).toBe('member');
    expect(badge.mirror.memberCount).toBe(2);
    // Alice's own copy also carries the badge — proves both members see it.
    void alice; // (referenced for clarity; not asserted here)
  });

  it('GET /portfolios on a fork carries `mirrorFork` (design §6 provenance line)', async () => {
    // Bob leaves → his copy is a fork; the portfolio summary carries the tombstone.
    const { bob, bPid, chain } = await setupChain();
    await harness.ctx.mirror.leaveChain(bob.id, chain.id);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const res = await bobAgent.get('/api/v1/portfolios').set(...XRW);
    expect(res.status).toBe(200);
    const fork = res.body.portfolios.find((p: { id: string }) => p.id === bPid);
    expect(fork.mirror).toBeUndefined();
    expect(fork.mirrorFork).toBeDefined();
    expect(fork.mirrorFork.chainId).toBe(chain.id);
    expect(fork.mirrorFork.chainName).toBe('Family M5');
    expect(typeof fork.mirrorFork.endedAt).toBe('string');
  });
});

/** The overlay reduced to what the chip renders, per kind: localId → username. */
function attributionOf(overlay: {
  transactions: Map<string, { addedBy: { username: string } }>;
  dividends: Map<string, { addedBy: { username: string } }>;
  cashMovements: Map<string, { addedBy: { username: string } }>;
  cashSources: Map<string, { addedBy: { username: string } }>;
}) {
  const names = (m: Map<string, { addedBy: { username: string } }>) =>
    [...m.entries()].map(([localId, info]) => `${localId}:${info.addedBy.username}`).sort();
  return {
    transactions: names(overlay.transactions),
    dividends: names(overlay.dividends),
    cashMovements: names(overlay.cashMovements),
    cashSources: names(overlay.cashSources),
  };
}

describe('mirrorchain M5 — a fork keeps its attribution (#1612, design §6)', () => {
  /**
   * Design §6 "What stays" is verbatim: `mirror_rows` attribution links survive
   * a fork "so 'added by alice' still renders in the fork's history". The
   * overlay used to short-circuit on `findActiveMembershipByPortfolio`, so the
   * moment a member was kicked every "added by …" chip on their transactions,
   * dividends, cash movements and cash sources went blank.
   *
   * The §10 sentence "attribution renders only to viewers who are themselves
   * active members" is the ORTHOGONAL rule, resolved in the design note by this
   * issue: it binds THIRD-PARTY VIEWERS of a shared/public copy, never the
   * holder of the copy itself.
   */
  async function chainWithOneOfEach() {
    const { alice, bob, asset, aPid, bPid, chain } = await setupChain();
    await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 4,
        price: 20,
        fee: 0,
        executedAt: '2026-02-01T10:00:00.000Z',
      },
    ]);
    await harness.ctx.mirror.submitDividendRecord(alice.id, aPid, {
      assetId: asset.id,
      grossAmountEur: 12,
    });
    await harness.ctx.mirror.submitCashDeposit(alice.id, aPid, { amountEur: 250 });
    await harness.ctx.mirror.submitSourceCreate(bob.id, bPid, {
      name: 'Broker cash',
      type: 'bank',
    });
    await harness.ctx.mirror.replicateChain(chain.id);
    return { alice, bob, asset, aPid, bPid, chain };
  }

  it('a kicked member keeps "added by …" on all four kinds, and the chip survives the HTTP read', async () => {
    const { alice, bob, aPid, bPid, chain } = await chainWithOneOfEach();

    const beforeKick = attributionOf(await harness.ctx.mirror.overlayForPortfolio(bPid));
    // Non-empty on every kind, or the assertion below is vacuous.
    expect(beforeKick.transactions.length).toBeGreaterThan(0);
    expect(beforeKick.dividends.length).toBeGreaterThan(0);
    expect(beforeKick.cashMovements.length).toBeGreaterThan(0);
    expect(beforeKick.cashSources.length).toBeGreaterThan(0);

    await harness.ctx.mirror.removeMember(alice.id, chain.id, bob.id);

    // The whole pre-fork history is attributed exactly as it was, localId for
    // localId — Alice's rows still say Alice, Bob's still say Bob.
    const afterKick = attributionOf(await harness.ctx.mirror.overlayForPortfolio(bPid));
    expect(afterKick).toEqual(beforeKick);
    expect(afterKick.transactions.some((row) => row.endsWith(':aliceM5'))).toBe(true);
    expect(afterKick.cashSources.some((row) => row.endsWith(':bobM5'))).toBe(true);

    // Identical on the branch that stayed: the fork is not a degraded copy.
    const onTheChain = attributionOf(await harness.ctx.mirror.overlayForPortfolio(aPid));
    const kinds = ['transactions', 'dividends', 'cashMovements'] as const;
    for (const kind of kinds) {
      const forkNames = afterKick[kind].map((row) => row.split(':')[1]).sort();
      const chainNames = onTheChain[kind].map((row) => row.split(':')[1]).sort();
      expect(forkNames).toEqual(chainNames);
    }

    // And it reaches the wire the UI reads, not just the service.
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const txRes = await bobAgent.get(`/api/v1/portfolios/${bPid}/transactions`).set(...XRW);
    expect(txRes.status).toBe(200);
    expect(txRes.body.items[0].mirror.addedBy.username).toBe('aliceM5');
    const cashRes = await bobAgent.get(`/api/v1/portfolios/${bPid}/cash`).set(...XRW);
    expect(cashRes.status).toBe(200);
    expect(
      cashRes.body.movements.some(
        (m: { mirror?: { addedBy: { username: string } } }) =>
          m.mirror?.addedBy.username === 'aliceM5',
      ),
    ).toBe(true);
    expect(
      cashRes.body.sources.some(
        (src: { mirror?: { addedBy: { username: string } } }) =>
          src.mirror?.addedBy.username === 'bobM5',
      ),
    ).toBe(true);
  });

  it('a member who leaves keeps it too, and the fork reads FROZEN — no live icon, no chain version', async () => {
    const { alice, bob, asset, aPid, bPid, chain } = await chainWithOneOfEach();
    await harness.ctx.mirror.leaveChain(bob.id, chain.id);

    const fork = await harness.ctx.mirror.overlayForPortfolio(bPid);
    const forkRows = [...fork.transactions.values()];
    expect(forkRows.length).toBeGreaterThan(0);
    for (const info of forkRows) {
      // The identity stored on the fork's own rows still renders …
      expect(info.addedBy.username).toBe('aliceM5');
      expect(info.addedBy.userId).toBe(alice.id);
      // … but §6 severs every LIVE chain read: no co-member's current icon, and
      // no chain op version that would keep ticking as the others edit.
      expect(info.addedBy.profileIcon).toBeNull();
      expect(info.version).toBe(0);
    }

    // The still-active copy is unaffected — it keeps the live version.
    const active = [...(await harness.ctx.mirror.overlayForPortfolio(aPid)).transactions.values()];
    expect(active.every((info) => info.version > 0)).toBe(true);

    // No cross-fork leakage in either direction after the severance.
    const forkKeysBefore = attributionOf(fork);
    await harness.ctx.mirror.submitTransactionsCreate(alice.id, aPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 1,
        price: 30,
        fee: 0,
        executedAt: '2026-03-01T10:00:00.000Z',
      },
    ]);
    await harness.ctx.mirror.replicateChain(chain.id);
    expect(attributionOf(await harness.ctx.mirror.overlayForPortfolio(bPid))).toEqual(
      forkKeysBefore,
    );

    // Bob's own post-fork write is a plain local row: his fork is an ordinary
    // portfolio again, so it carries no chain attribution at all.
    const [bobTx] = await harness.ctx.mirror.submitTransactionsCreate(bob.id, bPid, [
      {
        assetId: asset.id,
        side: 'buy',
        quantity: 2,
        price: 15,
        fee: 0,
        executedAt: '2026-03-02T10:00:00.000Z',
      },
    ]);
    const afterOwnWrite = await harness.ctx.mirror.overlayForPortfolio(bPid);
    expect(afterOwnWrite.transactions.has(bobTx!.id)).toBe(false);
    // …and it never reaches the chain's copy.
    await harness.ctx.mirror.replicateChain(chain.id);
    const aliceAfter = await harness.ctx.mirror.overlayForPortfolio(aPid);
    expect([...aliceAfter.transactions.keys()]).not.toContain(bobTx!.id);
  });

  it('a portfolio that never belonged to a chain still short-circuits to empty maps', async () => {
    const stranger = await harness.seedUser({
      email: 'stranger-m5@bettertrack.test',
      username: 'strangerM5',
    });
    const pid = await harness.ctx.portfolio.getDefaultPortfolioId(stranger.id);
    const overlay = await harness.ctx.mirror.overlayForPortfolio(pid);
    expect(attributionOf(overlay)).toEqual({
      transactions: [],
      dividends: [],
      cashMovements: [],
      cashSources: [],
    });
  });
});

describe('mirrorchain M5 — attribution stripping (design §10)', () => {
  it('overlayForPortfolio({ stripAttribution }) replaces every actor with the generic chip', async () => {
    const { alice, aPid, chain, asset } = await setupChain();
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
    await harness.ctx.mirror.replicateChain(chain.id);
    const stripped = await harness.ctx.mirror.overlayForPortfolio(aPid, {
      stripAttribution: true,
    });
    for (const info of stripped.transactions.values()) {
      expect(info.addedBy.userId).toBeNull();
      expect(info.addedBy.username).toBe(MIRROR_STRIPPED_ATTRIBUTION_USERNAME);
      expect(info.addedBy.profileIcon).toBeNull();
    }
    // Sanity: without the flag the actor is preserved.
    const kept = await harness.ctx.mirror.overlayForPortfolio(aPid);
    for (const info of kept.transactions.values()) {
      expect(info.addedBy.username).toBe('aliceM5');
    }
  });
});
