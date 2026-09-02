import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { and, eq } from 'drizzle-orm';

import {
  COMMENT_PAGE_SIZE,
  commentThreadResponseSchema,
  commentThreadSummaryResponseSchema,
  itemCommentSchema,
  reactionListResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createStubMarketData } from '../testing/marketDataStubs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Comments + reactions on shared items (§13.5 V5-P8). The privacy core: a
 * comment is visible to EXACTLY the item's current audience — resolved through
 * the same audience-enforcement layer every social read uses (fail-closed) — the
 * owner moderates any comment, authors delete their own, reactions toggle and
 * aggregate, only the curated six emojis are accepted, and public links stay
 * read-only (no comment endpoint is reachable logged-out).
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

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

async function befriend(from: Agent, to: Agent, toIdentifier: string): Promise<void> {
  await from
    .post('/api/v1/social/requests')
    .set(...XRW)
    .send({ identifier: toIdentifier });
  const inbox = await to.get('/api/v1/social/requests');
  const requestId = inbox.body.incoming[0]?.id as string;
  const res = await to
    .post(`/api/v1/social/requests/${requestId}/accept`)
    .set(...XRW)
    .send();
  expect(res.status).toBe(200);
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

function putAudience(
  agent: Agent,
  subjectId: string,
  body: { audience: string; friendIds?: string[]; acknowledgePublic?: boolean },
): Promise<request.Response> {
  return agent
    .put(`/api/v1/social/audience/portfolio/${subjectId}`)
    .set(...XRW)
    .send({ confirmWiden: true, ...body });
}

function getThread(agent: Agent, subjectId: string, cursor?: string): Promise<request.Response> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return agent.get(`/api/v1/social/items/portfolio/${subjectId}/thread${query}`);
}

function getThreadSummary(agent: Agent, subjectId: string): Promise<request.Response> {
  return agent.get(`/api/v1/social/items/portfolio/${subjectId}/thread/summary`);
}

function postComment(agent: Agent, subjectId: string, body: string): Promise<request.Response> {
  return agent
    .post(`/api/v1/social/items/portfolio/${subjectId}/comments`)
    .set(...XRW)
    .send({ body });
}

function reactItem(agent: Agent, subjectId: string, emoji: string): Promise<request.Response> {
  return agent
    .post(`/api/v1/social/items/portfolio/${subjectId}/reactions`)
    .set(...XRW)
    .send({ emoji });
}

/**
 * alice (owner) with a funded default portfolio; bob befriended; carol a
 * separate user who is NOT alice's friend. Returns the actors + portfolio id.
 */
async function scenario() {
  const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
  const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
  const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
  const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
  const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
  const carolAgent = await loginAgent(harness.app, carol.email, carol.password);
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
      quantity: '1',
      price: '100',
      currency: 'EUR',
      executedAt: new Date().toISOString(),
    });

  return { alice, bob, carol, aliceAgent, bobAgent, carolAgent, pid };
}

describe('comments — audience-scoped visibility (§13.5 V5-P8)', () => {
  it('all_friends: a friend reads + posts; the owner and friend see it; a non-friend 404s', async () => {
    const { bob, carol, aliceAgent, bobAgent, carolAgent, pid } = await scenario();
    // carol becomes a NON-friend by removing the friendship.
    await aliceAgent
      .delete(`/api/v1/social/friends/${carol.id}`)
      .set(...XRW)
      .send();
    await putAudience(aliceAgent, pid, { audience: 'all_friends' });

    const posted = await postComment(bobAgent, pid, 'Nice position!');
    expect(posted.status).toBe(201);
    expect(itemCommentSchema.parse(posted.body).author.username).toBe('bob');

    // Owner sees it and may moderate (canDelete true on any comment).
    const ownerThread = await getThread(aliceAgent, pid);
    expect(ownerThread.status).toBe(200);
    const owned = commentThreadResponseSchema.parse(ownerThread.body);
    expect(owned.commentCount).toBe(1);
    expect(owned.comments[0]!.canDelete).toBe(true);
    void bob;

    // The audience-excluded (non-friend) user can neither read nor write.
    expect((await getThread(carolAgent, pid)).status).toBe(404);
    expect((await postComment(carolAgent, pid, 'sneaky')).status).toBe(404);
  });

  it('specific_friends: only the named friend sees the thread; a non-named friend 404s', async () => {
    const { bob, aliceAgent, bobAgent, carolAgent, pid } = await scenario();
    await putAudience(aliceAgent, pid, { audience: 'specific_friends', friendIds: [bob.id] });

    expect((await getThread(bobAgent, pid)).status).toBe(200);
    // carol is a friend but NOT in the specific set → fail-closed 404.
    expect((await getThread(carolAgent, pid)).status).toBe(404);
    expect((await postComment(carolAgent, pid, 'nope')).status).toBe(404);
  });

  it('narrowing the audience immediately narrows thread visibility', async () => {
    const { aliceAgent, bobAgent, pid } = await scenario();
    await putAudience(aliceAgent, pid, { audience: 'all_friends' });
    expect((await getThread(bobAgent, pid)).status).toBe(200);

    // Narrow to private — bob loses access on the very next read (no caching).
    await putAudience(aliceAgent, pid, { audience: 'private' });
    expect((await getThread(bobAgent, pid)).status).toBe(404);
    expect((await postComment(bobAgent, pid, 'still here?')).status).toBe(404);
  });

  it('a private (unshared) item exposes no thread to friends', async () => {
    const { bobAgent, pid } = await scenario();
    // Never shared — default private.
    expect((await getThread(bobAgent, pid)).status).toBe(404);
  });
});

describe('comment moderation (§13.5 V5-P8)', () => {
  async function commentAs(agent: Agent, pid: string, body: string): Promise<string> {
    const res = await postComment(agent, pid, body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('the item owner deletes any comment; the author deletes their own; nobody else can', async () => {
    const { aliceAgent, bobAgent, carolAgent, pid } = await scenario();
    await putAudience(aliceAgent, pid, { audience: 'all_friends' });

    const bobComment = await commentAs(bobAgent, pid, 'from bob');

    // carol (a friend, not the author, not the owner) cannot delete bob's comment.
    expect(
      (
        await carolAgent
          .delete(`/api/v1/social/comments/${bobComment}`)
          .set(...XRW)
          .send()
      ).status,
    ).toBe(404);

    // The item owner (alice) moderates bob's comment.
    expect(
      (
        await aliceAgent
          .delete(`/api/v1/social/comments/${bobComment}`)
          .set(...XRW)
          .send()
      ).status,
    ).toBe(204);

    // Now gone from the thread.
    const thread = commentThreadResponseSchema.parse((await getThread(aliceAgent, pid)).body);
    expect(thread.commentCount).toBe(0);

    // The author can delete their own.
    const carolComment = await commentAs(carolAgent, pid, 'from carol');
    expect(
      (
        await carolAgent
          .delete(`/api/v1/social/comments/${carolComment}`)
          .set(...XRW)
          .send()
      ).status,
    ).toBe(204);
  });
});

describe('reactions (§13.5 V5-P8)', () => {
  it('toggles per user/emoji and aggregates counts across users', async () => {
    const { aliceAgent, bobAgent, pid } = await scenario();
    await putAudience(aliceAgent, pid, { audience: 'all_friends' });

    // alice + bob both react 🔥; count aggregates to 2, each sees `reacted: true`.
    const a1 = reactionListResponseSchema.parse((await reactItem(aliceAgent, pid, '🔥')).body);
    expect(a1.reactions).toEqual([{ emoji: '🔥', count: 1, reacted: true }]);
    const b1 = reactionListResponseSchema.parse((await reactItem(bobAgent, pid, '🔥')).body);
    expect(b1.reactions).toEqual([{ emoji: '🔥', count: 2, reacted: true }]);

    // bob toggles the same emoji off → count drops to 1, bob no longer reacted.
    const b2 = reactionListResponseSchema.parse((await reactItem(bobAgent, pid, '🔥')).body);
    expect(b2.reactions).toEqual([{ emoji: '🔥', count: 1, reacted: false }]);
  });

  it('rejects any emoji outside the curated six (contract-enforced 400)', async () => {
    const { aliceAgent, pid } = await scenario();
    await putAudience(aliceAgent, pid, { audience: 'all_friends' });
    expect((await reactItem(aliceAgent, pid, '💩')).status).toBe(400);
    expect((await reactItem(aliceAgent, pid, 'not-an-emoji')).status).toBe(400);
  });

  it('reacts on a comment and reflects it in the thread aggregate', async () => {
    const { aliceAgent, bobAgent, pid } = await scenario();
    await putAudience(aliceAgent, pid, { audience: 'all_friends' });
    const posted = await postComment(bobAgent, pid, 'reactable');
    const commentId = posted.body.id as string;

    const r = await aliceAgent
      .post(`/api/v1/social/comments/${commentId}/reactions`)
      .set(...XRW)
      .send({ emoji: '👍' });
    expect(r.status).toBe(200);
    expect(reactionListResponseSchema.parse(r.body).reactions).toEqual([
      { emoji: '👍', count: 1, reacted: true },
    ]);

    const thread = commentThreadResponseSchema.parse((await getThread(bobAgent, pid)).body);
    // bob (a different viewer) sees the count but `reacted: false`.
    expect(thread.comments[0]!.reactions).toEqual([{ emoji: '👍', count: 1, reacted: false }]);
  });
});

describe('the thread is served in bounded pages (§13.5 V5-P8)', () => {
  /** Seed `n` live comments straight into SQL, one second apart, oldest first. */
  async function seedComments(pid: string, authorId: string, n: number): Promise<void> {
    const base = Date.parse('2026-07-01T00:00:00.000Z');
    await harness.db.insert(schema.itemComments).values(
      Array.from({ length: n }, (_unused, index) => ({
        kind: 'portfolio' as const,
        subjectId: pid,
        authorId,
        body: `comment ${index}`,
        createdAt: new Date(base + index * 1000),
      })),
    );
  }

  it('returns the newest page + a cursor, and the cursor reaches the tail in stable order', async () => {
    const { alice, aliceAgent, bobAgent, pid } = await scenario();
    await putAudience(aliceAgent, pid, { audience: 'all_friends' });
    const total = COMMENT_PAGE_SIZE + 5;
    await seedComments(pid, alice.id, total);

    const first = commentThreadResponseSchema.parse((await getThread(bobAgent, pid)).body);
    // The whole thread is never served: one page, plus the true total count.
    expect(first.comments).toHaveLength(COMMENT_PAGE_SIZE);
    expect(first.commentCount).toBe(total);
    expect(first.nextCursor).not.toBeNull();
    // Newest page, oldest-first inside the page.
    expect(first.comments[0]!.body).toBe(`comment ${total - COMMENT_PAGE_SIZE}`);
    expect(first.comments.at(-1)!.body).toBe(`comment ${total - 1}`);

    const older = commentThreadResponseSchema.parse(
      (await getThread(bobAgent, pid, first.nextCursor!)).body,
    );
    // The tail is reachable and the walk terminates — no overlap, no gap.
    expect(older.comments).toHaveLength(5);
    expect(older.nextCursor).toBeNull();
    expect(older.comments.map((c) => c.body)).toEqual([
      'comment 0',
      'comment 1',
      'comment 2',
      'comment 3',
      'comment 4',
    ]);

    const walked = [...older.comments, ...first.comments].map((c) => c.body);
    expect(new Set(walked).size).toBe(total);
  });

  it('rejects a malformed cursor at the edge (400)', async () => {
    const { aliceAgent, bobAgent, pid } = await scenario();
    await putAudience(aliceAgent, pid, { audience: 'all_friends' });
    expect((await getThread(bobAgent, pid, 'not-a-cursor')).status).toBe(400);
  });

  it('serves the collapsed count + item reactions without any body, under the same audience rule', async () => {
    const { alice, aliceAgent, bobAgent, carolAgent, carol, pid } = await scenario();
    await aliceAgent
      .delete(`/api/v1/social/friends/${carol.id}`)
      .set(...XRW)
      .send();
    await putAudience(aliceAgent, pid, { audience: 'all_friends' });
    await seedComments(pid, alice.id, 3);
    await reactItem(aliceAgent, pid, '🔥');

    const summary = commentThreadSummaryResponseSchema.parse(
      (await getThreadSummary(bobAgent, pid)).body,
    );
    expect(summary.commentCount).toBe(3);
    expect(summary.reactions).toEqual([{ emoji: '🔥', count: 1, reacted: false }]);

    // The excluded viewer gets the same uniform 404 the thread itself gives.
    expect((await getThreadSummary(carolAgent, pid)).status).toBe(404);
  });
});

describe('subject teardown purges the conversation (§13.5 V5-P8)', () => {
  async function commentRowsFor(kind: 'portfolio' | 'watchlist', subjectId: string) {
    return harness.db
      .select()
      .from(schema.itemComments)
      .where(and(eq(schema.itemComments.kind, kind), eq(schema.itemComments.subjectId, subjectId)));
  }

  it('deleting a shared portfolio removes its comments and both kinds of reaction', async () => {
    const { aliceAgent, bobAgent } = await scenario();
    // A second portfolio, so the delete is not the account's last one.
    const created = await aliceAgent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Side pot' });
    expect(created.status).toBe(201);
    const sidePid = created.body.portfolio.id as string;
    await putAudience(aliceAgent, sidePid, { audience: 'all_friends' });

    const posted = await postComment(bobAgent, sidePid, 'my broker is X, account 1234');
    expect(posted.status).toBe(201);
    const commentId = posted.body.id as string;
    expect((await reactItem(bobAgent, sidePid, '🔥')).status).toBe(200);
    expect(
      (
        await aliceAgent
          .post(`/api/v1/social/comments/${commentId}/reactions`)
          .set(...XRW)
          .send({ emoji: '👍' })
      ).status,
    ).toBe(200);

    expect((await aliceAgent.delete(`/api/v1/portfolios/${sidePid}`).set(...XRW)).status).toBe(204);

    expect(await commentRowsFor('portfolio', sidePid)).toHaveLength(0);
    const reactions = await harness.db.select().from(schema.itemReactions);
    expect(reactions).toHaveLength(0);
  });

  it('does the same for a watchlist (the hook is universal, not portfolio-only)', async () => {
    const { aliceAgent, bobAgent } = await scenario();
    const created = await aliceAgent
      .post('/api/v1/workboard/watchlists')
      .set(...XRW)
      .send({ name: 'Ideas' });
    expect(created.status).toBe(201);
    const watchlistId = created.body.id as string;
    const shared = await aliceAgent
      .put(`/api/v1/social/audience/watchlist/${watchlistId}`)
      .set(...XRW)
      .send({ audience: 'all_friends', confirmWiden: true });
    expect(shared.status).toBe(200);

    const posted = await bobAgent
      .post(`/api/v1/social/items/watchlist/${watchlistId}/comments`)
      .set(...XRW)
      .send({ body: 'watching this too' });
    expect(posted.status).toBe(201);
    expect(
      (
        await bobAgent
          .post(`/api/v1/social/items/watchlist/${watchlistId}/reactions`)
          .set(...XRW)
          .send({ emoji: '👍' })
      ).status,
    ).toBe(200);

    expect(
      (await aliceAgent.delete(`/api/v1/workboard/watchlists/${watchlistId}`).set(...XRW)).status,
    ).toBe(204);

    expect(await commentRowsFor('watchlist', watchlistId)).toHaveLength(0);
    expect(await harness.db.select().from(schema.itemReactions)).toHaveLength(0);
  });

  it('lets the author delete a comment orphaned before the purge existed', async () => {
    const { bob, bobAgent } = await scenario();
    // The pre-purge state: a comment whose subject no longer resolves an owner.
    const [orphan] = await harness.db
      .insert(schema.itemComments)
      .values({
        kind: 'portfolio',
        subjectId: '00000000-0000-0000-7000-0000000000ff',
        authorId: bob.id,
        body: 'my broker is X, account 1234',
      })
      .returning();

    const removed = await bobAgent
      .delete(`/api/v1/social/comments/${orphan!.id}`)
      .set(...XRW)
      .send();
    expect(removed.status).toBe(204);

    const [row] = await harness.db
      .select()
      .from(schema.itemComments)
      .where(eq(schema.itemComments.id, orphan!.id));
    expect(row!.deletedAt).not.toBeNull();
  });
});

describe('public links stay read-only (§13.5 V5-P8 regression)', () => {
  it('every comment endpoint rejects an unauthenticated (logged-out) request', async () => {
    const { aliceAgent, pid } = await scenario();
    await putAudience(aliceAgent, pid, { audience: 'public_link', acknowledgePublic: true });
    const anon = request.agent(harness.app);

    // No session → requireUser rejects (401), regardless of the public audience.
    expect((await anon.get(`/api/v1/social/items/portfolio/${pid}/thread`)).status).toBe(401);
    expect(
      (
        await anon
          .post(`/api/v1/social/items/portfolio/${pid}/comments`)
          .set(...XRW)
          .send({ body: 'public?' })
      ).status,
    ).toBe(401);
    expect(
      (
        await anon
          .post(`/api/v1/social/items/portfolio/${pid}/reactions`)
          .set(...XRW)
          .send({ emoji: '🔥' })
      ).status,
    ).toBe(401);
  });
});
