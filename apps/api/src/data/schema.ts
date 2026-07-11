import { sql, type SQL } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { newId } from './ids';

/**
 * Database schema (PROJECTPLAN.md §5.5).
 * Conventions: uuid PKs (UUIDv7, app-generated), timestamptz stored UTC;
 * numeric(20,8) quantities, numeric(20,6) prices/values, numeric(6,3) weights.
 * Deleting a user cascades to everything they own; share links die with their
 * conglomerate.
 */

export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled']);

/**
 * Friend-sharing visibility (§6.8/§6.9): `private` (default) or `friends`. Shared
 * across the surfaces that can be friend-shared — portfolios, conglomerates, and
 * a user's watchlist + their default-visibility preference (§13.2 V2-P9). Defined
 * here so the `users` columns below can reference it.
 */
export const portfolioVisibilityEnum = pgEnum('portfolio_visibility', ['private', 'friends']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    email: varchar('email', { length: 320 }).notNull(),
    username: varchar('username', { length: 40 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull().default('user'),
    status: userStatusEnum('status').notNull().default('active'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    // Optional PIN gate (§6.1, §5.5): when enabled the user re-enters this
    // argon2id-hashed code to resume a session, which renews its 30-day window.
    // NULL hash = no PIN set; the enabled flag and hash always move together.
    pinHash: text('pin_hash'),
    pinEnabled: boolean('pin_enabled').notNull().default(false),
    // AFK auto-lock idle timeout in minutes (§6.1, §13.2 V2-P2). NULL = off:
    // the PIN lock is then only required on app (re)open, never on idle. The UI
    // lock this drives never touches session lifetime — it gates the SPA only.
    pinLockIdleMinutes: integer('pin_lock_idle_minutes'),
    // Two-factor auth (§6.1, §13.2 V2-P5). The TOTP secret is stored ENCRYPTED
    // at rest (AES-256-GCM) — never plaintext; NULL = not enrolled. The secret
    // and `twoFactorEnabled` move together: enrollment writes the secret with the
    // flag still false (provisional), and a valid TOTP code confirms it — flipping
    // the flag on and stamping `twoFactorConfirmedAt`. Recovery codes live in the
    // `two_factor_recovery_codes` child table. All 2FA state cascades away with
    // the user; user-kind accounts only.
    twoFactorSecret: text('two_factor_secret'),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    twoFactorConfirmedAt: timestamp('two_factor_confirmed_at', { withTimezone: true }),
    // Standalone email-code 2FA method (§6.1, §13.2 V2-P5 addendum, #298).
    // Independent of the TOTP flag above: either method being on arms the login
    // challenge. Enabled only after an emailed code proves mailbox access; the
    // shared recovery codes are issued on the FIRST method enabled and wiped when
    // the last one goes off.
    twoFactorEmailEnabled: boolean('two_factor_email_enabled').notNull().default(false),
    baseCurrency: char('base_currency', { length: 3 }).notNull().default('EUR'),
    // UI-language preference (§13.3 V3-P1). A short BCP-47-ish code (`en`, `de`,
    // `de-AT`); EN is the source of truth and the default, so a fresh account
    // keeps the column default and the SPA falls back to EN for any code it
    // can't render. Persisted here so `/auth/me` can seed the runtime and
    // notification emails can render in the recipient's language.
    locale: varchar('locale', { length: 5 }).notNull().default('en'),
    // Global notification mute (#368): while set, the dispatcher suppresses
    // EVERY channel for every type — a kill switch over the per-type matrix,
    // which stays stored untouched underneath.
    notificationsMuted: boolean('notifications_muted').notNull().default(false),
    // Default friend-sharing visibility applied when the user creates a *new*
    // portfolio (§6.9, §13.2 V2-P9). Only affects the default at creation time;
    // existing portfolios and explicit per-item toggles are untouched. The
    // auto-created "Main" is provisioned before any preference exists, so it keeps
    // the column default (`private`).
    defaultPortfolioVisibility: portfolioVisibilityEnum('default_portfolio_visibility')
      .notNull()
      .default('private'),
    // Whether the user shares their *whole* watchlist with friends (§6.9, §13.2
    // V2-P9). All-or-nothing per user — there is no per-item sharing; a friend
    // sees a read-only copy while this is `friends` and they remain friends.
    watchlistVisibility: portfolioVisibilityEnum('watchlist_visibility')
      .notNull()
      .default('private'),
    // Opt-in public profile (§6.9, §14, V3-P6). When `profilePublic` is true a
    // logged-out visitor can open `/u/<username>` and see a page composed from
    // the user's items whose audience is `public_link`, plus `profileBio`.
    // Flipping it off unpublishes the page instantly (the slug 404s). No item is
    // ever exposed by the profile that isn't already `public_link` — the profile
    // reads the same audience model the enforcement layer authorizes against.
    profilePublic: boolean('profile_public').notNull().default(false),
    profileBio: varchar('profile_bio', { length: 280 }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Email is stored lowercased; username uniqueness is case-insensitive.
    uniqueIndex('users_email_unique').on(t.email),
    uniqueIndex('users_username_lower_unique').on(sql`lower(${t.username})`),
  ],
);

/**
 * Personal API keys (PROJECTPLAN.md §5.5, §6.1). Issuance/OAuth is post-v1
 * (§6.13, §14) — this table exists schema-only so the invariant is fixed from
 * day one: **API keys never expire.** They are revoke-only — there is
 * deliberately NO `expires_at` column; access ends solely when `revoked_at` is
 * set (or the owning user is deleted). Session-expiry logic lives entirely in
 * Redis and never touches this table, so a 30-day session lapse can never
 * expire a key. Only the argon2id-style token *hash* is stored, never the token.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    // Coarse per-module read/write scopes the bearer middleware enforces
    // (§6.13, V2-P12). A key can never carry an admin scope — account-kind
    // separation keeps the admin surface unreachable regardless of this array.
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // Revoke-only lifecycle: set to end access. No expiry counterpart exists.
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_token_hash_unique').on(t.tokenHash),
    index('api_keys_user_idx').on(t.userId),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    email: varchar('email', { length: 320 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invites_token_hash_unique').on(t.tokenHash),
    index('invites_email_idx').on(t.email),
  ],
);

/**
 * Self-service password-reset tokens (PROJECTPLAN.md §6.1, §14, §13.2 V2-P4).
 * Follows the invite-token model: only the SHA-256 `token_hash` is stored, the
 * raw token lives in the emailed link and is never persisted. Single-use
 * (`used_at`), short-lived (`expires_at`, ~1 h), and revoked on use and on any
 * password change. Cascades away with the owning user. User-kind accounts only —
 * admin recovery stays the admin temp-password path.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('password_reset_tokens_token_hash_unique').on(t.tokenHash),
    index('password_reset_tokens_user_idx').on(t.userId),
  ],
);

/**
 * Single-use 2FA recovery codes (PROJECTPLAN.md §6.1, §13.2 V2-P5). Only the
 * SHA-256 `code_hash` is stored — the plaintext codes are shown once at
 * generation and never persisted. A code is consumed by stamping `used_at`
 * (single-use); regenerating wipes the whole set and issues a fresh batch, and
 * disabling 2FA clears them entirely. Cascades away with the owning user.
 */
export const twoFactorRecoveryCodes = pgTable(
  'two_factor_recovery_codes',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('two_factor_recovery_codes_hash_unique').on(t.codeHash),
    index('two_factor_recovery_codes_user_idx').on(t.userId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    // Kept on user deletion (set null) so the security trail survives.
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }),
    targetId: uuid('target_id'),
    ip: varchar('ip', { length: 64 }),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_created_at_idx').on(t.createdAt)],
);

// --- Market data: assets & price history ---------------------------------

/**
 * Postgres `tsvector` for the catalog's full-text column (§5.5). Drizzle has no
 * built-in type; the column is DB-generated, so the app only ever reads it.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const assetTypeEnum = pgEnum('asset_type', [
  'stock',
  'etf',
  'index',
  'fx',
  'commodity',
  'crypto',
  'custom',
]);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    providerId: text('provider_id').notNull(),
    providerRef: text('provider_ref').notNull(),
    // NULL = global market asset; set = that user's custom asset.
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    type: assetTypeEnum('type').notNull(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    exchange: text('exchange'),
    currency: char('currency', { length: 3 }).notNull(),
    meta: jsonb('meta'),
    // Local search catalog (§5.5, §6.2): full-text document over symbol + name,
    // maintained by Postgres itself so it can never drift from the row.
    searchText: tsvector('search_text').generatedAlwaysAs(
      (): SQL => sql`to_tsvector('simple', ${assets.symbol} || ' ' || ${assets.name})`,
    ),
  },
  (t) => [
    uniqueIndex('assets_provider_owner_unique').on(t.providerId, t.providerRef, t.ownerId),
    // §5.5 search indexes: GIN over the generated tsvector for word matches, and
    // a trigram GIN over (symbol, name) so misspellings ("bayr") still resolve.
    index('assets_search_text_gin').using('gin', t.searchText),
    index('assets_symbol_name_trgm_gin').using(
      'gin',
      t.symbol.op('gin_trgm_ops'),
      t.name.op('gin_trgm_ops'),
    ),
    // §5.5 intends one global row per (provider, ref) for market assets, but a
    // plain UNIQUE over (provider_id, provider_ref, owner_id) does NOT enforce
    // it: Postgres treats NULLs as distinct, so NULL owner_id rows never collide.
    // This partial unique index closes that gap, making the first-touch upsert
    // (§6.2) genuinely idempotent — exactly one global asset, one backfill.
    uniqueIndex('assets_global_provider_ref_unique')
      .on(t.providerId, t.providerRef)
      .where(sql`${t.ownerId} is null`),
  ],
);

export const priceHistory = pgTable(
  'price_history',
  {
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    close: numeric('close').notNull(),
  },
  // Daily adjusted closes; also FX pairs and custom-asset value points.
  (t) => [primaryKey({ name: 'price_history_asset_date_pk', columns: [t.assetId, t.date] })],
);

// --- Workboard & alerts ----------------------------------------------------

/**
 * Named watchlists (§13.3 V3-P5). Each user owns one or more lists; the
 * auto-provisioned **General** list (`is_default`) is the default target for
 * every add-to-watchlist flow and can never be renamed away or deleted. Names
 * are unique per user (case-insensitive); a per-list share setting lives in the
 * unified `share_audiences` model, not here. Cascades away with the owning user.
 */
export const watchlists = pgTable(
  'watchlists',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('watchlists_user_name_lower_unique').on(t.userId, sql`lower(${t.name})`),
    // Exactly one default (General) list per user — the add-flow anchor.
    uniqueIndex('watchlists_user_default_unique')
      .on(t.userId)
      .where(sql`${t.isDefault}`),
  ],
);

export const workboardItems = pgTable(
  'workboard_items',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The named list this item belongs to (§13.3 V3-P5). Backfilled to each
    // user's General list by the 0024 migration, then NOT NULL. The same asset
    // may appear in different lists but not twice in one list (unique below).
    watchlistId: uuid('watchlist_id')
      .notNull()
      .references(() => watchlists.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull(),
    note: text('note'),
  },
  (t) => [uniqueIndex('workboard_items_watchlist_asset_unique').on(t.watchlistId, t.assetId)],
);

export const alertKindEnum = pgEnum('alert_kind', [
  'price_above',
  'price_below',
  'pct_up_from_ref',
  'pct_down_from_ref',
  'pct_day_up',
  'pct_day_down',
]);
export const alertStatusEnum = pgEnum('alert_status', ['active', 'triggered', 'disabled']);

export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  assetId: uuid('asset_id')
    .notNull()
    .references(() => assets.id, { onDelete: 'cascade' }),
  kind: alertKindEnum('kind').notNull(),
  threshold: numeric('threshold').notNull(),
  // Captured at creation for the *_from_ref kinds.
  refPrice: numeric('ref_price'),
  repeat: boolean('repeat').notNull().default(false),
  status: alertStatusEnum('status').notNull(),
  lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
});

// --- Notifications ---------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: jsonb('payload'),
    readAt: timestamp('read_at', { withTimezone: true }),
    // #368: a hidden row is invisible to the inbox/unread queries but still
    // carries its payload.eventKey — it is the DURABLE dedupe marker that makes
    // the at-least-once notifications.dispatch job idempotent even when the
    // recipient routed the type away from in-app (or is globally muted).
    hidden: boolean('hidden').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The (user, eventKey) dedupe marker enforced by the DB, not just the
    // dispatcher's exists→insert pair: a second dispatcher replica racing past
    // the read still collapses to one row (insert is ON CONFLICT DO NOTHING),
    // and the per-dispatch eventKey lookup stops being a JSON scan. Partial:
    // only dispatcher-written rows carry an eventKey.
    uniqueIndex('notifications_user_event_key_unique')
      .on(t.userId, sql`(${t.payload} ->> 'eventKey')`)
      .where(sql`(${t.payload} ->> 'eventKey') is not null`),
  ],
);

export const notificationChannelEnum = pgEnum('notification_channel', [
  'inapp',
  'email',
  'telegram',
  'discord',
  'push',
  'webpush',
]);

/**
 * FCM device registrations for phone push (#368/#351). One row per token;
 * `token` is globally unique and an upsert re-binds it to the registering user
 * (a device that logs into another account takes its pushes along). Pruned when
 * FCM reports the registration gone (structured errorCode UNREGISTERED).
 */
export const devicePlatformEnum = pgEnum('device_platform', ['android', 'ios', 'web']);

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    platform: devicePlatformEnum('platform').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('device_tokens_token_unique').on(t.token),
    index('device_tokens_user_id_idx').on(t.userId),
  ],
);

/**
 * Web-push (VAPID) subscriptions for browser push (#368/#350). One row per
 * subscription `endpoint` (globally unique, upsert re-binds like device
 * tokens); pruned when the push service reports it gone (404/410).
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_unique').on(t.endpoint),
    index('push_subscriptions_user_id_idx').on(t.userId),
  ],
);

export const notificationSettings = pgTable(
  'notification_settings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum('channel').notNull(),
    enabled: boolean('enabled').notNull(),
    config: jsonb('config'),
  },
  (t) => [
    primaryKey({ name: 'notification_settings_user_channel_pk', columns: [t.userId, t.channel] }),
  ],
);

/**
 * Email send log (PROJECTPLAN.md §6.10). One row per send *attempt* — never a
 * body or any secret, only a coarse `error_code` on failure. `user_id` is
 * nullable (pre-account sends like invites) and set null (not cascaded) on user
 * deletion so the log survives for admin review. Admins read it globally and
 * per user (§6.12).
 */
export const emailStatusEnum = pgEnum('email_status', ['sent', 'failed', 'suppressed']);

export const emailLog = pgTable(
  'email_log',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    recipient: varchar('recipient', { length: 320 }).notNull(),
    template: varchar('template', { length: 64 }).notNull(),
    subject: text('subject').notNull(),
    status: emailStatusEnum('status').notNull(),
    errorCode: varchar('error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('email_log_created_at_idx').on(t.createdAt),
    index('email_log_user_id_idx').on(t.userId),
  ],
);

// --- Conglomerates & sharing ----------------------------------------------

export const conglomerateStatusEnum = pgEnum('conglomerate_status', ['draft', 'active']);

export const conglomerates = pgTable('conglomerates', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  status: conglomerateStatusEnum('status').notNull(),
  // Friend-sharing visibility (§6.9, §13.2 V2-P9): `private` (default) or
  // `friends` — a read-only copy exposed to the owner's friends via Shared With
  // Me. Mirrors the portfolio model; revocable, no tokens.
  visibility: portfolioVisibilityEnum('visibility').notNull().default('private'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const conglomeratePositions = pgTable(
  'conglomerate_positions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    conglomerateId: uuid('conglomerate_id')
      .notNull()
      .references(() => conglomerates.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    weightPct: numeric('weight_pct', { precision: 6, scale: 3 }).notNull(),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [uniqueIndex('conglomerate_positions_cong_asset_unique').on(t.conglomerateId, t.assetId)],
);

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    conglomerateId: uuid('conglomerate_id')
      .notNull()
      .references(() => conglomerates.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('share_links_token_unique').on(t.token)],
);

// --- Portfolio -------------------------------------------------------------

export const portfolios = pgTable(
  'portfolios',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('Main'),
    // V1: exactly one auto-created "Main" per user; all portfolio queries are
    // portfolio_id-scoped so multi-portfolio is purely additive (§6.8).
    visibility: portfolioVisibilityEnum('visibility').notNull().default('private'),
    sortOrder: integer('sort_order').notNull().default(0),
    // Sticky per-portfolio default funding source for transaction entry (§14,
    // #220): remembers whether "pay from cash" is preselected so repeat entry is
    // one click. Persisted + returned only — the backend never *applies* it
    // silently; the client reads it to preselect and always sends explicit flags.
    defaultPayFromCash: boolean('default_pay_from_cash').notNull().default(false),
    // Soft-archive (§13.2 V2-P8): a non-null timestamp hides the portfolio from
    // the default list while keeping its history restorable. The default-
    // portfolio invariant only ever considers *active* (archived_at IS NULL)
    // rows, and archiving the last active portfolio is rejected upstream so a
    // user can never be left with zero usable portfolios.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('portfolios_user_name_unique').on(t.userId, t.name)],
);

export const transactionSideEnum = pgEnum('transaction_side', ['buy', 'sell']);

/**
 * Tax modes (V3-P4, §13.3): `none` = pre-V3-P4 behavior, `manual_per_trade` =
 * user-entered tax per sell/dividend, `country_specific` = automated per
 * country (AT only). Used both for the per-user setting (`user_tax_settings`)
 * and — frozen at recording time (§16 2026-07-08 cutover semantics) — on each
 * sell/dividend row.
 */
export const taxModeEnum = pgEnum('tax_mode', ['none', 'manual_per_trade', 'country_specific']);

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    side: transactionSideEnum('side').notNull(),
    quantity: numeric('quantity', { precision: 20, scale: 8 }).notNull(),
    price: numeric('price', { precision: 20, scale: 6 }).notNull(),
    fee: numeric('fee', { precision: 20, scale: 6 }).notNull().default('0'),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull(),
    note: text('note'),
    // Tax facts frozen at recording time (V3-P4, §16 2026-07-08): the tax mode
    // active when the row was created and the tax it produced then, in EUR
    // (signed: positive = withheld, negative = refunded). NULL mode = recorded
    // before the tax engine existed (behaves exactly like 'none'); NULL amount
    // = no tax was computed/entered (buys, none mode, manual without entry).
    // Mode switches and later corrections never rewrite these — the year's
    // *current* truth lives in the tax movements, re-derived append-only.
    taxMode: taxModeEnum('tax_mode'),
    taxCountry: char('tax_country', { length: 2 }),
    taxAmountEur: numeric('tax_amount_eur', { precision: 20, scale: 6 }),
    // Uncovered sell (issue #369): a SELL recorded against an insufficient/zero
    // holding behind the explicit acknowledgment closes the position at 0 (no
    // shorts). `allow_uncovered` is the persisted acknowledgment — it also keeps
    // a later edit/delete replay from silently rejecting the (already accepted)
    // oversell. `uncovered_entry_price` is the native per-unit basis the user
    // supplied for the uncovered shares (NULL = the sale price is used → 0 %
    // realized on that portion, so no phantom gain reaches the tax ledger).
    allowUncovered: boolean('allow_uncovered').notNull().default(false),
    uncoveredEntryPrice: numeric('uncovered_entry_price', { precision: 20, scale: 6 }),
  },
  (t) => [
    check('transactions_quantity_positive', sql`${t.quantity} > 0`),
    check('transactions_price_nonneg', sql`${t.price} >= 0`),
    // Uncovered fields are sell-only, and an entry price is meaningless without
    // the acknowledgment (mirrors the contract's refineUncoveredSell, #369).
    check(
      'transactions_uncovered_sell_only',
      sql`${t.allowUncovered} = false OR ${t.side} = 'sell'`,
    ),
    check(
      'transactions_uncovered_entry_price_requires_flag',
      sql`${t.uncoveredEntryPrice} IS NULL OR ${t.allowUncovered} = true`,
    ),
  ],
);

/**
 * Per-portfolio cash ledger ("Bargeld", PROJECTPLAN.md §14, #220/#278; cash
 * sources V3-P3 §13.3). Every movement is a *reconciling* row — signed EUR
 * amount — so **current cash = sum of signed movements** (the #220 invariant,
 * computed via `domain/cashLedger.cashBalance`). `deposit` / `withdrawal` are
 * external (money crossing the portfolio boundary, TWR cash flows); `buy` /
 * `sell_proceeds` are internal (cash ↔ shares form change, TWR-neutral) and
 * carry `transaction_id` linking the movement to the buy/sell it funded;
 * `transfer_out` / `transfer_in` (V3-P3) are the paired legs of an internal
 * transfer between two cash sources — they share a `transfer_id`, cancel to
 * zero in every roll-up, and are NEVER TWR flows. Cash is EUR-only in V1
 * (multi-currency cash is out of scope). Deleting the linked transaction
 * cascades its movement away, restoring the balance.
 */
export const cashMovementKindEnum = pgEnum('cash_movement_kind', [
  'deposit',
  'withdrawal',
  'buy',
  'sell_proceeds',
  'transfer_out',
  'transfer_in',
  'dividend',
  'tax_withholding',
  'tax_refund',
]);

/**
 * Cash sources (V3-P3): the auto-provisioned **Main** plus named siblings
 * ("Bank account X"), each owning a slice of the portfolio's cash movements.
 * Exactly one Main per portfolio (partial unique index; provisioned on first
 * cash touch, or by the 0019 migration for pre-existing ledgers). The type is a
 * purely descriptive label. Balances are never stored — a source's balance is
 * the sum of its movements' signed amounts. Sources soft-archive like
 * portfolios: `archived_at` hides them from active listings while their history
 * stays queryable; the service only archives sources whose balance is exactly
 * €0.00 and never archives Main.
 */
export const cashSourceTypeEnum = pgEnum('cash_source_type', [
  'bank',
  'retirement',
  'cash',
  'custom',
]);

export const portfolioCashSources = pgTable(
  'portfolio_cash_sources',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: cashSourceTypeEnum('type').notNull(),
    isMain: boolean('is_main').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Names are unique per portfolio across archived rows too (mirrors
    // portfolios_user_name_unique), so create/rename can 409 cleanly.
    uniqueIndex('portfolio_cash_sources_portfolio_name_unique').on(t.portfolioId, t.name),
    // At most one Main per portfolio — the idempotence anchor of getOrCreateMain.
    uniqueIndex('portfolio_cash_sources_main_unique')
      .on(t.portfolioId)
      .where(sql`${t.isMain}`),
  ],
);

/**
 * Dividends (V3-P4, §13.3): income events on a held asset — gross EUR amount
 * on a pay date, landing in a chosen cash source as a `dividend` movement,
 * taxed per the mode active at recording (frozen on the row like transaction
 * tax facts, §16 2026-07-08). Cash is EUR-only, so the gross amount is entered
 * in EUR. `cash_source_id` has no cascade for the same reason movements'
 * `source_id` has none: sources soft-archive, never hard-delete while rows
 * exist (portfolio deletion cascades through `portfolio_id`). Deleting a
 * dividend cascades its movements away (`portfolio_cash_movements.dividend_id`).
 */
export const dividends = pgTable(
  'dividends',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    cashSourceId: uuid('cash_source_id')
      .notNull()
      .references(() => portfolioCashSources.id),
    grossAmountEur: numeric('gross_amount_eur', { precision: 20, scale: 6 }).notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull(),
    note: text('note'),
    // Tax facts frozen at recording time — same semantics as the transaction
    // columns (mode active when recorded; the tax it produced then, signed).
    taxMode: taxModeEnum('tax_mode').notNull(),
    taxCountry: char('tax_country', { length: 2 }),
    taxAmountEur: numeric('tax_amount_eur', { precision: 20, scale: 6 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('dividends_portfolio_idx').on(t.portfolioId, t.executedAt),
    check('dividends_gross_positive', sql`${t.grossAmountEur} > 0`),
  ],
);

export const portfolioCashMovements = pgTable(
  'portfolio_cash_movements',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    // The cash source this movement belongs to (V3-P3). No cascade: sources are
    // soft-archived, never hard-deleted while movements exist (portfolio
    // deletion cascades through portfolio_id on both tables instead).
    sourceId: uuid('source_id')
      .notNull()
      .references(() => portfolioCashSources.id),
    kind: cashMovementKindEnum('kind').notNull(),
    // Signed EUR amount, full precision: inflows (deposit/sell_proceeds/
    // transfer_in) > 0, outflows (withdrawal/buy/transfer_out) < 0. The sign is
    // part of the data, not derived.
    amountEur: numeric('amount_eur', { precision: 20, scale: 6 }).notNull(),
    // Set for internal (buy/sell_proceeds) movements: the transaction they
    // funded. Null for external deposits/withdrawals. Cascade so removing the
    // buy/sell removes its cash movement.
    transactionId: uuid('transaction_id').references(() => transactions.id, {
      onDelete: 'cascade',
    }),
    // Set on both legs of one transfer (V3-P3): a shared correlation id pairing
    // transfer_out with its transfer_in, plus the other leg's source for
    // display ("Transfer to Bank X") without a self-join. Null otherwise.
    transferId: uuid('transfer_id'),
    counterpartSourceId: uuid('counterpart_source_id').references(() => portfolioCashSources.id),
    // Set on a dividend's movements (V3-P4): the gross `dividend` inflow and
    // its tax settlement both link back to the dividend row; deleting the
    // dividend cascades them away, mirroring the transaction linkage above.
    dividendId: uuid('dividend_id').references(() => dividends.id, { onDelete: 'cascade' }),
    // Set on every tax_withholding / tax_refund (V3-P4): the Europe/Vienna
    // calendar year whose AT pool (or manual report bucket) this settlement
    // belongs to. The movement's executed_at can differ — a backdated trade
    // settles a past year with a movement dated at the trade, and a correction
    // posted after a deletion settles it with a movement dated now — so the
    // year attribution is explicit, never inferred from the timestamp.
    taxYear: integer('tax_year'),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('portfolio_cash_movements_portfolio_idx').on(t.portfolioId, t.executedAt),
    index('portfolio_cash_movements_source_idx').on(t.sourceId, t.executedAt),
    // Defense-in-depth mirror of domain/cashLedger's CASH_MOVEMENT_SIGN: the
    // amount's sign must match the kind, and never zero (the ledger never guesses).
    check(
      'portfolio_cash_movements_sign',
      sql`(${t.kind} in ('deposit','sell_proceeds','transfer_in','dividend','tax_refund') and ${t.amountEur} > 0)
          or (${t.kind} in ('withdrawal','buy','transfer_out','tax_withholding') and ${t.amountEur} < 0)`,
    ),
    // Transfer legs always carry their pairing columns; other kinds never do.
    check(
      'portfolio_cash_movements_transfer_link',
      sql`(${t.kind} in ('transfer_out','transfer_in'))
          = (${t.transferId} is not null and ${t.counterpartSourceId} is not null)`,
    ),
    // Tax settlements always carry their year; nothing else ever does.
    check(
      'portfolio_cash_movements_tax_year',
      sql`(${t.kind} in ('tax_withholding','tax_refund')) = (${t.taxYear} is not null)`,
    ),
    // A dividend inflow always links its dividend row (its tax settlement may).
    check(
      'portfolio_cash_movements_dividend_link',
      sql`${t.kind} <> 'dividend' or ${t.dividendId} is not null`,
    ),
  ],
);

/**
 * Per-user tax settings (V3-P4, §13.3): Settings → Taxes. One optional row per
 * user — a missing row IS `none` mode (the pre-V3-P4 default), so the feature
 * is additive by construction. `country` is set exactly when the mode is
 * `country_specific` (AT is the only shipped country); the CHECK makes the
 * pair unrepresentable any other way. The mode applies to sells/dividends at
 * the moment they are *recorded* (§16 2026-07-08) — switching never rewrites
 * existing rows.
 */
export const userTaxSettings = pgTable(
  'user_tax_settings',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: taxModeEnum('mode').notNull().default('none'),
    country: char('country', { length: 2 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'user_tax_settings_country',
      sql`(${t.mode} = 'country_specific') = (${t.country} is not null)`,
    ),
  ],
);

/**
 * Social graph (PROJECTPLAN.md §5.5, §6.9). Two tables:
 *
 * `friend_requests` — a directed request from one user to another. A pair may
 * hold at most one *pending* request at a time (partial unique index below);
 * accepted/declined/cancelled rows are kept for history and never block a fresh
 * request. Deleting either user cascades the request away.
 *
 * `friendships` — the undirected result of an accepted request, stored once per
 * pair with the canonical ordering `user_a < user_b` so a friendship is a single
 * row regardless of who sent the request. Deleting either user cascades the
 * friendship away, closing all shared access.
 */
export const friendRequestStatusEnum = pgEnum('friend_request_status', [
  'pending',
  'accepted',
  'declined',
  'cancelled',
]);

export const friendRequests = pgTable(
  'friend_requests',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    fromUser: uuid('from_user')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUser: uuid('to_user')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: friendRequestStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (t) => [
    // At most one *pending* request per ordered pair; resolved rows don't block.
    uniqueIndex('friend_requests_pending_pair_unique')
      .on(t.fromUser, t.toUser)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const friendships = pgTable(
  'friendships',
  {
    // Canonical ordering: rows are always stored with user_a < user_b, so a
    // friendship is one row per pair regardless of request direction.
    userA: uuid('user_a')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userB: uuid('user_b')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'friendships_pk', columns: [t.userA, t.userB] })],
);

/**
 * Unified sharing audiences (§13.3 V3-P5) — ONE model + ONE enforcement layer
 * over every shareable kind: each portfolio, each conglomerate, each named
 * watchlist. Three tables:
 *
 * `share_audiences` — one row per (kind, subject) that has ever been shared: the
 * owner, the current audience rung, and the subject's polymorphic id (a
 * portfolio / conglomerate / watchlist id — deliberately no FK, so one table
 * spans all kinds; the enforcement query INNER JOINs the concrete subject table,
 * so a deleted/archived subject is unreadable even if a stale row lingers).
 * A missing row means `private`.
 *
 * `share_audience_members` — the selected friends when audience =
 * `specific_friends` (empty otherwise).
 *
 * `share_audience_links` — public-link tokens (§14): only the SHA-256 `token_hash`
 * is stored, never the raw token; `revoked_at` kills a link instantly and the
 * enforcement join also requires the audience still be `public_link`, so there
 * is nowhere authorization can be cached. Everything cascades away with the
 * owning audience row (and thus the owner).
 */
export const shareKindEnum = pgEnum('share_kind', ['portfolio', 'conglomerate', 'watchlist']);
export const shareAudienceEnum = pgEnum('share_audience', [
  'private',
  'specific_friends',
  'all_friends',
  'public_link',
]);

export const shareAudiences = pgTable(
  'share_audiences',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: shareKindEnum('kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    audience: shareAudienceEnum('audience').notNull().default('private'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('share_audiences_kind_subject_unique').on(t.kind, t.subjectId),
    index('share_audiences_owner_idx').on(t.ownerId),
  ],
);

export const shareAudienceMembers = pgTable(
  'share_audience_members',
  {
    audienceId: uuid('audience_id')
      .notNull()
      .references(() => shareAudiences.id, { onDelete: 'cascade' }),
    friendId: uuid('friend_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ name: 'share_audience_members_pk', columns: [t.audienceId, t.friendId] }),
    index('share_audience_members_friend_idx').on(t.friendId),
  ],
);

export const shareAudienceLinks = pgTable(
  'share_audience_links',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    audienceId: uuid('audience_id')
      .notNull()
      .references(() => shareAudiences.id, { onDelete: 'cascade' }),
    // SHA-256 hash of the ≥128-bit token; the raw token is shown once and never
    // persisted (§14). Enforcement matches on this hash + revoked_at IS NULL.
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('share_audience_links_token_hash_unique').on(t.tokenHash),
    index('share_audience_links_audience_idx').on(t.audienceId),
  ],
);

/**
 * Per-viewer activity-alert preferences on shared items (§14, V3-P6). A row means
 * "notify me about activity on this item a friend shares with me" — presence IS
 * the opt-in (toggling off deletes the row). Keyed by (viewer, kind, subject);
 * `subject_id` is polymorphic (no FK), matching {@link shareAudiences}. Only the
 * **preference** lives here — the friend-activity events + delivery ship with
 * Notifications-v2 (#368); until then the toggle simply persists and lights up.
 * A pref is only writable while the viewer is actually authorized to read the
 * item (checked through the enforcement layer at set-time).
 */
export const sharedItemActivityPrefs = pgTable(
  'shared_item_activity_prefs',
  {
    viewerId: uuid('viewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: shareKindEnum('kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'shared_item_activity_prefs_pk',
      columns: [t.viewerId, t.kind, t.subjectId],
    }),
  ],
);

// --- Friend chat (§13.3 V3-P8) ----------------------------------------------

/**
 * A chat share-chip's target kind. The three §13.3 shareable kinds resolve
 * through the audience-enforcement layer; `asset` is a global market/custom
 * reference resolved through the §10 asset-visibility rule.
 */
export const chatChipKindEnum = pgEnum('chat_chip_kind', [
  'asset',
  'portfolio',
  'conglomerate',
  'watchlist',
]);

/**
 * 1:1 friend conversations (§13.3 V3-P8). One row per friend pair, stored with
 * the canonical ordering `user_a < user_b` (like {@link friendships}) so a pair
 * maps to a single conversation regardless of who opened it — the unique index
 * makes "one conversation per pair" a schema invariant.
 *
 * Unread is **per-participant** and derived, not a stored counter: each side's
 * `*_last_read_at` marks how far they've read, and the caller's unread count is
 * the messages after their marker not sent by them (computed at list/thread
 * time, so it always survives a reload). `last_message_at` is denormalized for
 * cheap newest-first list ordering (null until the first message).
 */
export const chatConversations = pgTable(
  'chat_conversations',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    // Nullable + ON DELETE SET NULL (#362, §16 2026-07-09): deleting an account
    // must NOT destroy the partner's chat history. The deleted side nulls out
    // ("Deleted user"), the thread stays readable for the survivor and is closed
    // to new messages; a conversation with BOTH sides null is purged.
    userA: uuid('user_a').references(() => users.id, { onDelete: 'set null' }),
    userB: uuid('user_b').references(() => users.id, { onDelete: 'set null' }),
    // How far each side has read — the derived-unread markers (never a counter).
    userALastReadAt: timestamp('user_a_last_read_at', { withTimezone: true }),
    userBLastReadAt: timestamp('user_b_last_read_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_conversations_pair_unique').on(t.userA, t.userB),
    index('chat_conversations_user_a_idx').on(t.userA),
    index('chat_conversations_user_b_idx').on(t.userB),
  ],
);

/**
 * One message in a conversation (§13.3 V3-P8). Carries text, a share chip, or
 * both — a chip is stored as a bare `(chip_kind, chip_subject_id)` REFERENCE
 * (polymorphic, no FK, mirroring {@link shareAudiences}), never a snapshot of the
 * item, so every viewer's chip is re-resolved through the enforcement layer at
 * read time and nothing can leak or go stale. The CHECK guarantees a message is
 * never empty (text or chip). UUIDv7 ids give newest-first keyset pagination.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversations.id, { onDelete: 'cascade' }),
    // Nullable + ON DELETE SET NULL (#362): a deleted sender anonymizes their
    // messages for the remaining participant instead of recalling them.
    senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body'),
    chipKind: chatChipKindEnum('chip_kind'),
    chipSubjectId: uuid('chip_subject_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chat_messages_conversation_idx').on(t.conversationId, t.id),
    // A message is text, a chip, or both — never empty; and a chip is all-or-nothing.
    check('chat_messages_not_empty', sql`${t.body} IS NOT NULL OR ${t.chipKind} IS NOT NULL`),
    check(
      'chat_messages_chip_complete',
      sql`(${t.chipKind} IS NULL) = (${t.chipSubjectId} IS NULL)`,
    ),
  ],
);

/**
 * OAuth 2.0 provider — "API access as a product" part 2 (PROJECTPLAN.md §6.13,
 * §14, V2-P12). Authorization-code + PKCE, built on the personal-API-key model:
 * only token/secret *hashes* are ever stored, scopes are the coarse #302
 * taxonomy, and delegated access is revocable. A registered app
 * (`oauth_clients`) — public (PKCE-only, no secret) or confidential — issues
 * short-lived single-use `oauth_auth_codes`, exchanged for an access token +
 * rotating refresh token that hang off an `oauth_grants` row. Revoking the grant
 * (or deleting the client) instantly kills every token, because the bearer
 * lookup joins through the grant and rejects a `revoked_at` one.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    // The owning user for a user-registered app (Settings → API Access). NULL for
    // an admin-managed FIRST-PARTY app (`is_first_party`), which belongs to the
    // system, not a person, so it survives any single account and is managed only
    // from the admin panel.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // The public, non-secret client identifier (`btc_…`) partners put in their
    // authorize URL. Distinct from the internal uuid PK the tables reference.
    clientId: text('client_id').notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    // Null for public clients (no secret, PKCE required). Only the SHA-256 hash
    // is stored; the raw secret is shown once at registration and never again.
    clientSecretHash: text('client_secret_hash'),
    // Exact-match redirect targets (https / http-loopback / custom scheme).
    redirectUris: text('redirect_uris').array().notNull(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    isPublic: boolean('is_public').notNull().default(false),
    // Admin-registered official app. Trusted: the consent screen shows BetterTrack
    // branding and is auto-approved (no scope-approval prompt), and it is managed
    // only from the admin panel (never listed under a user's API Access).
    isFirstParty: boolean('is_first_party').notNull().default(false),
    // Optional app icon shown on the consent screen for THIRD-party apps (a
    // developer/app avatar). First-party apps render the BetterTrack mark instead.
    logoUrl: text('logo_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('oauth_clients_client_id_unique').on(t.clientId),
    index('oauth_clients_user_idx').on(t.userId),
  ],
);

export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // Revoke to instantly cut off the app: the token lookup joins here.
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('oauth_grants_user_idx').on(t.userId),
    index('oauth_grants_client_idx').on(t.clientId),
  ],
);

export const oauthAuthCodes = pgTable(
  'oauth_auth_codes',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    codeHash: text('code_hash').notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    codeChallenge: text('code_challenge'),
    codeChallengeMethod: text('code_challenge_method'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Single-use: stamped at first exchange; a second exchange is rejected.
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oauth_auth_codes_code_hash_unique').on(t.codeHash)],
);

export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oauth_access_tokens_token_hash_unique').on(t.tokenHash)],
);

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Rotation: stamped when this token is exchanged for a fresh pair.
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oauth_refresh_tokens_token_hash_unique').on(t.tokenHash)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type OAuthGrantRow = typeof oauthGrants.$inferSelect;
export type OAuthAuthCodeRow = typeof oauthAuthCodes.$inferSelect;
export type OAuthAccessTokenRow = typeof oauthAccessTokens.$inferSelect;
export type OAuthRefreshTokenRow = typeof oauthRefreshTokens.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type TwoFactorRecoveryCodeRow = typeof twoFactorRecoveryCodes.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type PriceHistoryRow = typeof priceHistory.$inferSelect;
export type WorkboardItemRow = typeof workboardItems.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationSettingRow = typeof notificationSettings.$inferSelect;
export type DeviceTokenRow = typeof deviceTokens.$inferSelect;
export type NewDeviceTokenRow = typeof deviceTokens.$inferInsert;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscriptionRow = typeof pushSubscriptions.$inferInsert;
export type EmailLogRow = typeof emailLog.$inferSelect;
export type NewEmailLogRow = typeof emailLog.$inferInsert;
export type ConglomerateRow = typeof conglomerates.$inferSelect;
export type ConglomeratePositionRow = typeof conglomeratePositions.$inferSelect;
export type ShareLinkRow = typeof shareLinks.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type CashMovementRow = typeof portfolioCashMovements.$inferSelect;
export type NewCashMovementRow = typeof portfolioCashMovements.$inferInsert;
export type CashSourceRow = typeof portfolioCashSources.$inferSelect;
export type NewCashSourceRow = typeof portfolioCashSources.$inferInsert;
export type DividendRow = typeof dividends.$inferSelect;
export type NewDividendRow = typeof dividends.$inferInsert;
export type UserTaxSettingsRow = typeof userTaxSettings.$inferSelect;
export type FriendRequestRow = typeof friendRequests.$inferSelect;
export type NewFriendRequestRow = typeof friendRequests.$inferInsert;
export type FriendshipRow = typeof friendships.$inferSelect;
export type NewFriendshipRow = typeof friendships.$inferInsert;
export type WatchlistRow = typeof watchlists.$inferSelect;
export type NewWatchlistRow = typeof watchlists.$inferInsert;
export type ShareAudienceRow = typeof shareAudiences.$inferSelect;
export type NewShareAudienceRow = typeof shareAudiences.$inferInsert;
export type ShareAudienceMemberRow = typeof shareAudienceMembers.$inferSelect;
export type ShareAudienceLinkRow = typeof shareAudienceLinks.$inferSelect;
export type SharedItemActivityPrefRow = typeof sharedItemActivityPrefs.$inferSelect;
export type NewSharedItemActivityPrefRow = typeof sharedItemActivityPrefs.$inferInsert;

/**
 * Global admin settings (PROJECTPLAN.md §5.5, §6.12). A keyed settings store —
 * one row per setting, the value carried as jsonb so new flags are additive and
 * never need a migration. V1 keys: `registration_mode`
 * (`closed | invite_token | approval | open`, default `closed`) and `beta_mode`
 * (bool, default false); future app-wide toggles live here too. `updated_by`
 * points at the admin who last wrote the key (nulled if that account is deleted).
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

export type AppSettingRow = typeof appSettings.$inferSelect;
export type NewAppSettingRow = typeof appSettings.$inferInsert;

/**
 * Idempotency keys on portfolio mutation endpoints (PROJECTPLAN.md §13.4 V4-P2a,
 * #417) — the backbone for the mobile app's offline FIFO queue (mobile SPEC §7).
 * A client MAY send an `Idempotency-Key` header (a UUID) on a mutating request:
 * the first request under a `(user_id, key)` claims the row (the unique index
 * makes the claim atomic, so two concurrent duplicates collapse to exactly one),
 * runs the mutation, then stores its response; a later duplicate replays
 * `status_code` + `response_body` verbatim instead of repeating the side effect.
 * `method`/`path` are the endpoint fingerprint and `request_hash` the body hash —
 * together they decide whether a same-key retry is the SAME request (replay) or a
 * different one (409, never replayed). Rows are retained ≥ 48 h and lazily purged
 * past that on the next write (no job needed), after which the key is reusable.
 * Keyed per user, so one user's key never touches another's; deleting the user
 * cascades the rows away.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    // NULL while the first request is still in flight; set once its response
    // settles, at which point a duplicate replays these exact bytes.
    statusCode: integer('status_code'),
    responseBody: text('response_body'),
    contentType: text('content_type'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The atomic per-user claim: INSERT … ON CONFLICT (user_id, key) DO NOTHING.
    uniqueIndex('idempotency_keys_user_key_unique').on(t.userId, t.key),
    // Drives the lazy retention purge (DELETE WHERE created_at < cutoff).
    index('idempotency_keys_created_at_idx').on(t.createdAt),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert;

export const schema = {
  users,
  apiKeys,
  oauthClients,
  oauthGrants,
  oauthAuthCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
  invites,
  passwordResetTokens,
  twoFactorRecoveryCodes,
  auditLog,
  assets,
  priceHistory,
  watchlists,
  workboardItems,
  alerts,
  notifications,
  notificationSettings,
  deviceTokens,
  pushSubscriptions,
  emailLog,
  conglomerates,
  conglomeratePositions,
  shareLinks,
  portfolios,
  transactions,
  portfolioCashSources,
  dividends,
  portfolioCashMovements,
  userTaxSettings,
  friendRequests,
  friendships,
  shareAudiences,
  shareAudienceMembers,
  shareAudienceLinks,
  sharedItemActivityPrefs,
  appSettings,
  idempotencyKeys,
  userRoleEnum,
  userStatusEnum,
  assetTypeEnum,
  alertKindEnum,
  alertStatusEnum,
  notificationChannelEnum,
  devicePlatformEnum,
  emailStatusEnum,
  conglomerateStatusEnum,
  transactionSideEnum,
  taxModeEnum,
  portfolioVisibilityEnum,
  cashMovementKindEnum,
  cashSourceTypeEnum,
  friendRequestStatusEnum,
  shareKindEnum,
  shareAudienceEnum,
};
