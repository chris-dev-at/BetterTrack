import { z } from 'zod';

/**
 * In-app notifications (PROJECTPLAN.md §6.10, §8). Rows are written by the
 * notification dispatcher (a pure event-bus subscriber); this contract only
 * covers the user-scoped read/mark-read surface the bell UI and Settings →
 * Notifications page consume.
 */

/**
 * The canonical notification-type taxonomy (PROJECTPLAN.md §6.10, #368
 * Notifications v2). ONE list shared by web and mobile (mobile
 * `docs/PUSH_NOTIFICATIONS_FOR_PLATFORM.md` mirrors these exact strings) — every
 * FCM data message carries its `type` verbatim. Each type is a distinct row a
 * user routes independently per channel (in-app / email / phone push / browser
 * push) through the Settings → Notifications grid (`settings.ts`).
 *
 * A muted `chat.message` silences bell/email/push while the message still lands
 * in the open thread (the realtime push is a separate bus consumer).
 */
export const NOTIFICATION_TYPES = [
  'friend.request',
  'friend.accepted',
  'portfolio.shared',
  'watchlist.shared',
  'conglomerate.shared',
  'friend.activity',
  'follow.published',
  'account.invite',
  'account.temp_password',
  'alert.triggered',
  'chat.message',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

/**
 * The settings-grid grouping (#368): rows are notification types grouped by
 * category, each category with a master toggle in the UI. Order here IS the
 * display order. Every {@link NOTIFICATION_TYPES} entry appears exactly once
 * (guarded by a contract test).
 */
export const NOTIFICATION_CATEGORIES = [
  { key: 'social', types: ['friend.request', 'friend.accepted'] },
  {
    key: 'sharing',
    types: [
      'portfolio.shared',
      'watchlist.shared',
      'conglomerate.shared',
      'friend.activity',
      'follow.published',
    ],
  },
  { key: 'chat', types: ['chat.message'] },
  { key: 'alerts', types: ['alert.triggered'] },
  { key: 'account', types: ['account.invite', 'account.temp_password'] },
] as const satisfies readonly { key: string; types: readonly NotificationType[] }[];
export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORIES)[number]['key'];

// ── Device tokens (phone push, #368/#351) ────────────────────────────────────

/** Platforms a push device token can belong to. `web` is reserved for FCM-web. */
export const DEVICE_PLATFORMS = ['android', 'ios', 'web'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
export const devicePlatformSchema = z.enum(DEVICE_PLATFORMS);

/**
 * `POST /notifications/devices` body — idempotent upsert keyed by `token`.
 * Re-registering an existing token refreshes it (and re-binds it to the caller,
 * so a device that logs into another account moves its pushes with it).
 */
export const registerDeviceRequestSchema = z
  .object({
    token: z.string().min(1).max(4096),
    platform: devicePlatformSchema,
  })
  .strict();
export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

/** `DELETE /notifications/devices` body — removes the caller's own token row. */
export const deleteDeviceRequestSchema = z.object({ token: z.string().min(1).max(4096) }).strict();
export type DeleteDeviceRequest = z.infer<typeof deleteDeviceRequestSchema>;

// ── Web-push subscriptions (browser push, #368/#350) ─────────────────────────

/**
 * `POST /notifications/web-push` body — a standard PushSubscription's transport
 * triple, upserted by `endpoint` (re-subscribing refreshes/re-binds like device
 * tokens). The VAPID public key the browser needs is served by
 * `GET /settings/notifications` (`webPushPublicKey`).
 */
export const webPushSubscribeRequestSchema = z
  .object({
    endpoint: z.string().url().max(2048),
    keys: z
      .object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) })
      .strict(),
  })
  .strict();
export type WebPushSubscribeRequest = z.infer<typeof webPushSubscribeRequestSchema>;

/** `DELETE /notifications/web-push` body — drops the caller's own subscription. */
export const webPushUnsubscribeRequestSchema = z
  .object({ endpoint: z.string().url().max(2048) })
  .strict();
export type WebPushUnsubscribeRequest = z.infer<typeof webPushUnsubscribeRequestSchema>;

// ── Archive state + deletion (#437) ──────────────────────────────────────────

/**
 * The three list views (#437). `active` (unarchived) is the DEFAULT, so
 * pre-archive clients (the mobile app in production) keep working unchanged —
 * archived rows simply stop appearing. A row is archived when the user archived
 * it explicitly or when the auto-archive sweep caught it (read more than
 * `AUTO_ARCHIVE_READ_AFTER_DAYS` ago — the API service owns that constant).
 */
export const NOTIFICATION_VIEWS = ['active', 'archived', 'all'] as const;
export type NotificationView = (typeof NOTIFICATION_VIEWS)[number];
export const notificationViewSchema = z.enum(NOTIFICATION_VIEWS);

/** `/notifications/:id/...` path param (archive, unarchive, delete). */
export const notificationIdParamSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * `DELETE /notifications?scope=` query — bulk hard delete (#437). `scope` is
 * REQUIRED (no default): `archived` deletes exactly the caller's archived rows,
 * `all` empties the caller's notifications entirely. Omitting it is a 400, so
 * an accidental bare DELETE can never wipe anything.
 */
export const notificationBulkDeleteQuerySchema = z
  .object({ scope: z.enum(['archived', 'all']) })
  .strict();
export type NotificationBulkDeleteQuery = z.infer<typeof notificationBulkDeleteQuerySchema>;

export const notificationSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string(),
    title: z.string(),
    body: z.string(),
    payload: z.unknown().optional(),
    readAt: z.string().datetime().nullable(),
    /** When the row was archived (explicitly or by the sweep); null = active (#437). */
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Notification = z.infer<typeof notificationSchema>;

/** `GET /notifications?cursor=` response — keyset paginated, newest first. */
export const notificationListResponseSchema = z
  .object({
    items: z.array(notificationSchema),
    nextCursor: z.string().nullable(),
    /** Unread among ACTIVE rows only — archived rows never count (#437). */
    unreadCount: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

/** Cursor pagination + view filter for the notification list (#437). */
export const notificationListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    view: notificationViewSchema.default('active'),
  })
  .strict();
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

/**
 * `POST /notifications/mark-read` body — an explicit id set, or `{ all: true }`
 * to mark every unread row for the caller read. Both forms are idempotent.
 */
export const markReadRequestSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;
