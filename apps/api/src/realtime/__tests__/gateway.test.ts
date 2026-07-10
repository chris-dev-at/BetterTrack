import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REALTIME_CLIENT_EVENTS,
  REALTIME_PATH,
  REALTIME_SERVER_EVENTS,
  type ApiKeyScope,
  type RealtimeNotificationNew,
  type RealtimeQuoteUpdated,
  type RealtimeRoomAck,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../../testing/createTestApp';

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

/** Bind the app to an ephemeral port and attach the gateway (as server.ts does). */
async function listenWithGateway(): Promise<void> {
  server = harness.app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  await harness.ctx.realtime.attach(server!);
}

type Agent = ReturnType<typeof request.agent>;

/** Log in over HTTP; returns an agent (cookie jar) + the raw session cookie pair. */
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

/** Open a socket; resolves on connect, rejects with the connect_error message. */
function connect(cookie?: string): Promise<ClientSocket> {
  const socket = ioClient(baseUrl, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: cookie ? { cookie } : {},
  });
  openSockets.push(socket);
  return new Promise<ClientSocket>((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

/**
 * Open a socket over the websocket transport with arbitrary handshake auth — a
 * bearer via the socket.io auth payload (`auth.token`) and/or an
 * `Authorization: Bearer …` upgrade header — the way the cookieless mobile app
 * connects. Resolves on connect, rejects with the connect_error message.
 */
function connectWith(opts: {
  auth?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}): Promise<ClientSocket> {
  const socket = ioClient(baseUrl, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    reconnection: false,
    auth: opts.auth,
    extraHeaders: opts.extraHeaders ?? {},
  });
  openSockets.push(socket);
  return new Promise<ClientSocket>((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

/** Mint a personal API key (bearer token) for a user — the mobile credential. */
async function mintKey(userId: string, scopes: ApiKeyScope[] = ['chat:read']): Promise<string> {
  const { token } = await harness.ctx.apiKeys.create({ userId, name: 'mobile', scopes });
  return token;
}

/** Resolve with the next `event` payload, or reject after `ms`. */
function waitForEvent<T>(socket: ClientSocket, event: string, ms = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Assert `event` does NOT arrive on `socket` within `ms`. */
function expectSilence(socket: ClientSocket, event: string, ms = 300): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    socket.once(event, () => {
      clearTimeout(timer);
      reject(new Error(`unexpected ${event} received`));
    });
  });
}

/** Emit `room.join` / `room.leave` and await the ack. */
function emitRoom(socket: ClientSocket, event: string, payload: unknown): Promise<RealtimeRoomAck> {
  return new Promise<RealtimeRoomAck>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event} ack`)), 3000);
    socket.emit(event, payload, (ack: RealtimeRoomAck) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

const joinRoom = (socket: ClientSocket, kind: string, id: string) =>
  emitRoom(socket, REALTIME_CLIENT_EVENTS.roomJoin, { room: { kind, id } });

async function defaultPortfolioId(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/portfolios');
  expect(res.status).toBe(200);
  const def = res.body.portfolios.find((p: { isDefault: boolean }) => p.isDefault) as {
    id: string;
  };
  return def.id;
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

const SOME_UUID = '018f6f00-0000-7000-8000-000000000001';

describe('realtime gateway — handshake auth (§4.5)', () => {
  it('rejects an unauthenticated handshake (no cookie)', async () => {
    await listenWithGateway();
    await expect(connect()).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('rejects an invalid/garbage session cookie', async () => {
    await listenWithGateway();
    await expect(connect('bt_sid=s%3Aforged.signature')).rejects.toThrow(/UNAUTHORIZED/);
    await expect(connect('bt_sid=not-even-signed')).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('rejects a logged-out (revoked) session', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const { agent, cookie } = await login(user.email, user.password);
    await agent
      .post('/api/v1/auth/logout')
      .set(...XRW)
      .send();
    await expect(connect(cookie)).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('rejects an admin-kind session — the gateway is a user-app surface (§3)', async () => {
    await listenWithGateway();
    const admin = await harness.seedAdmin();
    const { cookie } = await login(admin.email, admin.password);
    await expect(connect(cookie)).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('accepts a valid user session', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const { cookie } = await login(user.email, user.password);
    const socket = await connect(cookie);
    expect(socket.connected).toBe(true);
  });
});

describe('realtime gateway — bearer handshake auth (mobile, §6.13/§14)', () => {
  it('accepts a bearer via the socket.io auth payload and joins only its own user room', async () => {
    await listenWithGateway();
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    // No cookie — the mobile credential is the bearer alone.
    const aliceSocket = await connectWith({ auth: { token: await mintKey(alice.id) } });
    const bobSocket = await connectWith({ auth: { token: await mintKey(bob.id) } });
    expect(aliceSocket.connected).toBe(true);

    // A push addressed to alice reaches alice's BEARER socket and never bob's —
    // proving the bearer socket auto-joined `user:{alice}` exactly like a cookie
    // socket, and only its own room.
    const received = waitForEvent<RealtimeNotificationNew>(
      aliceSocket,
      REALTIME_SERVER_EVENTS.notificationNew,
    );
    const silence = expectSilence(bobSocket, REALTIME_SERVER_EVENTS.notificationNew);
    await harness.ctx.events.publish({
      type: 'notification.created',
      userId: alice.id,
      notificationId: SOME_UUID,
      occurredAt: new Date().toISOString(),
    });
    expect(await received).toEqual({ notificationId: SOME_UUID, occurredAt: expect.any(String) });
    await silence;
  });

  it('accepts a bearer via the Authorization: Bearer upgrade header', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const token = await mintKey(user.id);
    const socket = await connectWith({ extraHeaders: { Authorization: `Bearer ${token}` } });
    expect(socket.connected).toBe(true);
  });

  it('connects over the websocket transport directly (no polling handshake)', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const socket = await connectWith({ auth: { token: await mintKey(user.id) } });
    // The client dialled transports:['websocket'] — a direct websocket first-
    // connect with no polling handshake. Confirm the negotiated transport is ws.
    expect(socket.io.engine.transport.name).toBe('websocket');
    expect(socket.connected).toBe(true);
  });

  it('rejects an unknown / malformed bearer token', async () => {
    await listenWithGateway();
    await expect(connectWith({ auth: { token: 'btk_not-a-real-key' } })).rejects.toThrow(
      /UNAUTHORIZED/,
    );
    await expect(
      connectWith({ extraHeaders: { Authorization: 'Bearer garbage' } }),
    ).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('rejects a revoked bearer token (same revocation path as HTTP bearer auth)', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const { key, token } = await harness.ctx.apiKeys.create({
      userId: user.id,
      name: 'mobile',
      scopes: ['chat:read'],
    });
    await harness.ctx.apiKeys.revoke({ userId: user.id, id: key.id });
    await expect(connectWith({ auth: { token } })).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('rejects a bearer for an admin-kind account — the gateway is a user-app surface (§3)', async () => {
    await listenWithGateway();
    const admin = await harness.seedAdmin();
    const token = await mintKey(admin.id);
    await expect(connectWith({ auth: { token } })).rejects.toThrow(/UNAUTHORIZED/);
  });
});

describe('realtime gateway — rooms (§4.5)', () => {
  it("a client is only in its OWN user room: 'user' is not a joinable kind and pushes stay per-recipient", async () => {
    await listenWithGateway();
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceSocket = await connect((await login(alice.email, alice.password)).cookie);
    const bobSocket = await connect((await login(bob.email, bob.password)).cookie);

    // Requesting admission to a user room is rejected outright (schema-level).
    const ack = await joinRoom(aliceSocket, 'user', bob.id);
    expect(ack).toEqual({ ok: false, error: 'BAD_REQUEST' });

    // A push addressed to bob reaches bob's socket and never alice's.
    const received = waitForEvent<RealtimeNotificationNew>(
      bobSocket,
      REALTIME_SERVER_EVENTS.notificationNew,
    );
    const silence = expectSilence(aliceSocket, REALTIME_SERVER_EVENTS.notificationNew);
    await harness.ctx.events.publish({
      type: 'notification.created',
      userId: bob.id,
      notificationId: SOME_UUID,
      occurredAt: new Date().toISOString(),
    });
    expect(await received).toEqual({ notificationId: SOME_UUID, occurredAt: expect.any(String) });
    await silence;
  });

  it('quote updates push to asset:{id} subscribers only', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const other = await harness.seedUser({ email: 'other@bt.test', username: 'other' });
    const subscriber = await connect((await login(user.email, user.password)).cookie);
    const bystander = await connect((await login(other.email, other.password)).cookie);

    const assetId = SOME_UUID;
    expect(await joinRoom(subscriber, 'asset', assetId)).toEqual({ ok: true });

    const received = waitForEvent<RealtimeQuoteUpdated>(
      subscriber,
      REALTIME_SERVER_EVENTS.quoteUpdated,
    );
    const silence = expectSilence(bystander, REALTIME_SERVER_EVENTS.quoteUpdated);
    await harness.ctx.events.publish({
      type: 'quote.updated',
      assetId,
      occurredAt: new Date().toISOString(),
    });
    expect(await received).toEqual({ assetId, occurredAt: expect.any(String) });
    await silence;

    // room.leave stops the stream.
    expect(
      await emitRoom(subscriber, REALTIME_CLIENT_EVENTS.roomLeave, {
        room: { kind: 'asset', id: assetId },
      }),
    ).toEqual({ ok: true });
    const silentAfterLeave = expectSilence(subscriber, REALTIME_SERVER_EVENTS.quoteUpdated);
    await harness.ctx.events.publish({
      type: 'quote.updated',
      assetId,
      occurredAt: new Date().toISOString(),
    });
    await silentAfterLeave;
  });

  it('portfolio:{id} joins enforce owner-or-shared access (§6.9)', async () => {
    await listenWithGateway();
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const carol = await harness.seedUser({ email: 'carol@bt.test', username: 'carol' });
    const aliceLogin = await login(alice.email, alice.password);
    const bobLogin = await login(bob.email, bob.password);
    const carolLogin = await login(carol.email, carol.password);

    const portfolioId = await defaultPortfolioId(aliceLogin.agent);

    // Owner: always admitted.
    const aliceSocket = await connect(aliceLogin.cookie);
    expect(await joinRoom(aliceSocket, 'portfolio', portfolioId)).toEqual({ ok: true });

    // A friend while the portfolio is still private: rejected.
    await befriend(bobLogin.agent, aliceLogin.agent, 'alice');
    const bobSocket = await connect(bobLogin.cookie);
    expect(await joinRoom(bobSocket, 'portfolio', portfolioId)).toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });

    // Owner shares with friends: the friend is admitted, a stranger never is.
    await aliceLogin.agent
      .patch(`/api/v1/portfolios/${portfolioId}`)
      .set(...XRW)
      .send({ visibility: 'friends' })
      .expect(200);
    expect(await joinRoom(bobSocket, 'portfolio', portfolioId)).toEqual({ ok: true });

    const carolSocket = await connect(carolLogin.cookie);
    expect(await joinRoom(carolSocket, 'portfolio', portfolioId)).toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });

    // portfolio.changed fans out to the owner's user room AND admitted viewers,
    // but not to the stranger.
    const ownerGot = waitForEvent(aliceSocket, REALTIME_SERVER_EVENTS.portfolioChanged);
    const friendGot = waitForEvent(bobSocket, REALTIME_SERVER_EVENTS.portfolioChanged);
    const strangerSilent = expectSilence(carolSocket, REALTIME_SERVER_EVENTS.portfolioChanged);
    await harness.ctx.events.publish({
      type: 'portfolio.changed',
      userId: alice.id,
      portfolioId,
      occurredAt: new Date().toISOString(),
    });
    expect(await ownerGot).toEqual({ portfolioId, occurredAt: expect.any(String) });
    expect(await friendGot).toEqual({ portfolioId, occurredAt: expect.any(String) });
    await strangerSilent;
  });

  it('rejects malformed room frames without crashing the socket', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const socket = await connect((await login(user.email, user.password)).cookie);

    expect(await emitRoom(socket, REALTIME_CLIENT_EVENTS.roomJoin, { room: null })).toEqual({
      ok: false,
      error: 'BAD_REQUEST',
    });
    expect(
      await emitRoom(socket, REALTIME_CLIENT_EVENTS.roomJoin, {
        room: { kind: 'asset', id: 'not-a-uuid' },
      }),
    ).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(socket.connected).toBe(true);
  });
});

describe('realtime gateway — bell push end-to-end (§4.5 "done when")', () => {
  it('a friend request pops the recipient socket without any refetch', async () => {
    await listenWithGateway();
    // The dispatcher is the producer of notification.created — under test the
    // center delivers through it synchronously (#368), nothing to start.

    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceLogin = await login(alice.email, alice.password);
    const bobLogin = await login(bob.email, bob.password);

    // Two authenticated socket clients: A (actor) and B (recipient).
    const aliceSocket = await connect(aliceLogin.cookie);
    const bobSocket = await connect(bobLogin.cookie);

    const bellPush = waitForEvent<RealtimeNotificationNew>(
      bobSocket,
      REALTIME_SERVER_EVENTS.notificationNew,
    );
    const aliceSilent = expectSilence(aliceSocket, REALTIME_SERVER_EVENTS.notificationNew, 500);

    // Alice sends bob a friend request over plain HTTP — no socket involvement.
    await aliceLogin.agent
      .post('/api/v1/social/requests')
      .set(...XRW)
      .send({ identifier: 'bob' })
      .expect(202);

    // Bob's socket receives the push, carrying the id of a REAL persisted row —
    // the pushed id must exist in bob's notification list.
    const push = await bellPush;
    const list = await bobLogin.agent.get('/api/v1/notifications');
    expect(list.status).toBe(200);
    const ids = (list.body.items as { id: string }[]).map((n) => n.id);
    expect(ids).toContain(push.notificationId);
    await aliceSilent;
  });
});

describe('realtime gateway — REALTIME_ENABLED=false (flagged rollout)', () => {
  it('starts no socket server and leaves the HTTP API untouched', async () => {
    harness = await createTestApp({ env: { REALTIME_ENABLED: 'false' } });
    await listenWithGateway();

    expect(harness.ctx.config.realtime.enabled).toBe(false);
    expect(harness.ctx.realtime.isAttached()).toBe(false);

    // The engine.io handshake endpoint does not exist…
    const ws = await request(harness.app).get(`${REALTIME_PATH}/`).query({
      EIO: '4',
      transport: 'polling',
    });
    expect(ws.status).toBe(404);

    // …and the ordinary API keeps working exactly as before.
    const user = await harness.seedUser();
    const { agent } = await login(user.email, user.password);
    const health = await agent.get('/api/v1/health');
    expect(health.status).toBe(200);
  });
});
