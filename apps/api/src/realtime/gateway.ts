import type { Server as HttpServer } from 'node:http';

import cookieParser from 'cookie-parser';
import type { RequestHandler } from 'express';
import { Server as SocketIOServer, type Socket } from 'socket.io';

import {
  LIVE_RATE_MS,
  REALTIME_BEARER_SCOPE_REQUIREMENTS,
  REALTIME_CLIENT_EVENTS,
  REALTIME_PATH,
  REALTIME_SERVER_EVENTS,
  realtimeLiveUnwatchRequestSchema,
  realtimeLiveWatchRequestSchema,
  realtimePresenceRequestSchema,
  realtimeRoomRequestSchema,
  scopeSatisfies,
  type AssetRef,
  type ApiKeyScope,
  type FeatureFlagKey,
  type PresenceSurface,
  type RealtimeBearerCapability,
  type RealtimeChatMessage,
  type RealtimeLiveWatchAck,
  type RealtimeNotificationNew,
  type RealtimePortfolioChanged,
  type RealtimeQuoteUpdated,
  type RealtimeRoom,
  type RealtimeRoomAck,
} from '@bettertrack/contracts';

import type { AppConfig } from '../config/env';
import type { EventBus, RealtimePrincipalInvalidatedEvent, Unsubscribe } from '../events';
import type { Logger } from '../logger';
import { sha256Base64Url } from '../services/crypto/tokens';
import type { LiveModeService } from '../services/liveMode';
import type { PresenceStore } from '../services/notifications/presence';

/**
 * Realtime gateway (PROJECTPLAN.md §4.5, V3-P7a): a Socket.IO server at
 * {@link REALTIME_PATH} on the API origin, bridging the typed domain event bus
 * into socket rooms:
 *
 *   - `user:{id}`      — full first-party cookie sessions only; bearer sockets
 *                         use per-capability companion rooms instead.
 *   - `asset:{id}`     — quote/live pushes; requires `market:read` for bearers.
 *   - `portfolio:{id}` — shared-view invalidation; joins enforce owner-or-shared
 *                         access, recomputed at join time (§6.9).
 *
 * Handshake auth accepts EITHER of two credentials, resolved to one typed
 * principal. Cookie sessions own the socket's `user:{id}` room; bearers enter
 * only the capability-specific companion rooms their scopes permit:
 *
 *   - the **session cookie** — the web SPA path, resolved through the auth
 *     service's cookie→user resolution (verbatim the HTTP session path); or
 *   - a **bearer token** — the mobile app path (§6.13, §14). It holds no cookie,
 *     so it presents a personal API key (`btk_…`) or a delegated OAuth access
 *     token (`bto_…`) via the socket.io auth payload (`handshake.auth.token`)
 *     and/or an `Authorization: Bearer …` upgrade header. The token is validated
 *     through the SAME service the HTTP bearer middleware uses (revocation,
 *     expiry and consent-scope clamping included), so socket auth can never
 *     drift from — or widen — the HTTP surface. Bearer sockets are admitted only
 *     to the scoped rooms and commands their effective scopes allow; lightweight
 *     invalidations and quote frames still reveal data-family activity.
 *
 * Both transports are supported: a client may open the websocket transport
 * directly (the mobile app dials `transport=websocket` with no prior polling
 * handshake) or take the polling→websocket upgrade the web SPA performs.
 *
 * The gateway is a pure bus subscriber — producers are untouched — and a pure
 * enhancement layer: with `REALTIME_ENABLED=false` {@link RealtimeGateway.attach}
 * is a no-op and the API behaves exactly as before; the SPA's poll/refetch
 * fallback carries every feature (§4.5 "V1 ships without the socket").
 */

/** The first-party session user room; clients can never request it. */
export const userRoom = (userId: string): string => `user:${userId}`;
export const assetRoom = (assetId: string): string => `asset:${assetId}`;
export const portfolioRoom = (portfolioId: string): string => `portfolio:${portfolioId}`;

/** Bounded fail-closed backstop when a lifecycle pub/sub signal is missed. */
export const REALTIME_PRINCIPAL_REVALIDATION_INTERVAL_MS = 30_000;
export const REALTIME_PRINCIPAL_REVALIDATION_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

/** Bearer-only user rooms prevent a narrow token entering the full user room. */
const scopedUserRoom = (userId: string, capability: RealtimeBearerCapability): string =>
  `user:${userId}:scope:${capability}`;

function roomName(room: RealtimeRoom): string {
  return room.kind === 'asset' ? assetRoom(room.id) : portfolioRoom(room.id);
}

/** The user fields every connection resolver must freshly establish. */
export interface RealtimeResolvedUser {
  id: string;
  role: 'user' | 'admin';
  status: string;
  mustChangePassword: boolean;
}

/** Cookie-session resolver result, including data required for later revocation. */
export interface RealtimeSessionResolution {
  user: RealtimeResolvedUser;
  sessionId: string;
  expiresAt: string | null;
}

/** Personal-key resolver result. Keys are revoke-only, so they have no deadline. */
export interface RealtimePersonalResolution {
  kind: 'personal';
  user: RealtimeResolvedUser;
  keyId: string;
  scopes: ApiKeyScope[];
}

/** OAuth resolver result. A grant revokes the token; the token has its own expiry. */
export interface RealtimeOAuthResolution {
  kind: 'oauth';
  user: RealtimeResolvedUser;
  grantId: string;
  accessTokenId: string;
  expiresAt: string;
  scopes: ApiKeyScope[];
}

export type RealtimeBearerResolution = RealtimePersonalResolution | RealtimeOAuthResolution;

/**
 * Auth state retained on `socket.data`. A socket never keeps a plaintext bearer
 * token: key/grant ids plus a fresh service revalidation are enough to fail
 * closed if the lifecycle bus misses an invalidation.
 */
export interface RealtimeSessionPrincipal {
  kind: 'session';
  /** Public hash used by lifecycle events — never the session cookie secret. */
  credentialId: string;
  sessionId: string;
  userId: string;
  userStatus: 'active';
  scopes: 'all';
  expiresAt: string | null;
}

export interface RealtimePersonalPrincipal {
  kind: 'personal';
  credentialId: string;
  keyId: string;
  userId: string;
  userStatus: 'active';
  scopes: ApiKeyScope[];
  expiresAt: null;
}

export interface RealtimeOAuthPrincipal {
  kind: 'oauth';
  /** Grant id: revoking the grant invalidates every access token under it. */
  credentialId: string;
  grantId: string;
  accessTokenId: string;
  userId: string;
  userStatus: 'active';
  scopes: ApiKeyScope[];
  expiresAt: string;
}

export type RealtimePrincipal =
  | RealtimeSessionPrincipal
  | RealtimePersonalPrincipal
  | RealtimeOAuthPrincipal;

export interface RealtimeGatewayDeps {
  config: AppConfig;
  bus: EventBus;
  logger: Logger;
  /**
   * Session-cookie → user resolution — the SAME path the HTTP session
   * middleware uses ({@link import('../services/auth/authService').AuthService}),
   * so socket auth can never drift from HTTP auth. Passing the User-Agent keeps
   * the session manager's last-seen bookkeeping consistent (V3-P11a).
   */
  resolveSession(
    sessionId: string,
    userAgent?: string | null,
  ): Promise<RealtimeSessionResolution | null>;
  /**
   * Bearer token → user resolution — the SAME path the HTTP bearer middleware
   * uses ({@link import('../http/middleware/bearerAuth').loadBearerAuth}): a
   * personal API key (`btk_…`) or a delegated OAuth access token (`bto_…`), with
   * revocation, expiry and consent-scope clamping enforced inside the service.
   * The mobile app authenticates its socket with a bearer because it holds no
   * session cookie (§6.13, §14). Returns null for a missing, malformed, unknown,
   * revoked or expired token — indistinguishable, exactly like the HTTP 401.
   */
  resolveBearer(token: string): Promise<RealtimeBearerResolution | null>;
  /** Fail-closed, token-free revalidation for a connected personal key. */
  revalidatePersonal(input: {
    userId: string;
    keyId: string;
  }): Promise<RealtimePersonalResolution | null>;
  /** Fail-closed, token-free revalidation for a connected OAuth access token. */
  revalidateOAuth(input: {
    userId: string;
    grantId: string;
    accessTokenId: string;
    expiresAt: string;
    scopes: ApiKeyScope[];
  }): Promise<RealtimeOAuthResolution | null>;
  /** Owner-or-shared access check backing `portfolio:{id}` joins (§6.9). */
  canViewPortfolio(userId: string, portfolioId: string): Promise<boolean>;
  /**
   * Live Mode core (§6.3, V3-P7b): watcher counts + shared poll loops + ring
   * backfill. Null disables the live surface — `live.watch` acks UNAVAILABLE
   * and the SPA silently stays on its 60 s poll fallback.
   */
  liveMode: LiveModeService | null;
  /**
   * Runtime feature kill-switch read (§13.5 V5-P2 arc (c)): consulted per
   * connection (`realtime`) and per live-watch (`liveMode`). Omitted ⇒ always
   * enabled, so a gateway built without it is byte-identical to before.
   */
  isFeatureEnabled?: (key: FeatureFlagKey) => Promise<boolean>;
  /**
   * Resolve an asset the user may view (global or their own custom asset,
   * §10) to its provider ref for the poll loop; null when missing/foreign —
   * indistinguishable, exactly like the HTTP 404 (§10 no-leak rule).
   */
  resolveWatchableAsset(userId: string, assetId: string): Promise<AssetRef | null>;
  /**
   * Active-view presence store (#368): `presence.enter`/`presence.leave` write
   * here, the notification dispatcher reads it (cross-process, via Redis) to
   * suppress notifying a user about the surface they're looking at. One
   * protocol for web AND mobile — both are just sockets on this gateway.
   */
  presence: PresenceStore;
}

export interface RealtimeGateway {
  /**
   * Attach the Socket.IO server to the API's HTTP server and subscribe to the
   * event bus. A no-op when `config.realtime.enabled` is false — no socket
   * server exists and the API is byte-identical to a pre-gateway build.
   */
  attach(server: HttpServer): Promise<void>;
  /** True once attach() actually created the socket server (flag on). */
  isAttached(): boolean;
  /**
   * Live client count for the admin health page (§13.4 V4-P5a): the number of
   * connected Engine.IO clients, or 0 when the gateway is disabled/unattached.
   */
  connectionCount(): number;
  /** Disconnect all clients, drop bus subscriptions, close the socket server. */
  close(): Promise<void>;
}

export function createRealtimeGateway(deps: RealtimeGatewayDeps): RealtimeGateway {
  const { config, bus, logger } = deps;
  let io: SocketIOServer | null = null;
  let principalRevalidationTimer: ReturnType<typeof setInterval> | null = null;
  let principalRevalidationRunning = false;
  const unsubscribers: Unsubscribe[] = [];

  // The exact cookie-parser the Express app mounts: same signing secrets, same
  // rotation behavior. Run over the raw handshake request so `signedCookies`
  // resolves identically to an HTTP request.
  const parseCookies: RequestHandler = cookieParser(config.sessionSecrets);

  const BEARER_PREFIX = 'Bearer ';

  /** Runtime kill-switch read — always-on when no evaluator was injected. */
  const featureEnabled = (key: FeatureFlagKey): Promise<boolean> =>
    deps.isFeatureEnabled ? deps.isFeatureEnabled(key) : Promise.resolve(true);

  function eligibleUser(user: RealtimeResolvedUser): boolean {
    // Mirror the user-app HTTP surface: admin-kind accounts have no user
    // surface, disabled accounts are closed, and a forced password change is
    // limited to the change flow. Applied identically to every credential kind.
    return user.role === 'user' && user.status === 'active' && !user.mustChangePassword;
  }

  function sessionPrincipal(resolved: RealtimeSessionResolution): RealtimeSessionPrincipal | null {
    if (!eligibleUser(resolved.user)) return null;
    return {
      kind: 'session',
      credentialId: sha256Base64Url(resolved.sessionId),
      sessionId: resolved.sessionId,
      userId: resolved.user.id,
      userStatus: 'active',
      scopes: 'all',
      expiresAt: resolved.expiresAt,
    };
  }

  function bearerPrincipal(resolved: RealtimeBearerResolution): RealtimePrincipal | null {
    if (!eligibleUser(resolved.user)) return null;
    if (resolved.kind === 'personal') {
      return {
        kind: 'personal',
        credentialId: resolved.keyId,
        keyId: resolved.keyId,
        userId: resolved.user.id,
        userStatus: 'active',
        scopes: resolved.scopes,
        expiresAt: null,
      };
    }
    return {
      kind: 'oauth',
      credentialId: resolved.grantId,
      grantId: resolved.grantId,
      accessTokenId: resolved.accessTokenId,
      userId: resolved.user.id,
      userStatus: 'active',
      scopes: resolved.scopes,
      expiresAt: resolved.expiresAt,
    };
  }

  /** Resolve the handshake's session cookie to a typed principal, or null. */
  async function resolveCookiePrincipal(socket: Socket): Promise<RealtimePrincipal | null> {
    const request = socket.request as Parameters<RequestHandler>[0];
    await new Promise<void>((resolve, reject) => {
      parseCookies(request, {} as Parameters<RequestHandler>[1], (err?: unknown) =>
        err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(),
      );
    });
    const sessionId = (request.signedCookies as Record<string, unknown> | undefined)?.[
      config.cookie.name
    ];
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    const resolved = await deps.resolveSession(
      sessionId,
      socket.handshake.headers['user-agent'] ?? null,
    );
    return resolved ? sessionPrincipal(resolved) : null;
  }

  /**
   * The bearer token the mobile app presents (§6.13, §14). The socket.io auth
   * payload (`handshake.auth.token`) is preferred, falling back to an
   * `Authorization: Bearer …` upgrade header — accept EITHER, mirroring how the
   * client sends both best-effort. Null when neither carries a token.
   */
  function bearerTokenOf(socket: Socket): string | null {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    const fromPayload = auth?.token;
    if (typeof fromPayload === 'string' && fromPayload.length > 0) return fromPayload;
    const header = socket.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith(BEARER_PREFIX)) {
      const token = header.slice(BEARER_PREFIX.length).trim();
      if (token.length > 0) return token;
    }
    return null;
  }

  /** Resolve the handshake's bearer token to a typed principal, or null. */
  async function resolveBearerPrincipal(socket: Socket): Promise<RealtimePrincipal | null> {
    const token = bearerTokenOf(socket);
    if (!token) return null;
    const resolved = await deps.resolveBearer(token);
    return resolved ? bearerPrincipal(resolved) : null;
  }

  /**
   * Resolve the handshake to its complete principal — the session cookie (web
   * SPA) first, then a bearer token (mobile). The two are mutually exclusive in practice
   * (the SPA holds only a cookie, the app only a token); trying the cookie first
   * keeps the web path byte-identical and never touches the bearer services for
   * a cookie request. Both credentials pass through ONE gate below.
   */
  async function authenticate(socket: Socket): Promise<RealtimePrincipal | null> {
    return (await resolveCookiePrincipal(socket)) ?? (await resolveBearerPrincipal(socket));
  }

  /** Session principals have the whole first-party surface; bearer scopes gate every family. */
  function hasCapability(
    principal: RealtimePrincipal,
    capability: RealtimeBearerCapability,
  ): boolean {
    return (
      principal.kind === 'session' ||
      scopeSatisfies(principal.scopes, REALTIME_BEARER_SCOPE_REQUIREMENTS[capability])
    );
  }

  async function handleRoomJoin(
    socket: Socket,
    principal: RealtimePrincipal,
    payload: unknown,
    ack: unknown,
  ): Promise<void> {
    const respond = (result: RealtimeRoomAck): void => {
      if (typeof ack === 'function') (ack as (result: RealtimeRoomAck) => void)(result);
    };
    const parsed = realtimeRoomRequestSchema.safeParse(payload);
    if (!parsed.success) {
      // Covers malformed frames AND any attempt to join a `user:{id}` room —
      // 'user' is not a joinable kind, so admission stays connect-time only.
      respond({ ok: false, error: 'BAD_REQUEST' });
      return;
    }
    const { room } = parsed.data;
    if (room.kind === 'asset' && !hasCapability(principal, 'assetRoom')) {
      respond({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    if (room.kind === 'portfolio') {
      if (!hasCapability(principal, 'portfolioRoom')) {
        respond({ ok: false, error: 'FORBIDDEN' });
        return;
      }
      // Owner-or-shared, recomputed at join time — revoking a share stops new
      // joins immediately (§6.9). Errors fail closed.
      const allowed = await deps.canViewPortfolio(principal.userId, room.id).catch(() => false);
      if (!allowed) {
        respond({ ok: false, error: 'FORBIDDEN' });
        return;
      }
    }
    await socket.join(roomName(room));
    respond({ ok: true });
  }

  async function handleRoomLeave(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
    const respond = (result: RealtimeRoomAck): void => {
      if (typeof ack === 'function') (ack as (result: RealtimeRoomAck) => void)(result);
    };
    const parsed = realtimeRoomRequestSchema.safeParse(payload);
    if (!parsed.success) {
      respond({ ok: false, error: 'BAD_REQUEST' });
      return;
    }
    await socket.leave(roomName(parsed.data.room));
    respond({ ok: true });
  }

  /**
   * The assets this socket holds a live watch on (one registration each,
   * §6.3): the resolved provider ref (re-watches and stitched backfills reuse
   * it without re-resolving) and the rate registered with the shared loop —
   * an unwatch must release exactly the rate it registered (#372).
   */
  type LiveWatchEntry = { ref: AssetRef; rateMs: number | undefined };
  const liveAssetsOf = (socket: Socket): Map<string, LiveWatchEntry> =>
    (socket.data.liveAssets as Map<string, LiveWatchEntry> | undefined) ??
    (socket.data.liveAssets = new Map<string, LiveWatchEntry>());

  /**
   * Serialize a socket's live-mode ops. `live.watch` awaits an asset resolve
   * between reading and writing the socket's watch set, and clients re-emit
   * watches (window switch, remount) without awaiting the previous ack — so
   * un-serialized handlers can interleave at that await: two watches would both
   * register with the shared loop while the set holds ONE entry, leaking an
   * upstream poll loop no unwatch/disconnect can ever release (§5.3), and an
   * unwatch overtaking an in-flight watch would no-op. Running watch, unwatch
   * and disconnect-cleanup one-at-a-time per socket (errors don't stall the
   * chain) makes each op see settled state.
   */
  function enqueueLiveOp(socket: Socket, op: () => Promise<void>): Promise<void> {
    const prev = (socket.data.liveOpQueue as Promise<void> | undefined) ?? Promise.resolve();
    const next = prev.then(op);
    socket.data.liveOpQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * `live.watch` (§6.3, V3-P7b; rates per #372): first watch per socket
   * registers its requested rate with the shared loop and joins the
   * `asset:{id}` room for `live.frame` fan-out; a repeat watch (window or rate
   * switch) only re-backfills and — when the rate changed — re-registers this
   * socket's rate (new first, then old, so the loop never dips to zero and
   * restarts). The ack carries the requested window, oldest first: ring frames
   * preceded by a history-stitched seed when the ring falls short.
   */
  async function handleLiveWatch(
    socket: Socket,
    principal: RealtimePrincipal,
    payload: unknown,
    ack: unknown,
  ): Promise<void> {
    const respond = (result: RealtimeLiveWatchAck): void => {
      if (typeof ack === 'function') (ack as (result: RealtimeLiveWatchAck) => void)(result);
    };
    const parsed = realtimeLiveWatchRequestSchema.safeParse(payload);
    if (!parsed.success) {
      respond({ ok: false, error: 'BAD_REQUEST' });
      return;
    }
    if (!hasCapability(principal, 'liveWatch')) {
      respond({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    const liveMode = deps.liveMode;
    if (!liveMode) {
      respond({ ok: false, error: 'UNAVAILABLE' });
      return;
    }
    // Runtime kill-switch (§13.5 V5-P2 arc (c)): `liveMode` flipped OFF stops new
    // watches on the next op; the SPA falls back to its poll cadence.
    if (!(await featureEnabled('liveMode'))) {
      respond({ ok: false, error: 'UNAVAILABLE' });
      return;
    }
    const { assetId, window } = parsed.data;
    // No requested rate ⇒ undefined, so the live-mode service's configured
    // default applies (contract {@link DEFAULT_LIVE_RATE} in production).
    const rateMs = parsed.data.rate === undefined ? undefined : LIVE_RATE_MS[parsed.data.rate];
    const watched = liveAssetsOf(socket);
    let entry = watched.get(assetId);
    if (!entry) {
      const ref = await deps.resolveWatchableAsset(principal.userId, assetId).catch(() => null);
      if (!ref) {
        // Missing and someone-else's-custom look identical (§10). Fails closed.
        respond({ ok: false, error: 'NOT_FOUND' });
        return;
      }
      if (socket.disconnected) {
        // The socket vanished during the resolve: registering now would leave a
        // watch the disconnect cleanup (already queued behind this op) has to
        // undo, and the room join would outlive the adapter's own cleanup.
        respond({ ok: false, error: 'GONE' });
        return;
      }
      liveMode.watch(assetId, ref, rateMs);
      entry = { ref, rateMs };
      watched.set(assetId, entry);
      await socket.join(assetRoom(assetId));
    } else if (entry.rateMs !== rateMs) {
      liveMode.watch(assetId, entry.ref, rateMs);
      liveMode.unwatch(assetId, entry.rateMs);
      entry.rateMs = rateMs;
    }
    const frames = await liveMode.backfill(assetId, entry.ref, window);
    // The oldest frame is the earliest instant the backfill honestly covers
    // (§13.5 V5-P1 §5): when the seed reaches the window start it is ~now−window,
    // when history is genuinely short (new listing, market just opened) it is
    // later, and the client renders from here instead of padding an empty edge.
    const coverageFrom = frames[0]?.at;
    respond({ ok: true, frames, coverageFrom });
  }

  /**
   * The presence declarations this socket currently holds, as
   * `"<surface>:<id>"` keys — cleared on explicit leave and on disconnect, so
   * a closed tab can never suppress notifications for up to the TTL (the
   * companion tab's next heartbeat restores its own claim within seconds).
   */
  const presenceOf = (socket: Socket): Set<string> =>
    (socket.data.presence as Set<string> | undefined) ?? (socket.data.presence = new Set<string>());

  async function handlePresence(
    socket: Socket,
    principal: RealtimePrincipal,
    payload: unknown,
    ack: unknown,
    mode: 'enter' | 'leave',
  ): Promise<void> {
    const respond = (result: RealtimeRoomAck): void => {
      if (typeof ack === 'function') (ack as (result: RealtimeRoomAck) => void)(result);
    };
    const parsed = realtimePresenceRequestSchema.safeParse(payload);
    if (!parsed.success) {
      respond({ ok: false, error: 'BAD_REQUEST' });
      return;
    }
    if (!hasCapability(principal, 'chatPresence')) {
      respond({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    const { surface, id } = parsed.data;
    if (mode === 'enter') {
      // Idempotent — a re-enter IS the heartbeat that keeps the TTL alive.
      await deps.presence.enter(principal.userId, surface, id);
      presenceOf(socket).add(`${surface}:${id}`);
    } else {
      await deps.presence.leave(principal.userId, surface, id);
      presenceOf(socket).delete(`${surface}:${id}`);
    }
    respond({ ok: true });
  }

  /** Drop every presence claim a vanished socket still holds (best-effort —
   *  the TTL is the backstop when even this cleanup is unreachable). */
  async function clearPresence(socket: Socket, userId: string): Promise<void> {
    const held = presenceOf(socket);
    for (const key of held) {
      const [surface, id] = key.split(/:(.+)/, 2) as [PresenceSurface, string];
      await deps.presence.leave(userId, surface, id).catch(() => undefined);
    }
    held.clear();
  }

  async function handleLiveUnwatch(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
    const respond = (result: RealtimeRoomAck): void => {
      if (typeof ack === 'function') (ack as (result: RealtimeRoomAck) => void)(result);
    };
    const parsed = realtimeLiveUnwatchRequestSchema.safeParse(payload);
    if (!parsed.success) {
      respond({ ok: false, error: 'BAD_REQUEST' });
      return;
    }
    const { assetId } = parsed.data;
    // Idempotent: only a held watch releases its registration (and room seat).
    const entry = liveAssetsOf(socket).get(assetId);
    if (entry) {
      liveAssetsOf(socket).delete(assetId);
      deps.liveMode?.unwatch(assetId, entry.rateMs);
      await socket.leave(assetRoom(assetId));
    }
    respond({ ok: true });
  }

  const USER_EVENT_CAPABILITIES = [
    'notificationNew',
    'portfolioChanged',
    'chatMessage',
  ] as const satisfies readonly RealtimeBearerCapability[];

  const principalOf = (socket: Socket): RealtimePrincipal | null =>
    (socket.data.principal as RealtimePrincipal | undefined) ?? null;

  async function joinPrincipalRooms(socket: Socket, principal: RealtimePrincipal): Promise<void> {
    if (principal.kind === 'session') {
      await socket.join(userRoom(principal.userId));
      return;
    }
    const rooms = USER_EVENT_CAPABILITIES.filter((capability) =>
      hasCapability(principal, capability),
    ).map((capability) => scopedUserRoom(principal.userId, capability));
    if (rooms.length > 0) await socket.join(rooms);
  }

  function clearPrincipalExpiry(socket: Socket): void {
    const timer = socket.data.principalExpiryTimer as ReturnType<typeof setTimeout> | undefined;
    if (timer) clearTimeout(timer);
    delete socket.data.principalExpiryTimer;
  }

  function schedulePrincipalExpiry(socket: Socket, principal: RealtimePrincipal): void {
    clearPrincipalExpiry(socket);
    if (socket.disconnected || principal.expiresAt === null) return;
    const deadline = Date.parse(principal.expiresAt);
    if (!Number.isFinite(deadline)) {
      socket.disconnect(true);
      return;
    }
    // Session deadlines can exceed Node's maximum timeout. Revalidate at the
    // safe cap and schedule the remaining time from the fresh principal.
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, deadline - Date.now() + 1));
    const timer = setTimeout(() => {
      void revalidateSocket(socket);
    }, delay);
    timer.unref?.();
    socket.data.principalExpiryTimer = timer;
  }

  function sameScopes(a: RealtimePrincipal['scopes'], b: RealtimePrincipal['scopes']): boolean {
    if (a === 'all' || b === 'all') return a === b;
    return a.length === b.length && a.every((scope) => b.includes(scope));
  }

  function samePrincipalAuthorization(a: RealtimePrincipal, b: RealtimePrincipal): boolean {
    return (
      a.kind === b.kind &&
      a.userId === b.userId &&
      a.userStatus === b.userStatus &&
      a.credentialId === b.credentialId &&
      sameScopes(a.scopes, b.scopes)
    );
  }

  async function withPrincipalRevalidationDeadline<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('realtime principal revalidation timed out'));
      }, REALTIME_PRINCIPAL_REVALIDATION_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Re-resolve an already-connected principal without keeping its plaintext
   * bearer. Any resolver failure, account-status transition, revocation, expiry
   * or effective-scope change disconnects fail closed.
   */
  async function revalidateSocket(socket: Socket): Promise<void> {
    const previous = principalOf(socket);
    if (!previous || socket.disconnected) return;
    let next: RealtimePrincipal | null = null;
    try {
      next = await withPrincipalRevalidationDeadline(async () => {
        if (previous.kind === 'session') {
          const resolved = await deps.resolveSession(previous.sessionId);
          return resolved ? sessionPrincipal(resolved) : null;
        }
        if (previous.kind === 'personal') {
          const resolved = await deps.revalidatePersonal({
            userId: previous.userId,
            keyId: previous.keyId,
          });
          return resolved ? bearerPrincipal(resolved) : null;
        }
        const resolved = await deps.revalidateOAuth({
          userId: previous.userId,
          grantId: previous.grantId,
          accessTokenId: previous.accessTokenId,
          expiresAt: previous.expiresAt,
          scopes: previous.scopes,
        });
        return resolved ? bearerPrincipal(resolved) : null;
      });
    } catch (err) {
      logger.warn(
        { err, userId: previous.userId, kind: previous.kind },
        'realtime principal revalidation failed',
      );
      if (!socket.disconnected) socket.disconnect(true);
      return;
    }
    // A lifecycle invalidation or another fail-closed path may have disconnected
    // the socket while its resolver was in flight. Never let late settlement
    // mutate socket state or install a fresh expiry timer.
    if (socket.disconnected) return;
    if (!next || !samePrincipalAuthorization(previous, next)) {
      socket.disconnect(true);
      return;
    }
    socket.data.principal = next;
    schedulePrincipalExpiry(socket, next);
  }

  function startPrincipalRevalidation(server: SocketIOServer): void {
    if (principalRevalidationTimer) return;
    principalRevalidationTimer = setInterval(() => {
      if (principalRevalidationRunning) return;
      principalRevalidationRunning = true;
      void Promise.allSettled(
        [...server.sockets.sockets.values()].map((socket) => revalidateSocket(socket)),
      ).finally(() => {
        principalRevalidationRunning = false;
      });
    }, REALTIME_PRINCIPAL_REVALIDATION_INTERVAL_MS);
    principalRevalidationTimer.unref?.();
  }

  function stopPrincipalRevalidation(): void {
    if (principalRevalidationTimer) clearInterval(principalRevalidationTimer);
    principalRevalidationTimer = null;
    principalRevalidationRunning = false;
  }

  function matchesInvalidation(
    principal: RealtimePrincipal,
    event: RealtimePrincipalInvalidatedEvent,
  ): boolean {
    if (principal.userId !== event.userId) return false;
    if (event.kind === 'all') return true;
    if (principal.kind !== event.kind) return false;
    if (event.exceptCredentialId === principal.credentialId) return false;
    return event.credentialId === null || event.credentialId === principal.credentialId;
  }

  function disconnectInvalidatedSockets(
    server: SocketIOServer,
    event: RealtimePrincipalInvalidatedEvent,
  ): void {
    for (const socket of server.sockets.sockets.values()) {
      const principal = principalOf(socket);
      if (principal && matchesInvalidation(principal, event)) socket.disconnect(true);
    }
  }

  function emitUserCapability(
    server: SocketIOServer,
    userId: string,
    capability: (typeof USER_EVENT_CAPABILITIES)[number],
    event: string,
    payload: unknown,
  ): void {
    // Cookie sessions occupy `user:{id}`; bearer principals only enter the
    // capability-specific companion room, never the undifferentiated one.
    server.to(userRoom(userId)).to(scopedUserRoom(userId, capability)).emit(event, payload);
  }

  /** Bridge the typed domain events into room emissions (§4.5). */
  async function subscribeBus(server: SocketIOServer): Promise<void> {
    unsubscribers.push(
      await bus.subscribe('notification.created', (event) => {
        const payload: RealtimeNotificationNew = {
          notificationId: event.notificationId,
          occurredAt: event.occurredAt,
        };
        emitUserCapability(
          server,
          event.userId,
          'notificationNew',
          REALTIME_SERVER_EVENTS.notificationNew,
          payload,
        );
      }),
    );
    unsubscribers.push(
      await bus.subscribe('quote.updated', (event) => {
        const payload: RealtimeQuoteUpdated = {
          assetId: event.assetId,
          occurredAt: event.occurredAt,
        };
        server.to(assetRoom(event.assetId)).emit(REALTIME_SERVER_EVENTS.quoteUpdated, payload);
      }),
    );
    unsubscribers.push(
      await bus.subscribe('portfolio.changed', (event) => {
        const payload: RealtimePortfolioChanged = {
          portfolioId: event.portfolioId,
          occurredAt: event.occurredAt,
        };
        // Owner's cookie tabs + scoped portfolio bearers + any admitted shared
        // viewers. `.to().to()` targets the union and Socket.IO dedupes seats.
        server
          .to(userRoom(event.userId))
          .to(scopedUserRoom(event.userId, 'portfolioChanged'))
          .to(portfolioRoom(event.portfolioId))
          .emit(REALTIME_SERVER_EVENTS.portfolioChanged, payload);
      }),
    );
    unsubscribers.push(
      await bus.subscribe('chat.message', (event) => {
        // → the RECIPIENT's own room only (§13.3 V3-P8). A lightweight
        // invalidation signal: the body/chip never cross here, so the client's
        // thread refetch re-resolves the chip through the enforcement layer.
        // Independent of the notification matrix — a muted chat.message still
        // arrives in the thread.
        const payload: RealtimeChatMessage = {
          conversationId: event.conversationId,
          messageId: event.messageId,
          senderId: event.senderId,
          occurredAt: event.occurredAt,
        };
        emitUserCapability(
          server,
          event.userId,
          'chatMessage',
          REALTIME_SERVER_EVENTS.chatMessage,
          payload,
        );
      }),
    );
    unsubscribers.push(
      await bus.subscribe('realtime.principal.invalidated', (event) => {
        disconnectInvalidatedSockets(server, event);
      }),
    );
  }

  return {
    async attach(server: HttpServer): Promise<void> {
      if (!config.realtime.enabled || io) return;
      io = new SocketIOServer(server, {
        path: REALTIME_PATH,
        serveClient: false,
        // Accept a direct websocket first-connect (the mobile app dials the
        // websocket transport with no prior polling handshake) AND the
        // polling→websocket upgrade the web SPA's socket.io-client performs.
        // This is the socket.io default, pinned explicitly so websocket-first is
        // a supported, tested path that never rides on a library default (§4.5).
        transports: ['polling', 'websocket'],
        // Engine.IO handles its own CORS (the Express middleware never sees
        // /ws): same credentialed allowlist as the API (§4.6, §10).
        cors: { origin: config.corsOrigins, credentials: true },
      });

      io.use((socket, next) => {
        // Runtime kill-switch (§13.5 V5-P2 arc (c)): with `realtime` flipped OFF
        // the gateway refuses new sockets on the very next handshake — no
        // redeploy. The SPA also stops dialing once it reads the advertised flag;
        // this is the server-side backstop for a stale client or a direct dial.
        featureEnabled('realtime')
          .then((on) => {
            if (!on) {
              next(new Error('UNAVAILABLE'));
              return undefined;
            }
            return authenticate(socket).then((principal) => {
              if (!principal) {
                next(new Error('UNAUTHORIZED'));
                return;
              }
              socket.data.principal = principal;
              next();
            });
          })
          .catch((err) => {
            logger.warn({ err }, 'realtime handshake auth failed');
            next(new Error('UNAUTHORIZED'));
          });
      });

      io.on('connection', (socket) => {
        const principal = principalOf(socket);
        if (!principal) {
          socket.disconnect(true);
          return;
        }
        const { userId } = principal;
        void joinPrincipalRooms(socket, principal).catch((err) => {
          logger.warn({ err, userId, kind: principal.kind }, 'realtime principal room join failed');
          socket.disconnect(true);
        });
        schedulePrincipalExpiry(socket, principal);

        socket.on(REALTIME_CLIENT_EVENTS.roomJoin, (payload: unknown, ack: unknown) => {
          void handleRoomJoin(socket, principal, payload, ack).catch((err) => {
            logger.warn({ err, userId }, 'realtime room join failed');
          });
        });
        socket.on(REALTIME_CLIENT_EVENTS.roomLeave, (payload: unknown, ack: unknown) => {
          void handleRoomLeave(socket, payload, ack).catch((err) => {
            logger.warn({ err, userId }, 'realtime room leave failed');
          });
        });
        socket.on(REALTIME_CLIENT_EVENTS.liveWatch, (payload: unknown, ack: unknown) => {
          void enqueueLiveOp(socket, () => handleLiveWatch(socket, principal, payload, ack)).catch(
            (err) => {
              logger.warn({ err, userId }, 'live watch failed');
            },
          );
        });
        socket.on(REALTIME_CLIENT_EVENTS.liveUnwatch, (payload: unknown, ack: unknown) => {
          void enqueueLiveOp(socket, () => handleLiveUnwatch(socket, payload, ack)).catch((err) => {
            logger.warn({ err, userId }, 'live unwatch failed');
          });
        });
        socket.on(REALTIME_CLIENT_EVENTS.presenceEnter, (payload: unknown, ack: unknown) => {
          void handlePresence(socket, principal, payload, ack, 'enter').catch((err) => {
            logger.warn({ err, userId }, 'presence enter failed');
          });
        });
        socket.on(REALTIME_CLIENT_EVENTS.presenceLeave, (payload: unknown, ack: unknown) => {
          void handlePresence(socket, principal, payload, ack, 'leave').catch((err) => {
            logger.warn({ err, userId }, 'presence leave failed');
          });
        });
        // A vanished socket must release its live watches, or a closed tab
        // would keep an upstream loop hot forever (§6.3 auto-stop). Queued so
        // it runs AFTER any in-flight watch registers what it must release.
        // Presence claims clear too — a closed tab must never keep suppressing
        // notifications for the rest of the TTL (#368).
        socket.on('disconnect', () => {
          clearPrincipalExpiry(socket);
          void clearPresence(socket, userId).catch((err) => {
            logger.warn({ err, userId }, 'presence cleanup failed');
          });
          void enqueueLiveOp(socket, async () => {
            for (const [assetId, entry] of liveAssetsOf(socket)) {
              deps.liveMode?.unwatch(assetId, entry.rateMs);
            }
            liveAssetsOf(socket).clear();
          });
        });
      });

      await subscribeBus(io);
      startPrincipalRevalidation(io);
      // Live-frame fan-out (§6.3): every poll tick reaches every viewer in the
      // asset's room — N viewers, one upstream stream.
      if (deps.liveMode) {
        const server = io;
        const offFrames = deps.liveMode.onFrame((frame) => {
          server.to(assetRoom(frame.assetId)).emit(REALTIME_SERVER_EVENTS.liveFrame, frame);
        });
        unsubscribers.push(async () => offFrames());
      }
      logger.info({ path: REALTIME_PATH }, 'realtime gateway attached');
    },

    isAttached(): boolean {
      return io !== null;
    },

    connectionCount(): number {
      return io?.engine?.clientsCount ?? 0;
    },

    async close(): Promise<void> {
      stopPrincipalRevalidation();
      const pending = unsubscribers.splice(0, unsubscribers.length);
      await Promise.allSettled(pending.map((unsubscribe) => unsubscribe()));
      if (!io) return;
      const server = io;
      io = null;
      // Force-disconnect live websockets first — they are not "idle" HTTP
      // connections, so a plain server.close() would wait on them forever.
      server.disconnectSockets(true);
      await new Promise<void>((resolve) => {
        // Also closes the underlying HTTP server; the bootstrap's own
        // server.close() tolerates an already-closed server.
        void server.close(() => resolve());
      });
    },
  };
}
