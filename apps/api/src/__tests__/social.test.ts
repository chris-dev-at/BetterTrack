import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { friendRequestListResponseSchema, friendsListResponseSchema } from '@bettertrack/contracts';

import { createUserRepository } from '../data/repositories/userRepository';
import * as schema from '../data/schema';
import { DECLINE_COOLDOWN_MS } from '../services/social/socialService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

type Agent = ReturnType<typeof request.agent>;

async function seedTwo(h: TestHarness) {
  const alice = await h.seedUser({ email: 'alice@bt.test', username: 'alice' });
  const bob = await h.seedUser({ email: 'bob@bt.test', username: 'bob' });
  const aliceAgent = await loginAgent(h.app, alice.email, alice.password);
  const bobAgent = await loginAgent(h.app, bob.email, bob.password);
  return { alice, bob, aliceAgent, bobAgent };
}

function sendRequest(agent: Agent, identifier: string) {
  return agent
    .post('/api/v1/social/requests')
    .set(...XRW)
    .send({ identifier });
}

async function listRequests(agent: Agent) {
  const res = await agent.get('/api/v1/social/requests');
  expect(res.status).toBe(200);
  const parsed = friendRequestListResponseSchema.safeParse(res.body);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : { incoming: [], outgoing: [] };
}

async function listFriends(agent: Agent) {
  const res = await agent.get('/api/v1/social/friends');
  expect(res.status).toBe(200);
  const parsed = friendsListResponseSchema.safeParse(res.body);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data.friends : [];
}

describe('POST /api/v1/social/requests — no enumeration', () => {
  it('requires authentication', async () => {
    const res = await sendRequest(request.agent(harness.app), 'someone@bt.test');
    expect(res.status).toBe(401);
  });

  it('returns an identical response for a real, missing, and self target', async () => {
    const { alice, aliceAgent } = await seedTwo(harness);

    const real = await sendRequest(aliceAgent, 'bob');
    const missing = await sendRequest(aliceAgent, 'ghost@nowhere.test');
    const self = await sendRequest(aliceAgent, alice.username);

    for (const res of [real, missing, self]) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true });
    }

    // Only the real target produced a visible row; missing + self created nothing.
    const requests = await listRequests(aliceAgent);
    expect(requests.outgoing).toHaveLength(1);
    expect(requests.outgoing[0]?.user.username).toBe('bob');
    expect(requests.incoming).toHaveLength(0);
  });

  it('resolves the target by exact email as well as username', async () => {
    const { bob, aliceAgent } = await seedTwo(harness);
    const res = await sendRequest(aliceAgent, bob.email.toUpperCase());
    expect(res.status).toBe(202);
    const requests = await listRequests(aliceAgent);
    expect(requests.outgoing).toHaveLength(1);
  });

  it('is idempotent when a same-direction pending request already exists', async () => {
    const { aliceAgent } = await seedTwo(harness);
    await sendRequest(aliceAgent, 'bob');
    const second = await sendRequest(aliceAgent, 'bob');
    expect(second.status).toBe(202);
    const requests = await listRequests(aliceAgent);
    expect(requests.outgoing).toHaveLength(1);
  });

  it('does not create a crossing request when the target already asked you', async () => {
    const { aliceAgent, bobAgent } = await seedTwo(harness);
    // Alice → Bob pending.
    await sendRequest(aliceAgent, 'bob');
    // Bob → Alice while Alice's request is pending: graceful no-op.
    const res = await sendRequest(bobAgent, 'alice');
    expect(res.status).toBe(202);

    const bobReqs = await listRequests(bobAgent);
    expect(bobReqs.incoming).toHaveLength(1); // Alice's request to accept
    expect(bobReqs.outgoing).toHaveLength(0); // no crossing request created
  });

  it('is a no-op when the two are already friends', async () => {
    const { aliceAgent, bobAgent } = await seedTwo(harness);
    await sendRequest(aliceAgent, 'bob');
    const { incoming } = await listRequests(bobAgent);
    await bobAgent
      .post(`/api/v1/social/requests/${incoming[0]!.id}/accept`)
      .set(...XRW)
      .send();

    const res = await sendRequest(aliceAgent, 'bob');
    expect(res.status).toBe(202);
    const requests = await listRequests(aliceAgent);
    expect(requests.outgoing).toHaveLength(0);
  });
});

describe('POST /api/v1/social/requests — admin/disabled targets are unrequestable (no enumeration)', () => {
  it('cannot target an admin account — same 202, no outbox row (admin email stays a black hole)', async () => {
    const { aliceAgent } = await seedTwo(harness);
    const admin = await harness.seedAdmin({ email: 'root@bt.test', username: 'root' });

    // Both the admin's email and username resolve to nothing, exactly like a
    // missing account — so a guessed admin address never leaks its username.
    const byEmail = await sendRequest(aliceAgent, admin.email);
    const byUsername = await sendRequest(aliceAgent, admin.username);
    expect(byEmail.status).toBe(202);
    expect(byUsername.status).toBe(202);

    const requests = await listRequests(aliceAgent);
    expect(requests.outgoing).toHaveLength(0);
  });

  it('cannot target a disabled account — same 202, no outbox row', async () => {
    const { aliceAgent } = await seedTwo(harness);
    const disabled = await harness.seedUser({ email: 'ghost@bt.test', username: 'ghost' });
    await createUserRepository(harness.db).setStatus(disabled.id, 'disabled');

    const byEmail = await sendRequest(aliceAgent, disabled.email);
    const byUsername = await sendRequest(aliceAgent, disabled.username);
    expect(byEmail.status).toBe(202);
    expect(byUsername.status).toBe(202);

    const requests = await listRequests(aliceAgent);
    expect(requests.outgoing).toHaveLength(0);
  });
});

describe('POST /api/v1/social/requests — decline cooldown', () => {
  async function declineAliceToBob() {
    const { alice, bob, aliceAgent, bobAgent } = await seedTwo(harness);
    await sendRequest(aliceAgent, 'bob');
    const { incoming } = await listRequests(bobAgent);
    const res = await bobAgent
      .post(`/api/v1/social/requests/${incoming[0]!.id}/decline`)
      .set(...XRW)
      .send();
    expect(res.status).toBe(200);
    return { alice, bob, aliceAgent, bobAgent };
  }

  it('a declined sender cannot immediately re-request (same 202, no new pending row)', async () => {
    const { aliceAgent, bobAgent } = await declineAliceToBob();

    // Re-request right after the decline: uniform 202, but no fresh pending row
    // is created, so the recipient is not re-notified.
    const resend = await sendRequest(aliceAgent, 'bob');
    expect(resend.status).toBe(202);

    expect((await listRequests(aliceAgent)).outgoing).toHaveLength(0);
    expect((await listRequests(bobAgent)).incoming).toHaveLength(0);
  });

  it('re-requesting is allowed again once the cooldown has elapsed', async () => {
    const { bob, aliceAgent, bobAgent } = await declineAliceToBob();

    // Age the declined row past the cooldown window.
    const past = new Date(Date.now() - DECLINE_COOLDOWN_MS - 60_000);
    await harness.db
      .update(schema.friendRequests)
      .set({ respondedAt: past })
      .where(eq(schema.friendRequests.status, 'declined'));

    const resend = await sendRequest(aliceAgent, bob.username);
    expect(resend.status).toBe(202);
    expect((await listRequests(aliceAgent)).outgoing).toHaveLength(1);
    expect((await listRequests(bobAgent)).incoming).toHaveLength(1);
  });
});

describe('GET /api/v1/social/requests', () => {
  it('returns incoming + outgoing pending requests with a public-safe user (no email)', async () => {
    const { aliceAgent, bobAgent } = await seedTwo(harness);
    await sendRequest(aliceAgent, 'bob');

    const aliceReqs = await listRequests(aliceAgent);
    expect(aliceReqs.outgoing).toHaveLength(1);
    expect(aliceReqs.outgoing[0]?.direction).toBe('outgoing');
    expect(aliceReqs.outgoing[0]?.user).toEqual({
      id: expect.any(String),
      username: 'bob',
    });
    // strict schema already rejects an `email` field; assert explicitly too.
    expect(aliceReqs.outgoing[0]?.user).not.toHaveProperty('email');

    const bobReqs = await listRequests(bobAgent);
    expect(bobReqs.incoming).toHaveLength(1);
    expect(bobReqs.incoming[0]?.direction).toBe('incoming');
    expect(bobReqs.incoming[0]?.user.username).toBe('alice');
  });
});

describe('accept / decline / cancel', () => {
  async function pendingRequestId(from: Agent, to: Agent, target: string) {
    await sendRequest(from, target);
    const { incoming } = await listRequests(to);
    return incoming[0]!.id;
  }

  it('accept (by the recipient) forms exactly one friendship visible to both', async () => {
    const { aliceAgent, bobAgent } = await seedTwo(harness);
    const id = await pendingRequestId(aliceAgent, bobAgent, 'bob');

    const res = await bobAgent
      .post(`/api/v1/social/requests/${id}/accept`)
      .set(...XRW)
      .send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const aliceFriends = await listFriends(aliceAgent);
    const bobFriends = await listFriends(bobAgent);
    expect(aliceFriends.map((f) => f.user.username)).toEqual(['bob']);
    expect(bobFriends.map((f) => f.user.username)).toEqual(['alice']);

    // Request no longer pending on either side.
    expect((await listRequests(aliceAgent)).outgoing).toHaveLength(0);
    expect((await listRequests(bobAgent)).incoming).toHaveLength(0);
  });

  it('decline (by the recipient) resolves the request and creates no friendship', async () => {
    const { aliceAgent, bobAgent } = await seedTwo(harness);
    const id = await pendingRequestId(aliceAgent, bobAgent, 'bob');

    const res = await bobAgent
      .post(`/api/v1/social/requests/${id}/decline`)
      .set(...XRW)
      .send();
    expect(res.status).toBe(200);

    expect((await listRequests(bobAgent)).incoming).toHaveLength(0);
    expect(await listFriends(bobAgent)).toHaveLength(0);
    expect(await listFriends(aliceAgent)).toHaveLength(0);
  });

  it('cancel (by the sender) resolves the request and creates no friendship', async () => {
    const { aliceAgent, bobAgent } = await seedTwo(harness);
    await sendRequest(aliceAgent, 'bob');
    const { outgoing } = await listRequests(aliceAgent);

    const res = await aliceAgent
      .post(`/api/v1/social/requests/${outgoing[0]!.id}/cancel`)
      .set(...XRW)
      .send();
    expect(res.status).toBe(200);

    expect((await listRequests(aliceAgent)).outgoing).toHaveLength(0);
    expect((await listRequests(bobAgent)).incoming).toHaveLength(0);
    expect(await listFriends(bobAgent)).toHaveLength(0);
  });

  it('accepting a request not addressed to you is a 404 (never 403)', async () => {
    const { aliceAgent, bobAgent } = await seedTwo(harness);
    await sendRequest(aliceAgent, 'bob');
    const { outgoing } = await listRequests(aliceAgent);
    const id = outgoing[0]!.id;

    // Alice (the sender) may not accept her own outgoing request.
    const res = await aliceAgent
      .post(`/api/v1/social/requests/${id}/accept`)
      .set(...XRW)
      .send();
    expect(res.status).toBe(404);
    expect(await listFriends(bobAgent)).toHaveLength(0);
  });

  it('cancelling a request you did not send is a 404', async () => {
    const { aliceAgent, bobAgent } = await seedTwo(harness);
    const id = await pendingRequestId(aliceAgent, bobAgent, 'bob');
    // Bob (the recipient) may not cancel; that's the sender's action.
    const res = await bobAgent
      .post(`/api/v1/social/requests/${id}/cancel`)
      .set(...XRW)
      .send();
    expect(res.status).toBe(404);
  });

  it('acting on a nonexistent or already-resolved request is a 404', async () => {
    const { aliceAgent, bobAgent } = await seedTwo(harness);
    const id = await pendingRequestId(aliceAgent, bobAgent, 'bob');

    // Nonexistent id.
    const missing = await bobAgent
      .post(`/api/v1/social/requests/${MISSING_ID}/accept`)
      .set(...XRW)
      .send();
    expect(missing.status).toBe(404);

    // Accept once, then a second accept finds nothing pending.
    await bobAgent
      .post(`/api/v1/social/requests/${id}/accept`)
      .set(...XRW)
      .send();
    const again = await bobAgent
      .post(`/api/v1/social/requests/${id}/decline`)
      .set(...XRW)
      .send();
    expect(again.status).toBe(404);
  });
});

describe('DELETE /api/v1/social/friends/:userId', () => {
  async function befriend(h: TestHarness) {
    const ctx = await seedTwo(h);
    await sendRequest(ctx.aliceAgent, 'bob');
    const { incoming } = await listRequests(ctx.bobAgent);
    await ctx.bobAgent
      .post(`/api/v1/social/requests/${incoming[0]!.id}/accept`)
      .set(...XRW)
      .send();
    return ctx;
  }

  it('removes the friendship for both sides and allows a fresh request afterwards', async () => {
    const { alice, bob, aliceAgent, bobAgent } = await befriend(harness);

    // Either side may remove — Bob removes Alice here.
    const res = await bobAgent
      .delete(`/api/v1/social/friends/${alice.id}`)
      .set(...XRW)
      .send();
    expect(res.status).toBe(204);

    expect(await listFriends(aliceAgent)).toHaveLength(0);
    expect(await listFriends(bobAgent)).toHaveLength(0);

    // A fresh request can be sent again (the pending index was freed).
    const resend = await sendRequest(aliceAgent, bob.username);
    expect(resend.status).toBe(202);
    expect((await listRequests(bobAgent)).incoming).toHaveLength(1);
  });

  it('removing a non-friend is a 404', async () => {
    const { alice, bobAgent } = await seedTwo(harness);
    // Bob and Alice are not friends.
    const res = await bobAgent
      .delete(`/api/v1/social/friends/${alice.id}`)
      .set(...XRW)
      .send();
    expect(res.status).toBe(404);
  });
});
