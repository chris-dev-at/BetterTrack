import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  followersListResponseSchema,
  followingListResponseSchema,
  publicProfileResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Person-follow + the `follow.published` news pipeline (#438). A follow is
 * one-directional, grants NO read access, and only opts the follower into news
 * when a followed user's portfolio / watchlist / conglomerate becomes NEWLY
 * VISIBLE to them. The emission fires exactly once per newly-exposed follower on
 * a transition INTO `public_link`; friend-share transitions are covered by the
 * direct `*.shared` notice (no doubles), and a follower who could already see the
 * item — or one who followed after it was already public — gets nothing.
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

function follow(agent: Agent, userId: string): Promise<request.Response> {
  return agent
    .post('/api/v1/social/follows')
    .set(...XRW)
    .send({ userId });
}

function unfollow(agent: Agent, userId: string): Promise<request.Response> {
  return agent
    .delete(`/api/v1/social/follows/${userId}`)
    .set(...XRW)
    .send();
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

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
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

/** Non-hidden notification rows for a user, optionally filtered by type. */
async function notifs(userId: string, type?: string) {
  const rows = await harness.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId));
  return rows.filter((r) => !r.hidden && (type === undefined || r.type === type));
}

async function makePublic(agent: Agent, portfolioId: string): Promise<void> {
  const res = await putAudience(agent, 'portfolio', portfolioId, {
    audience: 'public_link',
    acknowledgePublic: true,
  });
  expect(res.status).toBe(200);
}

/**
 * Opt the caller into a public profile so the `/u/:username` slug resolves. The
 * `follow.published` fan-out is gated on this — a follower reaches a newly-public
 * item ONLY through the owner's public profile (the notification's deep link), so
 * an item published without a live profile deep-links nowhere and sends no news.
 */
async function enablePublicProfile(agent: Agent): Promise<void> {
  const res = await agent
    .put('/api/v1/social/profile')
    .set(...XRW)
    .send({ isPublic: true, acknowledgePublic: true });
  expect(res.status).toBe(200);
}

describe('follows — CRUD, lists, isolation', () => {
  it('follow/unfollow is idempotent; following/followers lists are correct and isolated', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const carolAgent = await loginAgent(harness.app, carol.email, carol.password);
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);

    expect((await follow(bobAgent, alice.id)).status).toBe(202);
    // Idempotent: a repeat follow is still a 202, and never a duplicate row.
    expect((await follow(bobAgent, alice.id)).status).toBe(202);
    expect((await follow(carolAgent, alice.id)).status).toBe(202);

    const bobFollowing = followingListResponseSchema.parse(
      (await bobAgent.get('/api/v1/social/follows')).body,
    );
    expect(bobFollowing.following.map((f) => f.user.username)).toEqual(['alice']);
    expect(bobFollowing.followingCount).toBe(1);
    // bob follows alice but nobody follows bob.
    expect(bobFollowing.followerCount).toBe(0);

    const aliceFollowers = followersListResponseSchema.parse(
      (await aliceAgent.get('/api/v1/social/followers')).body,
    );
    expect(aliceFollowers.followers.map((f) => f.user.username).sort()).toEqual(['bob', 'carol']);
    // alice follows nobody — following list is isolated per caller.
    expect(
      followingListResponseSchema.parse((await aliceAgent.get('/api/v1/social/follows')).body)
        .following,
    ).toEqual([]);

    // Unfollow removes exactly one direction; the other user's follow is untouched.
    expect((await unfollow(bobAgent, alice.id)).status).toBe(204);
    expect(
      followingListResponseSchema.parse((await bobAgent.get('/api/v1/social/follows')).body)
        .following,
    ).toEqual([]);
    expect(
      followersListResponseSchema
        .parse((await aliceAgent.get('/api/v1/social/followers')).body)
        .followers.map((f) => f.user.username),
    ).toEqual(['carol']);
  });

  it('rejects self-follow (400), unknown target (404), and unfollowing a non-follow (404)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);

    expect((await follow(aliceAgent, alice.id)).status).toBe(400);
    expect((await follow(aliceAgent, MISSING_ID)).status).toBe(404);
    // Unfollowing someone you never followed 404s (like removing a non-friend).
    expect((await unfollow(bobAgent, alice.id)).status).toBe(404);
  });
});

describe('follow.published — emission matrix + anti-noise', () => {
  it('AC1: making a portfolio public notifies exactly the followers, with a working link', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);

    expect((await follow(bobAgent, alice.id)).status).toBe(202); // carol does NOT follow

    // Alice opts into a public profile so the bell's `/u/alice` deep link resolves.
    await enablePublicProfile(aliceAgent);

    const pid = await defaultPortfolioId(aliceAgent);
    await makePublic(aliceAgent, pid);

    const bobNews = await notifs(bob.id, 'follow.published');
    expect(bobNews).toHaveLength(1);
    const payload = bobNews[0]!.payload as Record<string, unknown>;
    expect(payload.actorUsername).toBe('alice');
    expect(payload.itemKind).toBe('portfolio');
    expect(payload.itemId).toBe(pid);
    expect(typeof payload.itemName).toBe('string');

    // "with a working link": the deep link the bell builds from the payload
    // (`/u/${actorUsername}`) actually resolves — the follower can open Alice's
    // public profile AND drill into the freshly-published item, both 200.
    const slug = payload.actorUsername as string;
    const profileRes = await bobAgent.get(`/api/v1/social/profiles/${slug}`);
    expect(profileRes.status).toBe(200);
    expect(
      (profileRes.body.portfolios as { portfolioId: string }[]).map((p) => p.portfolioId),
    ).toContain(pid);
    expect((await bobAgent.get(`/api/v1/social/profiles/${slug}/portfolio/${pid}`)).status).toBe(
      200,
    );

    // The non-follower gets nothing.
    expect(await notifs(carol.id, 'follow.published')).toHaveLength(0);
  });

  it('does NOT notify followers when the owner has no public profile (dead-link guard)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await follow(bobAgent, alice.id);

    // Alice publishes an item but never opts into a public profile: `/u/alice`
    // 404s, so a follow.published would deep-link nowhere — none is sent.
    const pid = await defaultPortfolioId(aliceAgent);
    await makePublic(aliceAgent, pid);
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(0);
    expect((await bobAgent.get('/api/v1/social/profiles/alice')).status).toBe(404);

    // Once Alice enables the profile, publishing a fresh item DOES notify, and the
    // link now resolves (a distinct item keeps the dedup key from colliding).
    await enablePublicProfile(aliceAgent);
    const freshPid = await createPortfolio(aliceAgent, 'Now Public');
    await makePublic(aliceAgent, freshPid);
    const news = await notifs(bob.id, 'follow.published');
    expect(news).toHaveLength(1);
    expect((news[0]!.payload as Record<string, unknown>).itemId).toBe(freshPid);
    expect((await bobAgent.get('/api/v1/social/profiles/alice')).status).toBe(200);
  });

  it('fires for a newly-created portfolio made public (create-public path)', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await follow(bobAgent, alice.id);
    await enablePublicProfile(aliceAgent);

    const pid = await createPortfolio(aliceAgent, 'Fresh');
    await makePublic(aliceAgent, pid);

    const news = await notifs(bob.id, 'follow.published');
    expect(news).toHaveLength(1);
    expect((news[0]!.payload as Record<string, unknown>).itemId).toBe(pid);
  });

  it('the specific-share + all-friends paths do NOT double-notify a friend-follower', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, 'bob');
    await follow(bobAgent, alice.id);

    // specific_friends[bob]: bob gets ONE portfolio.shared and ZERO follow.published.
    const specificPid = await createPortfolio(aliceAgent, 'Specific');
    expect(
      (
        await putAudience(aliceAgent, 'portfolio', specificPid, {
          audience: 'specific_friends',
          friendIds: [bob.id],
        })
      ).status,
    ).toBe(200);
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(0);
    expect(await notifs(bob.id, 'portfolio.shared')).toHaveLength(1);

    // all_friends: bob (a friend) is covered by the direct portfolio.shared too.
    const allPid = await createPortfolio(aliceAgent, 'AllFriends');
    expect(
      (await putAudience(aliceAgent, 'portfolio', allPid, { audience: 'all_friends' })).status,
    ).toBe(200);
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(0);
    expect(await notifs(bob.id, 'portfolio.shared')).toHaveLength(2);
  });

  it('a non-friend follower is NOT notified (and gets no read access) on an all-friends share', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const carolAgent = await loginAgent(harness.app, carol.email, carol.password);
    // carol follows but is NOT a friend.
    await follow(carolAgent, alice.id);

    const pid = await defaultPortfolioId(aliceAgent);
    expect(
      (await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' })).status,
    ).toBe(200);

    // No news (a friends-only item is not visible to a non-friend), and following
    // grants no read access — the enforcement layer still 404s the drill-in.
    expect(await notifs(carol.id, 'follow.published')).toHaveLength(0);
    expect((await carolAgent.get(`/api/v1/social/shared/${pid}`)).status).toBe(404);
  });

  it('a friend-follower who already saw an all-friends item is NOT re-notified when it goes public', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, 'bob');
    await follow(bobAgent, alice.id);
    // Profile live, so the ONLY reason bob gets no news is "could see before".
    await enablePublicProfile(aliceAgent);

    const pid = await defaultPortfolioId(aliceAgent);
    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'all_friends' });
    await makePublic(aliceAgent, pid); // widen friends → public

    // bob could already see it as a friend, so widening to public re-notifies nobody.
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(0);
  });

  it('pre-existing public items produce nothing when the follow starts', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await enablePublicProfile(aliceAgent);

    const pid = await defaultPortfolioId(aliceAgent);
    await makePublic(aliceAgent, pid); // public BEFORE anyone follows
    await follow(bobAgent, alice.id);

    // Nothing to notify: bob wasn't a follower at the moment it went public.
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(0);
  });

  it('flapping public→private→public within a day does not re-fire', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await follow(bobAgent, alice.id);
    await enablePublicProfile(aliceAgent);

    const pid = await defaultPortfolioId(aliceAgent);
    await makePublic(aliceAgent, pid);
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(1);

    await putAudience(aliceAgent, 'portfolio', pid, { audience: 'private' });
    await makePublic(aliceAgent, pid); // same UTC day → deduped
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(1);
  });

  it('unfollowing stops news immediately', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await follow(bobAgent, alice.id);
    await enablePublicProfile(aliceAgent);

    const firstPid = await defaultPortfolioId(aliceAgent);
    await makePublic(aliceAgent, firstPid);
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(1);

    expect((await unfollow(bobAgent, alice.id)).status).toBe(204);
    const secondPid = await createPortfolio(aliceAgent, 'AfterUnfollow');
    await makePublic(aliceAgent, secondPid);
    // No new news for the second item — the follow is gone.
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(1);
  });

  it('watchlists and conglomerates published public also notify followers', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await follow(bobAgent, alice.id);
    await enablePublicProfile(aliceAgent);

    const lists = await aliceAgent.get('/api/v1/workboard/watchlists');
    const wid = lists.body.watchlists.find((w: { isDefault: boolean }) => w.isDefault).id as string;
    expect(
      (
        await putAudience(aliceAgent, 'watchlist', wid, {
          audience: 'public_link',
          acknowledgePublic: true,
        })
      ).status,
    ).toBe(200);

    const news = await notifs(bob.id, 'follow.published');
    expect(news).toHaveLength(1);
    expect((news[0]!.payload as Record<string, unknown>).itemKind).toBe('watchlist');
  });

  it('muting follow.published per channel suppresses the in-app row', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await follow(bobAgent, alice.id);
    // bob routes follow.published OFF for the in-app channel.
    expect(
      (
        await bobAgent
          .patch('/api/v1/settings/notifications')
          .set(...XRW)
          .send({
            matrix: {
              'follow.published': { inapp: false, email: true, push: true, webpush: true },
            },
          })
      ).status,
    ).toBe(200);
    await enablePublicProfile(aliceAgent);

    const pid = await defaultPortfolioId(aliceAgent);
    await makePublic(aliceAgent, pid);

    // The matrix row works: no visible in-app notification (only the hidden marker).
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(0);
  });

  it('the public profile reports the follower count', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const carolAgent = await loginAgent(harness.app, carol.email, carol.password);
    await follow(bobAgent, alice.id);
    await follow(carolAgent, alice.id);

    // alice opts into a public profile so the slug resolves.
    expect(
      (
        await aliceAgent
          .put('/api/v1/social/profile')
          .set(...XRW)
          .send({ isPublic: true, acknowledgePublic: true })
      ).status,
    ).toBe(200);

    const profile = publicProfileResponseSchema.parse(
      (await request(harness.app).get('/api/v1/social/profiles/alice')).body,
    );
    expect(profile.userId).toBe(alice.id);
    expect(profile.followerCount).toBe(2);
  });
});
