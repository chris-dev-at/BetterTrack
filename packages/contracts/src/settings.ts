import { z } from 'zod';

import { MAX_PASSWORD_LENGTH } from './auth';
import { localeSchema } from './i18n';
import {
  NOTIFICATION_TYPES,
  notificationCadenceSchema,
  quietHoursSchema,
  quietHoursUpdateSchema,
  type NotificationType,
} from './notifications';
import { portfolioVisibilitySchema } from './portfolio';

/**
 * User-facing notification settings (PROJECTPLAN.md §6.10, §6.11, §8; #368
 * Notifications v2). The `GET/PATCH /settings/notifications` surface exposes a
 * **per-type × channel matrix**: each {@link NOTIFICATION_TYPES} entry routes
 * independently to the **in-app bell**, **email**, **phone push** (FCM) and
 * **browser push** (web-push/VAPID), every cell defaulting to *on*.
 *
 * The push channels are deployment-gated: `channels` reports which are actually
 * configured on the server (SMTP for email, `BT_FCM_SERVICE_ACCOUNT_FILE` for
 * push, VAPID keys for webpush) so the UI only renders live columns — matrix
 * cells for an unconfigured channel still persist, they just deliver nothing
 * until the channel comes online. `muted` is the global kill switch: while set,
 * the dispatcher suppresses every channel regardless of the matrix.
 */

/** The user-toggleable notification channels (grid columns), in display order. */
export const NOTIFICATION_SETTING_CHANNELS = [
  'inapp',
  'email',
  'telegram',
  'discord',
  'push',
  'webpush',
] as const;
export type NotificationSettingChannel = (typeof NOTIFICATION_SETTING_CHANNELS)[number];

/**
 * One notification type's routing: which channels it fans out to. All-false =
 * muted for that type. Telegram + Discord (V4-P10) are additive channels that
 * default ON per type once the user configures them (matching the push
 * channels' behaviour), so an existing user with no override lights the cell
 * up as soon as the link/webhook is saved.
 */
export const notificationTypeRoutingSchema = z
  .object({
    inapp: z.boolean(),
    email: z.boolean(),
    telegram: z.boolean(),
    discord: z.boolean(),
    push: z.boolean(),
    webpush: z.boolean(),
  })
  .strict();
export type NotificationTypeRouting = z.infer<typeof notificationTypeRoutingSchema>;

// Build the matrix object schema keyed by every V1 type. Explicit per-type keys
// (rather than z.record) let the response guarantee every type is present with
// defaults applied, and give the SPA a fully-typed matrix.
const requiredMatrixShape = Object.fromEntries(
  NOTIFICATION_TYPES.map((type) => [type, notificationTypeRoutingSchema]),
) as Record<NotificationType, typeof notificationTypeRoutingSchema>;

const partialMatrixShape = Object.fromEntries(
  NOTIFICATION_TYPES.map((type) => [type, notificationTypeRoutingSchema.optional()]),
) as Record<NotificationType, z.ZodOptional<typeof notificationTypeRoutingSchema>>;

/** The full matrix: every type present, defaults applied — the GET response shape. */
export const notificationMatrixSchema = z.object(requiredMatrixShape).strict();
export type NotificationMatrix = z.infer<typeof notificationMatrixSchema>;

// The per-type digest cadence map (V5-P3). Like the matrix it is keyed by every
// type: the GET response carries a full map (defaults applied), the PATCH body a
// partial one. Governs the OUTBOUND channels only — the in-app bell is always
// instant regardless of a type's cadence.
const requiredCadenceShape = Object.fromEntries(
  NOTIFICATION_TYPES.map((type) => [type, notificationCadenceSchema]),
) as Record<NotificationType, typeof notificationCadenceSchema>;

const partialCadenceShape = Object.fromEntries(
  NOTIFICATION_TYPES.map((type) => [type, notificationCadenceSchema.optional()]),
) as Record<NotificationType, z.ZodOptional<typeof notificationCadenceSchema>>;

/** The full cadence map: every type present, defaults applied — GET response shape. */
export const notificationCadenceMapSchema = z.object(requiredCadenceShape).strict();
export type NotificationCadenceMap = z.infer<typeof notificationCadenceMapSchema>;

/**
 * Which channels the deployment can actually deliver on. `inapp` is always
 * true; the rest reflect server config (SMTP / FCM service account / VAPID)
 * plus per-user setup for the V4-P10 channels: `telegram` reports whether the
 * caller has a linked chat (bot token set AND link confirmed), `discord`
 * whether the caller has saved a validated webhook. Rendering the matrix
 * column keys off this so an unconfigured channel never surfaces.
 */
export const notificationChannelAvailabilitySchema = z
  .object({
    inapp: z.boolean(),
    email: z.boolean(),
    telegram: z.boolean(),
    discord: z.boolean(),
    push: z.boolean(),
    webpush: z.boolean(),
  })
  .strict();
export type NotificationChannelAvailability = z.infer<typeof notificationChannelAvailabilitySchema>;

/**
 * Deployment-level "is this channel offered at all in this build?" flags for
 * the V4-P10 additive channels (V5-P0 kill-switch). Distinct from
 * {@link notificationChannelAvailabilitySchema} — which conflates deployment
 * config with per-user linked state — these flip strictly with the
 * `BT_TELEGRAM_DISCORD_ENABLED` env kill-switch (Telegram also requires a bot
 * token). Drives whether the SPA renders the setup cards at all so it never
 * needs to probe the setup endpoints to decide.
 */
export const notificationChannelsConfigurableSchema = z
  .object({
    telegram: z.boolean(),
    discord: z.boolean(),
  })
  .strict();
export type NotificationChannelsConfigurable = z.infer<
  typeof notificationChannelsConfigurableSchema
>;

/**
 * `GET /settings/notifications` response — the session user's full type × channel
 * matrix (every type present, defaults applied), the global-mute flag, which
 * channels this deployment has configured, which of the V4-P10 additive channels
 * are OFFERED by this build at all (V5-P0 kill-switch), and — when browser push
 * is live — the VAPID public key the SPA needs for `PushManager.subscribe`.
 */
export const notificationSettingsResponseSchema = z
  .object({
    matrix: notificationMatrixSchema,
    /** Per-type outbound delivery cadence (V5-P3): instant / daily / weekly. */
    cadence: notificationCadenceMapSchema,
    /** Quiet-hours window + timezone (V5-P3); off by default (defaults applied). */
    quietHours: quietHoursSchema,
    muted: z.boolean(),
    channels: notificationChannelAvailabilitySchema,
    channelsConfigurable: notificationChannelsConfigurableSchema,
    webPushPublicKey: z.string().nullable(),
  })
  .strict();
export type NotificationSettingsResponse = z.infer<typeof notificationSettingsResponseSchema>;

/**
 * `PATCH /settings/notifications` body — a partial matrix and/or the global-mute
 * flag; at least one of the two is required. Each supplied type carries its full
 * four-channel routing.
 */
export const updateNotificationSettingsRequestSchema = z
  .object({
    matrix: z.object(partialMatrixShape).strict().optional(),
    /** Partial per-type cadence changes (V5-P3); each supplied type is upserted. */
    cadence: z.object(partialCadenceShape).strict().optional(),
    /** Partial quiet-hours changes (V5-P3); supplied fields are upserted. */
    quietHours: quietHoursUpdateSchema.optional(),
    muted: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.muted !== undefined ||
      Object.keys(body.matrix ?? {}).length > 0 ||
      Object.keys(body.cadence ?? {}).length > 0 ||
      (body.quietHours !== undefined && Object.keys(body.quietHours).length > 0),
    {
      message:
        'At least one notification type, cadence, quiet-hours field, or the muted flag is required.',
    },
  );
export type UpdateNotificationSettingsRequest = z.infer<
  typeof updateNotificationSettingsRequestSchema
>;

// --- Account settings (§6.9, §6.11, §13.2 V2-P9, §13.3 V3-P10d) ------------

/**
 * The base currencies a user can pick (§5.4, §13.3 V3-P10d). EUR is the
 * default; the initial set covers the owner-approved USD/CHF/GBP. Growing the
 * set is a one-line change here — every conversion already routes through the
 * §5.4 keystone with the base as a parameter, and FX crosses through EUR via
 * Yahoo's `EUR{CCY}=X` pairs, so no per-currency code exists anywhere.
 */
export const BASE_CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP'] as const;
export type BaseCurrency = (typeof BASE_CURRENCIES)[number];
export const baseCurrencySchema = z.enum(BASE_CURRENCIES);

/**
 * Settings → Account defaults (§6.9, V2-P9; §13.3 V3-P1 + V3-P10d):
 *  - **default portfolio visibility** applied when a new portfolio is created —
 *    `private` (default) or `friends`. Changing it only affects the *default*
 *    at creation time: existing portfolios and per-item toggles are untouched.
 *  - **locale** — the UI-language preference (§13.3 V3-P1); EN by default.
 *  - **baseCurrency** — the currency every valuation/graph/report is rendered
 *    in (§5.4: a read-time parameter only; stored amounts stay native).
 */
export const accountSettingsResponseSchema = z
  .object({
    defaultPortfolioVisibility: portfolioVisibilitySchema,
    /** The user's UI-language preference (§13.3 V3-P1); EN by default. */
    locale: localeSchema,
    /** The user's base currency (§13.3 V3-P10d); EUR by default. */
    baseCurrency: baseCurrencySchema,
    /**
     * Discreet mode (§13.5 V5-P13 arc (a)): while true the SPA masks every
     * absolute money amount app-wide (balances, values, cash, transaction
     * amounts, tooltips, chart axes) and keeps percentages/relative values
     * live — for showing the app to others without exposing amounts.
     * Per-user, server-persisted, OFF by default.
     */
    discreetMode: z.boolean(),
  })
  .strict();
export type AccountSettingsResponse = z.infer<typeof accountSettingsResponseSchema>;

/**
 * `PATCH /settings/account` body — a **partial** account-settings update: supply
 * any of the default portfolio visibility, the UI language, or the base
 * currency. At least one field is required, mirroring the notification-matrix
 * PATCH. Omitted fields are left untouched.
 */
export const updateAccountSettingsRequestSchema = z
  .object({
    defaultPortfolioVisibility: portfolioVisibilitySchema.optional(),
    locale: localeSchema.optional(),
    baseCurrency: baseCurrencySchema.optional(),
    /** Toggle discreet mode (§13.5 V5-P13 arc (a)); persists per user. */
    discreetMode: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.defaultPortfolioVisibility !== undefined ||
      body.locale !== undefined ||
      body.baseCurrency !== undefined ||
      body.discreetMode !== undefined,
    {
      message: 'At least one setting is required.',
    },
  );
export type UpdateAccountSettingsRequest = z.infer<typeof updateAccountSettingsRequestSchema>;

// --- Home widget board (R2 home-widgets) -----------------------------------

/**
 * The user's Home widget board, stored per ACCOUNT so the layout composed on one
 * device is the layout every other device gets (owner request; it used to live
 * only in one device-wide `localStorage` key).
 *
 * **These schemas validate SHAPE and SIZE. They must never validate the widget
 * vocabulary.** The board's types, sizes and settings keys are owned by the SPA
 * and change with every web deploy; the API is a verbatim store. A client one
 * deploy ahead of the server WILL send widget types and settings keys this build
 * has never heard of, and the server has to persist them and hand them back
 * untouched — an "unknown type" rejection (or a silent drop) would delete a
 * widget the user arranged on their updated device the moment they opened an
 * older one. So `type` and `size` are bounded strings, not enums, and `settings`
 * is an open record.
 *
 * The caps below are an **abuse boundary**, not a vocabulary one: this document
 * is user-controlled JSON that lands in a `users` column read on every
 * authenticated request, so it has to stay small and shallow. Anything past a
 * cap is a 400 — never a silent truncation, which would hand the user back a
 * board they did not build.
 *
 * Two extension rules follow from the object being `.strict()`:
 *  - a new **per-widget attribute** goes in `settings`, which is open; the
 *    widget frame (`id`/`type`/`size`/`settings`) is fixed;
 *  - a new **document-level** field needs a contract change and therefore a
 *    server deploy before any client may send it.
 * A `settings` value stays flat (primitive, or an array of primitives) for the
 * same reason the caps exist — a nested-object setting would need this contract
 * widened first.
 */

/** Widgets one board may hold. Far past any usable board; a fan-out bound only. */
export const HOME_LAYOUT_MAX_WIDGETS = 48;
/** Per-instance id length — a client-generated React key, not an identifier we mint. */
export const HOME_LAYOUT_MAX_ID_CHARS = 64;
/** Widget type token length (`net-worth`, `performance-chart`, …). */
export const HOME_LAYOUT_MAX_TYPE_CHARS = 64;
/** Size token length (`s`/`m`/`l` today — a token, not an enum, on purpose). */
export const HOME_LAYOUT_MAX_SIZE_CHARS = 16;
/** Settings keys one widget may carry. */
export const HOME_LAYOUT_MAX_SETTING_KEYS = 24;
export const HOME_LAYOUT_MAX_SETTING_KEY_CHARS = 64;
/** Cap on one string setting (portfolio ids, labels, range/variant tokens). */
export const HOME_LAYOUT_MAX_SETTING_STRING_CHARS = 256;
/** Cap on an array setting (`scopeIds` is the only one today, itself capped at 24). */
export const HOME_LAYOUT_MAX_SETTING_ARRAY_ITEMS = 64;
/** Schema version ceiling — the SPA owns the number; this only bounds it. */
export const HOME_LAYOUT_MAX_VERSION = 1_000_000;
/** Whole-document cap, measured on the serialised UTF-8 bytes. */
export const HOME_LAYOUT_MAX_BYTES = 32 * 1024;

const homeLayoutSettingScalarSchema = z.union([
  z.string().max(HOME_LAYOUT_MAX_SETTING_STRING_CHARS),
  z.number().finite(),
  z.boolean(),
]);

const homeLayoutSettingValueSchema = z.union([
  homeLayoutSettingScalarSchema,
  z.null(),
  z.array(homeLayoutSettingScalarSchema).max(HOME_LAYOUT_MAX_SETTING_ARRAY_ITEMS),
]);

/** One widget's settings: an open, flat map — keys and meanings belong to the SPA. */
export const homeLayoutSettingsSchema = z
  .record(z.string().min(1).max(HOME_LAYOUT_MAX_SETTING_KEY_CHARS), homeLayoutSettingValueSchema)
  .refine((settings) => Object.keys(settings).length <= HOME_LAYOUT_MAX_SETTING_KEYS, {
    message: `A widget may carry at most ${HOME_LAYOUT_MAX_SETTING_KEYS} settings.`,
  });

/** One placed widget. `type`/`size` are opaque tokens — see the block comment. */
export const homeLayoutWidgetSchema = z
  .object({
    id: z.string().min(1).max(HOME_LAYOUT_MAX_ID_CHARS),
    type: z.string().min(1).max(HOME_LAYOUT_MAX_TYPE_CHARS),
    size: z.string().min(1).max(HOME_LAYOUT_MAX_SIZE_CHARS),
    settings: homeLayoutSettingsSchema,
  })
  .strict();
export type HomeLayoutWidget = z.infer<typeof homeLayoutWidgetSchema>;

/**
 * The whole board. `version` is the SPA's own schema version, stored verbatim:
 * a document from a version this build does not know is still a document it must
 * keep, and the *client* decides whether it can read it (see the SPA's
 * `parseHomeConfig`, which falls back to its defaults rather than guessing).
 */
export const homeLayoutSchema = z
  .object({
    version: z.number().int().nonnegative().max(HOME_LAYOUT_MAX_VERSION),
    widgets: z.array(homeLayoutWidgetSchema).max(HOME_LAYOUT_MAX_WIDGETS),
  })
  .strict()
  .superRefine((layout, ctx) => {
    // Checked on the serialised form because that is what gets stored, and the
    // per-field caps alone still allow 48 × 24 × 256 characters of settings.
    if (new TextEncoder().encode(JSON.stringify(layout)).length > HOME_LAYOUT_MAX_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `The board must serialise to at most ${HOME_LAYOUT_MAX_BYTES} bytes.`,
      });
    }
  });
export type HomeLayout = z.infer<typeof homeLayoutSchema>;

/**
 * `GET/PUT /settings/home` response. `layout: null` with `updatedAt: null` means
 * the account has never saved a board; `layout: null` with an `updatedAt` means
 * it was explicitly cleared, which is what stops another device from pushing the
 * cleared board straight back up.
 */
export const homeLayoutResponseSchema = z
  .object({
    layout: homeLayoutSchema.nullable(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type HomeLayoutResponse = z.infer<typeof homeLayoutResponseSchema>;

/**
 * The **reader's** view of that same response, for the SPA.
 *
 * The client deliberately does NOT parse the response with
 * {@link homeLayoutResponseSchema}: a board saved by a newer build could exceed
 * a cap this build still enforces (more widgets, a longer token), and rejecting
 * the whole response would blank Home instead of degrading it. The layout is
 * therefore handed through as `unknown` and run past the SPA's own forward-safe
 * board parser, which keeps what it understands and drops what it does not
 * WITHOUT rewriting storage. `updatedAt` stays strict — it is the sync
 * revision, and a malformed one would break reconciliation silently.
 */
export const homeLayoutEnvelopeSchema = z
  .object({
    layout: z.unknown(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strip();
export type HomeLayoutEnvelope = z.infer<typeof homeLayoutEnvelopeSchema>;

/**
 * `PUT /settings/home` body — the whole board, replaced outright. There is no
 * partial update: the document is small, the client always holds all of it, and
 * a merge would need a conflict model the board does not have.
 *
 * `layout: null` clears the stored board (and still bumps `updatedAt`), so a user
 * who wipes their Home on one device does not have it resurrected by the next
 * one they open.
 */
export const updateHomeLayoutRequestSchema = z
  .object({ layout: homeLayoutSchema.nullable() })
  .strict();
export type UpdateHomeLayoutRequest = z.infer<typeof updateHomeLayoutRequestSchema>;

// --- Per-account widget layouts, per client namespace (board #68 item 3) ----

/**
 * `GET/PUT /settings/widget-layout/{namespace}` — the dashboard widget
 * composition a user arranged, stored per ACCOUNT and per CLIENT so it follows
 * them across devices without the two clients overwriting each other.
 *
 * **Two saved compositions, never one.** `mobile` and `web` are independent
 * documents keyed by (user, namespace): a phone board and a desktop board are
 * different layouts of different widgets at different sizes, and merging them
 * into one row would make each client's last save silently clobber the other's.
 *
 * **The document is opaque.** Unlike {@link homeLayoutSchema}, which bounds the
 * board's internal shape, this surface validates exactly two things: the payload
 * is a JSON **object**, and it serialises to at most
 * {@link WIDGET_LAYOUT_MAX_BYTES}. Nothing else is interpreted, so a client any
 * number of deploys ahead of the server can define whatever widget vocabulary,
 * nesting or versioning it likes and read it back byte-for-byte. The size cap is
 * the abuse boundary — the only thing an opaque store can meaningfully defend.
 */

/** The client surfaces that own an independent saved composition. */
export const WIDGET_LAYOUT_NAMESPACES = ['mobile', 'web'] as const;
export const widgetLayoutNamespaceSchema = z.enum(WIDGET_LAYOUT_NAMESPACES);
export type WidgetLayoutNamespace = z.infer<typeof widgetLayoutNamespaceSchema>;

/**
 * Path parameter for both endpoints. Anything outside the enum is a 400 rather
 * than a fresh namespace: an open namespace would let one bearer token mint
 * unbounded rows per account, and a typo (`Mobile`, `ios`) would silently strand
 * a user's board in a namespace nothing ever reads back.
 */
export const widgetLayoutNamespaceParamSchema = z
  .object({ namespace: widgetLayoutNamespaceSchema })
  .strict();
export type WidgetLayoutNamespaceParam = z.infer<typeof widgetLayoutNamespaceParamSchema>;

/** Whole-document cap, measured on the serialised UTF-8 bytes. */
export const WIDGET_LAYOUT_MAX_BYTES = 32 * 1024;

/** `413` when a document exceeds {@link WIDGET_LAYOUT_MAX_BYTES}. */
export const WIDGET_LAYOUT_TOO_LARGE_CODE = 'WIDGET_LAYOUT_TOO_LARGE';
/** `404` when the account has never saved this namespace. */
export const WIDGET_LAYOUT_NOT_FOUND_CODE = 'WIDGET_LAYOUT_NOT_FOUND';

/**
 * The stored document: any JSON object. `z.record` rejects arrays, `null` and
 * primitives (they parse as a different type), which is the whole shape contract
 * — a top-level object is what keeps the document extensible without a server
 * deploy, and it is the only structural promise either client relies on.
 *
 * The size cap deliberately lives OUTSIDE this schema: it is enforced in the
 * service so a breach answers `413 WIDGET_LAYOUT_TOO_LARGE` instead of being
 * folded into a generic `400 VALIDATION_ERROR` a client cannot act on.
 */
export const widgetLayoutDocSchema = z.record(z.string(), z.unknown());
export type WidgetLayoutDoc = z.infer<typeof widgetLayoutDocSchema>;

/** Serialised UTF-8 size of a document — what the cap is measured against. */
export function widgetLayoutDocByteLength(doc: unknown): number {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}

/**
 * `PUT /settings/widget-layout/{namespace}` body. The whole document is replaced
 * outright — last write wins. There is no partial update and no conflict model:
 * the client always holds the entire composition, and `updatedAt` is the
 * revision it can compare against before deciding to push.
 */
export const updateWidgetLayoutRequestSchema = z.object({ doc: widgetLayoutDocSchema }).strict();
export type UpdateWidgetLayoutRequest = z.infer<typeof updateWidgetLayoutRequestSchema>;

/**
 * `GET/PUT /settings/widget-layout/{namespace}` response — the stored document
 * and the stamp of the write that produced it. A namespace that was never saved
 * has no row and answers `404 WIDGET_LAYOUT_NOT_FOUND`, so `doc` here is always
 * a real document (never null): "never saved" and "saved an empty board" stay
 * distinguishable, which is what lets a client tell "adopt my local default"
 * apart from "the user deliberately cleared this".
 */
export const widgetLayoutResponseSchema = z
  .object({
    doc: widgetLayoutDocSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();
export type WidgetLayoutResponse = z.infer<typeof widgetLayoutResponseSchema>;

// --- Account data export (§13.4 V4-P6a, #494) ------------------------------

/**
 * Settings → "Export my data": an async job assembles a zip of every
 * user-owned entity (JSON per entity + CSVs for transactions / cash movements /
 * holdings), delivered behind an expiring, re-auth-gated download.
 *
 * Flow (all on `/account/export`):
 *  1. `POST` — re-authenticate (password OR a fresh 2FA code / recovery code),
 *     rate-limited to 1/day. Returns the job id, its status, and the RAW
 *     download token ONCE. Only the token's SHA-256 hash is stored server-side,
 *     so this response is the sole delivery of the usable token (mirrors the
 *     invite / password-reset model). The token is minted behind the re-auth
 *     and short-lived, so it doubles as the download's "fresh re-auth" proof.
 *  2. `GET` — poll the latest job's status (no secret in the response).
 *  3. `POST /download` — exchange the raw token in the request body for the zip.
 *     The session owner may consume a matching, ready, unexpired token exactly
 *     once; a foreign, expired, or replayed token fails closed.
 */

/** Lifecycle of one export job. `expired` is a ready job past its download window. */
export const EXPORT_STATUSES = ['pending', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
export const exportStatusSchema = z.enum(EXPORT_STATUSES);

/**
 * `POST /account/export` body — the re-auth gate. Send the current password, or
 * (for a 2FA-enrolled account) a fresh TOTP `code` or an unused `recoveryCode`.
 * Exactly the credential shape the account-deletion flow uses, minus the typed
 * username confirmation (an export is non-destructive).
 */
export const exportRequestSchema = z
  .object({
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH).optional(),
    /** A fresh 6-digit authenticator (TOTP) code — 2FA-enrolled accounts only. */
    code: z.string().trim().min(4).max(16).optional(),
    /** An unused recovery code — consumed on success AND on a failed match. */
    recoveryCode: z.string().trim().min(4).max(64).optional(),
  })
  .strict()
  .refine((b) => b.password !== undefined || b.code !== undefined || b.recoveryCode !== undefined, {
    message: 'Re-authentication is required: send your password or a two-factor code.',
  });
export type ExportRequest = z.infer<typeof exportRequestSchema>;

/**
 * `GET /account/export` response — the caller's latest export job, or
 * `status: null` when they have never requested one. Carries no secret; the
 * download token lives only in the {@link exportRequestResponseSchema}.
 */
export const exportStatusResponseSchema = z
  .object({
    status: exportStatusSchema.nullable(),
    jobId: z.string().uuid().nullable(),
    requestedAt: z.string().datetime().nullable(),
    /** When the ready file stops being downloadable (null until ready). */
    expiresAt: z.string().datetime().nullable(),
    /** Zip size in bytes once ready (null otherwise). */
    sizeBytes: z.number().int().nonnegative().nullable(),
    /**
     * Coarse reason a `failed` job failed — never a stack or a secret. Lets the
     * surface distinguish an actionable refusal (`EXPORT_TOO_LARGE`: the account
     * is past the packaging ceiling, so retrying unchanged cannot help) from a
     * transient build failure. Null unless the job failed.
     */
    error: z.string().nullable(),
  })
  .strict();
export type ExportStatusResponse = z.infer<typeof exportStatusResponseSchema>;

/**
 * `POST /account/export` response — the freshly-created job plus the RAW,
 * single-delivery download token. The client holds it in memory until the job
 * is `ready`, then exchanges it in a POST body; the server retains only its
 * hash.
 */
export const exportRequestResponseSchema = z
  .object({
    jobId: z.string().uuid(),
    status: exportStatusSchema,
    /** The raw download token — shown once; only its hash is persisted. */
    downloadToken: z.string().min(1),
  })
  .strict();
export type ExportRequestResponse = z.infer<typeof exportRequestResponseSchema>;

/** `POST /account/export/download` body — the one-time raw download token. */
export const exportDownloadRequestSchema = z.object({ token: z.string().min(1).max(200) }).strict();
export type ExportDownloadRequest = z.infer<typeof exportDownloadRequestSchema>;

// --- Telegram + Discord channels (§13.4 V4-P10) ----------------------------
//
// Two additive NotificationChannels the user configures per-account. The bot
// token is server-side / env-gated (Telegram); the Discord webhook URL is
// per-user, stored encrypted at rest. Both surface as extra matrix columns
// through `channels.telegram`/`channels.discord` in the notifications response.

/** Cap on the raw link-code characters returned by `/settings/telegram/link`. */
export const TELEGRAM_LINK_CODE_MAX = 24;

/**
 * `GET /settings/telegram` — the caller's Telegram link state.
 *  - `available` = deployment has the bot token configured (matrix column
 *    lights up); `null` in every other field when false.
 *  - `linked` = a chat is confirmed for the caller (`chatId` present, no
 *    pending code). The chatId is masked (last 4 digits) — the full value is
 *    never returned to the browser.
 *  - `pending` = a link code is issued and unused; `expiresAt` is set.
 *  - `botUsername` powers the deep link (`https://t.me/<bot>?start=<code>`).
 */
export const telegramSettingsResponseSchema = z
  .object({
    available: z.boolean(),
    linked: z.boolean(),
    pending: z.boolean(),
    /** Masked chat id (`…1234`) once linked; null otherwise. */
    chatIdMasked: z.string().nullable(),
    /** Bot @username served with the response so the SPA builds the deep link. */
    botUsername: z.string().nullable(),
    /** Raw code visible on the response of a link-start; else null. */
    pendingCode: z.string().max(TELEGRAM_LINK_CODE_MAX).nullable(),
    /** ISO datetime the pending code expires; null when there is no pending. */
    pendingExpiresAt: z.string().datetime().nullable(),
  })
  .strict();
export type TelegramSettingsResponse = z.infer<typeof telegramSettingsResponseSchema>;

/**
 * `POST /settings/telegram/link` — issue a fresh single-use link code + expiry;
 * response carries the same shape as `GET /settings/telegram`, so the caller
 * immediately has the deep link's `start` parameter. An existing pending code
 * is replaced (short expiry, single use so idempotency is fine).
 */
export type TelegramLinkResponse = TelegramSettingsResponse;

/**
 * `POST /settings/telegram/confirm` — the SPA polls (or the user clicks
 * "I've started the bot") to check whether the bot has received `/start
 * <code>` yet. On success, transitions from `pending` → `linked`.
 */
export const telegramConfirmResponseSchema = z
  .object({
    linked: z.boolean(),
    settings: telegramSettingsResponseSchema,
  })
  .strict();
export type TelegramConfirmResponse = z.infer<typeof telegramConfirmResponseSchema>;

/**
 * `POST /settings/discord/webhook` body — a candidate Discord webhook URL that
 * MUST match the standard `discord(app)?.com/api/webhooks/...` shape. The
 * handler additionally sends a live test message and rejects on any non-2xx
 * from Discord (so a mistyped or stale URL never persists).
 */
export const discordWebhookRequestSchema = z
  .object({
    /** Raw webhook URL — refined below to keep the error UX clean. */
    url: z.string().min(1).max(2048),
  })
  .strict()
  .superRefine((body, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(body.url);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'invalid_url' });
      return;
    }
    if (parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'invalid_scheme' });
      return;
    }
    const host = parsed.host.toLowerCase();
    const validHost =
      host === 'discord.com' ||
      host === 'discordapp.com' ||
      host === 'canary.discord.com' ||
      host === 'ptb.discord.com';
    if (!validHost) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'invalid_host' });
      return;
    }
    if (!parsed.pathname.startsWith('/api/webhooks/')) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'invalid_path' });
    }
  });
export type DiscordWebhookRequest = z.infer<typeof discordWebhookRequestSchema>;

/**
 * `GET /settings/discord` — the caller's Discord webhook state. The URL is
 * NEVER returned to the browser (it is a secret); only whether one is
 * configured and a short label (`configuredAt` + a `webhookIdMasked` for the
 * user to recognize it) surface. `available` mirrors `linked` here — a webhook
 * either exists or the channel is unavailable to this account.
 */
export const discordSettingsResponseSchema = z
  .object({
    available: z.boolean(),
    linked: z.boolean(),
    /** Masked webhook id (`…abcd`) once configured; null otherwise. */
    webhookIdMasked: z.string().nullable(),
    /** ISO datetime the webhook was saved; null otherwise. */
    configuredAt: z.string().datetime().nullable(),
  })
  .strict();
export type DiscordSettingsResponse = z.infer<typeof discordSettingsResponseSchema>;

/**
 * `POST /settings/discord/test` — dispatch a diagnostic message via the saved
 * webhook. The handler returns `{ ok: true }` when Discord accepts the send;
 * anything else is a 4xx with an i18n'd reason (`no_webhook` when the caller
 * has none, `send_failed` when Discord rejected).
 */
export const discordTestResponseSchema = z.object({ ok: z.boolean() }).strict();
export type DiscordTestResponse = z.infer<typeof discordTestResponseSchema>;
