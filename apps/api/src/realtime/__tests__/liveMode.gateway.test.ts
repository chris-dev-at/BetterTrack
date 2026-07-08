import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REALTIME_CLIENT_EVENTS,
  REALTIME_PATH,
  REALTIME_SERVER_EVENTS,
  type CachedResult,
  type Quote,
  type RealtimeLiveFrame,
  type RealtimeLiveWatchAck,
} from '@bettertrack/contracts';

import { createAssetRepository } from '../../data/repositories/assetRepository';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import { createStubMarketData, type StubMarketData } from '../../testing/marketDataStubs';

/**
 * Live Mode end-to-end over the gateway (§6.3, V3-P7b): the §5.3 "N viewers =
 * one upstream stream" contract, ring-buffer backfill, and auto-stop, all
 * through real sockets against a stubbed provider with a call counter.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const POLL_MS = 30;

let harness: TestHarness;
let stub: StubMarketData;
let server: HttpServer | null = null;
let baseUrl = '';
const openSockets: ClientSocket[] = [];

const quoteResult = (price: number): CachedResult<Quote> => ({
  value: { price, currency: 'EUR', dayChangePct: 0.5, asOf: new Date().toISOString() },
  stale: false,
  asOf: Date.now(),
});

beforeEach(async () => {
  let price = 100;
  stub = createStubMarketData({
    quote: () => quoteResult(price),
    poll: () => quoteResult(price++),
  });
  harness = await createTestApp({
    marketData: stub,
    liveModeOptions: { intervalMs: POLL_MS, maxIntervalMs: POLL_MS * 4 },
  });
  server = harness.app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  await harness.ctx.realtime.attach(server!);
});

afterEach(async () => {
  for (const socket of openSockets.splice(0, openSockets.length)) socket.disconnect();
  await harness.ctx.realtime.close();
  harness.ctx.liveMode.close();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function seedAsset(): Promise<string> {
  const repo = createAssetRepository(harness.db);
  const { row } = await repo.upsertGlobal({
    providerId: 'yahoo',
    providerRef: 'BAYN.DE',
    type: 'stock',
    symbol: 'BAYN.DE',
    name: 'Bayer AG',
    exchange: 'XETRA',
    currency: 'EUR',
  });
  return row.id;
}

async function connectUser(email: string, username: string): Promise<ClientSocket> {
  const user = await harness.seedUser({ email, username });
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status).toBe(200);
  const setCookie = res.headers['set-cookie'] as unknown;
  const first = Array.isArray(setCookie) ? (setCookie[0] as string) : (setCookie as string);
  const cookie = first.split(';')[0]!;

  const socket = ioClient(baseUrl, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { cookie },
  });
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
  return socket;
}

function watch(
  socket: ClientSocket,
  assetId: string,
  window: string,
): Promise<RealtimeLiveWatchAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for live.watch ack')), 3000);
    socket.emit(
      REALTIME_CLIENT_EVENTS.liveWatch,
      { assetId, window },
      (ack: RealtimeLiveWatchAck) => {
        clearTimeout(timer);
        resolve(ack);
      },
    );
  });
}

function unwatch(socket: ClientSocket, assetId: string): Promise<unknown> {
  return new Promise((resolve) => {
    socket.emit(REALTIME_CLIENT_EVENTS.liveUnwatch, { assetId }, (ack: unknown) => resolve(ack));
  });
}

function collectFrames(socket: ClientSocket): RealtimeLiveFrame[] {
  const frames: RealtimeLiveFrame[] = [];
  socket.on(REALTIME_SERVER_EVENTS.liveFrame, (frame: RealtimeLiveFrame) => frames.push(frame));
  return frames;
}

describe('Live Mode over the gateway (§6.3, V3-P7b)', () => {
  it('two concurrent viewers ⇒ exactly one upstream loop (provider-call counter)', async () => {
    const assetId = await seedAsset();
    const alice = await connectUser('alice@bt.test', 'alice');
    const bob = await connectUser('bob@bt.test', 'bob');
    const aliceFrames = collectFrames(alice);
    const bobFrames = collectFrames(bob);

    expect(await watch(alice, assetId, '10m')).toMatchObject({ ok: true });
    expect(await watch(bob, assetId, '1h')).toMatchObject({ ok: true });
    expect(harness.ctx.liveMode.watcherCount(assetId)).toBe(2);

    await vi.waitFor(() => {
      expect(aliceFrames.length).toBeGreaterThanOrEqual(3);
      expect(bobFrames.length).toBeGreaterThanOrEqual(3);
    });

    // Both viewers receive the SAME frames — one poll tick, one fan-out. With a
    // per-viewer loop the upstream counter would be ~2× the distinct frames.
    const distinct = new Set([...aliceFrames, ...bobFrames].map((f) => f.at)).size;
    expect(stub.calls.poll).toBeLessThanOrEqual(distinct + 2); // + ticks still in flight
    expect(bobFrames.map((f) => f.price)).toEqual(
      aliceFrames.slice(aliceFrames.length - bobFrames.length).map((f) => f.price),
    );
  });

  it('a viewer joining mid-stream gets the requested window backfilled, then live frames', async () => {
    const assetId = await seedAsset();
    const alice = await connectUser('alice@bt.test', 'alice');
    const aliceFrames = collectFrames(alice);

    // The first tick fires immediately, so alice's own ack may already carry a
    // frame; her full view is backfill + stream, deduped by producer timestamp.
    const aliceAck = await watch(alice, assetId, '1m');
    expect(aliceAck.ok).toBe(true);
    const aliceAll = () => {
      const seen = new Map<string, RealtimeLiveFrame>();
      for (const f of [...(aliceAck.frames ?? []), ...aliceFrames]) seen.set(f.at, f);
      return [...seen.values()];
    };
    await vi.waitFor(() => expect(aliceAll().length).toBeGreaterThanOrEqual(3));

    // Bob joins mid-stream: his ack backfills the frames the ring already holds…
    const bob = await connectUser('bob@bt.test', 'bob');
    const bobLive = collectFrames(bob);
    const ack = await watch(bob, assetId, '12h');
    expect(ack.ok).toBe(true);
    expect(ack.frames!.length).toBeGreaterThanOrEqual(3);
    expect(ack.frames!.map((f) => f.price)).toEqual(
      aliceAll()
        .slice(0, ack.frames!.length)
        .map((f) => f.price),
    );

    // …and live frames continue seamlessly after the backfill.
    await vi.waitFor(() => expect(bobLive.length).toBeGreaterThanOrEqual(1));
    const lastBackfilled = ack.frames![ack.frames!.length - 1]!;
    expect(bobLive[0]!.at >= lastBackfilled.at).toBe(true);
  });

  it('polling auto-stops when the last watcher leaves; provider calls cease', async () => {
    const assetId = await seedAsset();
    const alice = await connectUser('alice@bt.test', 'alice');
    const bob = await connectUser('bob@bt.test', 'bob');

    await watch(alice, assetId, '10m');
    await watch(bob, assetId, '10m');
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(2));

    await unwatch(alice, assetId);
    expect(harness.ctx.liveMode.watcherCount(assetId)).toBe(1); // still hot

    // Bob leaves by disconnecting (closed tab) — the gateway releases his watch.
    bob.disconnect();
    await vi.waitFor(() => expect(harness.ctx.liveMode.watcherCount(assetId)).toBe(0));

    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2)); // drain in-flight tick
    const frozen = stub.calls.poll;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5));
    expect(stub.calls.poll).toBe(frozen);
  });

  it('a window switch re-backfills without restarting or duplicating the loop', async () => {
    const assetId = await seedAsset();
    const alice = await connectUser('alice@bt.test', 'alice');

    await watch(alice, assetId, '1m');
    await vi.waitFor(() => expect(stub.calls.poll).toBeGreaterThanOrEqual(2));

    const ack = await watch(alice, assetId, '12h'); // same socket, new window
    expect(ack.ok).toBe(true);
    expect(ack.frames!.length).toBeGreaterThanOrEqual(2); // full ring window served
    expect(harness.ctx.liveMode.watcherCount(assetId)).toBe(1); // no double count
  });

  it('rejects malformed, unknown and foreign-custom watches without crashing the socket', async () => {
    const alice = await connectUser('alice@bt.test', 'alice');

    expect(await watch(alice, 'not-a-uuid', '10m')).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(await watch(alice, '018f6f00-0000-7000-8000-000000000009', '10m')).toEqual({
      ok: false,
      error: 'NOT_FOUND',
    });

    const assetId = await seedAsset();
    const badWindow = await new Promise<RealtimeLiveWatchAck>((resolve) => {
      alice.emit(
        REALTIME_CLIENT_EVENTS.liveWatch,
        { assetId, window: '2d' },
        (ack: RealtimeLiveWatchAck) => resolve(ack),
      );
    });
    expect(badWindow).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(alice.connected).toBe(true);
    expect(stub.calls.poll).toBe(0); // nothing above ever reached the provider
  });

  it('unwatch is idempotent and only releases a held watch', async () => {
    const assetId = await seedAsset();
    const alice = await connectUser('alice@bt.test', 'alice');
    const bob = await connectUser('bob@bt.test', 'bob');

    await watch(alice, assetId, '10m');
    await watch(bob, assetId, '10m');

    await unwatch(alice, assetId);
    await unwatch(alice, assetId); // repeat: must not steal bob's count
    expect(harness.ctx.liveMode.watcherCount(assetId)).toBe(1);
  });
});
