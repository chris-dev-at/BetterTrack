import request from 'supertest';
import type { Application } from 'express';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MIRROR_CONFLICT,
  MIRROR_STRIPPED_ATTRIBUTION_USERNAME,
  mirrorRowInfoSchema,
  strippedMirrorAttribution,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createMirrorchainRepository } from '../data/repositories/mirrorchainRepository';
import type { MirrorOverlayViewer } from '../services/mirror';
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

    const beforeKick = attributionOf(
      await harness.ctx.mirror.overlayForPortfolio(bPid, { viewerId: bob.id }),
    );
    // Non-empty on every kind, or the assertion below is vacuous.
    expect(beforeKick.transactions.length).toBeGreaterThan(0);
    expect(beforeKick.dividends.length).toBeGreaterThan(0);
    expect(beforeKick.cashMovements.length).toBeGreaterThan(0);
    expect(beforeKick.cashSources.length).toBeGreaterThan(0);

    await harness.ctx.mirror.removeMember(alice.id, chain.id, bob.id);

    // The whole pre-fork history is attributed exactly as it was, localId for
    // localId — Alice's rows still say Alice, Bob's still say Bob.
    const afterKick = attributionOf(
      await harness.ctx.mirror.overlayForPortfolio(bPid, { viewerId: bob.id }),
    );
    expect(afterKick).toEqual(beforeKick);
    expect(afterKick.transactions.some((row) => row.endsWith(':aliceM5'))).toBe(true);
    expect(afterKick.cashSources.some((row) => row.endsWith(':bobM5'))).toBe(true);

    // Identical on the branch that stayed: the fork is not a degraded copy.
    const onTheChain = attributionOf(
      await harness.ctx.mirror.overlayForPortfolio(aPid, { viewerId: alice.id }),
    );
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

    const fork = await harness.ctx.mirror.overlayForPortfolio(bPid, { viewerId: bob.id });
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
    const active = [
      ...(
        await harness.ctx.mirror.overlayForPortfolio(aPid, { viewerId: alice.id })
      ).transactions.values(),
    ];
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
    expect(
      attributionOf(await harness.ctx.mirror.overlayForPortfolio(bPid, { viewerId: bob.id })),
    ).toEqual(forkKeysBefore);

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
    const afterOwnWrite = await harness.ctx.mirror.overlayForPortfolio(bPid, { viewerId: bob.id });
    expect(afterOwnWrite.transactions.has(bobTx!.id)).toBe(false);
    // …and it never reaches the chain's copy.
    await harness.ctx.mirror.replicateChain(chain.id);
    const aliceAfter = await harness.ctx.mirror.overlayForPortfolio(aPid, { viewerId: alice.id });
    expect([...aliceAfter.transactions.keys()]).not.toContain(bobTx!.id);
  });

  it('a portfolio that never belonged to a chain still short-circuits to empty maps', async () => {
    const stranger = await harness.seedUser({
      email: 'stranger-m5@bettertrack.test',
      username: 'strangerM5',
    });
    const pid = await harness.ctx.portfolio.getDefaultPortfolioId(stranger.id);
    const overlay = await harness.ctx.mirror.overlayForPortfolio(pid, { viewerId: stranger.id });
    expect(attributionOf(overlay)).toEqual({
      transactions: [],
      dividends: [],
      cashMovements: [],
      cashSources: [],
    });
  });
});

describe('mirrorchain M5 — attribution is derived from the VIEWER (design §10, #2033)', () => {
  /**
   * §10: "attribution renders only to viewers who are themselves active members
   * of the chain", and §6/#1612: the holder of a copy — fork included — is never
   * the third party it guards against. `overlayForPortfolio` derives that from
   * the viewer + the roster; it used to be an opt-in `stripAttribution` boolean
   * that defaulted to FULL, so the first shared-ledger caller that forgot it
   * would have handed a third party every co-member's name and id.
   *
   * Every stripped assertion is paired with a negative-space scan of the whole
   * serialized overlay for each identity term it must NOT carry.
   */
  async function chainWithEveryKind() {
    const { alice, bob, asset, aPid, bPid, chain } = await setupChain();
    // A live icon, so "a stripped row carries no icon" is not vacuously true.
    await harness.db
      .update(schema.users)
      .set({ profileIcon: 'fox' })
      .where(eq(schema.users.id, alice.id));
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
    // The third party: a real user who is on no chain at all.
    const carol = await harness.seedUser({
      email: 'carol-m5@bettertrack.test',
      username: 'carolM5',
    });
    return { alice, bob, carol, aPid, bPid, chain };
  }

  type Overlay = Awaited<ReturnType<TestHarness['ctx']['mirror']['overlayForPortfolio']>>;

  /** Stripped on all four kinds, and no identity term anywhere in the payload. */
  function expectStripped(
    overlay: Overlay,
    members: ReadonlyArray<{ id: string; username: string }>,
  ) {
    const kinds = ['transactions', 'dividends', 'cashMovements', 'cashSources'] as const;
    for (const kind of kinds) {
      // Non-empty on every kind, or the loop below is vacuous.
      expect(overlay[kind].size).toBeGreaterThan(0);
      for (const info of overlay[kind].values()) {
        expect(info.addedBy).toEqual(strippedMirrorAttribution);
      }
    }
    const serialized = JSON.stringify(kinds.map((kind) => [...overlay[kind].values()]));
    for (const member of members) {
      expect(serialized).not.toContain(member.id);
      expect(serialized).not.toContain(member.username);
    }
    expect(serialized).not.toContain('fox');
  }

  it('KEYSTONE: a viewer who is not an active member gets stripped rows by construction', async () => {
    const { alice, bob, carol, aPid } = await chainWithEveryKind();
    const overlay = await harness.ctx.mirror.overlayForPortfolio(aPid, { viewerId: carol.id });
    expectStripped(overlay, [alice, bob]);
  });

  it('no caller-supplied flag widens it — the old opt-in and bypass-looking keys are inert', async () => {
    const { alice, bob, carol, aPid } = await chainWithEveryKind();
    const typed = await harness.ctx.mirror.overlayForPortfolio(aPid, {
      viewerId: carol.id,
      // @ts-expect-error — §10 entitlement is derived from the viewer, never requested (#2033).
      stripAttribution: false,
    });
    expectStripped(typed, [alice, bob]);
    // An untyped caller smuggling keys past the compiler gets the same answer.
    const smuggled = await harness.ctx.mirror.overlayForPortfolio(aPid, {
      viewerId: carol.id,
      stripAttribution: false,
      ownerRead: true,
      full: true,
    } as unknown as MirrorOverlayViewer);
    expectStripped(smuggled, [alice, bob]);
  });

  it('an anonymous reader and a malformed call fail CLOSED (stripped), not open or crashing', async () => {
    const { alice, bob, aPid } = await chainWithEveryKind();
    expectStripped(await harness.ctx.mirror.overlayForPortfolio(aPid, { viewerId: null }), [
      alice,
      bob,
    ]);
    // The paranoid service binding forwards raw args; a caller that drops the
    // viewer must land on the restrictive side.
    expectStripped(await harness.ctx.mirror.overlayForPortfolio(aPid, undefined as never), [
      alice,
      bob,
    ]);
    expectStripped(
      await harness.ctx.mirror.overlayForPortfolio(aPid, { viewerId: '' } as MirrorOverlayViewer),
      [alice, bob],
    );
  });

  it('an ACTIVE co-member viewing a copy that is not theirs reads full attribution (the roster grant)', async () => {
    const { alice, bob, aPid } = await chainWithEveryKind();
    const overlay = await harness.ctx.mirror.overlayForPortfolio(aPid, { viewerId: bob.id });
    const aliceTx = [...overlay.transactions.values()];
    expect(aliceTx.length).toBeGreaterThan(0);
    for (const info of aliceTx) {
      expect(info.addedBy).toEqual({
        state: 'shown',
        userId: alice.id,
        username: 'aliceM5',
        profileIcon: 'fox',
      });
    }
    expect(
      [...overlay.cashSources.values()].some(
        (info) => info.addedBy.userId === bob.id && info.addedBy.username === 'bobM5',
      ),
    ).toBe(true);
  });

  it('a kicked member loses the grant on the chain copy but keeps it on their own fork (§10 vs §6)', async () => {
    const { alice, bob, carol, aPid, bPid, chain } = await chainWithEveryKind();
    await harness.ctx.mirror.removeMember(alice.id, chain.id, bob.id);

    // Off the roster → a third party to Alice's still-active copy.
    expectStripped(await harness.ctx.mirror.overlayForPortfolio(aPid, { viewerId: bob.id }), [
      alice,
      bob,
    ]);
    // …but the holder of the fork keeps the frozen attribution on their own book.
    const fork = await harness.ctx.mirror.overlayForPortfolio(bPid, { viewerId: bob.id });
    const forkTx = [...fork.transactions.values()];
    expect(forkTx.length).toBeGreaterThan(0);
    for (const info of forkTx) {
      expect(info.addedBy).toEqual({
        state: 'shown',
        userId: alice.id,
        username: 'aliceM5',
        profileIcon: null,
      });
    }
    // A non-member reading the fork (a shared fork) is still a third party.
    expectStripped(await harness.ctx.mirror.overlayForPortfolio(bPid, { viewerId: carol.id }), [
      alice,
      bob,
    ]);
  });

  it('a copy whose membership lost its user (SET NULL) never matches an anonymous reader', async () => {
    // Synthetic: account deletion normally takes the copy with it. This pins the
    // structural trap itself — `membership.userId === viewerId` with both null
    // must never read as "the viewer holds this copy".
    const { alice, bob, bPid, chain } = await chainWithEveryKind();
    await harness.ctx.mirror.removeMember(alice.id, chain.id, bob.id);
    await harness.db
      .update(schema.mirrorChainMembers)
      .set({ userId: null })
      .where(eq(schema.mirrorChainMembers.portfolioId, bPid));
    expectStripped(await harness.ctx.mirror.overlayForPortfolio(bPid, { viewerId: null }), [
      alice,
      bob,
    ]);
  });

  it('the four owner-scoped ledger routes still hand the holder full attribution; a non-member gets 404', async () => {
    const { alice, carol, aPid } = await chainWithEveryKind();
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const carolAgent = await loginAgent(harness.app, carol.email, carol.password);
    type Row = { mirror?: { addedBy: { userId: string | null; username: string } } };
    const routes: Array<[string, (body: Record<string, Row[]>) => Row[]]> = [
      ['transactions', (b) => b.items!],
      ['cash', (b) => [...b.movements!, ...b.sources!]],
      ['cash/sources', (b) => b.sources!],
      ['dividends', (b) => b.dividends!],
    ];
    for (const [path, rowsOf] of routes) {
      const res = await aliceAgent.get(`/api/v1/portfolios/${aPid}/${path}`).set(...XRW);
      expect(res.status).toBe(200);
      const attributed = rowsOf(res.body).filter((row) => row.mirror);
      expect(attributed.length, path).toBeGreaterThan(0);
      for (const row of attributed) {
        expect(row.mirror!.addedBy.userId, path).not.toBeNull();
        expect(['aliceM5', 'bobM5'], path).toContain(row.mirror!.addedBy.username);
      }
      // Ownership scoping, not the strip, is what keeps Carol off these routes.
      const foreign = await carolAgent.get(`/api/v1/portfolios/${aPid}/${path}`).set(...XRW);
      expect(foreign.status, path).toBe(404);
      expect(JSON.stringify(foreign.body), path).not.toContain('aliceM5');
    }
  });
});

describe('mirrorchain M5 — a deleted author is not a stripped one (#2009, §6/§7 vs §10)', () => {
  /**
   * TWO different mechanisms null the actor id on a chain row, and the design
   * gives them OPPOSITE renderings:
   *
   * - the author's ACCOUNT was deleted (§6/§7) — `mirror_rows.created_by`
   *   SET-NULLs, the denormalized `created_by_username` survives, and every
   *   surviving copy keeps rendering "alice (account deleted)". That is history
   *   the design promises to entitled readers;
   * - attribution was STRIPPED for this viewer (§10) — the viewer is not an
   *   active member of the chain, so the actor is replaced wholesale. A member
   *   exposes their own book, never their co-members' identities.
   *
   * Collapsing them (as `userId === null` alone forces) either loses the §6
   * promise or leaks a co-member's name. `state` is the discriminator; this
   * block pins both directions, and the §10 direction is a negative test.
   */
  async function chainWithADeletedAuthor() {
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
    const [bobSource] = [
      await harness.ctx.mirror.submitSourceCreate(bob.id, bPid, {
        name: 'Broker cash',
        type: 'bank',
      }),
    ];
    expect(bobSource).toBeTruthy();
    await harness.ctx.mirror.replicateChain(chain.id);

    // Bob is a PLAIN MEMBER, so §7 succession never fires: the chain stays
    // active with Alice as owner and Alice's copy is untouched — except that
    // the rows Bob authored on it lose their `created_by` to the SET NULL.
    await harness.ctx.accountDeletion.deleteAccount({
      userId: bob.id,
      body: { confirmUsername: bob.username, password: bob.password },
    });
    return { alice, aPid, chain, deletedUsername: bob.username, deletedUserId: bob.id };
  }

  it("an entitled viewer reads the deleted author's frozen name with state 'deleted'", async () => {
    const { alice, aPid, chain, deletedUsername } = await chainWithADeletedAuthor();
    const repo = createMirrorchainRepository(harness.db);
    // Precondition: the chain survived Bob's deletion with Alice still on it.
    expect((await repo.getChain(chain.id))!.status).toBe('active');
    expect((await repo.listActiveMembers(chain.id)).map((m) => m.userId)).toEqual([alice.id]);

    const overlay = await harness.ctx.mirror.overlayForPortfolio(aPid, { viewerId: alice.id });
    const bobRows = [...overlay.cashSources.values()].filter(
      (info) => info.addedBy.username === deletedUsername,
    );
    // Not vacuous: Bob's replicated source is on Alice's copy.
    expect(bobRows.length).toBeGreaterThan(0);
    for (const info of bobRows) {
      expect(info.addedBy.state).toBe('deleted');
      expect(info.addedBy.userId).toBeNull();
      // The §6 promise: the frozen name is what makes "(account deleted)"
      // renderable at all, so it must still be here.
      expect(info.addedBy.username).toBe('bobM5');
      expect(info.addedBy.profileIcon).toBeNull();
      // …and the row is a legal DTO, refinement included.
      expect(mirrorRowInfoSchema.safeParse(info).success).toBe(true);
    }

    // Alice is alive, so HER rows are untouched — `deleted` is per-row, derived
    // from the stored `created_by`, not a property of the copy.
    const aliceRows = [...overlay.transactions.values()];
    expect(aliceRows.length).toBeGreaterThan(0);
    for (const info of aliceRows) {
      expect(info.addedBy.state).toBe('shown');
      expect(info.addedBy.userId).toBe(alice.id);
      expect(info.addedBy.username).toBe('aliceM5');
    }

    // And it reaches the wire the chip reads, not just the service.
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const cashRes = await aliceAgent.get(`/api/v1/portfolios/${aPid}/cash`).set(...XRW);
    expect(cashRes.status).toBe(200);
    const wire = cashRes.body.sources.filter(
      (src: { mirror?: { addedBy: { state: string; username: string } } }) =>
        src.mirror?.addedBy.state === 'deleted',
    );
    expect(wire).toHaveLength(bobRows.length);
    expect(wire[0].mirror.addedBy.username).toBe('bobM5');
  });

  it('a third-party viewer gets NEITHER name: stripping outranks the deleted flag (§10)', async () => {
    const { alice, aPid, chain, deletedUsername } = await chainWithADeletedAuthor();
    const repo = createMirrorchainRepository(harness.db);

    // The third party: a real second user who is NOT an active member of the
    // chain, i.e. exactly the viewer §10 guards against on a shared copy.
    const carol = await harness.seedUser({
      email: 'carol-m5@bettertrack.test',
      username: 'carolM5',
    });
    const activeMemberIds = (await repo.listActiveMembers(chain.id)).map((m) => m.userId);
    expect(activeMemberIds).not.toContain(carol.id);
    expect(activeMemberIds).toContain(alice.id);

    const stripped = await harness.ctx.mirror.overlayForPortfolio(aPid, { viewerId: carol.id });
    const all = [
      ...stripped.transactions.values(),
      ...stripped.dividends.values(),
      ...stripped.cashMovements.values(),
      ...stripped.cashSources.values(),
    ];
    // Not vacuous: both an alive author's rows and the deleted author's are here.
    expect(all.length).toBeGreaterThan(1);
    for (const info of all) {
      expect(info.addedBy.state).toBe('stripped');
      expect(info.addedBy.userId).toBeNull();
      expect(info.addedBy.username).toBe(MIRROR_STRIPPED_ATTRIBUTION_USERNAME);
      expect(info.addedBy.profileIcon).toBeNull();
      expect(mirrorRowInfoSchema.safeParse(info).success).toBe(true);
    }
    // NEGATIVE SPACE, named term by term — the regression this guards is a
    // branch order that hands the deleted author's FROZEN name to the one
    // reader who may not have it, which a `state`-only assertion would miss.
    const serialized = JSON.stringify(all);
    expect(serialized).not.toContain(deletedUsername);
    expect(serialized).not.toContain('bobM5');
    expect(serialized).not.toContain('aliceM5');
    expect(serialized).not.toContain(alice.id);
    expect(serialized).not.toContain('account deleted');
  });
});
