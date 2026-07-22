import { z } from 'zod';

import { currencyCodeSchema, marketStateSchema } from './market';

/**
 * Realtime gateway contracts (PROJECTPLAN.md §4.5, V3-P7a) and Live Mode
 * (§6.3, V3-P7b).
 *
 * The Socket.IO endpoint lives at {@link REALTIME_PATH} on the API origin. These
 * schemas are the single source of truth for every payload crossing the socket
 * in either direction — the API validates client frames against them and the SPA
 * derives its types from them, exactly like the HTTP contracts.
 *
 * ── Handshake auth ──────────────────────────────────────────────────────────
 * The handshake authenticates with EITHER credential, resolved to the user id
 * that owns the socket's `user:{id}` room:
 *
 *   - **Session cookie** — the web SPA path: the signed session cookie, resolved
 *     through the auth service's cookie→user resolution (verbatim the HTTP path).
 *   - **Bearer token** — the mobile path (§6.13, §14): the app holds no cookie,
 *     so it presents a personal API key (`btk_…`) or a delegated OAuth access
 *     token (`bto_…`) via the socket.io auth payload (`handshake.auth.token`)
 *     and/or an `Authorization: Bearer …` upgrade header (either is accepted).
 *     The token is validated through the SAME service the HTTP bearer middleware
 *     uses — revocation, expiry and consent-scope clamping included — so socket
 *     auth never drifts from, or widens, the HTTP surface. Because the gateway
 *     pushes invalidation signals only (no data crosses the socket; the client
 *     refetches each payload through the HTTP enforcement layer), an
 *     authenticated user in their own room is the correct bar — the gateway does
 *     no per-event scope filtering.
 *
 * ── Transports ──────────────────────────────────────────────────────────────
 * Both Engine.IO transports are supported: a client may open the websocket
 * transport directly (the mobile app dials `?EIO=4&transport=websocket` with no
 * prior polling handshake) or take the polling→websocket upgrade the web SPA
 * performs. A literal HTTP 400 (`{"code":3}`) on `transport=websocket` means the
 * request reached Engine.IO WITHOUT a valid WebSocket upgrade (typically a
 * reverse proxy not forwarding the `Upgrade`/`Connection` headers) — the gateway
 * itself accepts websocket-first connections.
 *
 * The gateway is an enhancement layer: every push maps to a TanStack Query
 * cache invalidation on the client, and the SPA's poll/refetch behavior stays
 * fully functional when the socket is absent (flag off, gateway down,
 * reconnecting).
 */

/** Socket.IO `path` for the realtime gateway on the API origin (§4.5). */
export const REALTIME_PATH = '/ws';

// ── Rooms ────────────────────────────────────────────────────────────────────

/**
 * The client-joinable rooms (§4.5). `user:{id}` is deliberately absent: the
 * gateway admits a socket to its own user room at connect time and a client can
 * never request admission to one, so "only its own user room" holds by
 * construction.
 */
export const REALTIME_JOINABLE_ROOM_KINDS = ['asset', 'portfolio'] as const;

export const realtimeRoomSchema = z.object({
  kind: z.enum(REALTIME_JOINABLE_ROOM_KINDS),
  id: z.string().uuid(),
});
export type RealtimeRoom = z.infer<typeof realtimeRoomSchema>;

// ── Client → server ──────────────────────────────────────────────────────────

/** Payload of `room.join` / `room.leave`. */
export const realtimeRoomRequestSchema = z.object({
  room: realtimeRoomSchema,
});
export type RealtimeRoomRequest = z.infer<typeof realtimeRoomRequestSchema>;

/** Ack returned for `room.join` / `room.leave`. */
export const realtimeRoomAckSchema = z.object({
  ok: z.boolean(),
  /** Machine-readable reason when `ok` is false (e.g. `FORBIDDEN`, `BAD_REQUEST`). */
  error: z.string().optional(),
});
export type RealtimeRoomAck = z.infer<typeof realtimeRoomAckSchema>;

/** Client → server event names. */
export const REALTIME_CLIENT_EVENTS = {
  roomJoin: 'room.join',
  roomLeave: 'room.leave',
  liveWatch: 'live.watch',
  liveUnwatch: 'live.unwatch',
  presenceEnter: 'presence.enter',
  presenceLeave: 'presence.leave',
} as const;

// ── Active-view presence (#368 Notifications v2) ─────────────────────────────

/**
 * Surfaces a client can declare itself actively viewing. The notification
 * dispatcher suppresses sends about a surface its recipient currently has open
 * (v1: a chat conversation — no bell/email/push for the thread you're reading).
 */
export const PRESENCE_SURFACES = ['chat'] as const;
export const presenceSurfaceSchema = z.enum(PRESENCE_SURFACES);
export type PresenceSurface = z.infer<typeof presenceSurfaceSchema>;

/**
 * Server-side TTL of one presence signal. A client that vanishes without
 * `presence.leave` (crash, dropped socket, backgrounded app) auto-clears when
 * the TTL lapses — the dispatcher can never suppress on presence staler than
 * this. Clients keep it alive by re-emitting `presence.enter` (idempotent)
 * every {@link PRESENCE_HEARTBEAT_MS} while the surface stays open + focused.
 */
export const PRESENCE_TTL_SECONDS = 60;
export const PRESENCE_HEARTBEAT_MS = 25_000;

/**
 * `presence.enter` / `presence.leave` payload: the surface the authed user is
 * viewing (enter = viewing + focused, re-emitted as heartbeat; leave = closed
 * or blurred). Both are per-user + per-subject; both ack `{ok}`.
 */
export const realtimePresenceRequestSchema = z
  .object({ surface: presenceSurfaceSchema, id: z.string().uuid() })
  .strict();
export type RealtimePresenceRequest = z.infer<typeof realtimePresenceRequestSchema>;

// ── Live Mode (§6.3, V3-P7b) ─────────────────────────────────────────────────

/**
 * The short real-time windows Live Mode offers on the asset chart (§6.3).
 * A window only scopes how much ring-buffer history a viewer is backfilled
 * with — switching it never touches the shared upstream polling loop.
 */
export const LIVE_WINDOWS = ['1m', '10m', '30m', '1h', '3h', '12h'] as const;

export const liveWindowSchema = z.enum(LIVE_WINDOWS);
export type LiveWindow = z.infer<typeof liveWindowSchema>;

/** Each live window's span in milliseconds (backfill cutoff + client trim). */
export const LIVE_WINDOW_MS: Record<LiveWindow, number> = {
  '1m': 60_000,
  '10m': 600_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '3h': 10_800_000,
  '12h': 43_200_000,
};

/**
 * The refresh rates a viewer may request for a live watch (#372), down to 1 s.
 * The rate is a REQUEST, not a promise: one shared per-asset loop serves all
 * viewers and polls at the finest rate any ACTIVE viewer requested — the
 * minimum, never a common divisor (4 s + 2 s viewers ⇒ one 2 s loop, NOT 1 s).
 * Viewers coarser than the loop downsample client-side; nobody's request ever
 * makes upstream calls faster than the fastest active viewer needs.
 */
export const LIVE_RATES = ['1s', '2s', '5s', '10s', '30s', '60s'] as const;

export const liveRateSchema = z.enum(LIVE_RATES);
export type LiveRate = z.infer<typeof liveRateSchema>;

/** Each live rate's poll interval in milliseconds. */
export const LIVE_RATE_MS: Record<LiveRate, number> = {
  '1s': 1_000,
  '2s': 2_000,
  '5s': 5_000,
  '10s': 10_000,
  '30s': 30_000,
  '60s': 60_000,
};

/** Applied when a watch omits `rate` (pre-#372 clients keep today's cadence). */
export const DEFAULT_LIVE_RATE: LiveRate = '10s';

/**
 * One live price observation. Produced once per poll tick by the shared
 * per-asset loop, appended to the Redis ring buffer, and fanned out as
 * `live.frame` to the `asset:{id}` room — N viewers, one upstream stream (§5.3).
 */
export const realtimeLiveFrameSchema = z.object({
  assetId: z.string().uuid(),
  price: z.number(),
  currency: currencyCodeSchema,
  dayChangePct: z.number().nullable(),
  /**
   * The exchange session the loop observed this price in (§13.5 V5-P1): drives
   * the chart's "Market closed" state when no ticks arrive. Null on a
   * history-stitched seed and whenever the provider does not report it.
   */
  marketState: marketStateSchema.nullable().optional(),
  /** When the loop observed this price (ISO-8601, producer-stamped). */
  at: z.string().datetime(),
  /**
   * True on a history-stitched seed frame (#372): the watch ack prepends the
   * tail of provider history when the ring buffer does not reach back to the
   * requested window's start. Seeds never stream — live ticks age them out of
   * the window until it is 100 % real observations.
   */
  seed: z.boolean().optional(),
});
export type RealtimeLiveFrame = z.infer<typeof realtimeLiveFrameSchema>;

/**
 * Payload of `live.watch`. Idempotent per socket per asset: a repeat watch
 * (e.g. a window switch) only re-backfills — the watcher count is untouched.
 * A repeat watch MAY carry a new `rate`; the socket's registered rate moves
 * with it and the shared loop re-derives its finest-active cadence (#372).
 * `rate` omitted ⇒ {@link DEFAULT_LIVE_RATE}.
 */
export const realtimeLiveWatchRequestSchema = z.object({
  assetId: z.string().uuid(),
  window: liveWindowSchema,
  rate: liveRateSchema.optional(),
});
export type RealtimeLiveWatchRequest = z.infer<typeof realtimeLiveWatchRequestSchema>;

/**
 * Ack returned for `live.watch`: on success, the requested window backfilled
 * from the ring buffer (oldest first); live frames stream after it.
 */
export const realtimeLiveWatchAckSchema = z.object({
  ok: z.boolean(),
  /** Machine-readable reason when `ok` is false (e.g. `NOT_FOUND`, `UNAVAILABLE`). */
  error: z.string().optional(),
  frames: z.array(realtimeLiveFrameSchema).optional(),
  /**
   * The earliest instant the backfill honestly covers (ISO-8601) — the oldest
   * frame's timestamp (§13.5 V5-P1 §5). When less history exists than the
   * requested window reaches back to (a new listing, market just opened), this
   * is later than `now − window`, so the client renders honestly from here
   * instead of padding an empty left edge. Absent when the backfill is empty.
   */
  coverageFrom: z.string().datetime().optional(),
});
export type RealtimeLiveWatchAck = z.infer<typeof realtimeLiveWatchAckSchema>;

/** Payload of `live.unwatch`. */
export const realtimeLiveUnwatchRequestSchema = z.object({
  assetId: z.string().uuid(),
});
export type RealtimeLiveUnwatchRequest = z.infer<typeof realtimeLiveUnwatchRequestSchema>;

// ── Server → client ──────────────────────────────────────────────────────────

/** `notification.new` → the bell owner's `user:{id}` room; invalidate the notifications list. */
export const realtimeNotificationNewSchema = z.object({
  notificationId: z.string().uuid(),
  occurredAt: z.string(),
});
export type RealtimeNotificationNew = z.infer<typeof realtimeNotificationNewSchema>;

/** `quote.updated` → the `asset:{id}` room whenever the asset's cached quote refreshes (§5.3). */
export const realtimeQuoteUpdatedSchema = z.object({
  assetId: z.string(),
  occurredAt: z.string(),
});
export type RealtimeQuoteUpdated = z.infer<typeof realtimeQuoteUpdatedSchema>;

/** `portfolio.changed` → the owner's `user:{id}` room and the `portfolio:{id}` room (shared viewers). */
export const realtimePortfolioChangedSchema = z.object({
  portfolioId: z.string().uuid(),
  occurredAt: z.string(),
});
export type RealtimePortfolioChanged = z.infer<typeof realtimePortfolioChangedSchema>;

/**
 * `chat.message` → the RECIPIENT's `user:{id}` room when a friend sends them a
 * chat message (§13.3 V3-P8). Like every other push this is a lightweight
 * invalidation signal — it carries the conversation + message ids only, never
 * the body or a share chip, so the recipient's thread refetch re-resolves each
 * chip through the sharing-enforcement layer (never a pushed snapshot). Delivery
 * is independent of the notification matrix: a `chat.message` the recipient
 * muted still pushes here (the message arrives in the thread) but produces no
 * bell/email.
 */
export const realtimeChatMessageSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  senderId: z.string().uuid(),
  occurredAt: z.string(),
});
export type RealtimeChatMessage = z.infer<typeof realtimeChatMessageSchema>;

/** Server → client event names. */
export const REALTIME_SERVER_EVENTS = {
  notificationNew: 'notification.new',
  quoteUpdated: 'quote.updated',
  portfolioChanged: 'portfolio.changed',
  /** `chat.message` → the recipient's `user:{id}` room on a new friend message (§13.3 V3-P8). */
  chatMessage: 'chat.message',
  /** `live.frame` → the `asset:{id}` room, once per shared poll tick (§6.3). */
  liveFrame: 'live.frame',
} as const;
