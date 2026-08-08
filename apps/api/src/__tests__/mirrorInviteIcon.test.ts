import { randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  mirrorInviteListResponseSchema,
  MIRROR_NOT_FRIENDS,
  PROFILE_ICON_IDS,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * MIRRORCHAIN invite rows carry the other party's profile icon (board #70).
 *
 * An invite is exactly the case where the client CANNOT resolve the face
 * locally: the inviter is by definition not yet a co-member, so nothing in the
 * viewer's chain roster has it — and they need not still be a friend either,
 * because unfriending between send and accept leaves the invite pending (design
 * §4 re-checks friendship at accept, not at list). Without the field the row
 * falls back to a generic avatar for a person the app can otherwise always draw.
 *
 * The icon is public-safe, like the id + username the row already exposes
 * (§6.9 — never any bytes, never an email), and it rides the joins the
 * usernames already use, so no read is widened.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

const uniq = () => randomBytes(5).toString('hex');

async function seedUser(icon?: string) {
  const tag = uniq();
  const user = await harness.seedUser({
    email: `u-${tag}@bettertrack.test`,
    username: `user${tag}`,
  });
  if (icon !== undefined) {
    await harness.db
      .update(schema.users)
      .set({ profileIcon: icon })
      .where(eq(schema.users.id, user.id));
  }
  return user;
}

async function makeFriends(a: string, b: string): Promise<void> {
  const [userA, userB] = a < b ? [a, b] : [b, a];
  await harness.db.insert(schema.friendships).values({ userA, userB });
}

async function unfriend(a: string, b: string): Promise<void> {
  const [userA, userB] = a < b ? [a, b] : [b, a];
  await harness.db
    .delete(schema.friendships)
    .where(and(eq(schema.friendships.userA, userA), eq(schema.friendships.userB, userB)));
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

/** Owner (with `ownerIcon`) invites a fresh invitee (with `inviteeIcon`). */
async function invited(ownerIcon?: string, inviteeIcon?: string) {
  const owner = await seedUser(ownerIcon);
  const invitee = await seedUser(inviteeIcon);
  const portfolioId = await harness.ctx.portfolio.getDefaultPortfolioId(owner.id);
  const { chainId } = await harness.ctx.mirror.convertChain(owner.id, portfolioId, {
    name: `Household ${uniq()}`,
  });
  await makeFriends(owner.id, invitee.id);
  await harness.ctx.mirror.inviteMember(owner.id, chainId, invitee.id);
  return { owner, invitee, chainId };
}

describe('mirror invite icons (board #70)', () => {
  it("an incoming row carries the INVITER's icon; the outgoing copy carries the invitee's", async () => {
    const { owner, invitee } = await invited('fox', 'panda');

    const incoming = (await harness.ctx.mirror.listInvites(invitee.id)).incoming;
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.fromUsername).toBe(owner.username);
    expect(incoming[0]!.profileIcon).toBe('fox');

    // The same invite seen from the other side is about the INVITEE, so it
    // carries their face — never the viewer's own.
    const outgoing = (await harness.ctx.mirror.listInvites(owner.id)).outgoing;
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.toUsername).toBe(invitee.username);
    expect(outgoing[0]!.profileIcon).toBe('panda');
  });

  it('still carries the inviter icon once the inviter is NO LONGER a friend', async () => {
    // The case the client cannot cover locally: friendship is re-checked at
    // accept, not at list, so a pending invite outlives the friendship and the
    // viewer has nothing left in their own graph that knows this face.
    const { owner, invitee } = await invited('robot');
    await unfriend(owner.id, invitee.id);

    const incoming = (await harness.ctx.mirror.listInvites(invitee.id)).incoming;
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.profileIcon).toBe('robot');

    // …and it really is un-acceptable now, i.e. the row genuinely belongs to a
    // non-friend rather than the unfriend having silently failed.
    await expect(
      harness.ctx.mirror.acceptInvite(invitee.id, incoming[0]!.id),
    ).rejects.toMatchObject({ code: MIRROR_NOT_FRIENDS });
  });

  it('is null when the user never picked one, on both sides', async () => {
    const { owner, invitee } = await invited();

    expect((await harness.ctx.mirror.listInvites(invitee.id)).incoming[0]!.profileIcon).toBeNull();
    expect((await harness.ctx.mirror.listInvites(owner.id)).outgoing[0]!.profileIcon).toBeNull();
  });

  it('carries every curated id verbatim — no mapping, no normalization', async () => {
    for (const icon of PROFILE_ICON_IDS) {
      const { invitee } = await invited(icon);
      expect((await harness.ctx.mirror.listInvites(invitee.id)).incoming[0]!.profileIcon).toBe(
        icon,
      );
    }
  });

  it('reaches the client through GET /mirrorchain/invites under the strict contract', async () => {
    const { owner, invitee } = await invited('crown', 'anchor');

    const inviteeAgent = await loginAgent(harness.app, invitee.email, invitee.password);
    const inRes = await inviteeAgent.get('/api/v1/mirrorchain/invites');
    expect(inRes.status, JSON.stringify(inRes.body)).toBe(200);
    // `.strict()` — parsing proves the field is on the wire, correctly named.
    const inbox = mirrorInviteListResponseSchema.parse(inRes.body);
    expect(inbox.incoming).toHaveLength(1);
    expect(inbox.incoming[0]!.profileIcon).toBe('crown');
    expect(inbox.outgoing).toHaveLength(0);

    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const outRes = await ownerAgent.get('/api/v1/mirrorchain/invites');
    expect(outRes.status).toBe(200);
    const outbox = mirrorInviteListResponseSchema.parse(outRes.body);
    expect(outbox.outgoing).toHaveLength(1);
    expect(outbox.outgoing[0]!.profileIcon).toBe('anchor');
  });

  it('never leaks an email or any other user column onto the row', async () => {
    const { invitee } = await invited('leaf');
    const agent = await loginAgent(harness.app, invitee.email, invitee.password);
    const res = await agent.get('/api/v1/mirrorchain/invites');
    const body = JSON.stringify(res.body);
    // The schema is `.strict()`, so this guards the *values*: the icon must not
    // have arrived by widening the join into something identity-bearing.
    expect(body).not.toContain('@bettertrack.test');
    expect(Object.keys(mirrorInviteListResponseSchema.parse(res.body).incoming[0]!).sort()).toEqual(
      [
        'chainId',
        'chainName',
        'createdAt',
        'direction',
        'fromUsername',
        'id',
        'profileIcon',
        'toUsername',
      ],
    );
  });
});
