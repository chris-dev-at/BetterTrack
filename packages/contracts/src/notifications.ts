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
  'follow.alert.created',
  'follow.alert.fired',
  'account.invite',
  'account.temp_password',
  'account.data_export',
  'alert.triggered',
  'chat.message',
  // V5-P5 market intelligence: an upcoming ex-date for a held asset. Opt-in —
  // default OFF on every channel (see {@link OPT_IN_NOTIFICATION_TYPES}).
  'dividend.event',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

/**
 * Per-user per-type **delivery cadence** for the OUTBOUND channels — email,
 * phone push (FCM) and browser push (V5-P3 digest mode). `instant` (the default
 * and the pre-digest behaviour) delivers each event the moment it fires;
 * `daily`/`weekly` defer the outbound channels into ONE grouped digest per
 * period, honouring the channel matrix. Cadence NEVER touches the in-app
 * notification center — the bell always receives every item instantly; it is
 * the record a digest summarizes. Telegram/Discord are outside this (globally
 * deactivated) and stay on the instant path.
 */
export const NOTIFICATION_CADENCES = ['instant', 'daily', 'weekly'] as const;
export type NotificationCadence = (typeof NOTIFICATION_CADENCES)[number];
export const notificationCadenceSchema = z.enum(NOTIFICATION_CADENCES);

/** The cadence a type resolves to with no stored override — current behaviour. */
export const DEFAULT_NOTIFICATION_CADENCE: NotificationCadence = 'instant';

/** The two deferred cadences a digest job renders (everything but `instant`). */
export const DIGEST_CADENCES = ['daily', 'weekly'] as const;
export type DigestCadence = (typeof DIGEST_CADENCES)[number];

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
      'follow.alert.created',
      'follow.alert.fired',
    ],
  },
  { key: 'chat', types: ['chat.message'] },
  { key: 'alerts', types: ['alert.triggered'] },
  { key: 'account', types: ['account.invite', 'account.temp_password', 'account.data_export'] },
  // V5-P5 market intelligence (opt-in, default off): dividend ex-date reminders.
  { key: 'market', types: ['dividend.event'] },
] as const satisfies readonly { key: string; types: readonly NotificationType[] }[];
export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORIES)[number]['key'];

/**
 * The **account/security category** (V4-P0c). These are the only notification
 * types whose EMAIL channel defaults ON — every other type's email default
 * flipped to OFF (the "lean email defaults" refinement, §16). Mirrors the
 * `account` category above; a contract test guards the two stay in lock-step.
 */
export const ACCOUNT_SECURITY_NOTIFICATION_TYPES = [
  'account.invite',
  'account.temp_password',
  'account.data_export',
] as const satisfies readonly NotificationType[];

/** Whether a type belongs to the account/security category (email-default-on set). */
export function isAccountSecurityNotificationType(type: string): boolean {
  return (ACCOUNT_SECURITY_NOTIFICATION_TYPES as readonly string[]).includes(type);
}

/**
 * **Opt-in** notification types (V5-P5): default OFF on EVERY channel — a user
 * must explicitly switch them on. Distinct from the lean-email set (which
 * defaults off on email only): an opt-in type stays fully silent until wanted,
 * so a niche market-intelligence reminder never adds noise to a fresh account
 * (the anti-bloat "invisible until wanted" rule). Currently the market-
 * intelligence dividend event (an upcoming ex-date for a held asset).
 */
export const OPT_IN_NOTIFICATION_TYPES = [
  'dividend.event',
] as const satisfies readonly NotificationType[];

/** Whether a type is opt-in (default off on every channel, V5-P5). */
export function isOptInNotificationType(type: string): boolean {
  return (OPT_IN_NOTIFICATION_TYPES as readonly string[]).includes(type);
}

// ── Quiet hours (§13.5 V5-P3) ────────────────────────────────────────────────

/** Minutes in a day — the ceiling for a quiet-hours window boundary. */
export const MINUTES_PER_DAY = 1440;

/**
 * The **urgent-bypass class** for quiet hours (planner-defined, §16-logged
 * verbatim). A notification in this class is ALWAYS delivered instantly, even
 * inside a user's quiet-hours window — nothing else bypasses. It is exactly:
 *   1. every type in {@link ACCOUNT_SECURITY_NOTIFICATION_TYPES}
 *      (`account.invite`, `account.temp_password`, `account.data_export`), AND
 *   2. admin announcements of `critical` severity.
 * Price alerts explicitly do NOT bypass — not being woken by market noise is the
 * whole point of quiet hours. The dispatcher only ever fans out the account
 * category through this taxonomy (announcements are in-app-only fan-outs), so it
 * gates on the type; the `announcementSeverity` arm exists so any surface that
 * could send a critical announcement out-of-band resolves the same class here.
 */
export function isUrgentNotification(input: {
  type: string;
  announcementSeverity?: ActiveAnnouncementSeverity | null;
}): boolean {
  if (isAccountSecurityNotificationType(input.type)) return true;
  return input.announcementSeverity === 'critical';
}

/**
 * An IANA timezone name (`Europe/Vienna`, `America/New_York`), validated by
 * asking the runtime's `Intl` engine to build a formatter for it — the only
 * dependency-free way to reject a bogus zone. `null` everywhere means "no
 * timezone set": quiet hours and digest boundaries then fall back to UTC (the
 * pre-quiet-hours behaviour), so an existing user is never migrated.
 */
export const ianaTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'invalid_timezone' },
  );

const minuteOfDaySchema = z
  .number()
  .int()
  .min(0)
  .max(MINUTES_PER_DAY - 1);

/**
 * A user's quiet-hours settings (§13.5 V5-P3). An optional window at minute
 * granularity plus an IANA timezone; **off by default** so existing users
 * behave byte-identically. `startMinute`/`endMinute` are minutes-since-local-
 * midnight; an overnight window (start > end, e.g. 22:00→07:00) is fully
 * supported. Quiet hours defer OUTBOUND channels only (email/phone push/browser
 * push) — the in-app bell is the record and always instant. The timezone is
 * stored independently of `enabled` because the digest boundaries also align to
 * it (a daily digest lands in the user's morning).
 */
export const quietHoursSchema = z
  .object({
    enabled: z.boolean(),
    startMinute: minuteOfDaySchema,
    endMinute: minuteOfDaySchema,
    timezone: ianaTimeZoneSchema.nullable(),
  })
  .strict();
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** The quiet-hours defaults a never-configured user resolves to (window off). */
export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  startMinute: 22 * 60, // 22:00
  endMinute: 7 * 60, // 07:00
  timezone: null,
};

/** `PATCH /settings/notifications` quiet-hours changes — every field optional. */
export const quietHoursUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    startMinute: minuteOfDaySchema.optional(),
    endMinute: minuteOfDaySchema.optional(),
    timezone: ianaTimeZoneSchema.nullable().optional(),
  })
  .strict();
export type QuietHoursUpdate = z.infer<typeof quietHoursUpdateSchema>;

/**
 * The default enabled state for a (channel, type) cell with **no stored
 * override** (V4-P0c lean email defaults, §6.10; V4-P10 telegram/discord).
 * Email defaults ON only for the account/security category and OFF for
 * everything else; the in-app bell, phone push, browser push, Telegram and
 * Discord channels are unchanged — every type defaults ON so a freshly-linked
 * Telegram chat or a newly-saved Discord webhook lights up its whole matrix
 * column without a manual toggle sweep. The single source of truth both the
 * settings surface and the dispatcher's fan-out gate resolve through, so web
 * and the delivery core cannot drift.
 */
export function notificationChannelDefaultEnabled(channel: string, type: string): boolean {
  // Opt-in types (V5-P5) are OFF on every channel until the user enables them.
  if (isOptInNotificationType(type)) return false;
  if (channel === 'email') return isAccountSecurityNotificationType(type);
  return true;
}

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

// ── Announcements banner (§13.4 V4-P5b) ─────────────────────────────────────
// The user surface for admin-composed announcements: the currently active list
// that the SPA renders as dismissible banners, plus the per-user dismiss action.
// Content is stored per-locale server-side and delivered in the viewer's locale;
// only UI chrome ("Dismiss") flows through the SPA i18n catalog.

/** Banner severity — mirrors `admin.announcementSeveritySchema`. */
export const ACTIVE_ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const activeAnnouncementSeveritySchema = z.enum(ACTIVE_ANNOUNCEMENT_SEVERITIES);
export type ActiveAnnouncementSeverity = z.infer<typeof activeAnnouncementSeveritySchema>;

/** One active-for-me announcement rendered in the viewer's locale. */
export const activeAnnouncementSchema = z
  .object({
    id: z.string().uuid(),
    severity: activeAnnouncementSeveritySchema,
    /** The viewer-locale rendered title (EN default when locale falls back). */
    title: z.string(),
    /** The viewer-locale rendered body (EN default when locale falls back). */
    body: z.string(),
    publishedAt: z.string().datetime().nullable(),
  })
  .strict();
export type ActiveAnnouncement = z.infer<typeof activeAnnouncementSchema>;

/**
 * `GET /notifications/announcements` — the active-for-me set. Server-computed:
 * currently in the window (start ≤ now ≤ end), flagged `active`, and NOT
 * dismissed by the caller. Rendered in the viewer's locale via `emailI18n`.
 */
export const activeAnnouncementListResponseSchema = z
  .object({ announcements: z.array(activeAnnouncementSchema) })
  .strict();
export type ActiveAnnouncementListResponse = z.infer<typeof activeAnnouncementListResponseSchema>;

/**
 * `POST /notifications/announcements/:id/dismiss` — per-user dismissal.
 * Idempotent (a repeat is a no-op); dismissal is per user AND per announcement,
 * so a newly published one still appears for a caller that dismissed a prior.
 */
export const announcementIdParamSchema = z.object({ id: z.string().uuid() }).strict();
export type AnnouncementIdParam = z.infer<typeof announcementIdParamSchema>;
