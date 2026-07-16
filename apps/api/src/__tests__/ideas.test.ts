import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createApiKeyResponseSchema,
  ideaListResponseSchema,
  ideaResponseSchema,
  mySharedResponseSchema,
  sharedWithMeResponseSchema,
  type IdeaWorkboardState,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Ideas — saved & shareable Workboard analyses (PROJECTPLAN.md §13.4 V4-P9).
 * Ideas are the FOURTH shareable kind through the ONE audience-enforcement layer:
 * this suite proves the exact-state roundtrip, the shared audience path (set via
 * `PUT /social/audience/idea/:id`, enforced on every read), the My-items and
 * Shared-With-Me groups, the leak-free chat chip, the audience-gated clone, the
 * public follow.published fan-out, and the bearer `workboard:*` scope mapping.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-7000-000000000000';
const ASSET_A = '019756a0-0000-7000-8000-0000000000a1';
const ASSET_B = '019756a0-0000-7000-8000-0000000000a2';

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

/** A fully-specified ad-hoc Workboard state. */
function adhocState(): IdeaWorkboardState {
  return {
    source: {
      kind: 'adhoc',
      positions: [
        { assetId: ASSET_A, weight: 60 },
        { assetId: ASSET_B, weight: 40 },
      ],
    },
    range: '3Y',
    benchmark: { preset: '^GSPC' },
    mode: 'cash',
    rebalance: 'quarterly',
  };
}

async function createIdea(
  agent: Agent,
  body: { name: string; thesis?: string | null; state: IdeaWorkboardState },
): Promise<string> {
  const res = await agent
    .post('/api/v1/ideas')
    .set(...XRW)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ideaResponseSchema.parse(res.body).idea.id;
}

async function createConglomerate(agent: Agent, name: string): Promise<string> {
  const res = await agent
    .post('/api/v1/conglomerates')
    .set(...XRW)
    .send({ name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function putIdeaAudience(
  agent: Agent,
  ideaId: string,
  body: { audience: string; friendIds?: string[]; acknowledgePublic?: boolean },
): Promise<request.Response> {
  return agent
    .put(`/api/v1/social/audience/idea/${ideaId}`)
    .set(...XRW)
    .send(body);
}

describe('POST/GET /ideas — exact-state roundtrip (AC#1)', () => {
  it('persists name + thesis + ad-hoc state and returns it byte-exact', async () => {
    const u = await harness.seedUser({ email: 'u@bt.test', username: 'u' });
    const agent = await loginAgent(harness.app, u.email, u.password);
    const state = adhocState();
    const id = await createIdea(agent, { name: 'My thesis', thesis: 'Tech overweight', state });

    const res = await agent.get(`/api/v1/ideas/${id}`);
    expect(res.status).toBe(200);
    const { idea } = ideaResponseSchema.parse(res.body);
    expect(idea.name).toBe('My thesis');
    expect(idea.thesis).toBe('Tech overweight');
    // Deep equality of the whole saved Workboard state — a reopen reproduces it.
    expect(idea.state).toEqual(state);
  });

  it('persists a conglomerate-ref state and validates ownership', async () => {
    const owner = await harness.seedUser({ email: 'o@bt.test', username: 'owner' });
    const other = await harness.seedUser({ email: 'x@bt.test', username: 'other' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const otherAgent = await loginAgent(harness.app, other.email, other.password);

    const congId = await createConglomerate(ownerAgent, 'My basket');
    const state: IdeaWorkboardState = {
      source: { kind: 'conglomerate', conglomerateId: congId },
      range: 'MAX',
      benchmark: null,
      mode: 'clip',
      rebalance: 'none',
    };
    const id = await createIdea(ownerAgent, { name: 'Basket idea', state });
    const got = ideaResponseSchema.parse((await ownerAgent.get(`/api/v1/ideas/${id}`)).body);
    expect(got.idea.state).toEqual(state);

    // A DIFFERENT user cannot save an idea referencing that conglomerate.
    const foreign = await otherAgent
      .post('/api/v1/ideas')
      .set(...XRW)
      .send({ name: 'nope', state });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe('IDEA_CONGLOMERATE_NOT_FOUND');
  });

  it("a foreign/unknown idea id is a 404 (never another user's data)", async () => {
    const owner = await harness.seedUser({ email: 'o@bt.test', username: 'owner' });
    const other = await harness.seedUser({ email: 'x@bt.test', username: 'other' });
    const ownerAgent = await loginAgent(harness.app, owner.email, owner.password);
    const otherAgent = await loginAgent(harness.app, other.email, other.password);
    const id = await createIdea(ownerAgent, { name: 'Private', state: adhocState() });

    expect((await otherAgent.get(`/api/v1/ideas/${id}`)).status).toBe(404);
    expect((await ownerAgent.get(`/api/v1/ideas/${MISSING_ID}`)).status).toBe(404);
  });

  it('ideas are private by default (no audience row) and updatable/deletable', async () => {
    const u = await harness.seedUser({ email: 'u@bt.test', username: 'u' });
    const agent = await loginAgent(harness.app, u.email, u.password);
    const id = await createIdea(agent, { name: 'v1', thesis: 'first', state: adhocState() });

    const aud = await agent.get(`/api/v1/social/audience/idea/${id}`);
    expect(aud.status).toBe(200);
    expect(aud.body.audience).toBe('private');

    // PATCH name + clear thesis.
    const patched = await agent
      .patch(`/api/v1/ideas/${id}`)
      .set(...XRW)
      .send({ name: 'v2', thesis: null });
    expect(patched.status).toBe(200);
    const { idea } = ideaResponseSchema.parse(patched.body);
    expect(idea.name).toBe('v2');
    expect(idea.thesis).toBeNull();

    expect((await agent.delete(`/api/v1/ideas/${id}`).set(...XRW)).status).toBe(204);
    expect((await agent.get(`/api/v1/ideas/${id}`)).status).toBe(404);
  });
});

describe('idea sharing — audience model + My-items / Shared-With-Me groups (AC#2, AC#3)', () => {
  it('surfaces the ideas group in My items with the correct audience', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, bob.email);

    const id = await createIdea(aliceAgent, {
      name: 'Shared idea',
      thesis: 'x',
      state: adhocState(),
    });

    let mine = mySharedResponseSchema.parse(
      (await aliceAgent.get('/api/v1/social/my-shared')).body,
    );
    expect(mine.ideas).toHaveLength(1);
    expect(mine.ideas[0]).toMatchObject({ ideaId: id, audience: 'private', hasThesis: true });

    // Share with bob specifically; the My-items audience reflects it.
    const put = await putIdeaAudience(aliceAgent, id, {
      audience: 'specific_friends',
      friendIds: [bob.id],
    });
    expect(put.status).toBe(200);
    mine = mySharedResponseSchema.parse((await aliceAgent.get('/api/v1/social/my-shared')).body);
    expect(mine.ideas[0]).toMatchObject({ audience: 'specific_friends', friendCount: 1 });
  });

  it('enforces the audience on Shared-With-Me across private/specific/all', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const carolAgent = await loginAgent(harness.app, carol.email, carol.password);
    await befriend(aliceAgent, bobAgent, bob.email);
    await befriend(aliceAgent, carolAgent, carol.email);

    const id = await createIdea(aliceAgent, { name: 'A', state: adhocState() });

    const bobIdeas = async () =>
      sharedWithMeResponseSchema.parse((await bobAgent.get('/api/v1/social/shared')).body).ideas;
    const carolIdeas = async () =>
      sharedWithMeResponseSchema.parse((await carolAgent.get('/api/v1/social/shared')).body).ideas;

    // private → neither friend sees it.
    expect(await bobIdeas()).toHaveLength(0);
    expect(await carolIdeas()).toHaveLength(0);

    // specific_friends[bob] → only bob.
    expect(
      (await putIdeaAudience(aliceAgent, id, { audience: 'specific_friends', friendIds: [bob.id] }))
        .status,
    ).toBe(200);
    expect((await bobIdeas()).map((i) => i.ideaId)).toEqual([id]);
    expect(await carolIdeas()).toHaveLength(0);

    // all_friends → both.
    expect((await putIdeaAudience(aliceAgent, id, { audience: 'all_friends' })).status).toBe(200);
    expect((await bobIdeas())[0]).toMatchObject({ ideaId: id, owner: { username: 'alice' } });
    expect((await carolIdeas()).map((i) => i.ideaId)).toEqual([id]);

    // back to private → both drop instantly.
    expect((await putIdeaAudience(aliceAgent, id, { audience: 'private' })).status).toBe(200);
    expect(await bobIdeas()).toHaveLength(0);
    expect(await carolIdeas()).toHaveLength(0);
  });
});

describe('idea chat chip — leak-free per-viewer resolution (AC#4)', () => {
  async function openThread(a: Agent, friendUserId: string): Promise<string> {
    const res = await a
      .post('/api/v1/chat/conversations')
      .set(...XRW)
      .send({ userId: friendUserId });
    expect(res.status).toBe(201);
    return res.body.conversation.id as string;
  }

  it('a recipient outside the audience sees no name; sending writes nothing to the model', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, bob.email);

    const id = await createIdea(aliceAgent, { name: 'Secret idea', state: adhocState() });
    const convId = await openThread(aliceAgent, bob.id);

    // Alice (owner) may chip her own private idea; it grants bob nothing.
    const sent = await aliceAgent
      .post(`/api/v1/chat/conversations/${convId}/messages`)
      .set(...XRW)
      .send({ chip: { kind: 'idea', subjectId: id } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    // Sender sees her own chip resolved.
    expect(sent.body.message.chip).toMatchObject({
      kind: 'idea',
      viewable: true,
      title: 'Secret idea',
    });

    // Sending wrote NOTHING to the audience model — the idea is still private.
    const aud = await aliceAgent.get(`/api/v1/social/audience/idea/${id}`);
    expect(aud.body.audience).toBe('private');

    // Bob (outside the audience) sees the chip as not-viewable, no name.
    const thread = await bobAgent.get(`/api/v1/chat/conversations/${convId}/messages`);
    expect(thread.status).toBe(200);
    const chip = thread.body.messages[0].chip;
    expect(chip).toMatchObject({ kind: 'idea', viewable: false, title: null, subtitle: null });

    // Share it with bob → the SAME chip now resolves for him.
    await putIdeaAudience(aliceAgent, id, { audience: 'all_friends' });
    const thread2 = await bobAgent.get(`/api/v1/chat/conversations/${convId}/messages`);
    expect(thread2.body.messages[0].chip).toMatchObject({
      kind: 'idea',
      viewable: true,
      title: 'Secret idea',
      subtitle: 'alice',
    });
  });

  it('a sender cannot chip an idea they do not own', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, bob.email);
    const id = await createIdea(aliceAgent, { name: 'Hers', state: adhocState() });
    // Even if shared, bob may not RE-chip alice's idea (he doesn't own it).
    await putIdeaAudience(aliceAgent, id, { audience: 'all_friends' });
    const convRes = await bobAgent
      .post('/api/v1/chat/conversations')
      .set(...XRW)
      .send({ userId: alice.id });
    const convId = convRes.body.conversation.id as string;
    const res = await bobAgent
      .post(`/api/v1/chat/conversations/${convId}/messages`)
      .set(...XRW)
      .send({ chip: { kind: 'idea', subjectId: id } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHAT_CHIP_NOT_OWNED');
  });
});

describe('idea clone — audience-gated (AC#5)', () => {
  it('an admitted viewer clones into an own private byte-exact copy', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    await befriend(aliceAgent, bobAgent, bob.email);

    const state = adhocState();
    const id = await createIdea(aliceAgent, { name: 'Alpha', thesis: 'note', state });
    await putIdeaAudience(aliceAgent, id, { audience: 'specific_friends', friendIds: [bob.id] });

    const cloned = await bobAgent.post(`/api/v1/ideas/${id}/clone`).set(...XRW);
    expect(cloned.status, JSON.stringify(cloned.body)).toBe(201);
    const clone = ideaResponseSchema.parse(cloned.body).idea;
    expect(clone.id).not.toBe(id);
    expect(clone.name).toBe('Alpha');
    expect(clone.thesis).toBe('note');
    expect(clone.state).toEqual(state);

    // The clone is bob's own, private idea.
    const bobList = ideaListResponseSchema.parse((await bobAgent.get('/api/v1/ideas')).body);
    expect(bobList.ideas.map((i) => i.id)).toContain(clone.id);
    const bobShared = mySharedResponseSchema.parse(
      (await bobAgent.get('/api/v1/social/my-shared')).body,
    );
    expect(bobShared.ideas.find((i) => i.ideaId === clone.id)?.audience).toBe('private');
  });

  it('a non-admitted viewer gets a 404 with no existence leak', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const stranger = await harness.seedUser({ email: 's@bt.test', username: 'stranger' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);
    const strangerAgent = await loginAgent(harness.app, stranger.email, stranger.password);
    await befriend(aliceAgent, bobAgent, bob.email);

    const id = await createIdea(aliceAgent, { name: 'Alpha', state: adhocState() });
    // Private → even a friend cannot clone.
    expect((await bobAgent.post(`/api/v1/ideas/${id}/clone`).set(...XRW)).status).toBe(404);
    // Shared with bob → a non-friend stranger still cannot (404, never 403).
    await putIdeaAudience(aliceAgent, id, { audience: 'specific_friends', friendIds: [bob.id] });
    const strangerRes = await strangerAgent.post(`/api/v1/ideas/${id}/clone`).set(...XRW);
    expect(strangerRes.status).toBe(404);
  });
});

describe('idea → public fires follow.published (AC#6)', () => {
  async function notifs(userId: string, type: string) {
    const rows = await harness.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
    return rows.filter((r) => !r.hidden && r.type === type);
  }

  it('a follower is notified exactly once when an idea flips to public', async () => {
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);

    // Alice enables her public profile (the follow.published reachability gate);
    // bob follows her.
    await aliceAgent
      .put('/api/v1/social/profile')
      .set(...XRW)
      .send({ isPublic: true, acknowledgePublic: true });
    expect(
      (
        await bobAgent
          .post('/api/v1/social/follows')
          .set(...XRW)
          .send({ userId: alice.id })
      ).status,
    ).toBe(202);

    const id = await createIdea(aliceAgent, { name: 'Public thesis', state: adhocState() });
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(0);

    const put = await putIdeaAudience(aliceAgent, id, {
      audience: 'public_link',
      acknowledgePublic: true,
    });
    expect(put.status).toBe(200);
    const news = await notifs(bob.id, 'follow.published');
    expect(news).toHaveLength(1);
    // Re-saving public → public notifies nobody again (anti-noise).
    await putIdeaAudience(aliceAgent, id, { audience: 'public_link', acknowledgePublic: true });
    expect(await notifs(bob.id, 'follow.published')).toHaveLength(1);
  });
});

describe('bearer scope — /ideas maps to workboard:* (AC#7)', () => {
  async function mintKey(scopes: string[]): Promise<{ token: string; email: string }> {
    const suffix = scopes.join('-').replace(/[^a-z]/g, '');
    const u = await harness.seedUser({ email: `k-${suffix}@bt.test`, username: `k${suffix}` });
    const agent = await loginAgent(harness.app, u.email, u.password);
    const res = await agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'mobile', scopes });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { token: createApiKeyResponseSchema.parse(res.body).token, email: u.email };
  }

  it('a token with workboard:read lists ideas; without it → 403 INSUFFICIENT_SCOPE', async () => {
    const withScope = await mintKey(['workboard:read']);
    const ok = await request(harness.app)
      .get('/api/v1/ideas')
      .set('Authorization', `Bearer ${withScope.token}`);
    expect(ok.status).toBe(200);
    expect(ideaListResponseSchema.parse(ok.body).ideas).toEqual([]);

    const without = await mintKey(['portfolio:read']);
    const denied = await request(harness.app)
      .get('/api/v1/ideas')
      .set('Authorization', `Bearer ${without.token}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('creating an idea needs workboard:write', async () => {
    const readOnly = await mintKey(['workboard:read']);
    const denied = await request(harness.app)
      .post('/api/v1/ideas')
      .set('Authorization', `Bearer ${readOnly.token}`)
      .send({ name: 'x', state: adhocState() });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');

    const writer = await mintKey(['workboard:write']);
    const ok = await request(harness.app)
      .post('/api/v1/ideas')
      .set('Authorization', `Bearer ${writer.token}`)
      .send({ name: 'x', state: adhocState() });
    expect(ok.status).toBe(201);
  });
});
