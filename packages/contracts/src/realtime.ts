import { z } from 'zod';

import { currencyCodeSchema } from './market';

/**
 * Realtime gateway contracts (PROJECTPLAN.md §4.5, V3-P7a) and Live Mode
 * (§6.3, V3-P7b).
 *
 * The Socket.IO endpoint lives at {@link REALTIME_PATH} on the API origin and is
 * authenticated via the session cookie on handshake. These schemas are the
 * single source of truth for every payload crossing the socket in either
 * direction — the API validates client frames against them and the SPA derives
 * its types from them, exactly like the HTTP contracts.
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
} as const;

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
 * One live price observation. Produced once per poll tick by the shared
 * per-asset loop, appended to the Redis ring buffer, and fanned out as
 * `live.frame` to the `asset:{id}` room — N viewers, one upstream stream (§5.3).
 */
export const realtimeLiveFrameSchema = z.object({
  assetId: z.string().uuid(),
  price: z.number(),
  currency: currencyCodeSchema,
  dayChangePct: z.number().nullable(),
  /** When the loop observed this price (ISO-8601, producer-stamped). */
  at: z.string().datetime(),
});
export type RealtimeLiveFrame = z.infer<typeof realtimeLiveFrameSchema>;

/**
 * Payload of `live.watch`. Idempotent per socket per asset: a repeat watch
 * (e.g. a window switch) only re-backfills — the watcher count and the
 * upstream loop are untouched.
 */
export const realtimeLiveWatchRequestSchema = z.object({
  assetId: z.string().uuid(),
  window: liveWindowSchema,
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

/** Server → client event names. */
export const REALTIME_SERVER_EVENTS = {
  notificationNew: 'notification.new',
  quoteUpdated: 'quote.updated',
  portfolioChanged: 'portfolio.changed',
  /** `live.frame` → the `asset:{id}` room, once per shared poll tick (§6.3). */
  liveFrame: 'live.frame',
} as const;
