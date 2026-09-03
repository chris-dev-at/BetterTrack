import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  commentThreadResponseSchema,
  friendGroupSchema,
  friendGroupListResponseSchema,
  mySharedResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
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
