import type { MirrorOpPayload } from '@bettertrack/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMirrorchainRepository } from '../data/repositories/mirrorchainRepository';
import { portfolios } from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * MIRRORCHAIN M1 storage tests (`docs/mirrorchain-design.md` §§1–2). Exercise the
 * access patterns §2 needs against real (PGlite) tables: the `last_seq` append
 * lock + dense seqs, seq-ordered reads, watermark monotonicity, membership
 * lookups, and the §1 partial-unique invariants.
 */
describe('mirrorchainRepository (M1)', () => {
  let harness: TestHarness;
  let repo: ReturnType<typeof createMirrorchainRepository>;

  beforeEach(async () => {
    harness = await createTestApp();
    repo = createMirrorchainRepository(harness.db);
  });

  async function seedPortfolio(userId: string, name: string): Promise<string> {
    const [row] = await harness.db
      .insert(portfolios)
      .values({ userId, name })
      .returning({ id: portfolios.id });
    return row!.id;
  }

  function txPayload(mirrorId: string): MirrorOpPayload {
    return {
      opVersion: 1,
      kind: 'tx.create',
      mirrorId,
      assetId: mirrorId,
      side: 'buy',
      quantity: 1,
      price: 10,
      fee: 0,
      executedAt: '2026-07-22T10:00:00.000Z',
      note: null,
      allowUncovered: false,
      uncoveredEntryPrice: null,
      originSource: 'manual',
    };
  }

  async function seedChainWithOwner() {
    const owner = await harness.seedUser({
      email: 'owner@bettertrack.test',
      username: 'owner',
    });
    const chain = await repo.createChain({
      name: 'Family',
      createdBy: owner.id,
      createdByUsername: owner.username,
    });
    const pid = await seedPortfolio(owner.id, 'Family');
    const member = await repo.insertMember({
      chainId: chain.id,
      userId: owner.id,
      username: owner.username,
      portfolioId: pid,
      role: 'owner',
    });
    return { owner, chain, pid, member };
  }

  it('appendOps assigns dense consecutive seqs under the chain lock and bumps last_seq', async () => {
    const { chain, owner } = await seedChainWithOwner();
    const MIRROR_A = '018f0000-0000-7000-8000-00000000000a';
    const MIRROR_B = '018f0000-0000-7000-8000-00000000000b';

    const first = await repo.appendOps(chain.id, [
      {
        kind: 'tx.create',
        mirrorId: MIRROR_A,
        actorUserId: owner.id,
        actorUsername: owner.username,
        payload: txPayload(MIRROR_A),
      },
    ]);
    expect(first.map((o) => o.seq)).toEqual([1]);

    // A batch submit lands as ONE append → consecutive seqs.
    const batch = await repo.appendOps(chain.id, [
      {
        kind: 'tx.create',
        mirrorId: MIRROR_B,
        actorUserId: owner.id,
        actorUsername: owner.username,
        payload: txPayload(MIRROR_B),
      },
      {
        kind: 'tx.create',
        mirrorId: MIRROR_B,
        actorUserId: owner.id,
        actorUsername: owner.username,
        payload: txPayload(MIRROR_B),
      },
    ]);
    expect(batch.map((o) => o.seq)).toEqual([2, 3]);

    const reloaded = await repo.getChain(chain.id);
    expect(reloaded?.lastSeq).toBe(3);
  });

  it('listOpsSince reads in seq order; latestOpForEntity returns the highest-seq op', async () => {
    const { chain, owner } = await seedChainWithOwner();
    const MIRROR_A = '018f0000-0000-7000-8000-00000000000a';
    const MIRROR_B = '018f0000-0000-7000-8000-00000000000b';
    for (const m of [MIRROR_A, MIRROR_B, MIRROR_A]) {
      await repo.appendOps(chain.id, [
        {
          kind: 'tx.create',
          mirrorId: m,
          actorUserId: owner.id,
          actorUsername: owner.username,
          payload: txPayload(m),
        },
      ]);
    }

    const since1 = await repo.listOpsSince(chain.id, 1);
    expect(since1.map((o) => o.seq)).toEqual([2, 3]);

    const latestA = await repo.latestOpForEntity(chain.id, MIRROR_A);
    expect(latestA?.seq).toBe(3); // ops 1 and 3 targeted A → highest is 3
    const latestB = await repo.latestOpForEntity(chain.id, MIRROR_B);
    expect(latestB?.seq).toBe(2);
    expect(
      await repo.latestOpForEntity(chain.id, '018f0000-0000-7000-8000-0000000000ff'),
    ).toBeNull();
  });

  it('advanceWatermark moves forward only (idempotent replay guard)', async () => {
    const { member } = await seedChainWithOwner();
    expect(await repo.advanceWatermark(member.id, 5)).toBe(true);
    // Re-delivering an already-applied seq is a no-op.
    expect(await repo.advanceWatermark(member.id, 5)).toBe(false);
    expect(await repo.advanceWatermark(member.id, 3)).toBe(false);
    expect(await repo.advanceWatermark(member.id, 6)).toBe(true);
    const reloaded = await repo.findActiveMembership(member.chainId, member.userId!);
    expect(reloaded?.appliedSeq).toBe(6);
  });

  it('membership lookups identify a synced copy and clear on tombstone', async () => {
    const { chain, owner, pid, member } = await seedChainWithOwner();

    const byPortfolio = await repo.findActiveMembershipByPortfolio(pid);
    expect(byPortfolio?.id).toBe(member.id);
    expect((await repo.listActiveMembershipsForUser(owner.id)).map((m) => m.chainId)).toContain(
      chain.id,
    );

    await repo.endMembership(member.id, 'removed', new Date());
    // The fork's portfolio is no longer an active synced copy.
    expect(await repo.findActiveMembershipByPortfolio(pid)).toBeNull();
    expect(await repo.findActiveMembership(chain.id, owner.id)).toBeNull();
    expect(await repo.listActiveMembershipsForUser(owner.id)).toHaveLength(0);
  });

  it('listActiveMembers orders by join tenure (succession order, §7)', async () => {
    const { chain } = await seedChainWithOwner();
    const m1 = await harness.seedUser({ email: 'm1@bettertrack.test', username: 'm1' });
    const m2 = await harness.seedUser({ email: 'm2@bettertrack.test', username: 'm2' });
    await repo.insertMember({
      chainId: chain.id,
      userId: m1.id,
      username: m1.username,
      portfolioId: await seedPortfolio(m1.id, 'Family'),
      role: 'manager',
    });
    await repo.insertMember({
      chainId: chain.id,
      userId: m2.id,
      username: m2.username,
      portfolioId: await seedPortfolio(m2.id, 'Family'),
      role: 'member',
    });
    const members = await repo.listActiveMembers(chain.id);
    expect(members.map((m) => m.role)).toEqual(['owner', 'manager', 'member']);
  });

  it('enforces the §1 invariants: one active owner + one chain per portfolio', async () => {
    const { chain, pid } = await seedChainWithOwner();
    const other = await harness.seedUser({ email: 'x@bettertrack.test', username: 'x' });
    // A second ACTIVE owner in the same chain violates the partial-unique index.
    await expect(
      repo.insertMember({
        chainId: chain.id,
        userId: other.id,
        username: other.username,
        portfolioId: await seedPortfolio(other.id, 'Other'),
        role: 'owner',
      }),
    ).rejects.toThrow();
    // A portfolio already in an active membership cannot join a second chain.
    const chain2 = await repo.createChain({
      name: 'Second',
      createdBy: other.id,
      createdByUsername: other.username,
    });
    await expect(
      repo.insertMember({
        chainId: chain2.id,
        userId: other.id,
        username: other.username,
        portfolioId: pid,
        role: 'owner',
      }),
    ).rejects.toThrow();
  });

  it('invites are unique while pending; a declined invite allows re-invite', async () => {
    const { chain, owner } = await seedChainWithOwner();
    const invitee = await harness.seedUser({ email: 'inv@bettertrack.test', username: 'inv' });

    const invite = await repo.createInvite({
      chainId: chain.id,
      fromUser: owner.id,
      toUser: invitee.id,
    });
    expect((await repo.findPendingInvite(chain.id, invitee.id))?.id).toBe(invite.id);
    await expect(
      repo.createInvite({ chainId: chain.id, fromUser: owner.id, toUser: invitee.id }),
    ).rejects.toThrow();

    await repo.setInviteStatus(invite.id, 'declined', new Date());
    expect(await repo.findPendingInvite(chain.id, invitee.id)).toBeNull();
    // Re-invite after a decline is allowed (pending-uniqueness, not per-pair).
    const reinvite = await repo.createInvite({
      chainId: chain.id,
      fromUser: owner.id,
      toUser: invitee.id,
    });
    expect((await repo.listPendingInvitesForUser(invitee.id)).map((i) => i.id)).toEqual([
      reinvite.id,
    ]);
  });

  it('mirror rows map logical↔local, dedupe creates, and re-point on correction', async () => {
    const { chain, owner, pid } = await seedChainWithOwner();
    const MIRROR = '018f0000-0000-7000-8000-00000000000a';
    const LOCAL = '018f0000-0000-7000-8000-0000000000d1';

    await repo.insertMirrorRow({
      chainId: chain.id,
      kind: 'transaction',
      mirrorId: MIRROR,
      portfolioId: pid,
      localId: LOCAL,
      createdBy: owner.id,
      createdByUsername: owner.username,
    });

    const found = await repo.findMirrorRow('transaction', MIRROR, pid);
    expect(found?.localId).toBe(LOCAL);
    expect(found?.createdByUsername).toBe('owner');
    expect((await repo.findMirrorRowByLocal('transaction', LOCAL))?.mirrorId).toBe(MIRROR);
    expect(await repo.listMirrorRowsForPortfolio(pid)).toHaveLength(1);

    // Idempotency: the natural key (kind, mirrorId, portfolioId) rejects a re-create.
    await expect(
      repo.insertMirrorRow({
        chainId: chain.id,
        kind: 'transaction',
        mirrorId: MIRROR,
        portfolioId: pid,
        localId: '018f0000-0000-7000-8000-0000000000d2',
        createdBy: owner.id,
        createdByUsername: owner.username,
      }),
    ).rejects.toThrow();

    // Tax-immutable correction re-points the link to a fresh local row (§2).
    const NEW_LOCAL = '018f0000-0000-7000-8000-0000000000d3';
    await repo.repointMirrorRow('transaction', MIRROR, pid, NEW_LOCAL);
    expect((await repo.findMirrorRow('transaction', MIRROR, pid))?.localId).toBe(NEW_LOCAL);
  });
});
