import { eq, or } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  commentThreadResponseSchema,
  friendGroupSchema,
  friendGroupListResponseSchema,
  mySharedResponseSchema,
  FRIEND_GROUPS_MAX,
  FRIEND_GROUP_MEMBERS_MAX,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { limiterKeyForUser } from '../http/middleware/rateLimit';
import { progressiveKeys } from '../services/security/progressiveLimiter';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Friend groups as a sharing audience (§13.5 V5-P8). Privacy-critical: a `group`
 * share must reach EXACTLY the circle's current members, edits apply
 * retroactively to existing shares, only accepted friends can be added,
 * unfriending closes the group route, deleting a group fails closed, and a group
 * is private to its owner. Every read is scoped by friendship AND the group
 * roster at query time (§6.9); non-members get 404, never 403.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-7000-000000000000';

function stubMarketData() {
  return createStubMarketData({
    quote: () => ({
      value: {
        price: 120,
        currency: 'EUR',
        prevClose: 100,
        dayChangePct: 20,
        asOf: new Date().toISOString(),
      },
      stale: false,
      asOf: Date.now(),
    }),
  });
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ marketData: stubMarketData() });
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** Make two agents friends: `from` requests, `to` accepts. */
async function befriend(from: Agent, to: Agent, toIdentifier: string): Promise<void> {
  await from
    .post('/api/v1/social/requests')
    .set(...XRW)
    .send({ identifier: toIdentifier });
  const inbox = await to.get('/api/v1/social/requests');
  const requestId = inbox.body.incoming[0]?.id as string;
  expect(requestId).toBeTruthy();
  const res = await to
    .post(`/api/v1/social/requests/${requestId}/accept`)
    .set(...XRW)
    .send();
  expect(res.status).toBe(200);
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  return def.id as string;
}

async function createGroup(agent: Agent, name: string): Promise<string> {
  const res = await agent
    .post('/api/v1/social/groups')
    .set(...XRW)
    .send({ name });
  expect(res.status).toBe(201);
  expect(friendGroupSchema.safeParse(res.body).success).toBe(true);
  return res.body.id as string;
}

async function addMember(agent: Agent, groupId: string, userId: string) {
  return agent
    .post(`/api/v1/social/groups/${groupId}/members`)
    .set(...XRW)
    .send({ userId });
}

async function carolId(aliceAgent: Agent): Promise<string> {
  const friends = await aliceAgent.get('/api/v1/social/friends');
  const carol = friends.body.friends.find(
    (f: { user: { username: string } }) => f.user.username === 'carol',
  );
  return carol.user.id as string;
}

/** The `portfolio.shared` rows a user actually received (the `*.shared` fan-out). */
async function sharedNotifications(userId: string) {
  const rows = await harness.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId));
  return rows.filter((r) => r.type === 'portfolio.shared');
}

async function shareToGroup(agent: Agent, portfolioId: string, groupId: string) {
  return agent
    .put(`/api/v1/social/audience/portfolio/${portfolioId}`)
    .set(...XRW)
    .send({ audience: 'group', groupId, confirmWiden: true });
}

/**
 * alice owns a portfolio worth 120 EUR; bob and carol are her friends, dave is
 * not. Returns the actors + the portfolio id.
 */
async function scenario() {
  const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
  const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
  const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
  const dave = await harness.seedUser({ email: 'dave@bt.test', username: 'dave' });

  const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
  const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
  const carolAgent = await loginAgent(harness.app, carol.email, carol.password);
  const daveAgent = await loginAgent(harness.app, dave.email, dave.password);

  await befriend(aliceAgent, bobAgent, 'bob');
  await befriend(aliceAgent, carolAgent, 'carol');

  const pid = await defaultPortfolioId(aliceAgent);
  const [asset] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: 'BAYN.DE',
      type: 'stock',
      symbol: 'BAYN.DE',
      name: 'Bayer AG',
      currency: 'EUR',
      exchange: 'XETRA',
    })
    .returning();
  await aliceAgent
    .post(`/api/v1/portfolios/${pid}/transactions`)
    .set(...XRW)
    .send({
      assetId: asset!.id,
      side: 'buy',
      quantity: 1,
      price: 100,
      executedAt: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    });

  return {
    alice,
    bob,
    carol,
    dave,
    aliceAgent,
    bobAgent,
    carolAgent,
    daveAgent,
    pid,
  };
}

describe('friend group CRUD', () => {
  it('requires authentication', async () => {
    const res = await request(harness.app).get('/api/v1/social/groups');
    expect(res.status).toBe(401);
  });

  it('creates, lists, renames and deletes a group', async () => {
    const { aliceAgent } = await scenario();

    const groupId = await createGroup(aliceAgent, 'Family');
    const list = await aliceAgent.get('/api/v1/social/groups');
    expect(friendGroupListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.groups).toHaveLength(1);
    expect(list.body.groups[0]).toMatchObject({ id: groupId, name: 'Family', memberCount: 0 });

    const renamed = await aliceAgent
      .patch(`/api/v1/social/groups/${groupId}`)
      .set(...XRW)
      .send({ name: 'Inner circle' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Inner circle');

    const del = await aliceAgent.delete(`/api/v1/social/groups/${groupId}`).set(...XRW);
    expect(del.status).toBe(204);
    expect((await aliceAgent.get('/api/v1/social/groups')).body.groups).toHaveLength(0);
  });

  it('only lets accepted friends be added (400 for a non-friend)', async () => {
    const { aliceAgent, bob, dave } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');

    const ok = await addMember(aliceAgent, groupId, bob.id);
    expect(ok.status).toBe(200);
    expect(ok.body.memberCount).toBe(1);

    const rejected = await addMember(aliceAgent, groupId, dave.id);
    expect(rejected.status).toBe(400);
    expect((await aliceAgent.get('/api/v1/social/groups')).body.groups[0].memberCount).toBe(1);
  });

  it("keeps a group private to its owner (404 on another user's group)", async () => {
    const { aliceAgent, bobAgent, bob } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');

    // Bob can't see it in his own list, nor rename/delete/add to it.
    expect((await bobAgent.get('/api/v1/social/groups')).body.groups).toHaveLength(0);
    expect(
      (
        await bobAgent
          .patch(`/api/v1/social/groups/${groupId}`)
          .set(...XRW)
          .send({ name: 'hijack' })
      ).status,
    ).toBe(404);
    expect((await bobAgent.delete(`/api/v1/social/groups/${groupId}`).set(...XRW)).status).toBe(
      404,
    );
    expect((await addMember(bobAgent, groupId, bob.id)).status).toBe(404);
  });

  it('rejects sharing to a group the caller does not own (400)', async () => {
    const { aliceAgent, bobAgent } = await scenario();
    const aliceGroup = await createGroup(aliceAgent, 'Family');

    // Bob owns his own portfolio; try to point its audience at alice's group.
    const bobPid = await defaultPortfolioId(bobAgent);
    const res = await shareToGroup(bobAgent, bobPid, aliceGroup);
    expect(res.status).toBe(400);

    // A group audience with no group id at all is rejected (on his own item, so
    // ownership passes and we hit the group-validation gate, not a 404).
    const missing = await bobAgent
      .put(`/api/v1/social/audience/portfolio/${bobPid}`)
      .set(...XRW)
      .send({ audience: 'group' });
    expect(missing.status).toBe(400);
  });
});

describe('sharing to a group (the gate criterion)', () => {
  it('rejects an unconfirmed chat-style replacement of the current group audience', async () => {
    const { aliceAgent, bob, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);
    expect((await shareToGroup(aliceAgent, pid, groupId)).status).toBe(200);

    const staleChatWrite = await aliceAgent
      .put(`/api/v1/social/audience/portfolio/${pid}`)
      .set(...XRW)
      .send({ audience: 'specific_friends', friendIds: [bob.id] });
    expect(staleChatWrite.status).toBe(409);
    expect(staleChatWrite.body.error).toMatchObject({
      code: 'AUDIENCE_WIDEN_CONFIRMATION_REQUIRED',
      details: { currentAudience: 'group' },
    });
    expect((await aliceAgent.get(`/api/v1/social/audience/portfolio/${pid}`)).body).toMatchObject({
      audience: 'group',
      groupId,
    });

    const confirmed = await aliceAgent
      .put(`/api/v1/social/audience/portfolio/${pid}`)
      .set(...XRW)
      .send({
        audience: 'specific_friends',
        friendIds: [bob.id],
        confirmWiden: true,
      });
    expect(confirmed.status).toBe(200);
  });

  it('reaches exactly the members; membership edits apply to existing shares', async () => {
    const { aliceAgent, bobAgent, carolAgent, daveAgent, bob, pid } = await scenario();

    const groupId = await createGroup(aliceAgent, 'Family');
    expect((await addMember(aliceAgent, groupId, bob.id)).status).toBe(200);

    // Share to the group: only bob (a member) sees it; carol (friend, non-member)
    // and dave (non-friend) do not.
    expect((await shareToGroup(aliceAgent, pid, groupId)).status).toBe(200);
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);
    expect((await carolAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
    expect((await daveAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
    // The Shared-With-Me list agrees.
    expect((await bobAgent.get('/api/v1/social/shared')).body.portfolios).toHaveLength(1);
    expect((await carolAgent.get('/api/v1/social/shared')).body.portfolios).toHaveLength(0);

    // Add carol to the SAME group: she now sees the SAME existing share, no
    // re-share needed (retroactive membership).
    expect((await addMember(aliceAgent, groupId, await carolId(aliceAgent))).status).toBe(200);
    expect((await carolAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);

    // Remove bob from the group: he loses access to the existing share instantly.
    const rm = await aliceAgent
      .delete(`/api/v1/social/groups/${groupId}/members/${bob.id}`)
      .set(...XRW);
    expect(rm.status).toBe(200);
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
    expect((await carolAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);
  });

  it('unfriending removes the ex-friend from the group and closes their access', async () => {
    const { aliceAgent, bobAgent, bob, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);
    await shareToGroup(aliceAgent, pid, groupId);
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);

    // Alice unfriends bob → he's dropped from the group and the share goes dark.
    const rm = await aliceAgent.delete(`/api/v1/social/friends/${bob.id}`).set(...XRW);
    expect(rm.status).toBe(204);
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
    expect((await aliceAgent.get('/api/v1/social/groups')).body.groups[0].memberCount).toBe(0);
  });

  it('deleting the group makes the share resolve to nobody (fail-closed)', async () => {
    const { aliceAgent, bobAgent, bob, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);
    await shareToGroup(aliceAgent, pid, groupId);
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);

    // Deleting the group must NOT widen the share — it goes dark.
    expect((await aliceAgent.delete(`/api/v1/social/groups/${groupId}`).set(...XRW)).status).toBe(
      204,
    );
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
    // The owner still sees the item, now reporting a group audience with no group.
    const audience = await aliceAgent.get(`/api/v1/social/audience/portfolio/${pid}`);
    expect(audience.status).toBe(200);
    expect(audience.body.audience).toBe('group');
    expect(audience.body.groupId).toBeNull();
  });
});

describe('group audience round-trips through the picker state', () => {
  it('reports the selected group id in GET /audience', async () => {
    const { aliceAgent, bob, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);
    await shareToGroup(aliceAgent, pid, groupId);

    const res = await aliceAgent.get(`/api/v1/social/audience/portfolio/${pid}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ audience: 'group', groupId });

    // A missing group id is treated as no leak — an unknown subject 404s.
    expect((await aliceAgent.get(`/api/v1/social/audience/portfolio/${MISSING_ID}`)).status).toBe(
      404,
    );
  });
});

/**
 * The owner has to be able to READ their own reach (§13.5 V5-P8, #1677): a flat
 * "Friend group" badge made a share seen by nobody indistinguishable from one
 * seen by everybody, which directly undercuts the friction ladder's premise.
 * My items therefore carries the circle's name and its LIVE roster size.
 */
describe('My items reports a group share by name and live size', () => {
  async function myPortfolio(agent: Agent, portfolioId: string) {
    const res = await agent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    const parsed = mySharedResponseSchema.parse(res.body);
    return parsed.portfolios.find((p) => p.portfolioId === portfolioId);
  }

  it('names the group and counts its current members', async () => {
    const { aliceAgent, bob, carol, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);
    await addMember(aliceAgent, groupId, carol.id);
    await shareToGroup(aliceAgent, pid, groupId);

    expect(await myPortfolio(aliceAgent, pid)).toMatchObject({
      audience: 'group',
      group: { id: groupId, name: 'Family', memberCount: 2 },
    });
  });

  it('follows a membership edit on the very next read — no cached reach', async () => {
    const { aliceAgent, bob, carol, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);
    await addMember(aliceAgent, groupId, carol.id);
    await shareToGroup(aliceAgent, pid, groupId);
    expect((await myPortfolio(aliceAgent, pid))?.group?.memberCount).toBe(2);

    await aliceAgent
      .delete(`/api/v1/social/groups/${groupId}/members/${carol.id}`)
      .set(...XRW)
      .send();
    expect((await myPortfolio(aliceAgent, pid))?.group?.memberCount).toBe(1);
  });

  it('distinguishes a populated circle from an empty one and from a deleted one', async () => {
    const { aliceAgent, bob, pid } = await scenario();
    const family = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, family, bob.id);
    await shareToGroup(aliceAgent, pid, family);
    const populated = await myPortfolio(aliceAgent, pid);
    expect(populated?.group).toEqual({ id: family, name: 'Family', memberCount: 1 });

    // An emptied circle still names itself, but reports a reach of zero.
    await aliceAgent
      .delete(`/api/v1/social/groups/${family}/members/${bob.id}`)
      .set(...XRW)
      .send();
    const emptied = await myPortfolio(aliceAgent, pid);
    expect(emptied?.group).toEqual({ id: family, name: 'Family', memberCount: 0 });

    // A DELETED circle nulls `group_id` and the share resolves to nobody — a
    // distinct state from both of the above, never the same flat badge.
    expect((await aliceAgent.delete(`/api/v1/social/groups/${family}`).set(...XRW)).status).toBe(
      204,
    );
    const deleted = await myPortfolio(aliceAgent, pid);
    expect(deleted?.audience).toBe('group');
    expect(deleted?.group).toBeNull();
    expect(deleted?.group).not.toEqual(populated?.group);
    expect(deleted?.group).not.toEqual(emptied?.group);
  });

  it('reports no group for every non-group audience', async () => {
    const { aliceAgent, bob, pid } = await scenario();
    await aliceAgent
      .put(`/api/v1/social/audience/portfolio/${pid}`)
      .set(...XRW)
      .send({ audience: 'specific_friends', friendIds: [bob.id], confirmWiden: true });
    expect(await myPortfolio(aliceAgent, pid)).toMatchObject({
      audience: 'specific_friends',
      friendCount: 1,
      group: null,
    });
  });
});

/**
 * The reach summary has to agree with ENFORCEMENT, not with the rows that
 * happen to be stored (#1710). Every read authorizes through a friendship join
 * AND an active-owner join; a summary computed without those can claim a reach
 * the enforcement layer refuses — precisely the failure the surface exists to
 * prevent, since the §16 friction ladder tells the owner to trust this badge.
 */
describe('the reach summary agrees with what enforcement grants', () => {
  async function myPortfolio(agent: Agent, portfolioId: string) {
    const res = await agent.get('/api/v1/social/my-shared');
    expect(res.status).toBe(200);
    return mySharedResponseSchema
      .parse(res.body)
      .portfolios.find((p) => p.portfolioId === portfolioId);
  }

  it('drops an unfriended recipient from the count, the ids and the reach', async () => {
    const { aliceAgent, carolAgent, bob, carol, pid } = await scenario();
    const shared = await aliceAgent
      .put(`/api/v1/social/audience/portfolio/${pid}`)
      .set(...XRW)
      .send({ audience: 'specific_friends', friendIds: [bob.id, carol.id], confirmWiden: true });
    expect(shared.status).toBe(200);
    expect((await myPortfolio(aliceAgent, pid))?.friendCount).toBe(2);
    expect((await carolAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);

    // Unfriending carol closes her access instantly (the friendship join). The
    // owner surface must say so on the very next read.
    expect((await aliceAgent.delete(`/api/v1/social/friends/${carol.id}`).set(...XRW)).status).toBe(
      204,
    );
    expect((await carolAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
    expect(await myPortfolio(aliceAgent, pid)).toMatchObject({
      audience: 'specific_friends',
      friendCount: 1,
    });
    const audience = await aliceAgent.get(`/api/v1/social/audience/portfolio/${pid}`);
    expect(audience.status).toBe(200);
    expect(audience.body.friendIds).toEqual([bob.id]);
  });

  it('prunes the grant, so re-friending does not silently restore the share', async () => {
    const { aliceAgent, carolAgent, carol, pid } = await scenario();
    await aliceAgent
      .put(`/api/v1/social/audience/portfolio/${pid}`)
      .set(...XRW)
      .send({ audience: 'specific_friends', friendIds: [carol.id], confirmWiden: true });
    expect((await carolAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(200);

    await aliceAgent.delete(`/api/v1/social/friends/${carol.id}`).set(...XRW);
    // Re-friending is a plain accept — no re-share, no widen confirmation. The
    // old membership row must not be lying in wait to become a live grant again.
    await befriend(aliceAgent, carolAgent, 'carol');
    expect((await carolAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
    expect((await myPortfolio(aliceAgent, pid))?.friendCount).toBe(0);
    expect(
      (await aliceAgent.get(`/api/v1/social/audience/portfolio/${pid}`)).body.friendIds,
    ).toEqual([]);
  });

  it('excludes a disabled member from both group rosters and from the fan-out', async () => {
    const { aliceAgent, bob, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);
    expect((await shareToGroup(aliceAgent, pid, groupId)).status).toBe(200);
    expect((await myPortfolio(aliceAgent, pid))?.group?.memberCount).toBe(1);
    expect(await sharedNotifications(bob.id)).toHaveLength(1);

    // An admin disable only flips the status column; nothing prunes rosters. A
    // disabled account cannot sign in and is refused by every read's active-user
    // join, so the reported reach is now ZERO — not "Family · 1".
    await harness.db
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, bob.id));

    const summary = await myPortfolio(aliceAgent, pid);
    expect(summary?.group).toEqual({ id: groupId, name: 'Family', memberCount: 0 });
    // …and the two owner surfaces agree on that roster size.
    const list = await aliceAgent.get('/api/v1/social/groups');
    expect(friendGroupListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.groups[0]).toMatchObject({ id: groupId, memberCount: 0 });
    expect(list.body.groups[0].memberCount).toBe(summary?.group?.memberCount);

    // Re-sharing to the circle sends the disabled member nothing new.
    expect((await shareToGroup(aliceAgent, pid, groupId)).status).toBe(200);
    expect(await sharedNotifications(bob.id)).toHaveLength(1);
  });

  it('reports the same roster size on both surfaces for an active member', async () => {
    const { aliceAgent, bob, carol, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);
    await addMember(aliceAgent, groupId, carol.id);
    await shareToGroup(aliceAgent, pid, groupId);

    const list = await aliceAgent.get('/api/v1/social/groups');
    expect(list.body.groups[0].memberCount).toBe(2);
    expect((await myPortfolio(aliceAgent, pid))?.group?.memberCount).toBe(2);
  });

  it('counts the shares pointing at a circle, so the delete warning can name them', async () => {
    const { aliceAgent, bob, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    // A fresh circle, and one that a mutation just touched, both report zero.
    expect((await addMember(aliceAgent, groupId, bob.id)).body.shareCount).toBe(0);

    await shareToGroup(aliceAgent, pid, groupId);
    expect((await aliceAgent.get('/api/v1/social/groups')).body.groups[0].shareCount).toBe(1);

    // Narrowing the item away from the circle drops the count again.
    await aliceAgent
      .put(`/api/v1/social/audience/portfolio/${pid}`)
      .set(...XRW)
      .send({ audience: 'private' });
    expect((await aliceAgent.get('/api/v1/social/groups')).body.groups[0].shareCount).toBe(0);
  });

  /**
   * The warning may only count what the owner can reconcile. Archiving a
   * portfolio leaves its audience row in place, but enforcement excludes
   * archived portfolios and My items does not list them — so counting that row
   * would tell the owner "1 shared item points at this group" against nothing
   * they can see, which is the blind confirmation #1710 removed (#1830).
   */
  it('leaves an archived portfolio out of the warning, since nothing reaches it any more', async () => {
    const { aliceAgent, bob } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);

    const created = await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Old ideas' });
    expect(created.status).toBe(201);
    const secondId = created.body.portfolio.id as string;
    expect((await shareToGroup(aliceAgent, secondId, groupId)).status).toBe(200);

    // Live: counted here and listed in My items — the #1710 behaviour.
    expect((await aliceAgent.get('/api/v1/social/groups')).body.groups[0].shareCount).toBe(1);
    expect(await myPortfolio(aliceAgent, secondId)).toBeDefined();

    expect(
      (await aliceAgent.post(`/api/v1/portfolios/${secondId}/archive`).set(...XRW)).status,
    ).toBe(200);

    expect((await aliceAgent.get('/api/v1/social/groups')).body.groups[0].shareCount).toBe(0);
    expect(await myPortfolio(aliceAgent, secondId)).toBeUndefined();
  });
});

describe('a group audience scopes the comment thread (§13.5 V5-P8)', () => {
  function getThread(agent: Agent, subjectId: string): Promise<request.Response> {
    return agent.get(`/api/v1/social/items/portfolio/${subjectId}/thread`);
  }

  it('admits exactly the current members and revokes on the next read after removal', async () => {
    const { aliceAgent, bobAgent, carolAgent, bob, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    expect((await addMember(aliceAgent, groupId, bob.id)).status).toBe(200);
    expect((await shareToGroup(aliceAgent, pid, groupId)).status).toBe(200);

    // The member reads AND writes the thread; carol (a friend outside the
    // group) is fail-closed on both, with the uniform 404.
    const posted = await bobAgent
      .post(`/api/v1/social/items/portfolio/${pid}/comments`)
      .set(...XRW)
      .send({ body: 'in the circle' });
    expect(posted.status).toBe(201);
    const memberThread = commentThreadResponseSchema.parse((await getThread(bobAgent, pid)).body);
    expect(memberThread.comments.map((c) => c.body)).toEqual(['in the circle']);
    expect((await getThread(carolAgent, pid)).status).toBe(404);

    // Editing the group applies to the existing share: on the NEXT request the
    // removed member no longer reaches the thread at all.
    const removed = await aliceAgent
      .delete(`/api/v1/social/groups/${groupId}/members/${bob.id}`)
      .set(...XRW)
      .send();
    expect(removed.status).toBe(200);

    expect((await getThread(bobAgent, pid)).status).toBe(404);
    expect(
      (await bobAgent.get(`/api/v1/social/items/portfolio/${pid}/thread/summary`)).status,
    ).toBe(404);
    expect(
      (
        await bobAgent
          .post(`/api/v1/social/items/portfolio/${pid}/comments`)
          .set(...XRW)
          .send({ body: 'still here?' })
      ).status,
    ).toBe(404);
  });
});

/**
 * The bounding and derivation edges of the group surface (#1780). `GET
 * /social/groups` is the read every `AudiencePicker` open performs, so what a
 * user can accumulate is what that read costs; and the `group` rung's reported
 * reach has to be derived from friendship like every other rung, not read off a
 * roster table.
 */
describe('the friend-group surface is bounded (§13.5 V5-P8, #1780)', () => {
  it('refuses a circle past the per-user ceiling, with a mapped code', async () => {
    const { alice, aliceAgent } = await scenario();
    // Filled directly to one below the ceiling: the boundary is the subject
    // here, not FRIEND_GROUPS_MAX HTTP round trips.
    await harness.db.insert(schema.friendGroups).values(
      Array.from({ length: FRIEND_GROUPS_MAX - 1 }, (_, i) => ({
        ownerId: alice.id,
        name: `Circle ${String(i).padStart(2, '0')}`,
      })),
    );

    expect(
      (
        await aliceAgent
          .post('/api/v1/social/groups')
          .set(...XRW)
          .send({ name: 'The last one' })
      ).status,
    ).toBe(201);

    const over = await aliceAgent
      .post('/api/v1/social/groups')
      .set(...XRW)
      .send({ name: 'One too many' });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('FRIEND_GROUP_LIMIT_REACHED');

    // The bounded read answers with exactly the ceiling — never more.
    const list = await aliceAgent.get('/api/v1/social/groups');
    expect(friendGroupListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.groups).toHaveLength(FRIEND_GROUPS_MAX);
  });

  /**
   * Insert `count` extra users and put them on `groupId`'s roster directly, so
   * the stored roster can be filled without 199 round trips. `befriended` also
   * writes the owner↔member friendship row, which is what decides whether the
   * resulting rows are part of the roster the owner can SEE.
   */
  async function fillRoster(
    ownerId: string,
    groupId: string,
    count: number,
    opts: { befriended: boolean; prefix?: string } = { befriended: false },
  ): Promise<string[]> {
    const prefix = opts.prefix ?? 'filler';
    const filler = await harness.db
      .insert(schema.users)
      .values(
        Array.from({ length: count }, (_, i) => ({
          email: `${prefix}${i}@bt.test`,
          username: `${prefix}${i}`,
          passwordHash: 'x',
        })),
      )
      .returning({ id: schema.users.id });
    const ids = filler.map((u) => u.id);
    if (opts.befriended) {
      // Friendship rows are stored canonically (user_a < user_b), whichever way
      // round the pair happens to sort.
      await harness.db.insert(schema.friendships).values(
        ids.map((id) => ({
          userA: ownerId < id ? ownerId : id,
          userB: ownerId < id ? id : ownerId,
        })),
      );
    }
    await harness.db
      .insert(schema.friendGroupMembers)
      .values(ids.map((id) => ({ groupId, memberId: id })));
    return ids;
  }

  /** The RAW roster rows of a group — including any the owner cannot see. */
  async function storedRosterSize(groupId: string): Promise<number> {
    const rows = await harness.db
      .select()
      .from(schema.friendGroupMembers)
      .where(eq(schema.friendGroupMembers.groupId, groupId));
    return rows.length;
  }

  it('refuses a member past the roster ceiling, but still accepts an idempotent repeat', async () => {
    const { aliceAgent, alice, bob, carol } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    expect((await addMember(aliceAgent, groupId, bob.id)).status).toBe(200);

    // Fill the rest of the roster directly, with members alice really can
    // reach — the circle is genuinely full.
    await fillRoster(alice.id, groupId, FRIEND_GROUP_MEMBERS_MAX - 1, { befriended: true });

    const over = await addMember(aliceAgent, groupId, carol.id);
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('FRIEND_GROUP_MEMBER_LIMIT_REACHED');

    // The refusal names a state the owner can resolve: every blocking row is in
    // the roster they read, so `memberCount` reports the blocking total and each
    // one has a Remove button (#1830).
    const list = await aliceAgent.get('/api/v1/social/groups');
    expect(friendGroupListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.groups[0].memberCount).toBe(FRIEND_GROUP_MEMBERS_MAX);
    expect(list.body.groups[0].members).toHaveLength(FRIEND_GROUP_MEMBERS_MAX);
    // Removing one of them makes room, and the add that was refused now lands.
    expect(
      (await aliceAgent.delete(`/api/v1/social/groups/${groupId}/members/${bob.id}`).set(...XRW))
        .status,
    ).toBe(200);
    expect((await addMember(aliceAgent, groupId, carol.id)).status).toBe(200);

    // A repeat add of someone already in the full circle adds nobody, so the
    // ceiling has nothing to refuse — the endpoint stays idempotent.
    expect((await addMember(aliceAgent, groupId, carol.id)).status).toBe(200);
  });

  /**
   * The ceiling counts STORED rows, but the owner only ever sees the live
   * roster. A row for a disabled or no-longer-friend member grants nothing, is
   * absent from `members` and therefore has no Remove button — so it must never
   * be what refuses an add, or the circle is permanently un-addable-to with the
   * cause invisible and unclearable (#1830).
   */
  it('clears the roster rows the owner cannot see instead of refusing an add behind them', async () => {
    const { aliceAgent, alice, bob, carol } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    expect((await addMember(aliceAgent, groupId, bob.id)).status).toBe(200);

    // Fill the circle to the stored ceiling with rows that grant nothing: 198
    // non-friends, plus one friend whose account an admin disabled.
    await fillRoster(alice.id, groupId, FRIEND_GROUP_MEMBERS_MAX - 2, { befriended: false });
    const [disabled] = await fillRoster(alice.id, groupId, 1, {
      befriended: true,
      prefix: 'disabled',
    });
    await harness.db
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, disabled!));

    expect(await storedRosterSize(groupId)).toBe(FRIEND_GROUP_MEMBERS_MAX);
    // …yet the owner is told the circle holds one member, so the add they are
    // offered must not come back as a full-circle refusal.
    const before = await aliceAgent.get('/api/v1/social/groups');
    expect(before.body.groups[0].memberCount).toBe(1);

    const added = await addMember(aliceAgent, groupId, carol.id);
    expect(added.status).toBe(200);
    expect(friendGroupSchema.safeParse(added.body).success).toBe(true);
    expect(added.body.memberCount).toBe(2);

    // The unreachable rows are gone, not merely uncounted — the circle can be
    // filled again with members the owner can actually reach.
    expect(await storedRosterSize(groupId)).toBe(2);
    const list = await aliceAgent.get('/api/v1/social/groups');
    expect(list.body.groups[0].members.map((m: { username: string }) => m.username).sort()).toEqual(
      ['bob', 'carol'],
    );
  });

  it('meters the moderation and roster-churn writes like their POST siblings', async () => {
    harness = await createTestApp({ marketData: stubMarketData(), rateLimitsEnabled: true });
    const { aliceAgent, alice, bob } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);

    const keys = progressiveKeys('social', limiterKeyForUser(alice.id));
    const spent = async () => Number((await harness.ctx.redis.get(keys.count)) ?? 0);

    let before = await spent();
    expect(
      (
        await aliceAgent
          .patch(`/api/v1/social/groups/${groupId}`)
          .set(...XRW)
          .send({ name: 'Inner circle' })
      ).status,
    ).toBe(200);
    expect(await spent()).toBe(before + 1);

    before = await spent();
    expect(
      (await aliceAgent.delete(`/api/v1/social/groups/${groupId}/members/${bob.id}`).set(...XRW))
        .status,
    ).toBe(200);
    expect(await spent()).toBe(before + 1);

    before = await spent();
    expect((await aliceAgent.delete(`/api/v1/social/groups/${groupId}`).set(...XRW)).status).toBe(
      204,
    );
    expect(await spent()).toBe(before + 1);
  });
});

describe("the group rung's reported reach is derived from friendship (#1780)", () => {
  it('excludes a member whose friendship vanished from the count, the roster and the fan-out', async () => {
    const { aliceAgent, bobAgent, bob, pid } = await scenario();
    const groupId = await createGroup(aliceAgent, 'Family');
    await addMember(aliceAgent, groupId, bob.id);
    expect((await shareToGroup(aliceAgent, pid, groupId)).status).toBe(200);
    expect(await sharedNotifications(bob.id)).toHaveLength(1);

    const myPortfolio = async () => {
      const res = await aliceAgent.get('/api/v1/social/my-shared');
      return mySharedResponseSchema.parse(res.body).portfolios.find((p) => p.portfolioId === pid);
    };
    expect((await myPortfolio())?.group?.memberCount).toBe(1);

    // Drop the friendship row alone. The unfriend endpoint prunes rosters inside
    // its own transaction (#1710), so this is the state that survives every path
    // that does NOT — a restore, a repair, a future writer — and enforcement
    // already refuses it. What is under test is that the owner is told the same.
    await harness.db
      .delete(schema.friendships)
      .where(or(eq(schema.friendships.userA, bob.id), eq(schema.friendships.userB, bob.id)));

    expect((await myPortfolio())?.group).toEqual({ id: groupId, name: 'Family', memberCount: 0 });
    const list = await aliceAgent.get('/api/v1/social/groups');
    expect(friendGroupListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.groups[0]).toMatchObject({ id: groupId, memberCount: 0, members: [] });

    // Enforcement agrees, and re-sharing the circle emits nothing to the
    // ex-friend — no `*.shared` notice pointing at an item they now 404 on.
    expect((await bobAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
    expect((await shareToGroup(aliceAgent, pid, groupId)).status).toBe(200);
    expect(await sharedNotifications(bob.id)).toHaveLength(1);
  });
});
