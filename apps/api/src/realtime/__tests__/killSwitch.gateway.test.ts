import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REALTIME_CLIENT_EVENTS,
  REALTIME_PATH,
  REALTIME_SERVER_EVENTS,
  realtimeFeatureDisabledSchema,
  type AssetRef,
  type CachedResult,
  type Quote,
  type RealtimeFeatureDisabled,
  type RealtimeLiveWatchAck,
  type RealtimeRoomAck,
} from '@bettertrack/contracts';

import { createAssetRepository } from '../../data/repositories/assetRepository';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import { createStubMarketData, type StubMarketData } from '../../testing/marketDataStubs';
import {
  REALTIME_FEATURE_SHED_MAX_DELAY_MS,
  REALTIME_PRINCIPAL_REVALIDATION_INTERVAL_MS,
} from '../gateway';

/**
 * Runtime kill switches over ESTABLISHED work (§13.5 V5-P2 arc (c)). A kill
 * switch exists to stop load during an incident, so for the two flags that gate
 * long-lived work the flip must reach what is already running: `realtime` owns
 * the connection, `liveMode` owns the shared upstream poll loop. Both ride the
 * gateway's existing revalidation sweep — driven here through the captured
 * interval callback, exactly as the production timer drives it.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const POLL_MS = 30;
/** The control asset's own loop measures elapsed poll intervals — no sleeping. */
const CONTROL_TICKS = 5;

let harness: TestHarness;
let stub: StubMarketData;
let server: HttpServer | null = null;
let baseUrl = '';
let triggerSweep: (() => void) | null = null;
const pollsByRef = new Map<string, number>();
const openSockets: ClientSocket[] = [];

const quoteResult = (price: number): CachedResult<Quote> => ({
  value: { price, currency: 'EUR', dayChangePct: 0.5, asOf: new Date().toISOString() },
  stale: false,
  asOf: Date.now(),
});

const pollsFor = (providerRef: string): number => pollsByRef.get(providerRef) ?? 0;

beforeEach(async () => {
  let price = 100;
  pollsByRef.clear();
  stub = createStubMarketData({
    quote: () => quoteResult(price),
    poll: (ref: AssetRef) => {
      pollsByRef.set(ref.providerRef, pollsFor(ref.providerRef) + 1);
      return quoteResult(price++);
    },
  });
  harness = await createTestApp({
    marketData: stub,
    liveModeOptions: { intervalMs: POLL_MS, maxIntervalMs: POLL_MS * 4 },
  });
  server = harness.app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

  // Capture the sweep callback the gateway installs at attach so a test can run
  // one pass on demand instead of waiting out a 30 s wall-clock interval.
  triggerSweep = null;
  const nativeSetInterval = globalThis.setInterval;
  const intervalSpy = vi
    .spyOn(globalThis, 'setInterval')
    .mockImplementation((callback, delay, ...args) => {
      const timer = nativeSetInterval(callback, delay, ...args);
      if (delay === REALTIME_PRINCIPAL_REVALIDATION_INTERVAL_MS) {
        triggerSweep = () => callback(...args);
      }
      return timer;
    });
  try {
    await harness.ctx.realtime.attach(server);
  } finally {
    intervalSpy.mockRestore();
  }
  expect(triggerSweep).not.toBeNull();
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

type Agent = ReturnType<typeof request.agent>;

async function seedAsset(providerRef: string): Promise<string> {
  const repo = createAssetRepository(harness.db);
  const { row } = await repo.upsertGlobal({
    providerId: 'yahoo',
    providerRef,
    type: 'stock',
    symbol: providerRef,
    name: `Asset ${providerRef}`,
    exchange: 'XETRA',
    currency: 'EUR',
  });
  return row.id;
}

async function loginCookie(user: { email: string; password: string }): Promise<string> {
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(res.status).toBe(200);
  const setCookie = res.headers['set-cookie'] as unknown;
  const first = Array.isArray(setCookie) ? (setCookie[0] as string) : (setCookie as string);
  return first.split(';')[0]!;
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

/** The admin's own surface — flipping through it exercises the cache DEL too. */
async function adminAgent(): Promise<Agent> {
  const admin = await harness.seedAdmin();
  return await harness.loginAdmin(admin);
}

async function flip(agent: Agent, key: string, enabled: boolean): Promise<void> {
  const res = await agent
    .patch(`/api/v1/admin/feature-flags/${key}`)
    .set(...XRW)
    .send({ enabled });
  expect(res.status).toBe(200);
}

function waitForEvent<T>(socket: ClientSocket, event: string, ms = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
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

/** Join the `asset:{id}` room so `quote.updated` is addressed to this socket. */
function joinAssetRoom(socket: ClientSocket, assetId: string): Promise<RealtimeRoomAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for room.join ack')), 3000);
    socket.emit(
      REALTIME_CLIENT_EVENTS.roomJoin,
      { room: { kind: 'asset', id: assetId } },
      (ack: RealtimeRoomAck) => {
        clearTimeout(timer);
        resolve(ack);
      },
    );
  });
}

/** Every server→client frame this socket saw, in arrival order. */
function collectEvents(socket: ClientSocket): string[] {
  const seen: string[] = [];
  socket.onAny((event: string) => seen.push(event));
  return seen;
}

/** The three pushes §4.5 fans out to a connected client. */
async function pushEvents(userId: string, assetId: string): Promise<void> {
  const occurredAt = new Date().toISOString();
  await Promise.all([
    harness.ctx.events.publish({
      type: 'notification.created',
      userId,
      notificationId: randomUUID(),
      occurredAt,
    }),
    harness.ctx.events.publish({
      type: 'portfolio.changed',
      userId,
      portfolioId: randomUUID(),
      occurredAt,
    }),
    harness.ctx.events.publish({ type: 'quote.updated', assetId, occurredAt }),
  ]);
}

describe('`realtime` OFF sheds connections that are already established', () => {
  it('disconnects a live socket with a distinguishable reason, then admits it again when flipped back ON', async () => {
    const user = await harness.seedUser({ email: 'shed@bt.test', username: 'shed' });
    const admin = await adminAgent();
    const assetId = await seedAsset('SHED.DE');
    const cookie = await loginCookie(user);
    const socket = await connect(cookie);
    expect(await joinAssetRoom(socket, assetId)).toEqual({ ok: true });
    const seen = collectEvents(socket);
    let closeReason: string | null = null;
    socket.on('disconnect', (reason: string) => {
      closeReason = reason;
    });
    const disabled = waitForEvent<RealtimeFeatureDisabled>(
      socket,
      REALTIME_SERVER_EVENTS.featureDisabled,
    );

    await flip(admin, 'realtime', false);
    // The flip applies to HTTP on the very next request (cache DEL intact) …
    const advertised = await request(harness.app).get('/api/v1/feature-flags');
    expect(advertised.body.flags.realtime).toBe(false);
    // … and refuses the next handshake, as it always did.
    await expect(connect(cookie)).rejects.toThrow();
    // The established socket is still up: the shed is sweep-bounded, not instant.
    expect(socket.connected).toBe(true);

    triggerSweep!();

    expect(realtimeFeatureDisabledSchema.parse(await disabled)).toEqual({ feature: 'realtime' });
    await vi.waitFor(() => expect(socket.connected).toBe(false));
    // The SERVER closed it — not a client teardown and not a network drop, so
    // the SPA can render "realtime disabled" and stay on its poll fallback.
    expect(closeReason).toBe('io server disconnect');

    // Nothing may reach the shed socket any more.
    await pushEvents(user.id, assetId);

    // Round trip: ON again admits a fresh handshake with no restart — and that
    // fresh socket receiving its own push proves the emits above were processed,
    // so the shed socket's silence is a conclusion, not a race.
    await flip(admin, 'realtime', true);
    const reconnected = await connect(cookie);
    const delivered = waitForEvent(reconnected, REALTIME_SERVER_EVENTS.notificationNew);
    await harness.ctx.events.publish({
      type: 'notification.created',
      userId: user.id,
      notificationId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    });
    await delivered;

    expect(seen).toEqual([REALTIME_SERVER_EVENTS.featureDisabled]);
  });

  it('reads the flag once per sweep — never per emit', async () => {
    const user = await harness.seedUser({ email: 'bounded@bt.test', username: 'bounded' });
    const admin = await adminAgent();
    const assetId = await seedAsset('BOUND.DE');
    const socket = await connect(await loginCookie(user));
    const isEnabled = vi.spyOn(harness.ctx.featureFlags, 'isEnabled');
    const realtimeReads = (): number =>
      isEnabled.mock.calls.filter(([key]) => key === 'realtime').length;

    await flip(admin, 'realtime', false);
    const stillPushed = waitForEvent(socket, REALTIME_SERVER_EVENTS.notificationNew);
    await pushEvents(user.id, assetId);
    await stillPushed;
    // The emit paths never consult the flag; the switch is enforced by the sweep
    // alone, whose bound is one interval.
    expect(realtimeReads()).toBe(0);
    expect(REALTIME_FEATURE_SHED_MAX_DELAY_MS).toBe(REALTIME_PRINCIPAL_REVALIDATION_INTERVAL_MS);

    triggerSweep!();
    await vi.waitFor(() => expect(socket.connected).toBe(false));
    expect(realtimeReads()).toBe(1);
    isEnabled.mockRestore();
  });
});

describe('`liveMode` OFF sheds established watches, not the connection', () => {
  it('releases the watch, drains the shared upstream loop and keeps the socket up', async () => {
    const user = await harness.seedUser({ email: 'live@bt.test', username: 'liveuser' });
    const admin = await adminAgent();
    const watchedId = await seedAsset('WATCHED.DE');
    const socket = await connect(await loginCookie(user));
    const disabled = waitForEvent<RealtimeFeatureDisabled>(
      socket,
      REALTIME_SERVER_EVENTS.featureDisabled,
    );

    expect(await watch(socket, watchedId, '10m')).toMatchObject({ ok: true });
    // A control loop nobody watches through a socket: the sweep cannot touch it,
    // so its tick count measures elapsed poll intervals for the assertion below.
    const controlId = await seedAsset('CONTROL.DE');
    expect(
      await harness.ctx.liveMode.watch(controlId, {
        providerId: 'yahoo',
        providerRef: 'CONTROL.DE',
      }),
    ).not.toBeNull();
    await vi.waitFor(() => {
      expect(pollsFor('WATCHED.DE')).toBeGreaterThanOrEqual(2);
      expect(pollsFor('CONTROL.DE')).toBeGreaterThanOrEqual(2);
    });

    await flip(admin, 'liveMode', false);
    expect(harness.ctx.liveMode.watcherCount(watchedId)).toBe(1); // still hot pre-sweep

    triggerSweep!();

    await vi.waitFor(() => {
      expect(harness.ctx.liveMode.watcherCount(watchedId)).toBe(0);
      expect(harness.ctx.liveMode.pollIntervalMs(watchedId)).toBeNull();
    });
    expect(realtimeFeatureDisabledSchema.parse(await disabled)).toEqual({ feature: 'liveMode' });
    // Only Live Mode died — `realtime` owns the connection.
    expect(socket.connected).toBe(true);

    const frozen = pollsFor('WATCHED.DE');
    const controlBefore = pollsFor('CONTROL.DE');
    await vi.waitFor(
      () => expect(pollsFor('CONTROL.DE')).toBeGreaterThanOrEqual(controlBefore + CONTROL_TICKS),
      { timeout: 5000 },
    );
    // Several poll intervals later the shed asset has issued no further provider
    // call: the switch that exists to stop provider load stopped provider load.
    expect(pollsFor('WATCHED.DE')).toBe(frozen);

    // And a re-watch is refused while the switch is off (unchanged behaviour).
    expect(await watch(socket, watchedId, '10m')).toEqual({ ok: false, error: 'UNAVAILABLE' });
  });

  it('leaves the connection and its watches alone while liveMode is ON', async () => {
    const user = await harness.seedUser({ email: 'liveon@bt.test', username: 'liveon' });
    const assetId = await seedAsset('ON.DE');
    const socket = await connect(await loginCookie(user));
    expect(await watch(socket, assetId, '10m')).toMatchObject({ ok: true });

    triggerSweep!();
    await vi.waitFor(() => expect(pollsFor('ON.DE')).toBeGreaterThanOrEqual(3));

    expect(socket.connected).toBe(true);
    expect(harness.ctx.liveMode.watcherCount(assetId)).toBe(1);
  });
});
