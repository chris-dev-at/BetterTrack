import { z } from 'zod';

/**
 * In-app notifications (PROJECTPLAN.md §6.10, §8). Rows are written by the
 * notification dispatcher (a pure event-bus subscriber); this contract only
 * covers the user-scoped read/mark-read surface the bell UI and Settings →
 * Notifications page consume.
 */

/**
 * The V1 notification types (PROJECTPLAN.md §6.10). Each is a distinct row a
 * user can independently route to in-app / email / both / muted through the
 * Settings → Notifications matrix (`settings.ts`). `alert.triggered` arrives with
 * alerts, post-v1.
 */
export const NOTIFICATION_TYPES = [
  'friend.request',
  'friend.accepted',
  'portfolio.shared',
  'account.invite',
  'account.temp_password',
  'alert.triggered',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

export const notificationSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string(),
    title: z.string(),
    body: z.string(),
    payload: z.unknown().optional(),
    readAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Notification = z.infer<typeof notificationSchema>;

/** `GET /notifications?cursor=` response — keyset paginated, newest first. */
export const notificationListResponseSchema = z
  .object({
    items: z.array(notificationSchema),
    nextCursor: z.string().nullable(),
    unreadCount: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

/** Cursor pagination query for the notification list. */
export const notificationListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
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
