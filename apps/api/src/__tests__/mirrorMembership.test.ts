import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  MIRROR_CANNOT_INVITE_SELF,
  MIRROR_FORBIDDEN,
  MIRROR_INVITE_EXISTS,
  MIRROR_INVITE_NOT_FOUND,
  MIRROR_MEMBER_CAP_REACHED,
  MIRROR_NOT_FRIENDS,
  MIRROR_OWNER_TRANSFER_REQUIRED,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createMirrorchainRepository } from '../data/repositories/mirrorchainRepository';
import { MIRROR_INVITE_TTL_MS } from '../services/mirror/mirrorService';
import type { DispatchableEvent } from '../services/notifications/notificationDispatcher';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * MIRRORCHAIN M3 — membership lifecycle (`docs/mirrorchain-design.md` §§4–7,
 * §11; issue #680). The §12 test list: the §5 authority matrix (every capability
 * × role, plus the revoke-vs-kick role race), kick-freeze with a lagging copy,
 * re-invite → a brand-new copy, invite-void-on-unfriend, transfer, dissolve, the
 * §7 owner-refusal stopgap, and the eight `mirror.*` notifications dispatching
 * through the existing dispatcher.
 */

let seq = 0;
function uu(prefix: string): { email: string; username: string } {
  seq += 1;
  return { email: `${prefix}-${seq}@bettertrack.test`, username: `${prefix}${seq}` };
}

const repoOf = (h: TestHarness) => createMirrorchainRepository(h.db);

async function makeFriends(h: TestHarness, a: string, b: string): Promise<void> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await h.db.insert(schema.friendships).values({ userA: lo, userB: hi });
}

async function unfriend(h: TestHarness, a: string, b: string): Promise<void> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await h.db
    .delete(schema.friendships)
    .where(and(eq(schema.friendships.userA, lo), eq(schema.friendships.userB, hi)));
}

/** Age an invite by rewinding its `created_at` (there is no `expires_at` column). */
async function backdateInvite(h: TestHarness, inviteId: string, ageDays: number): Promise<void> {
  await h.db
    .update(schema.mirrorChainInvites)
    .set({ createdAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000) })
    .where(eq(schema.mirrorChainInvites.id, inviteId));
}

/** The current status of an invite row (asserting the expiry transition). */
async function inviteStatus(h: TestHarness, inviteId: string): Promise<string> {
  const [row] = await h.db
    .select()
    .from(schema.mirrorChainInvites)
    .where(eq(schema.mirrorChainInvites.id, inviteId));
  return row!.status;
}

/** Owner O with a converted chain; returns O + chainId + O's copy id. */
async function ownerChain(h: TestHarness) {
  const owner = await h.seedUser(uu('owner'));
  const portfolioId = await h.ctx.portfolio.getDefaultPortfolioId(owner.id);
  const { chain } = await h.ctx.mirror.convertToChain(owner.id, portfolioId);
  return { ownerId: owner.id, chainId: chain.id, ownerPortfolioId: portfolioId };
}

/** Attach a fresh member/manager to a chain; returns the new user + copy id. */
async function join(h: TestHarness, chainId: string, role: 'manager' | 'member') {
  const user = await h.seedUser(uu(role));
  const { portfolioId } = await h.ctx.mirror.attachMemberCopy(chainId, user.id, { role });
  return { userId: user.id, portfolioId };
}

// ── The §5 authority matrix — every capability × role ────────────────────────

type Role = 'owner' | 'manager' | 'member';
type Outcome = 'allow' | 'forbidden' | 'ownerTransfer';
const ROLES: Role[] = ['owner', 'manager', 'member'];

/** A fresh chain where the ACTOR holds `actorRole`. */
async function chainWithActor(h: TestHarness, actorRole: Role) {
  const { ownerId, chainId } = await ownerChain(h);
  if (actorRole === 'owner') return { chainId, ownerId, actorId: ownerId };
  const { userId } = await join(h, chainId, actorRole);
  return { chainId, ownerId, actorId: userId };
}

interface MatrixCell {
  name: string;
  expected: Record<Role, Outcome>;
  exec: (h: TestHarness, actorRole: Role) => Promise<unknown>;
}

const MATRIX: MatrixCell[] = [
  {
    name: 'invite / add member',
    expected: { owner: 'allow', manager: 'allow', member: 'forbidden' },
    async exec(h, actorRole) {
      const { chainId, actorId } = await chainWithActor(h, actorRole);
      const friend = await h.seedUser(uu('friend'));
      await makeFriends(h, actorId, friend.id);
      await h.ctx.mirror.inviteMember(actorId, chainId, friend.id);
    },
  },
  {
    name: 'kick a plain member',
    expected: { owner: 'allow', manager: 'allow', member: 'forbidden' },
    async exec(h, actorRole) {
      const { chainId, actorId } = await chainWithActor(h, actorRole);
      const target = await join(h, chainId, 'member');
      await h.ctx.mirror.removeMember(actorId, chainId, target.userId);
    },
  },
  {
    name: 'kick a manager',
    expected: { owner: 'allow', manager: 'forbidden', member: 'forbidden' },
    async exec(h, actorRole) {
      const { chainId, actorId } = await chainWithActor(h, actorRole);
      const target = await join(h, chainId, 'manager');
      await h.ctx.mirror.removeMember(actorId, chainId, target.userId);
    },
  },
  {
    name: 'grant / revoke manage rights',
    expected: { owner: 'allow', manager: 'forbidden', member: 'forbidden' },
    async exec(h, actorRole) {
      const { chainId, actorId } = await chainWithActor(h, actorRole);
      const target = await join(h, chainId, 'member');
      await h.ctx.mirror.setMemberRole(actorId, chainId, target.userId, 'manager');
    },
  },
  {
    name: 'rename the chain',
    expected: { owner: 'allow', manager: 'allow', member: 'forbidden' },
    async exec(h, actorRole) {
      const { chainId, actorId } = await chainWithActor(h, actorRole);
      await h.ctx.mirror.renameChain(actorId, chainId, 'Renamed');
    },
  },
  {
    name: 'transfer ownership',
    expected: { owner: 'allow', manager: 'forbidden', member: 'forbidden' },
    async exec(h, actorRole) {
      const { chainId, actorId } = await chainWithActor(h, actorRole);
      const target = await join(h, chainId, 'member');
      await h.ctx.mirror.transferOwnership(actorId, chainId, target.userId);
    },
  },
  {
    name: 'leave (keeping a fork)',
    expected: { owner: 'ownerTransfer', manager: 'allow', member: 'allow' },
    async exec(h, actorRole) {
      const { chainId, actorId } = await chainWithActor(h, actorRole);
      await h.ctx.mirror.leaveChain(actorId, chainId);
    },
  },
  {
    name: 'dissolve the chain',
    expected: { owner: 'allow', manager: 'forbidden', member: 'forbidden' },
    async exec(h, actorRole) {
      const { chainId, actorId } = await chainWithActor(h, actorRole);
      await h.ctx.mirror.dissolveChain(actorId, chainId);
    },
  },
];

describe('mirrorchain M3 — the §5 authority matrix (every capability × role)', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createTestApp();
  });

  for (const cell of MATRIX) {
    for (const role of ROLES) {
      const outcome = cell.expected[role];
      it(`${cell.name}: ${role} → ${outcome}`, async () => {
        if (outcome === 'allow') {
          await cell.exec(h, role); // no throw ⇒ permitted
        } else if (outcome === 'forbidden') {
          await expect(cell.exec(h, role)).rejects.toMatchObject({ code: MIRROR_FORBIDDEN });
        } else {
          await expect(cell.exec(h, role)).rejects.toMatchObject({
            code: MIRROR_OWNER_TRANSFER_REQUIRED,
          });
        }
      });
    }
  }

  it('role race: a revoked manager cannot kick afterwards (role re-checked at append)', async () => {
    const { ownerId, chainId } = await ownerChain(h);
    const bob = await join(h, chainId, 'manager');
    const carol = await join(h, chainId, 'member');
    // Owner revokes Bob's manage rights (op appends first, §5).
    await h.ctx.mirror.setMemberRole(ownerId, chainId, bob.userId, 'member');
    // Bob's later kick is refused — his role was re-read under the chain lock.
    await expect(
      h.ctx.mirror.removeMember(bob.userId, chainId, carol.userId),
    ).rejects.toMatchObject({ code: MIRROR_FORBIDDEN });

    // Reverse order (fresh chain): the manager kicks BEFORE the revoke → allowed.
    const other = await ownerChain(h);
    const dave = await join(h, other.chainId, 'manager');
    const erin = await join(h, other.chainId, 'member');
    await h.ctx.mirror.removeMember(dave.userId, other.chainId, erin.userId); // succeeds
    const erinRow = await repoOf(h).findActiveMembership(other.chainId, erin.userId);
    expect(erinRow).toBeNull();
  });
});

// ── Create / convert ─────────────────────────────────────────────────────────

describe('mirrorchain M3 — create + convert', () => {
  it('create ("new group portfolio") and convert both produce a synced owner copy', async () => {
    const h = await createTestApp();
    const owner = await h.seedUser(uu('owner'));

    const created = await h.ctx.mirror.createChain(owner.id, 'My Group');
    expect(created.role).toBe('owner');
    expect(created.name).toBe('My Group');
    expect(created.memberCount).toBe(1);
    expect(created.portfolioId).toBeTruthy();
    expect(await h.ctx.mirror.syncedMembership(created.portfolioId!)).toBeTruthy();

    const other = await h.seedUser(uu('other'));
    const pid = await h.ctx.portfolio.getDefaultPortfolioId(other.id);
    const converted = await h.ctx.mirror.convertChain(other.id, pid, {});
    expect(converted.role).toBe('owner');
    expect(await h.ctx.mirror.syncedMembership(pid)).toBeTruthy();

    const chains = await h.ctx.mirror.listChainsForUser(owner.id);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.chainId).toBe(created.chainId);
  });
});

// ── Invite flow (friends-only, pending-unique, void-on-unfriend) ─────────────

describe('mirrorchain M3 — invite flow (design §4)', () => {
  it('friends-only at send; pending-unique; unfriend between send and accept voids it', async () => {
    const events: DispatchableEvent[] = [];
    const h = await createTestApp({
      notificationEnqueue: async (e) => {
        events.push(e);
      },
    });
    const { ownerId, chainId } = await ownerChain(h);
    const bob = await h.seedUser(uu('bob'));

    // Not friends ⇒ send refused (checked at send).
    await expect(h.ctx.mirror.inviteMember(ownerId, chainId, bob.id)).rejects.toMatchObject({
      code: MIRROR_NOT_FRIENDS,
    });

    await makeFriends(h, ownerId, bob.id);
    await h.ctx.mirror.inviteMember(ownerId, chainId, bob.id);
    expect(events.some((e) => e.type === 'mirror.invite' && e.userId === bob.id)).toBe(true);

    // Pending-unique per (chain, invitee).
    await expect(h.ctx.mirror.inviteMember(ownerId, chainId, bob.id)).rejects.toMatchObject({
      code: MIRROR_INVITE_EXISTS,
    });

    // Unfriend, then accept ⇒ voided (re-checked at accept), no longer pending.
    await unfriend(h, ownerId, bob.id);
    const pending = await h.ctx.mirror.listInvites(bob.id);
    expect(pending.incoming).toHaveLength(1);
    await expect(h.ctx.mirror.acceptInvite(bob.id, pending.incoming[0]!.id)).rejects.toMatchObject({
      code: MIRROR_NOT_FRIENDS,
    });
    const after = await h.ctx.mirror.listInvites(bob.id);
    expect(after.incoming).toHaveLength(0);
  });

  it('inviting yourself is refused with a dedicated code (not the not-friends code)', async () => {
    const h = await createTestApp();
    const { ownerId, chainId } = await ownerChain(h);
    await expect(h.ctx.mirror.inviteMember(ownerId, chainId, ownerId)).rejects.toMatchObject({
      code: MIRROR_CANNOT_INVITE_SELF,
    });
  });

  it('accept materializes a copy + notifies the owner; the member cap is enforced at accept', async () => {
    const events: DispatchableEvent[] = [];
    const h = await createTestApp({
      env: { MIRROR_MAX_MEMBERS: '2' },
      notificationEnqueue: async (e) => {
        events.push(e);
      },
    });
    const { ownerId, chainId } = await ownerChain(h);
    const f1 = await h.seedUser(uu('f1'));
    const f2 = await h.seedUser(uu('f2'));
    await makeFriends(h, ownerId, f1.id);
    await makeFriends(h, ownerId, f2.id);

    // Both invited while below the cap (1 active member).
    await h.ctx.mirror.inviteMember(ownerId, chainId, f1.id);
    await h.ctx.mirror.inviteMember(ownerId, chainId, f2.id);

    const i1 = (await h.ctx.mirror.listInvites(f1.id)).incoming[0]!.id;
    const accepted = await h.ctx.mirror.acceptInvite(f1.id, i1); // → 2 active members
    expect(accepted.portfolioId).toBeTruthy();
    expect(await h.ctx.mirror.syncedMembership(accepted.portfolioId)).toBeTruthy();
    expect(events.some((e) => e.type === 'mirror.member_joined' && e.userId === ownerId)).toBe(
      true,
    );

    // The cap (2) is re-checked at accept.
    const i2 = (await h.ctx.mirror.listInvites(f2.id)).incoming[0]!.id;
    await expect(h.ctx.mirror.acceptInvite(f2.id, i2)).rejects.toMatchObject({
      code: MIRROR_MEMBER_CAP_REACHED,
    });
  });
});

// ── Invite expiry (design §4 — the 30-day token hygiene) ─────────────────────

describe('mirrorchain M3 — invite expiry (design §4)', () => {
  it('rejects an invite past the 30-day horizon at accept and marks it expired', async () => {
    const h = await createTestApp();
    const { ownerId, chainId } = await ownerChain(h);
    const bob = await h.seedUser(uu('bob'));
    await makeFriends(h, ownerId, bob.id);
    await h.ctx.mirror.inviteMember(ownerId, chainId, bob.id);
    const inviteId = (await h.ctx.mirror.listInvites(bob.id)).incoming[0]!.id;

    await backdateInvite(h, inviteId, 31);
    await expect(h.ctx.mirror.acceptInvite(bob.id, inviteId)).rejects.toMatchObject({
      code: MIRROR_INVITE_NOT_FOUND,
    });
    expect(await inviteStatus(h, inviteId)).toBe('expired');
  });

  it('hides an expired invite from both inboxes', async () => {
    const h = await createTestApp();
    const { ownerId, chainId } = await ownerChain(h);
    const bob = await h.seedUser(uu('bob'));
    await makeFriends(h, ownerId, bob.id);
    await h.ctx.mirror.inviteMember(ownerId, chainId, bob.id);
    const inviteId = (await h.ctx.mirror.listInvites(bob.id)).incoming[0]!.id;
    expect((await h.ctx.mirror.listInvites(ownerId)).outgoing).toHaveLength(1);

    await backdateInvite(h, inviteId, 40);
    expect((await h.ctx.mirror.listInvites(bob.id)).incoming).toHaveLength(0);
    expect((await h.ctx.mirror.listInvites(ownerId)).outgoing).toHaveLength(0);
  });

  it('an expired pending invite no longer blocks a re-invite (frees the pending-unique slot)', async () => {
    const h = await createTestApp();
    const { ownerId, chainId } = await ownerChain(h);
    const bob = await h.seedUser(uu('bob'));
    await makeFriends(h, ownerId, bob.id);
    await h.ctx.mirror.inviteMember(ownerId, chainId, bob.id);
    const staleId = (await h.ctx.mirror.listInvites(bob.id)).incoming[0]!.id;
    await backdateInvite(h, staleId, 45);

    // The re-invite succeeds despite the stale pending row (which is retired),
    // rather than tripping MIRROR_INVITE_EXISTS.
    await h.ctx.mirror.inviteMember(ownerId, chainId, bob.id);
    expect(await inviteStatus(h, staleId)).toBe('expired');

    const fresh = (await h.ctx.mirror.listInvites(bob.id)).incoming;
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id).not.toBe(staleId);
    // The fresh invite accepts cleanly.
    const accepted = await h.ctx.mirror.acceptInvite(bob.id, fresh[0]!.id);
    expect(accepted.portfolioId).toBeTruthy();
  });

  it('the cleanup sweep retires only pending invites older than the cutoff', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { ownerId, chainId } = await ownerChain(h);
    const stale = await h.seedUser(uu('stale'));
    const fresh = await h.seedUser(uu('fresh'));
    await makeFriends(h, ownerId, stale.id);
    await makeFriends(h, ownerId, fresh.id);
    await h.ctx.mirror.inviteMember(ownerId, chainId, stale.id);
    await h.ctx.mirror.inviteMember(ownerId, chainId, fresh.id);
    const staleId = (await h.ctx.mirror.listInvites(stale.id)).incoming[0]!.id;
    const freshId = (await h.ctx.mirror.listInvites(fresh.id)).incoming[0]!.id;
    await backdateInvite(h, staleId, 31);

    const cutoff = new Date(Date.now() - MIRROR_INVITE_TTL_MS);
    expect(await repo.expireStalePendingInvites(cutoff)).toBe(1);
    expect(await inviteStatus(h, staleId)).toBe('expired');
    expect(await inviteStatus(h, freshId)).toBe('pending');
  });
});

// ── Kick / leave → fork ──────────────────────────────────────────────────────

describe('mirrorchain M3 — kick / leave → fork (design §6)', () => {
  it('kick freezes a lagging copy at its watermark, severs access, and re-invite makes a NEW copy', async () => {
    const events: DispatchableEvent[] = [];
    const h = await createTestApp({
      notificationEnqueue: async (e) => {
        events.push(e);
      },
    });
    const repo = repoOf(h);
    const { ownerId, chainId, ownerPortfolioId } = await ownerChain(h);
    const bob = await h.seedUser(uu('bob'));
    const { member, portfolioId: forkPid } = await h.ctx.mirror.attachMemberCopy(chainId, bob.id, {
      role: 'member',
    });
    expect(member.appliedSeq).toBe(0);

    // Owner writes so last_seq advances, but we DON'T replicate → Bob lags at 0.
    await h.ctx.mirror.submitCashDeposit(ownerId, ownerPortfolioId, { amountEur: 100 });
    expect((await repo.getChain(chainId))!.lastSeq).toBeGreaterThan(0);
    expect((await repo.findActiveMembership(chainId, bob.id))!.appliedSeq).toBe(0);

    // Kick, then replicate: Bob's frozen copy is skipped (severance is immediate).
    await h.ctx.mirror.removeMember(ownerId, chainId, bob.id);
    await h.ctx.mirror.replicateChain(chainId);
    const [tomb] = await h.db
      .select()
      .from(schema.mirrorChainMembers)
      .where(eq(schema.mirrorChainMembers.id, member.id));
    expect(tomb!.status).toBe('removed');
    expect(tomb!.appliedSeq).toBe(0); // frozen at its watermark, never advanced
    expect(events.some((e) => e.type === 'mirror.removed' && e.userId === bob.id)).toBe(true);

    // The fork survives as an ordinary portfolio; chain access is severed.
    expect(await h.ctx.portfolio.listCashSources(bob.id, forkPid)).toBeTruthy();
    await expect(h.ctx.mirror.getMemberList(bob.id, chainId)).rejects.toMatchObject({
      statusCode: 404,
    });

    // Re-invite creates a brand-new copy; the fork is left untouched.
    await makeFriends(h, ownerId, bob.id);
    await h.ctx.mirror.inviteMember(ownerId, chainId, bob.id);
    const reInvite = (await h.ctx.mirror.listInvites(bob.id)).incoming[0]!.id;
    const rejoined = await h.ctx.mirror.acceptInvite(bob.id, reInvite);
    expect(rejoined.portfolioId).not.toBe(forkPid);
    expect(await h.ctx.portfolio.listCashSources(bob.id, forkPid)).toBeTruthy(); // fork intact
  });
});

// ── Transfer ─────────────────────────────────────────────────────────────────

describe('mirrorchain M3 — transfer ownership (design §5)', () => {
  it('owner-only, active-member target; the old owner becomes a plain member', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { ownerId, chainId } = await ownerChain(h);
    const bob = await join(h, chainId, 'member');

    await h.ctx.mirror.transferOwnership(ownerId, chainId, bob.userId);
    const members = await repo.listActiveMembers(chainId);
    expect(members.find((m) => m.userId === bob.userId)!.role).toBe('owner');
    expect(members.find((m) => m.userId === ownerId)!.role).toBe('member');
    const ops = await repo.listActivity(chainId, { limit: 100 });
    expect(ops.some((o) => o.kind === 'owner.transferred')).toBe(true);
  });

  it('notifies other members but neither the acting owner nor the new owner', async () => {
    const events: DispatchableEvent[] = [];
    const h = await createTestApp({
      notificationEnqueue: async (e) => {
        events.push(e);
      },
    });
    const { ownerId, chainId } = await ownerChain(h);
    const newOwner = await join(h, chainId, 'member');
    const third = await join(h, chainId, 'member');

    await h.ctx.mirror.transferOwnership(ownerId, chainId, newOwner.userId);
    const transferEvents = events.filter((e) => e.type === 'mirror.ownership_transferred');
    const notified = transferEvents.map((e) => e.userId);
    expect(notified).toContain(third.userId);
    // The new owner is skipped — the copy reads "⟨actor⟩ is now the owner", which
    // self-named reads wrong; the acting old owner already knows.
    expect(notified).not.toContain(newOwner.userId);
    expect(notified).not.toContain(ownerId);
    // The refId carries the op seq (not the bare new-owner id), so transferring
    // ownership BACK to a prior owner is not silently deduped downstream.
    const thirdEvent = transferEvents.find((e) => e.userId === third.userId)!;
    expect((thirdEvent as { refId: string }).refId).toMatch(
      new RegExp(`^${newOwner.userId}:\\d+$`),
    );
  });
});

// ── Dissolve ─────────────────────────────────────────────────────────────────

describe('mirrorchain M3 — dissolve (design §6)', () => {
  it('ends every membership as dissolved; every copy survives as a fork', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { ownerId, chainId } = await ownerChain(h);
    const bob = await join(h, chainId, 'member');

    await h.ctx.mirror.dissolveChain(ownerId, chainId);
    expect((await repo.getChain(chainId))!.status).toBe('dissolved');
    const all = await h.db
      .select()
      .from(schema.mirrorChainMembers)
      .where(eq(schema.mirrorChainMembers.chainId, chainId));
    expect(all.every((m) => m.status === 'dissolved')).toBe(true);
    // The copies remain ordinary, fully-working portfolios.
    expect(await h.ctx.portfolio.listCashSources(bob.userId, bob.portfolioId)).toBeTruthy();
  });
});

// ── Owner-refusal stopgap (design §7 sequencing) ─────────────────────────────

describe('mirrorchain M3 — owner-refusal stopgap + copy-delete interception (design §7)', () => {
  it('owner leave / owner copy-delete are refused; a non-owner copy-delete = leave-then-delete', async () => {
    const h = await createTestApp();
    const repo = repoOf(h);
    const { ownerId, chainId, ownerPortfolioId } = await ownerChain(h);
    const bob = await join(h, chainId, 'member');

    await expect(h.ctx.mirror.leaveChain(ownerId, chainId)).rejects.toMatchObject({
      code: MIRROR_OWNER_TRANSFER_REQUIRED,
    });
    await expect(
      h.ctx.mirror.submitPortfolioDelete(ownerId, ownerPortfolioId),
    ).rejects.toMatchObject({ code: MIRROR_OWNER_TRANSFER_REQUIRED });

    // A non-owner deleting their copy is intercepted as leave-then-delete.
    await h.ctx.mirror.submitPortfolioDelete(bob.userId, bob.portfolioId);
    expect(await repo.findActiveMembership(chainId, bob.userId)).toBeNull();
    const [tomb] = await h.db
      .select()
      .from(schema.mirrorChainMembers)
      .where(eq(schema.mirrorChainMembers.userId, bob.userId));
    expect(tomb!.status).toBe('left');
    await expect(h.ctx.portfolio.listCashSources(bob.userId, bob.portfolioId)).rejects.toBeTruthy();
  });
});

// ── Notification dispatch through the existing dispatcher ─────────────────────

describe('mirrorchain M3 — notifications dispatch through the matrix', () => {
  it('mirror.invite lands as an in-app notification (default ON) for the invitee', async () => {
    const h = await createTestApp(); // default = direct dispatch through the dispatcher
    const { ownerId, chainId } = await ownerChain(h);
    const friend = await h.seedUser(uu('friend'));
    await makeFriends(h, ownerId, friend.id);
    await h.ctx.mirror.inviteMember(ownerId, chainId, friend.id);

    const rows = await h.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, friend.id));
    expect(rows.some((r) => r.type === 'mirror.invite' && !r.hidden)).toBe(true);
  });
});
