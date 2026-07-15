import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  followingListResponseSchema,
  itemFollowsListResponseSchema,
  type FollowedItem,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Item follows + per-person auto-follow (#439). An item follow is a BOOKMARK of
 * another user's visible item: it grants no read access, only a currently
 * visible item is followable (friend-shared, or public on a live public
 * profile), and every list read re-derives visibility through the audience
 * enforcement layer — an unshared/unfriended item degrades to the chat-chip
 * style `viewable:false` shell, a deleted one is purged. `autoFollowItems` on a
 * person-follow (#438) auto-bookmarks each item that becomes newly visible to
 * the follower, riding the exact `follow.published` event matrix.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-7000-000000000000';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
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

function putAudience(
  agent: Agent,
  kind: 'portfolio' | 'conglomerate' | 'watchlist',
  subjectId: string,
  body: { audience: string; friendIds?: string[]; acknowledgePublic?: boolean },
): Promise<request.Response> {
  return agent
    .put(`/api/v1/social/audience/${kind}/${subjectId}`)
    .set(...XRW)
    .send(body);
}

function followItem(agent: Agent, kind: string, subjectId: string): Promise<request.Response> {
  return agent
    .post('/api/v1/social/item-follows')
    .set(...XRW)
    .send({ kind, subjectId });
}

function unfollowItem(agent: Agent, kind: string, subjectId: string): Promise<request.Response> {
  return agent
    .delete(`/api/v1/social/item-follows/${kind}/${subjectId}`)
    .set(...XRW)
    .send();
}

async function listItems(agent: Agent): Promise<FollowedItem[]> {
  const res = await agent.get('/api/v1/social/item-follows');
  expect(res.status).toBe(200);
  return itemFollowsListResponseSchema.parse(res.body).items;
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault);
  return def.id as string;
}

async function createPortfolio(agent: Agent, name: string): Promise<string> {
  const res = await agent
    .post('/api/v1/portfolios')
    .set(...XRW)
    .send({ name });
  expect(res.status).toBe(201);
  return res.body.portfolio.id as string;
}

async function defaultWatchlistId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/workboard/watchlists');
  return res.body.watchlists.find((w: { isDefault: boolean }) => w.isDefault).id as string;
}

async function createConglomerate(agent: Agent, name: string): Promise<string> {
  const res = await agent
    .post('/api/v1/conglomerates')
    .set(...XRW)
    .send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function enablePublicProfile(agent: Agent): Promise<void> {
  const res = await agent
    .put('/api/v1/social/profile')
    .set(...XRW)
    .send({ isPublic: true, acknowledgePublic: true });
  expect(res.status).toBe(200);
}

/** Non-hidden notification rows for a user, optionally filtered by type. */
async function notifs(userId: string, type?: string) {
  const rows = await harness.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId));
  return rows.filter((r) => !r.hidden && (type === undefined || r.type === type));
}

describe('item follows — round-trip, visibility gates, isolation', () => {
  it('follows a friend-shared item, lists it viewable (via friend), unfollows; idempotent + isolated', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const carolAgent = await loginAgent(harness.app, carol.email, carol.password);
    await befriend(aliceAgent, bobAgent, 'bob');

    const pid = await defaultPortfolioId(aliceAgent);
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });

    expect((await followItem(bobAgent, 'portfolio', pid)).status).toBe(202);
    // Idempotent: a repeat follow is still a 202 and never a duplicate row.
    expect((await followItem(bobAgent, 'portfolio', pid)).status).toBe(202);

    const items = await listItems(bobAgent);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'portfolio',
      subjectId: pid,
      viewable: true,
      owner: { id: alice.id, username: 'alice' },
      via: 'friend',
    });
    expect(items[0]!.name).toBeTruthy();

    // User isolation: carol's collection is untouched by bob's follow.
    expect(await listItems(carolAgent)).toHaveLength(0);

    expect((await unfollowItem(bobAgent, 'portfolio', pid)).status).toBe(204);
    expect(await listItems(bobAgent)).toHaveLength(0);
    // Unfollowing a non-follow 404s.
    expect((await unfollowItem(bobAgent, 'portfolio', pid)).status).toBe(404);
  });

  it('only visible items are followable: private/unknown 404, own item 400, friends-only stranger 404', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const carolAgent = await loginAgent(harness.app, carol.email, carol.password);

    const pid = await defaultPortfolioId(aliceAgent);

    // Private (no audience row) → 404, indistinguishable from unknown.
    expect((await followItem(carolAgent, 'portfolio', pid)).status).toBe(404);
    expect((await followItem(carolAgent, 'portfolio', MISSING_ID)).status).toBe(404);

    // Friends-only item, carol is a stranger → still 404 (no probe).
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });
    expect((await followItem(carolAgent, 'portfolio', pid)).status).toBe(404);

    // Your own item is never followable, whatever its audience.
    expect((await followItem(aliceAgent, 'portfolio', pid)).status).toBe(400);
  });

  it('a public item is followable by a non-friend ONLY while the owner profile is live (via public)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const carolAgent = await loginAgent(harness.app, carol.email, carol.password);

    const wid = await defaultWatchlistId(aliceAgent);
    await putAudience(aliceAgent, 'watchlist', wid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });

    // Public item but NO public profile: a non-friend has no route to it → 404
    // (the #438 reachability rule, mirrored).
    expect((await followItem(carolAgent, 'watchlist', wid)).status).toBe(404);

    await enablePublicProfile(aliceAgent);
    expect((await followItem(carolAgent, 'watchlist', wid)).status).toBe(202);
    const items = await listItems(carolAgent);
    expect(items[0]).toMatchObject({ kind: 'watchlist', subjectId: wid, via: 'public' });
  });

  it('renders all three subject kinds in one collection', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, 'bob');

    const pid = await defaultPortfolioId(aliceAgent);
    const wid = await defaultWatchlistId(aliceAgent);
    const cid = await createConglomerate(aliceAgent, 'Basket');
    for (const [kind, id] of [
      ['portfolio', pid],
      ['watchlist', wid],
      ['conglomerate', cid],
    ] as const) {
      await putAudience(aliceAgent, kind, id, { audience: 'all_friends' });
      expect((await followItem(bobAgent, kind, id)).status).toBe(202);
    }

    const items = await listItems(bobAgent);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.kind).sort()).toEqual(['conglomerate', 'portfolio', 'watchlist']);
    for (const item of items) {
      expect(item.viewable).toBe(true);
      expect(item.name).toBeTruthy();
      expect(item.owner?.username).toBe('alice');
    }
  });
});

describe('item follows — losing visibility degrades gracefully', () => {
  it('unsharing renders the row as a viewable:false shell (no name/owner leak); unfollow still works', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, 'bob');

    const pid = await defaultPortfolioId(aliceAgent);
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });
    expect((await followItem(bobAgent, 'portfolio', pid)).status).toBe(202);

    // Owner narrows the audience back to private: the very next read degrades.
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'private' });
    const items = await listItems(bobAgent);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: 'portfolio',
      subjectId: pid,
      followedAt: expect.any(String),
      viewable: false,
      name: null,
      owner: null,
      via: null,
    });

    // The gone row can still be cleaned up by its follower.
    expect((await unfollowItem(bobAgent, 'portfolio', pid)).status).toBe(204);
  });

  it('unfriending closes friend-mode visibility on the next read', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, 'bob');

    const pid = await defaultPortfolioId(aliceAgent);
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });
    expect((await followItem(bobAgent, 'portfolio', pid)).status).toBe(202);

    expect((await aliceAgent.delete(`/api/v1/social/friends/${bob.id}`).set(...XRW)).status).toBe(
      204,
    );
    const items = await listItems(bobAgent);
    expect(items[0]).toMatchObject({ viewable: false, name: null, owner: null });
  });

  it('deleting the subject purges the follow row entirely', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, 'bob');

    // A second portfolio, so the default one keeps the account deletable-safe.
    const pid = await createPortfolio(aliceAgent, 'Trading');
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });
    expect((await followItem(bobAgent, 'portfolio', pid)).status).toBe(202);

    expect((await aliceAgent.delete(`/api/v1/portfolios/${pid}`).set(...XRW)).status).toBe(204);
    // Purged, not just degraded: the clearForSubject hygiene hook removed it.
    expect(await listItems(bobAgent)).toHaveLength(0);
  });
});

describe('auto-follow — the #438 event matrix auto-adds for opted-in followers', () => {
  it('ON at follow time: a newly published item lands in the follower collection AND notifies; OFF: news only', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const carolAgent = await loginAgent(harness.app, carol.email, carol.password);

    // Alice opts into a public profile so the two non-friends can follow her
    // (V4-P0b). bob opts into auto-follow AT FOLLOW TIME; carol takes the default.
    await enablePublicProfile(aliceAgent);
    expect(
      (
        await bobAgent
          .post('/api/v1/social/follows')
          .set(...XRW)
          .send({ userId: alice.id, autoFollowItems: true })
      ).status,
    ).toBe(202);
    expect(
      (
        await carolAgent
          .post('/api/v1/social/follows')
          .set(...XRW)
          .send({ userId: alice.id })
      ).status,
    ).toBe(202);

    const pid = await createPortfolio(aliceAgent, 'Fresh');
    await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });

    // Both followers get the #438 news…
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(1);
    expect(await notifs(carol.id, 'follow.published')).toHaveLength(1);

    // …but only bob's collection gained the item, fully viewable via public.
    const bobItems = await listItems(bobAgent);
    expect(bobItems).toHaveLength(1);
    expect(bobItems[0]).toMatchObject({
      kind: 'portfolio',
      subjectId: pid,
      viewable: true,
      via: 'public',
    });
    expect(await listItems(carolAgent)).toHaveLength(0);
  });

  it('is settable later via PATCH, per followed person, default OFF; PATCH on a non-follow 404s', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const emma = await harness.seedUser({ email: 'emma@bt.test', username: 'emma' });
    const dave = await harness.seedUser({ email: 'dave@bt.test', username: 'dave' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const emmaAgent = await loginAgent(harness.app, emma.email, emma.password);
    const daveAgent = await loginAgent(harness.app, dave.email, dave.password);

    // Both targets open a public profile so the non-friend dave can follow them (V4-P0b).
    await enablePublicProfile(aliceAgent);
    await enablePublicProfile(emmaAgent);

    // dave follows alice and emma; both prefs default OFF.
    for (const target of [alice.id, emma.id]) {
      expect(
        (
          await daveAgent
            .post('/api/v1/social/follows')
            .set(...XRW)
            .send({ userId: target })
        ).status,
      ).toBe(202);
    }
    let following = followingListResponseSchema.parse(
      (await daveAgent.get('/api/v1/social/follows')).body,
    ).following;
    expect(following.map((f) => f.autoFollowItems)).toEqual([false, false]);

    // PATCH flips exactly one followed person.
    const patch = await daveAgent
      .patch(`/api/v1/social/follows/${alice.id}`)
      .set(...XRW)
      .send({ autoFollowItems: true });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ user: { username: 'alice' }, autoFollowItems: true });

    following = followingListResponseSchema.parse(
      (await daveAgent.get('/api/v1/social/follows')).body,
    ).following;
    expect(Object.fromEntries(following.map((f) => [f.user.username, f.autoFollowItems]))).toEqual({
      alice: true,
      emma: false,
    });

    // A repeat person-follow never silently flips the pref back.
    expect(
      (
        await daveAgent
          .post('/api/v1/social/follows')
          .set(...XRW)
          .send({ userId: alice.id })
      ).status,
    ).toBe(202);
    following = followingListResponseSchema.parse(
      (await daveAgent.get('/api/v1/social/follows')).body,
    ).following;
    expect(following.find((f) => f.user.username === 'alice')?.autoFollowItems).toBe(true);

    // PATCHing someone dave doesn't follow 404s.
    expect(
      (
        await daveAgent
          .patch(`/api/v1/social/follows/${MISSING_ID}`)
          .set(...XRW)
          .send({ autoFollowItems: true })
      ).status,
    ).toBe(404);

    // The PATCHed pref drives the auto-add: alice publishes → dave's collection gains it.
    await enablePublicProfile(aliceAgent);
    const pid = await createPortfolio(aliceAgent, 'AfterPatch');
    await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    const items = await listItems(daveAgent);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'portfolio', subjectId: pid });
  });

  it('auto-follow only rides NEWLY-visible transitions: a friend who already saw the item gets nothing', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, 'bob');
    expect(
      (
        await bobAgent
          .post('/api/v1/social/follows')
          .set(...XRW)
          .send({ userId: alice.id, autoFollowItems: true })
      ).status,
    ).toBe(202);
    await enablePublicProfile(aliceAgent);

    // bob (a friend) could already see it under all_friends…
    const pid = await defaultPortfolioId(aliceAgent);
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });
    // …so widening to public is not newly-visible for bob: no news, no auto-add
    // (the exact #438 matrix — mirroring its "no re-notify" case).
    await putAudience(aliceAgent, 'portfolio', pid, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(0);
    expect(await listItems(bobAgent)).toHaveLength(0);
  });
});
