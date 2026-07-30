import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { eq } from 'drizzle-orm';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REALTIME_CLIENT_EVENTS,
  REALTIME_MAX_CONNECTIONS_PER_BEARER,
  REALTIME_MAX_CONNECTIONS_PER_USER,
  REALTIME_PATH,
  REALTIME_SERVER_EVENTS,
  REALTIME_SOCKET_COMMAND_BURST,
  twoFactorEnrollResponseSchema,
  type ApiKeyScope,
  type RealtimeChatMessage,
  type RealtimeLiveWatchAck,
  type RealtimeNotificationNew,
  type RealtimePortfolioChanged,
  type RealtimeQuoteUpdated,
  type RealtimeRoomAck,
} from '@bettertrack/contracts';

import { createOAuthRepository } from '../../data/repositories/oauthRepository';
import * as schema from '../../data/schema';
import { generateTotpCode } from '../../services/auth/totp';
import { hashToken } from '../../services/crypto/tokens';
import type { LiveModeService } from '../../services/liveMode';
import {
  createRealtimeAdmission,
  realtimeAdmissionKeys,
  type RealtimeAdmission,
} from '../../services/security/realtimeAdmission';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import {
  createRealtimeGateway,
  REALTIME_PRINCIPAL_REVALIDATION_INTERVAL_MS,
  REALTIME_PRINCIPAL_REVALIDATION_TIMEOUT_MS,
} from '../gateway';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;
let server: HttpServer | null = null;
let baseUrl = '';
let commandClockMs: number | null = null;
const openSockets: ClientSocket[] = [];

beforeEach(async () => {
  commandClockMs = null;
  harness = await createTestApp({
    realtimeCommandNow: () => commandClockMs ?? Date.now(),
  });
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

type HandshakeTransport = 'polling' | 'websocket';

interface ConnectOptions {
  /** Undefined models a browser at the configured web Origin; null omits the header. */
  origin?: string | null;
  transport?: HandshakeTransport;
}

function handshakeHeaders(
  origin: string | null | undefined,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const effectiveOrigin = origin === undefined ? harness.ctx.config.topology.webOrigin : origin;
  return {
    ...(effectiveOrigin === null ? {} : { Origin: effectiveOrigin }),
    ...extraHeaders,
  };
}

/** Open a socket; resolves on connect, rejects with the connect_error message. */
function connect(cookie?: string, options: ConnectOptions = {}): Promise<ClientSocket> {
  const socket = ioClient(baseUrl, {
    path: REALTIME_PATH,
    transports: [options.transport ?? 'websocket'],
    reconnection: false,
    extraHeaders: handshakeHeaders(options.origin, cookie ? { cookie } : {}),
  });
  openSockets.push(socket);
  return new Promise<ClientSocket>((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

/**
 * Open a socket with arbitrary transport and handshake auth — a bearer via the
 * socket.io auth payload (`auth.token`) and/or an `Authorization: Bearer …`
 * handshake header. Native/no-Origin cases must use the latter. Resolves on
 * connect, rejects with the connect_error message.
 */
function connectWith(opts: {
  auth?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  /** Undefined models a browser at the configured web Origin; null omits the header. */
  origin?: string | null;
  transport?: HandshakeTransport;
}): Promise<ClientSocket> {
  const socket = ioClient(baseUrl, {
    path: REALTIME_PATH,
    transports: [opts.transport ?? 'websocket'],
    reconnection: false,
    auth: opts.auth,
    extraHeaders: handshakeHeaders(opts.origin, opts.extraHeaders),
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

function emitAck<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event} ack`)), 3000);
    socket.emit(event, payload, (ack: T) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function waitForDisconnect(socket: ClientSocket, ms = 3000): Promise<void> {
  if (!socket.connected) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for disconnect')), ms);
    socket.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
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

/** Enable TOTP on an already-authenticated ordinary-user session. */
async function enrollTotp(agent: Agent): Promise<string> {
  const enroll = await agent.post('/api/v1/auth/2fa/enroll').set(...XRW);
  expect(enroll.status).toBe(200);
  const { secret } = twoFactorEnrollResponseSchema.parse(enroll.body);
  const confirm = await agent
    .post('/api/v1/auth/2fa/confirm')
    .set(...XRW)
    .send({ code: generateTotpCode(secret) });
  expect(confirm.status).toBe(200);
  return secret;
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

/** Mint a confidential OAuth access token through the same public flow as a mobile app. */
async function mintOAuthToken(
  clientOwner: Agent,
  userId: string,
  scopes: ApiKeyScope[],
  authorizedUser: Agent = clientOwner,
): Promise<{ accessToken: string; grantId: string; clientRowId: string }> {
  const redirectUri = 'https://realtime.test/callback';
  const clientRes = await clientOwner
    .post('/api/v1/settings/oauth-clients')
    .set(...XRW)
    .send({
      name: 'Realtime test client',
      redirectUris: [redirectUri],
      scopes,
      public: false,
    });
  expect(clientRes.status).toBe(201);
  const { client, clientSecret } = clientRes.body as {
    client: { id: string; clientId: string };
    clientSecret: string;
  };

  const approveRes = await authorizedUser
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send({ client_id: client.clientId, redirect_uri: redirectUri, scope: scopes.join(' ') });
  expect(approveRes.status).toBe(200);
  const code = new URL(approveRes.body.redirectTo as string).searchParams.get('code');
  expect(code).toBeTruthy();

  const tokenRes = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    client_secret: clientSecret,
  });
  expect(tokenRes.status).toBe(200);
  const grants = await harness.ctx.oauth.listGrants(userId);
  expect(grants).toHaveLength(1);
  return {
    accessToken: tokenRes.body.access_token as string,
    grantId: grants[0]!.id,
    clientRowId: client.id,
  };
}

/** Mint a delegated token for an admin-managed first-party client. */
async function mintFirstPartyOAuthToken(
  admin: Agent,
  user: Agent,
  userId: string,
  scopes: ApiKeyScope[],
): Promise<{ accessToken: string; clientRowId: string }> {
  const redirectUri = 'https://realtime.test/first-party-callback';
  const clientRes = await admin
    .post('/api/v1/admin/oauth-clients')
    .set(...XRW)
    .send({
      name: 'Realtime first-party test client',
      redirectUris: [redirectUri],
      scopes,
      public: false,
    });
  expect(clientRes.status).toBe(201);
  const { client, clientSecret } = clientRes.body as {
    client: { id: string; clientId: string };
    clientSecret: string;
  };

  const approveRes = await user
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send({ client_id: client.clientId, redirect_uri: redirectUri, scope: scopes.join(' ') });
  expect(approveRes.status).toBe(200);
  const code = new URL(approveRes.body.redirectTo as string).searchParams.get('code');
  expect(code).toBeTruthy();

  const tokenRes = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    client_secret: clientSecret,
  });
  expect(tokenRes.status).toBe(200);
  const grants = await harness.ctx.oauth.listGrants(userId);
  expect(grants).toHaveLength(1);
  return { accessToken: tokenRes.body.access_token as string, clientRowId: client.id };
}

const SOME_UUID = '018f6f00-0000-7000-8000-000000000001';
const CONTROLLED_USER_ID = '018f6f00-0000-7000-8000-000000000099';

function controlledAdmission(overrides: Partial<RealtimeAdmission> = {}): RealtimeAdmission {
  return {
    acquireConnection: vi.fn(async () => ({ ok: true as const })),
    renewConnection: vi.fn(async () => true),
    releaseConnection: vi.fn(async () => undefined),
    consumeUserCommand: vi.fn(async () => true),
    acquireWatch: vi.fn(async () => ({ ok: true as const, sharedGlobalAsset: false })),
    renewWatch: vi.fn(async () => true),
    releaseWatch: vi.fn(async () => undefined),
    acquireWatchStart: vi.fn(async () => true),
    renewWatchStart: vi.fn(async () => true),
    releaseWatchStart: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function listenControlledGateway(options: {
  admission: RealtimeAdmission;
  leaseTtlMs: number;
  liveMode?: LiveModeService | null;
  commandNow?: () => number;
}): Promise<{
  gateway: ReturnType<typeof createRealtimeGateway>;
  server: HttpServer;
  url: string;
}> {
  const personal = {
    kind: 'personal' as const,
    user: {
      id: CONTROLLED_USER_ID,
      role: 'user' as const,
      status: 'active',
      mustChangePassword: false,
    },
    keyId: 'key-controlled-lease',
    scopes: ['market:read'] as ApiKeyScope[],
  };
  const gateway = createRealtimeGateway({
    config: harness.ctx.config,
    bus: harness.ctx.events,
    logger: harness.ctx.logger,
    redis: harness.ctx.redis,
    realtimeAdmission: options.admission,
    realtimeAdmissionOptions: { leaseTtlMs: options.leaseTtlMs },
    realtimeCommandNow: options.commandNow,
    resolveSession: async () => null,
    resolveBearer: async () => personal,
    revalidatePersonal: async () => personal,
    revalidateOAuth: async () => null,
    canViewPortfolio: async () => false,
    liveMode: options.liveMode ?? null,
    resolveWatchableAsset: async () => ({ providerId: 'yahoo', providerRef: 'BAYN.DE' }),
    presence: harness.ctx.presence,
  });
  const controlledServer = createServer();
  controlledServer.listen(0);
  await new Promise<void>((resolve) => controlledServer.once('listening', resolve));
  await gateway.attach(controlledServer);
  return {
    gateway,
    server: controlledServer,
    url: `http://127.0.0.1:${(controlledServer.address() as AddressInfo).port}`,
  };
}

async function closeControlledGateway(
  gateway: ReturnType<typeof createRealtimeGateway>,
  controlledServer: HttpServer,
  sockets: ClientSocket[],
): Promise<void> {
  for (const socket of sockets) socket.disconnect();
  await gateway.close();
  if (controlledServer.listening) {
    await new Promise<void>((resolve) => controlledServer.close(() => resolve()));
  }
}

describe('realtime gateway — Origin admission', () => {
  it.each(['websocket', 'polling'] as const)(
    'accepts an exact configured Origin over %s',
    async (transport) => {
      await listenWithGateway();
      const user = await harness.seedUser();
      const { cookie } = await login(user.email, user.password);

      const socket = await connect(cookie, {
        origin: harness.ctx.config.topology.webOrigin,
        transport,
      });

      expect(socket.connected).toBe(true);
      expect(socket.io.engine.transport.name).toBe(transport);
    },
  );

  it('rejects forged same-origin metadata without Origin or bearer before auth', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const { cookie } = await login(user.email, user.password);
    const sessionSpy = vi.spyOn(harness.ctx.auth, 'resolveSession');
    const bearerSpy = vi.spyOn(harness.ctx.apiKeys, 'authenticate');

    try {
      const rejected = await request(server!)
        .get(`${REALTIME_PATH}/`)
        .query({ EIO: 4, transport: 'polling' })
        .set({
          Host: new URL(harness.ctx.config.topology.webOrigin).host,
          cookie,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
        });

      expect(rejected.status).toBe(403);
      expect(sessionSpy).not.toHaveBeenCalled();
      expect(bearerSpy).not.toHaveBeenCalled();
      expect(harness.ctx.realtime.connectionCount()).toBe(0);
    } finally {
      sessionSpy.mockRestore();
      bearerSpy.mockRestore();
    }
  });

  it.each([
    ['cross-site', 'https://attacker.example', 'websocket'],
    ['same-site sibling', 'http://localhost:5175', 'websocket'],
    ['cross-site', 'https://attacker.example', 'polling'],
  ] as const)(
    'rejects a %s Origin (%s) over %s before credential resolution',
    async (_kind, origin, transport) => {
      await listenWithGateway();
      const user = await harness.seedUser();
      const { cookie } = await login(user.email, user.password);
      const token = await mintKey(user.id);
      const sessionSpy = vi.spyOn(harness.ctx.auth, 'resolveSession');
      const bearerSpy = vi.spyOn(harness.ctx.apiKeys, 'authenticate');

      try {
        await expect(
          connectWith({
            origin,
            transport,
            extraHeaders: { cookie, Authorization: `Bearer ${token}` },
          }),
        ).rejects.toBeInstanceOf(Error);

        expect(sessionSpy).not.toHaveBeenCalled();
        expect(bearerSpy).not.toHaveBeenCalled();
        expect(harness.ctx.realtime.connectionCount()).toBe(0);
      } finally {
        sessionSpy.mockRestore();
        bearerSpy.mockRestore();
      }
    },
  );

  it.each(['websocket', 'polling'] as const)(
    'accepts a no-Origin native bearer over %s',
    async (transport) => {
      await listenWithGateway();
      const user = await harness.seedUser();
      const token = await mintKey(user.id);

      const socket = await connectWith({
        origin: null,
        transport,
        extraHeaders: { Authorization: `Bearer ${token}` },
      });

      expect(socket.connected).toBe(true);
      expect(socket.io.engine.transport.name).toBe(transport);
    },
  );

  it('rejects no-Origin cookie authentication without ever resolving the session', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const { cookie } = await login(user.email, user.password);
    const sessionSpy = vi.spyOn(harness.ctx.auth, 'resolveSession');

    try {
      await expect(connect(cookie, { origin: null })).rejects.toBeInstanceOf(Error);
      await expect(
        connectWith({
          origin: null,
          extraHeaders: { cookie, Authorization: 'Bearer garbage' },
        }),
      ).rejects.toThrow(/UNAUTHORIZED/);

      expect(sessionSpy).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(harness.ctx.realtime.connectionCount()).toBe(0));
    } finally {
      sessionSpy.mockRestore();
    }
  });
});

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

  it('releases admission when Engine.IO closes while namespace middleware is in flight', async () => {
    let signalAcquireStarted!: () => void;
    const acquireStarted = new Promise<void>((resolve) => {
      signalAcquireStarted = resolve;
    });
    let finishAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      finishAcquire = resolve;
    });
    const releaseConnection = vi.fn(async () => undefined);
    const admission: RealtimeAdmission = {
      acquireConnection: vi.fn(async () => {
        signalAcquireStarted();
        await acquireGate;
        return { ok: true as const };
      }),
      renewConnection: vi.fn(async () => true),
      releaseConnection,
      consumeUserCommand: vi.fn(async () => true),
      acquireWatch: vi.fn(async () => ({ ok: true as const, sharedGlobalAsset: false })),
      renewWatch: vi.fn(async () => true),
      releaseWatch: vi.fn(async () => undefined),
      acquireWatchStart: vi.fn(async () => true),
      renewWatchStart: vi.fn(async () => true),
      releaseWatchStart: vi.fn(async () => undefined),
    };
    const userId = '018f6f00-0000-7000-8000-000000000099';
    const personal = {
      kind: 'personal' as const,
      user: {
        id: userId,
        role: 'user' as const,
        status: 'active',
        mustChangePassword: false,
      },
      keyId: 'key-controlled-abort',
      scopes: ['chat:read'] as ApiKeyScope[],
    };
    const controlledGateway = createRealtimeGateway({
      config: harness.ctx.config,
      bus: harness.ctx.events,
      logger: harness.ctx.logger,
      redis: harness.ctx.redis,
      realtimeAdmission: admission,
      resolveSession: async () => null,
      resolveBearer: async () => personal,
      revalidatePersonal: async () => personal,
      revalidateOAuth: async () => null,
      canViewPortfolio: async () => false,
      liveMode: null,
      resolveWatchableAsset: async () => null,
      presence: harness.ctx.presence,
    });
    const controlledServer = createServer();
    const clientSockets: ClientSocket[] = [];
    try {
      controlledServer.listen(0);
      await new Promise<void>((resolve) => controlledServer.once('listening', resolve));
      await controlledGateway.attach(controlledServer);
      const url = `http://127.0.0.1:${(controlledServer.address() as AddressInfo).port}`;
      const client = ioClient(url, {
        path: REALTIME_PATH,
        transports: ['websocket'],
        reconnection: false,
        auth: { token: 'controlled-token' },
        extraHeaders: { Origin: harness.ctx.config.topology.webOrigin },
      });
      clientSockets.push(client);
      client.on('connect_error', () => undefined);

      await acquireStarted;
      client.io.engine?.close();
      finishAcquire();

      await vi.waitFor(() => expect(releaseConnection).toHaveBeenCalledTimes(1));
      expect(controlledGateway.connectionCount()).toBe(0);
    } finally {
      finishAcquire();
      for (const socket of clientSockets) socket.disconnect();
      await controlledGateway.close();
      if (controlledServer.listening) {
        await new Promise<void>((resolve) => controlledServer.close(() => resolve()));
      }
    }
  });

  it('fails closed before a never-settling connection renewal can outlive its lease', async () => {
    const leaseTtlMs = 90;
    const renewConnection = vi.fn(() => new Promise<boolean>(() => undefined));
    const releaseConnection = vi.fn(async () => undefined);
    const admission = controlledAdmission({ renewConnection, releaseConnection });
    const controlled = await listenControlledGateway({ admission, leaseTtlMs });
    const clientSockets: ClientSocket[] = [];
    try {
      const client = ioClient(controlled.url, {
        path: REALTIME_PATH,
        transports: ['websocket'],
        reconnection: false,
        auth: { token: 'controlled-token' },
        extraHeaders: { Origin: harness.ctx.config.topology.webOrigin },
      });
      clientSockets.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('connect_error', reject);
      });

      await waitForDisconnect(client, 1_000);
      expect(renewConnection).toHaveBeenCalledTimes(1);
      expect(releaseConnection).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, leaseTtlMs));
      expect(renewConnection).toHaveBeenCalledTimes(1);
    } finally {
      await closeControlledGateway(controlled.gateway, controlled.server, clientSockets);
    }
  });

  it('keeps a never-settling watch-start renewal single-flight and stops its live work', async () => {
    const leaseTtlMs = 120;
    const renewWatchStart = vi.fn(() => new Promise<boolean>(() => undefined));
    const releaseWatchStart = vi.fn(async () => undefined);
    const releaseWatch = vi.fn(async () => undefined);
    const admission = controlledAdmission({
      renewWatchStart,
      releaseWatchStart,
      releaseWatch,
    });
    const unwatch = vi.fn();
    const liveMode: LiveModeService = {
      watch: vi.fn(() => true),
      unwatch,
      backfill: vi.fn(() => new Promise<never>(() => undefined)),
      onFrame: vi.fn(() => () => undefined),
      watcherCount: vi.fn(() => 0),
      pollIntervalMs: vi.fn(() => null),
      reconcile: vi.fn(),
      close: vi.fn(),
    };
    const controlled = await listenControlledGateway({
      admission,
      leaseTtlMs,
      liveMode,
    });
    const clientSockets: ClientSocket[] = [];
    try {
      const client = ioClient(controlled.url, {
        path: REALTIME_PATH,
        transports: ['websocket'],
        reconnection: false,
        auth: { token: 'controlled-token' },
        extraHeaders: { Origin: harness.ctx.config.topology.webOrigin },
      });
      clientSockets.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('connect_error', reject);
      });
      client.emit(REALTIME_CLIENT_EVENTS.liveWatch, {
        assetId: SOME_UUID,
        window: '10m',
      });

      await vi.waitFor(() => expect(renewWatchStart).toHaveBeenCalledTimes(1));
      await waitForDisconnect(client, 1_000);
      await vi.waitFor(() => {
        expect(unwatch).toHaveBeenCalledTimes(1);
        expect(releaseWatch).toHaveBeenCalledTimes(1);
        expect(releaseWatchStart).toHaveBeenCalledTimes(1);
      });
      await new Promise((resolve) => setTimeout(resolve, leaseTtlMs));
      expect(renewWatchStart).toHaveBeenCalledTimes(1);
    } finally {
      await closeControlledGateway(controlled.gateway, controlled.server, clientSockets);
    }
  });

  it('retains renewing watch-start capacity until disconnected backfill work settles', async () => {
    const leaseTtlMs = 180;
    const admission = createRealtimeAdmission(harness.ctx.redis, {
      leaseTtlMs,
      limits: { concurrentWatchStarts: 1 },
    });
    const renewWatchStart = vi.spyOn(admission, 'renewWatchStart');
    const releaseWatchStart = vi.spyOn(admission, 'releaseWatchStart');
    let finishBackfill!: () => void;
    const backfillGate = new Promise<void>((resolve) => {
      finishBackfill = resolve;
    });
    let activeBackfills = 0;
    let maxActiveBackfills = 0;
    const backfill = vi.fn(async () => {
      activeBackfills += 1;
      maxActiveBackfills = Math.max(maxActiveBackfills, activeBackfills);
      try {
        await backfillGate;
        return [];
      } finally {
        activeBackfills -= 1;
      }
    });
    const liveMode: LiveModeService = {
      watch: vi.fn(() => true),
      unwatch: vi.fn(),
      backfill,
      onFrame: vi.fn(() => () => undefined),
      watcherCount: vi.fn(() => 0),
      pollIntervalMs: vi.fn(() => null),
      reconcile: vi.fn(),
      close: vi.fn(),
    };
    const controlled = await listenControlledGateway({
      admission,
      leaseTtlMs,
      liveMode,
    });
    const clientSockets: ClientSocket[] = [];
    try {
      const client = ioClient(controlled.url, {
        path: REALTIME_PATH,
        transports: ['websocket'],
        reconnection: false,
        auth: { token: 'controlled-token' },
        extraHeaders: { Origin: harness.ctx.config.topology.webOrigin },
      });
      clientSockets.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('connect_error', reject);
      });
      client.emit(REALTIME_CLIENT_EVENTS.liveWatch, {
        assetId: SOME_UUID,
        window: '10m',
      });

      await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () => {
        expect(renewWatchStart).toHaveBeenCalled();
        expect(await harness.ctx.redis.zcard(realtimeAdmissionKeys.watchStarts)).toBe(1);
      });

      client.disconnect();

      const renewalsAtDisconnect = renewWatchStart.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, leaseTtlMs + 60));
      expect(renewWatchStart.mock.calls.length).toBeGreaterThan(renewalsAtDisconnect);
      expect(await harness.ctx.redis.zcard(realtimeAdmissionKeys.watchStarts)).toBe(1);
      expect(releaseWatchStart).not.toHaveBeenCalled();

      const replacement = ioClient(controlled.url, {
        path: REALTIME_PATH,
        transports: ['websocket'],
        reconnection: false,
        auth: { token: 'controlled-token' },
        extraHeaders: { Origin: harness.ctx.config.topology.webOrigin },
      });
      clientSockets.push(replacement);
      await new Promise<void>((resolve, reject) => {
        replacement.once('connect', () => resolve());
        replacement.once('connect_error', reject);
      });
      await expect(
        emitAck<RealtimeLiveWatchAck>(replacement, REALTIME_CLIENT_EVENTS.liveWatch, {
          assetId: SOME_UUID,
          window: '10m',
        }),
      ).resolves.toEqual({ ok: false, error: 'LIVE_WORK_BUSY' });
      expect(activeBackfills).toBe(1);
      expect(maxActiveBackfills).toBe(1);

      finishBackfill();
      await vi.waitFor(async () => {
        expect(activeBackfills).toBe(0);
        expect(releaseWatchStart).toHaveBeenCalledTimes(1);
        expect(await harness.ctx.redis.zcard(realtimeAdmissionKeys.watchStarts)).toBe(0);
      });
    } finally {
      finishBackfill();
      await closeControlledGateway(controlled.gateway, controlled.server, clientSockets);
    }
  });

  it('keeps admitted unwatch cleanup out of a stalled watch queue', async () => {
    const leaseTtlMs = 300;
    const releaseWatch = vi.fn(async () => undefined);
    const admission = controlledAdmission({ releaseWatch });
    let commandClockMs = 0;
    let finishBackfill!: () => void;
    const backfillGate = new Promise<void>((resolve) => {
      finishBackfill = resolve;
    });
    const unwatch = vi.fn();
    const liveMode: LiveModeService = {
      watch: vi.fn(() => true),
      unwatch,
      backfill: vi.fn(async () => {
        await backfillGate;
        return [];
      }),
      onFrame: vi.fn(() => () => undefined),
      watcherCount: vi.fn(() => 0),
      pollIntervalMs: vi.fn(() => null),
      reconcile: vi.fn(),
      close: vi.fn(),
    };
    const controlled = await listenControlledGateway({
      admission,
      leaseTtlMs,
      liveMode,
      // Advance one refill quantum on every bucket-clock read. This models a
      // sustained 20/s stream without wall-clock timing in the burst assertion.
      commandNow: () => {
        commandClockMs += 50;
        return commandClockMs;
      },
    });
    const clientSockets: ClientSocket[] = [];
    try {
      const client = ioClient(controlled.url, {
        path: REALTIME_PATH,
        transports: ['websocket'],
        reconnection: false,
        auth: { token: 'controlled-token' },
        extraHeaders: { Origin: harness.ctx.config.topology.webOrigin },
      });
      clientSockets.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('connect_error', reject);
      });
      const watchAck = emitAck<RealtimeLiveWatchAck>(client, REALTIME_CLIENT_EVENTS.liveWatch, {
        assetId: SOME_UUID,
        window: '10m',
      });
      await vi.waitFor(() => expect(liveMode.backfill).toHaveBeenCalledTimes(1));

      await expect(
        emitAck<RealtimeRoomAck>(client, REALTIME_CLIENT_EVENTS.liveUnwatch, {
          assetId: SOME_UUID,
        }),
      ).resolves.toEqual({ ok: true });
      const arbitraryAssetId = '018f6f00-0000-7000-8000-000000000777';
      for (let index = 0; index < 200; index += 1) {
        client.emit(REALTIME_CLIENT_EVENTS.liveUnwatch, { assetId: arbitraryAssetId });
      }
      await expect(
        emitAck<RealtimeRoomAck>(client, REALTIME_CLIENT_EVENTS.liveUnwatch, {
          assetId: arbitraryAssetId,
        }),
      ).resolves.toEqual({ ok: true });
      expect(unwatch).toHaveBeenCalledTimes(1);
      expect(releaseWatch).toHaveBeenCalledTimes(1);

      finishBackfill();
      await expect(watchAck).resolves.toMatchObject({ ok: true });
    } finally {
      finishBackfill();
      await closeControlledGateway(controlled.gateway, controlled.server, clientSockets);
    }
  });

  it('admits exactly five concurrent sockets per user and releases on disconnect', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const { cookie } = await login(user.email, user.password);
    const sockets: ClientSocket[] = [];
    for (let index = 0; index < REALTIME_MAX_CONNECTIONS_PER_USER; index += 1) {
      sockets.push(await connect(cookie));
    }

    await expect(connect(cookie)).rejects.toThrow('USER_CONNECTION_LIMIT');
    sockets[0]!.disconnect();
    await vi.waitFor(async () => {
      expect(await harness.ctx.redis.zcard(realtimeAdmissionKeys.connectionUser(user.id))).toBe(
        REALTIME_MAX_CONNECTIONS_PER_USER - 1,
      );
    });
    await expect(connect(cookie)).resolves.toMatchObject({ connected: true });
  });

  it('admits exactly three sockets per bearer credential independent of other keys', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const token = await mintKey(user.id);
    for (let index = 0; index < REALTIME_MAX_CONNECTIONS_PER_BEARER; index += 1) {
      await expect(connectWith({ auth: { token } })).resolves.toMatchObject({ connected: true });
    }
    await expect(connectWith({ auth: { token } })).rejects.toThrow('BEARER_CONNECTION_LIMIT');

    // A distinct credential for the same account still has its own bearer
    // budget (and remains under the five-socket user budget).
    await expect(connectWith({ auth: { token: await mintKey(user.id) } })).resolves.toMatchObject({
      connected: true,
    });
  });
});

describe('realtime gateway — bearer handshake auth (mobile, §6.13/§14)', () => {
  it('accepts a notification-scoped bearer via the socket.io auth payload', async () => {
    await listenWithGateway();
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    // No cookie — the mobile credential is the bearer alone.
    const aliceSocket = await connectWith({
      auth: { token: await mintKey(alice.id, ['notifications:read']) },
    });
    const bobSocket = await connectWith({
      auth: { token: await mintKey(bob.id, ['notifications:read']) },
    });
    expect(aliceSocket.connected).toBe(true);

    // A push addressed to alice reaches alice's notification-scoped bearer and
    // never bob's. The bearer never enters the undifferentiated user room.
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

describe('realtime gateway — scoped bearer matrix (#880)', () => {
  it('isolates notification, portfolio, chat, and market bearer capabilities', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const loginState = await login(user.email, user.password);
    const portfolioId = await defaultPortfolioId(loginState.agent);
    const assetId = SOME_UUID;
    const { accessToken: oauthChatToken } = await mintOAuthToken(loginState.agent, user.id, [
      'chat:read',
    ]);

    const notifications = await connectWith({
      auth: { token: await mintKey(user.id, ['notifications:read']) },
    });
    const portfolio = await connectWith({
      auth: { token: await mintKey(user.id, ['portfolio:read']) },
    });
    const chat = await connectWith({ auth: { token: await mintKey(user.id, ['chat:read']) } });
    const oauthChat = await connectWith({ auth: { token: oauthChatToken } });
    const market = await connectWith({ auth: { token: await mintKey(user.id, ['market:read']) } });

    // Joining a room is itself a data-family authorization boundary.
    await expect(joinRoom(notifications, 'asset', assetId)).resolves.toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(joinRoom(portfolio, 'asset', assetId)).resolves.toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(joinRoom(chat, 'asset', assetId)).resolves.toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(joinRoom(oauthChat, 'asset', assetId)).resolves.toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(joinRoom(market, 'asset', assetId)).resolves.toEqual({ ok: true });

    await expect(joinRoom(notifications, 'portfolio', portfolioId)).resolves.toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(joinRoom(chat, 'portfolio', portfolioId)).resolves.toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(joinRoom(oauthChat, 'portfolio', portfolioId)).resolves.toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(joinRoom(market, 'portfolio', portfolioId)).resolves.toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(joinRoom(portfolio, 'portfolio', portfolioId)).resolves.toEqual({ ok: true });

    // Chat presence is a chat read, not a generic authenticated command.
    await expect(
      emitAck<RealtimeRoomAck>(chat, REALTIME_CLIENT_EVENTS.presenceEnter, {
        surface: 'chat',
        id: SOME_UUID,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      emitAck<RealtimeRoomAck>(oauthChat, REALTIME_CLIENT_EVENTS.presenceEnter, {
        surface: 'chat',
        id: SOME_UUID,
      }),
    ).resolves.toEqual({ ok: true });
    for (const socket of [notifications, portfolio, market]) {
      await expect(
        emitAck<RealtimeRoomAck>(socket, REALTIME_CLIENT_EVENTS.presenceEnter, {
          surface: 'chat',
          id: SOME_UUID,
        }),
      ).resolves.toEqual({ ok: false, error: 'FORBIDDEN' });
    }

    // `live.watch` is rejected before asset resolution without market read; a
    // market token reaches resolution and gets the ordinary no-leak NOT_FOUND.
    for (const socket of [notifications, portfolio, chat, oauthChat]) {
      await expect(
        emitAck<RealtimeLiveWatchAck>(socket, REALTIME_CLIENT_EVENTS.liveWatch, {
          assetId,
          window: '10m',
        }),
      ).resolves.toEqual({ ok: false, error: 'FORBIDDEN' });
    }
    await expect(
      emitAck<RealtimeLiveWatchAck>(market, REALTIME_CLIENT_EVENTS.liveWatch, {
        assetId,
        window: '10m',
      }),
    ).resolves.toEqual({ ok: false, error: 'NOT_FOUND' });

    const notification = waitForEvent<RealtimeNotificationNew>(
      notifications,
      REALTIME_SERVER_EVENTS.notificationNew,
    );
    const portfolioChanged = waitForEvent<RealtimePortfolioChanged>(
      portfolio,
      REALTIME_SERVER_EVENTS.portfolioChanged,
    );
    const chatMessage = waitForEvent<RealtimeChatMessage>(chat, REALTIME_SERVER_EVENTS.chatMessage);
    const oauthChatMessage = waitForEvent<RealtimeChatMessage>(
      oauthChat,
      REALTIME_SERVER_EVENTS.chatMessage,
    );
    const quote = waitForEvent<RealtimeQuoteUpdated>(market, REALTIME_SERVER_EVENTS.quoteUpdated);
    const deniedFamilies = Promise.all([
      ...[portfolio, chat, oauthChat, market].map((socket) =>
        expectSilence(socket, REALTIME_SERVER_EVENTS.notificationNew),
      ),
      ...[notifications, chat, oauthChat, market].map((socket) =>
        expectSilence(socket, REALTIME_SERVER_EVENTS.portfolioChanged),
      ),
      ...[notifications, portfolio, market].map((socket) =>
        expectSilence(socket, REALTIME_SERVER_EVENTS.chatMessage),
      ),
      ...[notifications, portfolio, chat, oauthChat].map((socket) =>
        expectSilence(socket, REALTIME_SERVER_EVENTS.quoteUpdated),
      ),
    ]);

    const occurredAt = new Date().toISOString();
    await Promise.all([
      harness.ctx.events.publish({
        type: 'notification.created',
        userId: user.id,
        notificationId: SOME_UUID,
        occurredAt,
      }),
      harness.ctx.events.publish({
        type: 'portfolio.changed',
        userId: user.id,
        portfolioId,
        occurredAt,
      }),
      harness.ctx.events.publish({
        type: 'chat.message',
        userId: user.id,
        senderId: SOME_UUID,
        senderUsername: 'sender',
        conversationId: SOME_UUID,
        messageId: SOME_UUID,
        bodyPreview: null,
        hasChip: false,
        occurredAt,
      }),
      harness.ctx.events.publish({ type: 'quote.updated', assetId, occurredAt }),
    ]);

    await expect(notification).resolves.toMatchObject({ notificationId: SOME_UUID });
    await expect(portfolioChanged).resolves.toMatchObject({ portfolioId });
    await expect(chatMessage).resolves.toMatchObject({ conversationId: SOME_UUID });
    await expect(oauthChatMessage).resolves.toMatchObject({ conversationId: SOME_UUID });
    await expect(quote).resolves.toMatchObject({ assetId });
    await deniedFamilies;
  });

  it('accepts matching write scopes as their implied realtime reads', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const loginState = await login(user.email, user.password);
    const portfolioId = await defaultPortfolioId(loginState.agent);
    const notificationWrite = await connectWith({
      auth: { token: await mintKey(user.id, ['notifications:write']) },
    });
    const portfolioWrite = await connectWith({
      auth: { token: await mintKey(user.id, ['portfolio:write']) },
    });
    const chatWrite = await connectWith({
      auth: { token: await mintKey(user.id, ['chat:write']) },
    });

    await expect(joinRoom(portfolioWrite, 'portfolio', portfolioId)).resolves.toEqual({ ok: true });
    await expect(
      emitAck<RealtimeRoomAck>(chatWrite, REALTIME_CLIENT_EVENTS.presenceEnter, {
        surface: 'chat',
        id: SOME_UUID,
      }),
    ).resolves.toEqual({ ok: true });

    const notification = waitForEvent(notificationWrite, REALTIME_SERVER_EVENTS.notificationNew);
    const portfolio = waitForEvent(portfolioWrite, REALTIME_SERVER_EVENTS.portfolioChanged);
    const chat = waitForEvent(chatWrite, REALTIME_SERVER_EVENTS.chatMessage);
    const occurredAt = new Date().toISOString();
    await Promise.all([
      harness.ctx.events.publish({
        type: 'notification.created',
        userId: user.id,
        notificationId: SOME_UUID,
        occurredAt,
      }),
      harness.ctx.events.publish({
        type: 'portfolio.changed',
        userId: user.id,
        portfolioId,
        occurredAt,
      }),
      harness.ctx.events.publish({
        type: 'chat.message',
        userId: user.id,
        senderId: SOME_UUID,
        senderUsername: 'sender',
        conversationId: SOME_UUID,
        messageId: SOME_UUID,
        bodyPreview: null,
        hasChip: false,
        occurredAt,
      }),
    ]);
    await expect(notification).resolves.toBeDefined();
    await expect(portfolio).resolves.toBeDefined();
    await expect(chat).resolves.toBeDefined();
  });
});

describe('realtime gateway — client command budgets (#881)', () => {
  it('allows the socket burst and returns RATE_LIMITED for burst + 1', async () => {
    commandClockMs = Date.now();
    await listenWithGateway();
    const user = await harness.seedUser();
    const { cookie } = await login(user.email, user.password);
    const socket = await connect(cookie);
    const decisions = await Promise.all(
      Array.from({ length: REALTIME_SOCKET_COMMAND_BURST + 1 }, () =>
        emitRoom(socket, REALTIME_CLIENT_EVENTS.roomLeave, {
          room: { kind: 'asset', id: SOME_UUID },
        }),
      ),
    );

    expect(decisions.filter((decision) => decision.ok)).toHaveLength(REALTIME_SOCKET_COMMAND_BURST);
    expect(decisions.filter((decision) => !decision.ok)).toEqual([
      { ok: false, error: 'RATE_LIMITED' },
    ]);
  });

  it('does not charge server-to-client frames to either command bucket', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const { cookie } = await login(user.email, user.password);
    const socket = await connect(cookie);
    for (let index = 0; index <= REALTIME_SOCKET_COMMAND_BURST; index += 1) {
      await harness.ctx.events.publish({
        type: 'notification.created',
        userId: user.id,
        notificationId: SOME_UUID,
        occurredAt: new Date().toISOString(),
      });
    }

    await expect(
      emitRoom(socket, REALTIME_CLIENT_EVENTS.roomLeave, {
        room: { kind: 'asset', id: SOME_UUID },
      }),
    ).resolves.toEqual({ ok: true });
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

describe('realtime gateway — after-connect credential lifecycle (#880)', () => {
  it('disconnects a revoked personal key and clears its chat presence', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const { key, token } = await harness.ctx.apiKeys.create({
      userId: user.id,
      name: 'realtime key',
      scopes: ['chat:read'],
    });
    const socket = await connectWith({ auth: { token } });
    await expect(
      emitAck<RealtimeRoomAck>(socket, REALTIME_CLIENT_EVENTS.presenceEnter, {
        surface: 'chat',
        id: SOME_UUID,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(harness.ctx.presence.isPresent(user.id, 'chat', SOME_UUID)).resolves.toBe(true);

    const disconnected = waitForDisconnect(socket);
    await harness.ctx.apiKeys.revoke({ userId: user.id, id: key.id });
    await disconnected;
    await vi.waitFor(async () => {
      await expect(harness.ctx.presence.isPresent(user.id, 'chat', SOME_UUID)).resolves.toBe(false);
      expect(await harness.ctx.redis.zcard(realtimeAdmissionKeys.connectionUser(user.id))).toBe(0);
    });
  });

  it('disconnects a cookie session on logout and password reset', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const loginState = await login(user.email, user.password);
    const socket = await connect(loginState.cookie);

    const loggedOut = waitForDisconnect(socket);
    await loginState.agent
      .post('/api/v1/auth/logout')
      .set(...XRW)
      .send()
      .expect(200);
    await loggedOut;

    const renewedLogin = await login(user.email, user.password);
    const resetSocket = await connect(renewedLogin.cookie);
    const admin = await harness.seedAdmin();
    const reset = waitForDisconnect(resetSocket);
    await harness.ctx.admin.resetPassword(user.id, { id: admin.id });
    await reset;
  });

  it('disconnects a socket when its account self-deletes after connect', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const loginState = await login(user.email, user.password);
    const socket = await connect(loginState.cookie);

    const disconnected = waitForDisconnect(socket);
    await loginState.agent
      .delete('/api/v1/account')
      .set(...XRW)
      .send({ confirmUsername: user.username, password: user.password })
      .expect(200);
    await disconnected;
  });

  it('disconnects the prior account socket when a cookie signs in as another user', async () => {
    await listenWithGateway();
    const alice = await harness.seedUser({ email: 'alice@bt.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bt.test', username: 'bob' });
    const aliceLogin = await login(alice.email, alice.password);
    const aliceSocket = await connect(aliceLogin.cookie);

    const disconnected = waitForDisconnect(aliceSocket);
    const switched = await aliceLogin.agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: bob.email, password: bob.password });
    expect(switched.status).toBe(200);
    await disconnected;
  });

  it('disconnects the prior account socket when an account switch completes through 2FA', async () => {
    await listenWithGateway();
    const alice = await harness.seedUser({ email: 'alice-2fa@bt.test', username: 'alice2fa' });
    const bob = await harness.seedUser({ email: 'bob-2fa@bt.test', username: 'bob2fa' });
    const bobLogin = await login(bob.email, bob.password);
    const bobTotpSecret = await enrollTotp(bobLogin.agent);
    const aliceLogin = await login(alice.email, alice.password);
    const aliceSocket = await connect(aliceLogin.cookie);

    const challenge = await aliceLogin.agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: bob.email, password: bob.password });
    expect(challenge.status).toBe(200);
    expect(challenge.body.twoFactorRequired).toBe(true);

    const disconnected = waitForDisconnect(aliceSocket);
    const verified = await aliceLogin.agent
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({
        pendingToken: challenge.body.pendingToken as string,
        code: generateTotpCode(bobTotpSecret),
      });
    expect(verified.status).toBe(200);
    await disconnected;
  });

  it('disconnects a revoked OAuth grant after connect', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const loginState = await login(user.email, user.password);
    const { accessToken, grantId } = await mintOAuthToken(loginState.agent, user.id, ['chat:read']);
    const socket = await connectWith({ auth: { token: accessToken } });

    const disconnected = waitForDisconnect(socket);
    await harness.ctx.oauth.revokeGrant({ userId: user.id, id: grantId });
    await disconnected;
  });

  it('disconnects an OAuth socket when its user-owned client is deleted', async () => {
    await listenWithGateway();
    const owner = await harness.seedUser({
      email: 'oauth-client-owner@bt.test',
      username: 'oauthclientowner',
    });
    const user = await harness.seedUser({
      email: 'oauth-client-user@bt.test',
      username: 'oauthclientuser',
    });
    const ownerLogin = await login(owner.email, owner.password);
    const userLogin = await login(user.email, user.password);
    // The deleter owns the app, while the socket belongs to a separate user who
    // authorized it. This proves cascade invalidation is attributed to grants,
    // not merely to the client owner.
    const { accessToken, clientRowId } = await mintOAuthToken(
      ownerLogin.agent,
      user.id,
      ['chat:read'],
      userLogin.agent,
    );
    const socket = await connectWith({ auth: { token: accessToken } });

    const disconnected = waitForDisconnect(socket);
    await ownerLogin.agent
      .delete(`/api/v1/settings/oauth-clients/${clientRowId}`)
      .set(...XRW)
      .send()
      .expect(204);
    await disconnected;
  });

  it('disconnects an OAuth socket when its first-party client is deleted', async () => {
    await listenWithGateway();
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const user = await harness.seedUser();
    const userLogin = await login(user.email, user.password);
    const { accessToken, clientRowId } = await mintFirstPartyOAuthToken(
      adminAgent,
      userLogin.agent,
      user.id,
      ['chat:read'],
    );
    const socket = await connectWith({ auth: { token: accessToken } });

    const disconnected = waitForDisconnect(socket);
    await adminAgent
      .delete(`/api/v1/admin/oauth-clients/${clientRowId}`)
      .set(...XRW)
      .send()
      .expect(200);
    await disconnected;
  });

  it('disconnects all credential kinds on account disable and never resurrects them on enable', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const loginState = await login(user.email, user.password);
    const { token } = await harness.ctx.apiKeys.create({
      userId: user.id,
      name: 'mobile',
      scopes: ['notifications:read'],
    });
    const cookieSocket = await connect(loginState.cookie);
    const keySocket = await connectWith({ auth: { token } });
    const admin = await harness.seedAdmin();

    const cookieDisconnected = waitForDisconnect(cookieSocket);
    const keyDisconnected = waitForDisconnect(keySocket);
    await harness.ctx.admin.updateUser(user.id, { status: 'disabled' }, { id: admin.id });
    await Promise.all([cookieDisconnected, keyDisconnected]);

    await harness.ctx.admin.updateUser(user.id, { status: 'active' }, { id: admin.id });
    expect(cookieSocket.connected).toBe(false);
    expect(keySocket.connected).toBe(false);
    await expect(connect(loginState.cookie)).rejects.toThrow(/UNAUTHORIZED/);
    await expect(connectWith({ auth: { token } })).rejects.toThrow(/UNAUTHORIZED/);
  });

  it('terminates an OAuth socket at access-token expiry without another client command', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const loginState = await login(user.email, user.password);
    const { accessToken } = await mintOAuthToken(loginState.agent, user.id, ['chat:read']);
    // Set a short but connect-safe deadline before the handshake reads the
    // token. The gateway must install its own deadline timer after connect.
    await harness.db
      .update(schema.oauthAccessTokens)
      .set({ expiresAt: new Date(Date.now() + 1500) })
      .where(eq(schema.oauthAccessTokens.tokenHash, hashToken(accessToken)));

    const socket = await connectWith({ auth: { token: accessToken } });
    await expect(waitForDisconnect(socket, 4000)).resolves.toBeUndefined();
  });

  it('fails closed on bounded revalidation when a lifecycle publish is missed', async () => {
    await listenWithGateway();
    const user = await harness.seedUser();
    const loginState = await login(user.email, user.password);
    const { accessToken, grantId } = await mintOAuthToken(loginState.agent, user.id, ['chat:read']);
    // The deadline forces the gateway through its token-free revalidation path
    // shortly after connect. Revoke through the repository directly so no bus
    // invalidation is published; the socket must still be rejected.
    await harness.db
      .update(schema.oauthAccessTokens)
      .set({ expiresAt: new Date(Date.now() + 1500) })
      .where(eq(schema.oauthAccessTokens.tokenHash, hashToken(accessToken)));
    const socket = await connectWith({ auth: { token: accessToken } });
    await createOAuthRepository(harness.db).revokeGrant(user.id, grantId);

    await expect(waitForDisconnect(socket, 4000)).resolves.toBeUndefined();
  });

  it('times out one stuck resolver without suppressing later revalidation sweeps', async () => {
    let triggerSweep: (() => void) | null = null;
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
      await listenWithGateway();
    } finally {
      intervalSpy.mockRestore();
    }
    expect(triggerSweep).not.toBeNull();

    const firstUser = await harness.seedUser({
      email: 'stuck-revalidation@bt.test',
      username: 'stuckrevalidation',
    });
    const secondUser = await harness.seedUser({
      email: 'healthy-revalidation@bt.test',
      username: 'healthyrevalidation',
    });
    const firstSocket = await connect((await login(firstUser.email, firstUser.password)).cookie);
    const secondSocket = await connect((await login(secondUser.email, secondUser.password)).cookie);
    const firstDisconnected = new Promise<void>((resolve) =>
      firstSocket.once('disconnect', () => resolve()),
    );
    const secondDisconnected = new Promise<void>((resolve) =>
      secondSocket.once('disconnect', () => resolve()),
    );

    const originalResolveSession = harness.ctx.auth.resolveSession.bind(harness.ctx.auth);
    let resolverCalls = 0;
    let settleHealthyResolver!: () => void;
    const healthyResolverSettled = new Promise<void>((resolve) => {
      settleHealthyResolver = resolve;
    });
    const resolverSpy = vi
      .spyOn(harness.ctx.auth, 'resolveSession')
      .mockImplementation(async (sessionId, userAgent) => {
        resolverCalls += 1;
        if (resolverCalls === 1) return await new Promise<never>(() => undefined);
        if (resolverCalls === 2) {
          try {
            return await originalResolveSession(sessionId, userAgent);
          } finally {
            settleHealthyResolver();
          }
        }
        return null;
      });

    const nativeSetTimeout = globalThis.setTimeout;
    const deadlineTimers: {
      fire: () => void;
      timer: ReturnType<typeof setTimeout>;
    }[] = [];
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delay, ...args) => {
        const timer = nativeSetTimeout(callback, delay, ...args);
        if (delay === REALTIME_PRINCIPAL_REVALIDATION_TIMEOUT_MS) {
          deadlineTimers.push({ fire: () => callback(...args), timer });
        }
        return timer;
      });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      triggerSweep!();
      await vi.waitFor(() => expect(deadlineTimers).toHaveLength(2));
      deadlineTimers[0]!.fire();
      await healthyResolverSettled;
      await vi.waitFor(() => {
        expect([firstSocket.connected, secondSocket.connected].filter(Boolean)).toHaveLength(1);
      });
      expect(resolverCalls).toBe(2);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(deadlineTimers[0]!.timer);

      // Both promises in the aggregate have settled now. A fresh pass must not
      // be suppressed by the previous sweep's global running guard.
      await Promise.resolve();
      triggerSweep!();
      await vi.waitFor(() => expect(resolverCalls).toBe(3));
      await Promise.all([firstDisconnected, secondDisconnected]);
      expect(deadlineTimers).toHaveLength(3);
      for (const { timer } of deadlineTimers) {
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
      }
    } finally {
      resolverSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
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
