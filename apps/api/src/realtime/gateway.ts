import type { Server as HttpServer } from 'node:http';

import cookieParser from 'cookie-parser';
import type { RequestHandler } from 'express';
import { Server as SocketIOServer, type Socket } from 'socket.io';

import {
  REALTIME_CLIENT_EVENTS,
  REALTIME_PATH,
  REALTIME_SERVER_EVENTS,
  realtimeLiveUnwatchRequestSchema,
  realtimeLiveWatchRequestSchema,
  realtimeRoomRequestSchema,
  type AssetRef,
  type RealtimeChatMessage,
  type RealtimeLiveWatchAck,
  type RealtimeNotificationNew,
  type RealtimePortfolioChanged,
  type RealtimeQuoteUpdated,
  type RealtimeRoom,
  type RealtimeRoomAck,
} from '@bettertrack/contracts';

import type { AppConfig } from '../config/env';
import type { EventBus, Unsubscribe } from '../events';
import type { Logger } from '../logger';
import type { LiveModeService } from '../services/liveMode';

/**
 * Realtime gateway (PROJECTPLAN.md §4.5, V3-P7a): a Socket.IO server at
 * {@link REALTIME_PATH} on the API origin, bridging the typed domain event bus
 * into socket rooms:
 *
 *   - `user:{id}`      — joined automatically at connect, never on request; a
 *                         socket only ever sits in its OWN user room.
 *   - `asset:{id}`     — quote pushes; any authenticated user may join (quotes
 *                         are not per-user data).
 *   - `portfolio:{id}` — shared-view invalidation; joins enforce owner-or-shared
 *                         access, recomputed at join time (§6.9).
 *
 * Handshake auth accepts EITHER of two credentials, resolved to the same user id
 * that then owns the socket's `user:{id}` room:
 *
 *   - the **session cookie** — the web SPA path, resolved through the auth
 *     service's cookie→user resolution (verbatim the HTTP session path); or
 *   - a **bearer token** — the mobile app path (§6.13, §14). It holds no cookie,
 *     so it presents a personal API key (`btk_…`) or a delegated OAuth access
 *     token (`bto_…`) via the socket.io auth payload (`handshake.auth.token`)
 *     and/or an `Authorization: Bearer …` upgrade header. The token is validated
 *     through the SAME service the HTTP bearer middleware uses (revocation,
 *     expiry and consent-scope clamping included), so socket auth can never
 *     drift from — or widen — the HTTP surface. The gateway pushes invalidation
 *     signals only (no data crosses the socket, §13.3), so an authenticated
 *     user in their own room is the correct bar; per-event scope filtering would
 *     over-engineer a socket that already carries nothing sensitive.
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

/** The user room — auto-joined at connect; clients can never request it. */
export const userRoom = (userId: string): string => `user:${userId}`;
export const assetRoom = (assetId: string): string => `asset:${assetId}`;
export const portfolioRoom = (portfolioId: string): string => `portfolio:${portfolioId}`;

function roomName(room: RealtimeRoom): string {
  return room.kind === 'asset' ? assetRoom(room.id) : portfolioRoom(room.id);
}

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
  ): Promise<{ id: string; role: 'user' | 'admin'; mustChangePassword: boolean } | null>;
  /**
   * Bearer token → user resolution — the SAME path the HTTP bearer middleware
   * uses ({@link import('../http/middleware/bearerAuth').loadBearerAuth}): a
   * personal API key (`btk_…`) or a delegated OAuth access token (`bto_…`), with
   * revocation, expiry and consent-scope clamping enforced inside the service.
   * The mobile app authenticates its socket with a bearer because it holds no
   * session cookie (§6.13, §14). Returns null for a missing, malformed, unknown,
   * revoked or expired token — indistinguishable, exactly like the HTTP 401.
   */
  resolveBearer(
    token: string,
  ): Promise<{ id: string; role: 'user' | 'admin'; mustChangePassword: boolean } | null>;
  /** Owner-or-shared access check backing `portfolio:{id}` joins (§6.9). */
  canViewPortfolio(userId: string, portfolioId: string): Promise<boolean>;
  /**
   * Live Mode core (§6.3, V3-P7b): watcher counts + shared poll loops + ring
   * backfill. Null disables the live surface — `live.watch` acks UNAVAILABLE
   * and the SPA silently stays on its 60 s poll fallback.
   */
  liveMode: LiveModeService | null;
  /**
   * Resolve an asset the user may view (global or their own custom asset,
   * §10) to its provider ref for the poll loop; null when missing/foreign —
   * indistinguishable, exactly like the HTTP 404 (§10 no-leak rule).
   */
  resolveWatchableAsset(userId: string, assetId: string): Promise<AssetRef | null>;
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
  /** Disconnect all clients, drop bus subscriptions, close the socket server. */
  close(): Promise<void>;
}

export function createRealtimeGateway(deps: RealtimeGatewayDeps): RealtimeGateway {
  const { config, bus, logger } = deps;
  let io: SocketIOServer | null = null;
  const unsubscribers: Unsubscribe[] = [];

  // The exact cookie-parser the Express app mounts: same signing secrets, same
  // rotation behavior. Run over the raw handshake request so `signedCookies`
  // resolves identically to an HTTP request.
  const parseCookies: RequestHandler = cookieParser(config.sessionSecrets);

  type ResolvedUser = { id: string; role: 'user' | 'admin'; mustChangePassword: boolean };
  const BEARER_PREFIX = 'Bearer ';

  /** Resolve the handshake's session cookie to a user-app account, or null. */
  async function resolveCookieUser(socket: Socket): Promise<ResolvedUser | null> {
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
    return deps.resolveSession(sessionId, socket.handshake.headers['user-agent'] ?? null);
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

  /** Resolve the handshake's bearer token to a user-app account, or null. */
  async function resolveBearerUser(socket: Socket): Promise<ResolvedUser | null> {
    const token = bearerTokenOf(socket);
    if (!token) return null;
    return deps.resolveBearer(token);
  }

  /**
   * Resolve the handshake to a user id — the session cookie (web SPA) first,
   * then a bearer token (mobile). The two are mutually exclusive in practice
   * (the SPA holds only a cookie, the app only a token); trying the cookie first
   * keeps the web path byte-identical and never touches the bearer services for
   * a cookie request. Both credentials pass through ONE gate below.
   */
  async function authenticate(socket: Socket): Promise<string | null> {
    const user = (await resolveCookieUser(socket)) ?? (await resolveBearerUser(socket));
    if (!user) return null;
    // Mirror the user-app HTTP surface: admin-kind accounts have no user surface
    // (§3, requireUser) and a forced-password-change principal is locked out of
    // everything except the change flow (§6.1). Applied identically to cookie-
    // and bearer-authenticated sockets so socket auth never widens HTTP auth.
    if (user.role !== 'user' || user.mustChangePassword) return null;
    return user.id;
  }

  async function handleRoomJoin(
    socket: Socket,
    userId: string,
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
    if (room.kind === 'portfolio') {
      // Owner-or-shared, recomputed at join time — revoking a share stops new
      // joins immediately (§6.9). Errors fail closed.
      const allowed = await deps.canViewPortfolio(userId, room.id).catch(() => false);
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

  /** The assets this socket holds a live watch on (one count each, §6.3). */
  const liveAssetsOf = (socket: Socket): Set<string> =>
    (socket.data.liveAssets as Set<string> | undefined) ??
    (socket.data.liveAssets = new Set<string>());

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
   * `live.watch` (§6.3, V3-P7b): first watch per socket registers with the
   * shared loop and joins the `asset:{id}` room for `live.frame` fan-out; a
   * repeat watch (window switch) only re-backfills — the loop never restarts.
   * The ack carries the requested window from the ring buffer, oldest first.
   */
  async function handleLiveWatch(
    socket: Socket,
    userId: string,
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
    const liveMode = deps.liveMode;
    if (!liveMode) {
      respond({ ok: false, error: 'UNAVAILABLE' });
      return;
    }
    const { assetId, window } = parsed.data;
    const watched = liveAssetsOf(socket);
    if (!watched.has(assetId)) {
      const ref = await deps.resolveWatchableAsset(userId, assetId).catch(() => null);
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
      liveMode.watch(assetId, ref);
      watched.add(assetId);
      await socket.join(assetRoom(assetId));
    }
    const frames = await liveMode.backfill(assetId, window);
    respond({ ok: true, frames });
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
    // Idempotent: only a held watch releases a count (and the room seat).
    if (liveAssetsOf(socket).delete(assetId)) {
      deps.liveMode?.unwatch(assetId);
      await socket.leave(assetRoom(assetId));
    }
    respond({ ok: true });
  }

  /** Bridge the typed domain events into room emissions (§4.5). */
  async function subscribeBus(server: SocketIOServer): Promise<void> {
    unsubscribers.push(
      await bus.subscribe('notification.created', (event) => {
        const payload: RealtimeNotificationNew = {
          notificationId: event.notificationId,
          occurredAt: event.occurredAt,
        };
        server.to(userRoom(event.userId)).emit(REALTIME_SERVER_EVENTS.notificationNew, payload);
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
        // Owner's own tabs + any admitted shared viewers; `.to().to()` targets
        // the union and Socket.IO dedupes sockets sitting in both rooms.
        server
          .to(userRoom(event.userId))
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
        server.to(userRoom(event.userId)).emit(REALTIME_SERVER_EVENTS.chatMessage, payload);
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
        authenticate(socket)
          .then((userId) => {
            if (!userId) {
              next(new Error('UNAUTHORIZED'));
              return;
            }
            socket.data.userId = userId;
            next();
          })
          .catch((err) => {
            logger.warn({ err }, 'realtime handshake auth failed');
            next(new Error('UNAUTHORIZED'));
          });
      });

      io.on('connection', (socket) => {
        const userId = socket.data.userId as string;
        void socket.join(userRoom(userId));

        socket.on(REALTIME_CLIENT_EVENTS.roomJoin, (payload: unknown, ack: unknown) => {
          void handleRoomJoin(socket, userId, payload, ack).catch((err) => {
            logger.warn({ err, userId }, 'realtime room join failed');
          });
        });
        socket.on(REALTIME_CLIENT_EVENTS.roomLeave, (payload: unknown, ack: unknown) => {
          void handleRoomLeave(socket, payload, ack).catch((err) => {
            logger.warn({ err, userId }, 'realtime room leave failed');
          });
        });
        socket.on(REALTIME_CLIENT_EVENTS.liveWatch, (payload: unknown, ack: unknown) => {
          void enqueueLiveOp(socket, () => handleLiveWatch(socket, userId, payload, ack)).catch(
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
        // A vanished socket must release its live watches, or a closed tab
        // would keep an upstream loop hot forever (§6.3 auto-stop). Queued so
        // it runs AFTER any in-flight watch registers what it must release.
        socket.on('disconnect', () => {
          void enqueueLiveOp(socket, async () => {
            for (const assetId of liveAssetsOf(socket)) deps.liveMode?.unwatch(assetId);
            liveAssetsOf(socket).clear();
          });
        });
      });

      await subscribeBus(io);
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

    async close(): Promise<void> {
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
