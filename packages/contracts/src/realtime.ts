import { z } from 'zod';

/**
 * Realtime gateway contracts (PROJECTPLAN.md §4.5, V3-P7a).
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
} as const;

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
} as const;
