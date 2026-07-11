import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  chatConversationListResponseSchema,
  chatThreadResponseSchema,
  conversationResponseSchema,
  sendChatMessageResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Friend chat (PROJECTPLAN.md §13.3 V3-P8). The privacy contract is the point:
 * friends-only conversations, a participant gate that never leaks a stranger's
 * thread, unfriending that closes the thread to new messages, per-viewer chip
 * enforcement through the #332 audience layer (no leak, no widening), and a
 * muted `chat.message` that silences the bell while the message still lands.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

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

interface Person {
  id: string;
  email: string;
  username: string;
  password: string;
  agent: Agent;
}

async function seedPerson(username: string): Promise<Person> {
  const seeded = await harness.seedUser({ email: `${username}@bt.test`, username });
  const agent = await loginAgent(harness.app, seeded.email, seeded.password);
  return { ...seeded, agent };
}

/** Form a friendship: `a` requests `b`, `b` accepts. */
async function befriend(a: Person, b: Person): Promise<void> {
  const sent = await a.agent
    .post('/api/v1/social/requests')
    .set(...XRW)
    .send({ identifier: b.username });
  expect(sent.status).toBe(202);
  const inbox = await b.agent.get('/api/v1/social/requests');
  const req = inbox.body.incoming.find((r: { user: { id: string } }) => r.user.id === a.id);
  const accepted = await b.agent
    .post(`/api/v1/social/requests/${req.id}/accept`)
    .set(...XRW)
    .send();
  expect(accepted.status).toBe(200);
}

async function openConversation(agent: Agent, userId: string): Promise<request.Response> {
  return agent
    .post('/api/v1/chat/conversations')
    .set(...XRW)
    .send({ userId });
}

async function sendMessage(
  agent: Agent,
  conversationId: string,
  body: { body?: string; chip?: { kind: string; subjectId: string } },
): Promise<request.Response> {
  return agent
    .post(`/api/v1/chat/conversations/${conversationId}/messages`)
    .set(...XRW)
    .send(body);
}

function getThread(agent: Agent, conversationId: string, query = ''): Promise<request.Response> {
  return agent.get(`/api/v1/chat/conversations/${conversationId}/messages${query}`);
}

async function markRead(agent: Agent, conversationId: string): Promise<request.Response> {
  return agent
    .post(`/api/v1/chat/conversations/${conversationId}/read`)
    .set(...XRW)
    .send();
}

async function listConversations(agent: Agent) {
  const res = await agent.get('/api/v1/chat/conversations');
  expect(res.status).toBe(200);
  expect(chatConversationListResponseSchema.safeParse(res.body).success).toBe(true);
  return res.body as {
    conversations: {
      id: string;
      user: { id: string; username: string };
      unreadCount: number;
    }[];
    unreadTotal: number;
  };
}

async function seedGlobalAsset(overrides: Partial<typeof schema.assets.$inferInsert> = {}) {
  const [row] = await harness.db
    .insert(schema.assets)
    .values({
      providerId: 'yahoo',
      providerRef: overrides.providerRef ?? 'AAPL',
      type: 'stock',
      symbol: overrides.symbol ?? 'AAPL',
      name: overrides.name ?? 'Apple Inc.',
      currency: 'USD',
      exchange: 'NASDAQ',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('seed asset failed');
  return row;
}

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  return res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault).id as string;
}

function putAudience(
  agent: Agent,
  kind: string,
  subjectId: string,
  body: { audience: string; friendIds?: string[] },
): Promise<request.Response> {
  return agent
    .put(`/api/v1/social/audience/${kind}/${subjectId}`)
    .set(...XRW)
    .send(body);
}

// ── Auth + friends-only ──────────────────────────────────────────────────────

describe('chat — auth + friends-only', () => {
  it('requires a session', async () => {
    const res = await request(harness.app).get('/api/v1/chat/conversations');
    expect(res.status).toBe(401);
  });

  it('opening a conversation with a non-friend 404s (never data)', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');

    const res = await openConversation(alice.agent, bob.id);
    expect(res.status).toBe(404);
  });

  it('opening a conversation with yourself 404s', async () => {
    const alice = await seedPerson('alice');
    const res = await openConversation(alice.agent, alice.id);
    expect(res.status).toBe(404);
  });

  it('friends can open exactly one conversation per pair (unique, order-independent)', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    await befriend(alice, bob);

    const fromAlice = await openConversation(alice.agent, bob.id);
    expect(fromAlice.status).toBe(201);
    expect(conversationResponseSchema.safeParse(fromAlice.body).success).toBe(true);
    expect(fromAlice.body.conversation.user.id).toBe(bob.id);

    const fromBob = await openConversation(bob.agent, alice.id);
    expect(fromBob.status).toBe(201);
    // Same underlying conversation regardless of who opened it.
    expect(fromBob.body.conversation.id).toBe(fromAlice.body.conversation.id);
    // Each side sees the OTHER participant.
    expect(fromBob.body.conversation.user.id).toBe(alice.id);
  });
});

// ── Send / thread / unread ───────────────────────────────────────────────────

describe('chat — messaging, unread, mark-read', () => {
  it('delivers a message into the recipient thread and tracks per-user unread across reload', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    await befriend(alice, bob);
    const { body: opened } = await openConversation(alice.agent, bob.id);
    const conversationId = opened.conversation.id as string;

    const sent = await sendMessage(alice.agent, conversationId, { body: 'hey bob' });
    expect(sent.status).toBe(201);
    expect(sendChatMessageResponseSchema.safeParse(sent.body).success).toBe(true);

    // Bob sees it in the thread…
    const thread = await getThread(bob.agent, conversationId);
    expect(thread.status).toBe(200);
    expect(chatThreadResponseSchema.safeParse(thread.body).success).toBe(true);
    expect(thread.body.messages).toHaveLength(1);
    expect(thread.body.messages[0].body).toBe('hey bob');
    expect(thread.body.messages[0].senderId).toBe(alice.id);

    // …and it's unread for Bob but not for Alice (her own message).
    const bobList = await listConversations(bob.agent);
    expect(bobList.unreadTotal).toBe(1);
    expect(bobList.conversations[0]!.unreadCount).toBe(1);
    const aliceList = await listConversations(alice.agent);
    expect(aliceList.unreadTotal).toBe(0);

    // Unread survives a reload — recomputed from persisted state.
    const bobReload = await listConversations(bob.agent);
    expect(bobReload.conversations[0]!.unreadCount).toBe(1);

    // Marking read clears the badge (idempotent).
    expect((await markRead(bob.agent, conversationId)).status).toBe(200);
    const cleared = await listConversations(bob.agent);
    expect(cleared.unreadTotal).toBe(0);
  });

  it('rejects an empty message', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    await befriend(alice, bob);
    const { body } = await openConversation(alice.agent, bob.id);
    const res = await sendMessage(alice.agent, body.conversation.id, {});
    expect(res.status).toBe(400);
  });

  it('paginates thread history newest-first', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    await befriend(alice, bob);
    const { body } = await openConversation(alice.agent, bob.id);
    const conversationId = body.conversation.id as string;
    for (let i = 0; i < 5; i += 1) {
      await sendMessage(alice.agent, conversationId, { body: `m${i}` });
    }
    const page1 = await getThread(alice.agent, conversationId, '?limit=2');
    expect(page1.body.messages).toHaveLength(2);
    expect(page1.body.messages[0].body).toBe('m4'); // newest first
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await getThread(
      alice.agent,
      conversationId,
      `?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.messages[0].body).toBe('m2');
  });
});

// ── Participant gate + unfriending ───────────────────────────────────────────

describe('chat — participant gate + unfriending', () => {
  it('a non-participant gets 404 for the thread and cannot send (never data)', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    const carol = await seedPerson('carol');
    await befriend(alice, bob);
    const { body } = await openConversation(alice.agent, bob.id);
    const conversationId = body.conversation.id as string;
    await sendMessage(alice.agent, conversationId, { body: 'private chat' });

    expect((await getThread(carol.agent, conversationId)).status).toBe(404);
    expect((await sendMessage(carol.agent, conversationId, { body: 'sneak' })).status).toBe(404);
    expect((await markRead(carol.agent, conversationId)).status).toBe(404);
  });

  it('an unknown conversation id 404s', async () => {
    const alice = await seedPerson('alice');
    expect((await getThread(alice.agent, MISSING_ID)).status).toBe(404);
  });

  it('unfriending closes the thread to new messages but leaves history readable', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    await befriend(alice, bob);
    const { body } = await openConversation(alice.agent, bob.id);
    const conversationId = body.conversation.id as string;
    await sendMessage(alice.agent, conversationId, { body: 'still friends' });

    // Alice unfriends Bob.
    const removed = await bob.agent.delete(`/api/v1/social/friends/${alice.id}`).set(...XRW);
    expect(removed.status).toBe(204);

    // Sending is now refused (403 — thread closed to new messages)…
    const blocked = await sendMessage(alice.agent, conversationId, { body: 'you there?' });
    expect(blocked.status).toBe(403);

    // …but the existing history is still readable by a participant.
    const thread = await getThread(bob.agent, conversationId);
    expect(thread.status).toBe(200);
    expect(thread.body.messages).toHaveLength(1);
  });
});

// ── Share-in-chat chips: enforcement, no leak, no widening ────────────────────

describe('chat — share-in-chat chip enforcement (reuses #332)', () => {
  it('a chip for a private portfolio shows the recipient a "not shared" state and leaks no data; sending never widens access', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    await befriend(alice, bob);
    const { body } = await openConversation(alice.agent, bob.id);
    const conversationId = body.conversation.id as string;
    const alicePortfolio = await defaultPortfolioId(alice.agent);

    // Bob cannot read Alice's private portfolio BEFORE the chip.
    expect((await bob.agent.get(`/api/v1/social/shared/${alicePortfolio}`)).status).toBe(404);

    const sent = await sendMessage(alice.agent, conversationId, {
      chip: { kind: 'portfolio', subjectId: alicePortfolio },
    });
    expect(sent.status).toBe(201);
    // The SENDER sees their own chip resolved (owner view).
    expect(sent.body.message.chip.viewable).toBe(true);
    expect(sent.body.message.chip.title).not.toBeNull();

    // The RECIPIENT sees a "not shared with you" chip — no title, no data.
    const thread = await getThread(bob.agent, conversationId);
    const chip = thread.body.messages[0].chip;
    expect(chip.kind).toBe('portfolio');
    expect(chip.viewable).toBe(false);
    expect(chip.title).toBeNull();
    expect(chip.subtitle).toBeNull();

    // Sending the chip did NOT widen access — Bob still 404s on the shared read.
    expect((await bob.agent.get(`/api/v1/social/shared/${alicePortfolio}`)).status).toBe(404);
  });

  it('a chip for an item shared with the recipient resolves to the item identity', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    await befriend(alice, bob);
    const { body } = await openConversation(alice.agent, bob.id);
    const conversationId = body.conversation.id as string;
    const alicePortfolio = await defaultPortfolioId(alice.agent);

    // Alice shares the portfolio with all friends.
    expect(
      (await putAudience(alice.agent, 'portfolio', alicePortfolio, { audience: 'all_friends' }))
        .status,
    ).toBe(200);

    await sendMessage(alice.agent, conversationId, {
      chip: { kind: 'portfolio', subjectId: alicePortfolio },
    });

    const thread = await getThread(bob.agent, conversationId);
    const chip = thread.body.messages[0].chip;
    expect(chip.viewable).toBe(true);
    expect(chip.title).not.toBeNull();
    expect(chip.subtitle).toBe('alice'); // owner username
    // And Bob really can read it now (consistent with the chip).
    expect((await bob.agent.get(`/api/v1/social/shared/${alicePortfolio}`)).status).toBe(200);
  });

  it('a chip for a portfolio the owner later hard-deletes resolves to the not-available state', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    await befriend(alice, bob);
    const { body } = await openConversation(alice.agent, bob.id);
    const conversationId = body.conversation.id as string;

    // A second portfolio, so hard-deleting it is not blocked as the last active one.
    await defaultPortfolioId(alice.agent);
    const created = await alice.agent
      .post('/api/v1/portfolios')
      .set(...XRW)
      .send({ name: 'Trading' });
    expect(created.status).toBe(201);
    const tradingPid = created.body.portfolio.id as string;

    // Alice shares it with all friends and chips it to Bob; Bob sees it resolved.
    expect(
      (await putAudience(alice.agent, 'portfolio', tradingPid, { audience: 'all_friends' })).status,
    ).toBe(200);
    await sendMessage(alice.agent, conversationId, {
      chip: { kind: 'portfolio', subjectId: tradingPid },
    });
    const before = await getThread(bob.agent, conversationId);
    expect(before.body.messages[0].chip.viewable).toBe(true);
    expect(before.body.messages[0].chip.title).not.toBeNull();

    // Alice permanently deletes the portfolio (she still has Main).
    expect((await alice.agent.delete(`/api/v1/portfolios/${tradingPid}`).set(...XRW)).status).toBe(
      204,
    );

    // The chat share-chip now resolves gracefully to the not-available state —
    // the #349/#332 bare-ref design: the enforcement joins exclude the vanished
    // subject, so the chip renders as unavailable rather than erroring.
    const after = await getThread(bob.agent, conversationId);
    const chip = after.body.messages[0].chip;
    expect(chip.kind).toBe('portfolio');
    expect(chip.subjectId).toBe(tradingPid);
    expect(chip.viewable).toBe(false);
    expect(chip.title).toBeNull();
    expect(chip.subtitle).toBeNull();
  });

  it('an asset chip (global market data) is viewable by the recipient', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    await befriend(alice, bob);
    const { body } = await openConversation(alice.agent, bob.id);
    const conversationId = body.conversation.id as string;
    const asset = await seedGlobalAsset();

    await sendMessage(alice.agent, conversationId, {
      chip: { kind: 'asset', subjectId: asset.id },
    });
    const thread = await getThread(bob.agent, conversationId);
    const chip = thread.body.messages[0].chip;
    expect(chip.viewable).toBe(true);
    expect(chip.title).toBe('AAPL');
  });

  it('a sender cannot chip an item they do not own', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    await befriend(alice, bob);
    const { body } = await openConversation(alice.agent, bob.id);
    const conversationId = body.conversation.id as string;
    // Bob's portfolio id — Alice must not be able to attach it.
    const bobPortfolio = await defaultPortfolioId(bob.agent);

    const res = await sendMessage(alice.agent, conversationId, {
      chip: { kind: 'portfolio', subjectId: bobPortfolio },
    });
    expect(res.status).toBe(400);
  });
});

// ── Notification matrix wiring (muted vs delivered) ──────────────────────────

describe('chat — chat.message notification matrix', () => {
  it('delivers a bell notification by default, but a muted chat.message row stays silent while the message still arrives', async () => {
    const alice = await seedPerson('alice');
    const bob = await seedPerson('bob');
    const carol = await seedPerson('carol');
    await befriend(alice, bob);
    await befriend(alice, carol);

    // Bob mutes chat.message on every channel; Carol keeps the default (on).
    const muted = await bob.agent
      .patch('/api/v1/settings/notifications')
      .set(...XRW)
      .send({
        matrix: { 'chat.message': { inapp: false, email: false, push: false, webpush: false } },
      });
    expect(muted.status).toBe(200);

    const dispatcher = harness.ctx.notificationDispatcher;

    // Alice → Bob (muted).
    const bobConv = (await openConversation(alice.agent, bob.id)).body.conversation.id as string;
    const toBob = await sendMessage(alice.agent, bobConv, { body: 'ping bob' });
    await dispatcher.dispatch({
      type: 'chat.message',
      userId: bob.id,
      senderId: alice.id,
      senderUsername: 'alice',
      conversationId: bobConv,
      messageId: toBob.body.message.id,
      bodyPreview: 'ping bob',
      hasChip: false,
      occurredAt: new Date().toISOString(),
    });

    // Alice → Carol (default: delivered).
    const carolConv = (await openConversation(alice.agent, carol.id)).body.conversation
      .id as string;
    const toCarol = await sendMessage(alice.agent, carolConv, { body: 'ping carol' });
    await dispatcher.dispatch({
      type: 'chat.message',
      userId: carol.id,
      senderId: alice.id,
      senderUsername: 'alice',
      conversationId: carolConv,
      messageId: toCarol.body.message.id,
      bodyPreview: 'ping carol',
      hasChip: false,
      occurredAt: new Date().toISOString(),
    });

    // Muted → NO bell notification for Bob…
    const bobNotifs = await bob.agent.get('/api/v1/notifications');
    expect(
      bobNotifs.body.items.filter((n: { type: string }) => n.type === 'chat.message'),
    ).toHaveLength(0);
    // …but the message still arrived in Bob's thread.
    const bobThread = await getThread(bob.agent, bobConv);
    expect(bobThread.body.messages).toHaveLength(1);
    expect(bobThread.body.messages[0].body).toBe('ping bob');

    // Default → Carol got the bell notification.
    const carolNotifs = await carol.agent.get('/api/v1/notifications');
    const carolChat = carolNotifs.body.items.filter(
      (n: { type: string }) => n.type === 'chat.message',
    );
    expect(carolChat).toHaveLength(1);
  });
});
