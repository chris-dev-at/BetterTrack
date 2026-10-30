import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REALTIME_CLIENT_EVENTS,
  REALTIME_PATH,
  REALTIME_SERVER_EVENTS,
  type RealtimeChatMessage,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import { waitForSocketAck, waitForSocketEvent } from '../../test/waitFor';

/**
 * Realtime delivery of friend chat over the §4.5 gateway (V3-P8). Proves a sent
 * message reaches the RECIPIENT's `user:{id}` room via the event bus → gateway
 * (and only the recipient's), and that with the gateway absent the chat stays
 * fully functional over HTTP polling.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;
let server: HttpServer | null = null;
let baseUrl = '';
const openSockets: ClientSocket[] = [];

beforeEach(async () => {
  harness = await createTestApp();
});

afterEach(async () => {
  for (const socket of openSockets.splice(0, openSockets.length)) socket.disconnect();
  await harness.ctx.realtime.close();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

type Agent = ReturnType<typeof request.agent>;

async function listenWithGateway(): Promise<void> {
  server = harness.app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  await harness.ctx.realtime.attach(server!);
}

async function login(
  identifier: string,
  password: string,
): Promise<{ agent: Agent; cookie: string }> {
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  const setCookie = res.headers['set-cookie'] as unknown;
  const first = Array.isArray(setCookie) ? (setCookie[0] as string) : (setCookie as string);
  return { agent, cookie: first.split(';')[0]! };
}

function connect(cookie: string): Promise<ClientSocket> {
  const socket = ioClient(baseUrl, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { Origin: harness.ctx.config.topology.webOrigin, cookie },
  });
  openSockets.push(socket);
  return new Promise<ClientSocket>((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

/** A room subject no test joins — the payload of the barrier round-trip below. */
const BARRIER_UUID = '018f6f00-0000-7000-8000-0000000000ba';

/**
 * Arm a "this event must NOT arrive on `socket`" check; `await confirm()`
 * settles it.
 *
 * `confirm()` emits a `room.leave` the gateway always acks and only inspects
 * what landed once that ack is back. Socket.IO writes one connection's packets
 * in order, so a leaked push is provably already delivered by then — an
 * ordering proof where the old fixed 300 ms window was a guess that a loaded
 * machine could falsify (#1622).
 */
function expectSilence(socket: ClientSocket, event: string): () => Promise<void> {
  let leaked: unknown;
  let sawEvent = false;
  const record = (payload: unknown): void => {
    sawEvent = true;
    leaked = payload;
  };
  socket.on(event, record);
  return async () => {
    try {
      await waitForSocketAck(socket, REALTIME_CLIENT_EVENTS.roomLeave, {
        room: { kind: 'asset', id: BARRIER_UUID },
      });
    } finally {
      socket.off(event, record);
    }
    if (sawEvent) {
      throw new Error(`unexpected ${event} received: ${JSON.stringify(leaked)}`);
    }
  };
}

/** Seed two users and make them friends over HTTP; return their agents + ids. */
async function seedFriends() {
  const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
  const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
  const a = await login(alice.email, alice.password);
  const b = await login(bob.email, bob.password);

  await a.agent
    .post('/api/v1/social/requests')
    .set(...XRW)
    .send({ identifier: 'bob' });
  const inbox = await b.agent.get('/api/v1/social/requests');
  const reqId = inbox.body.incoming[0].id as string;
  await b.agent
    .post(`/api/v1/social/requests/${reqId}/accept`)
    .set(...XRW)
    .send();

  return { alice: { ...alice, ...a }, bob: { ...bob, ...b } };
}

describe('realtime chat delivery', () => {
  it('pushes a sent message to the recipient user room — and only the recipient', async () => {
    await listenWithGateway();
    const { alice, bob } = await seedFriends();
    const conversationId = (
      await alice.agent
        .post('/api/v1/chat/conversations')
        .set(...XRW)
        .send({ userId: bob.id })
    ).body.conversation.id as string;

    const bobSocket = await connect(bob.cookie);
    const aliceSocket = await connect(alice.cookie);

    const received = waitForSocketEvent<RealtimeChatMessage>(
      bobSocket,
      REALTIME_SERVER_EVENTS.chatMessage,
    );
    // The sender must NOT receive their own message push (it targets bob's room).
    const senderSilent = expectSilence(aliceSocket, REALTIME_SERVER_EVENTS.chatMessage);

    const sent = await alice.agent
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set(...XRW)
      .send({ body: 'realtime hi' });
    expect(sent.status).toBe(201);

    const payload = await received;
    expect(payload.conversationId).toBe(conversationId);
    expect(payload.messageId).toBe(sent.body.message.id);
    expect(payload.senderId).toBe(alice.id);
    // The push carries NO body/chip — it's an invalidation signal only.
    expect((payload as Record<string, unknown>).body).toBeUndefined();

    await senderSilent();
  });

  it('with the gateway absent, chat stays fully functional over HTTP polling', async () => {
    // Deliberately do NOT attach the gateway — the poll-fallback path.
    const { alice, bob } = await seedFriends();
    const conversationId = (
      await alice.agent
        .post('/api/v1/chat/conversations')
        .set(...XRW)
        .send({ userId: bob.id })
    ).body.conversation.id as string;

    const sent = await alice.agent
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set(...XRW)
      .send({ body: 'poll me' });
    expect(sent.status).toBe(201);

    // Bob "polls" the thread + conversation list over plain HTTP.
    const thread = await bob.agent.get(`/api/v1/chat/conversations/${conversationId}/messages`);
    expect(thread.status).toBe(200);
    expect(thread.body.messages).toHaveLength(1);
    expect(thread.body.messages[0].body).toBe('poll me');

    const list = await bob.agent.get('/api/v1/chat/conversations');
    expect(list.body.unreadTotal).toBe(1);
  });
});
