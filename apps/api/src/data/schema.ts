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
    baseCurrency: char('base_currency', { length: 3 }).notNull().default('EUR'),
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

export const workboardItems = pgTable(
  'workboard_items',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull(),
    note: text('note'),
  },
  (t) => [uniqueIndex('workboard_items_user_asset_unique').on(t.userId, t.assetId)],
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

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().$defaultFn(newId),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  payload: jsonb('payload'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notificationChannelEnum = pgEnum('notification_channel', [
  'inapp',
  'email',
  'telegram',
  'discord',
]);

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

/**
 * Per-portfolio visibility (§6.8/§6.9): `private` (default) or `friends`. V1
 * only *stores + exposes* this flag; social consumption of it is P5 (§6.9).
 */
export const portfolioVisibilityEnum = pgEnum('portfolio_visibility', ['private', 'friends']);

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
  },
  (t) => [uniqueIndex('portfolios_user_name_unique').on(t.userId, t.name)],
);

export const transactionSideEnum = pgEnum('transaction_side', ['buy', 'sell']);

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
  },
  (t) => [
    check('transactions_quantity_positive', sql`${t.quantity} > 0`),
    check('transactions_price_nonneg', sql`${t.price} >= 0`),
  ],
);

/**
 * Per-portfolio cash ledger ("Bargeld", PROJECTPLAN.md §14, #220/#278). Every
 * movement is a *reconciling* row — signed EUR amount — so **current cash = sum
 * of signed movements** (the #220 invariant, computed via
 * `domain/cashLedger.cashBalance`). `deposit` / `withdrawal` are external
 * (money crossing the portfolio boundary, TWR cash flows); `buy` /
 * `sell_proceeds` are internal (cash ↔ shares form change, TWR-neutral) and
 * carry `transaction_id` linking the movement to the buy/sell it funded. Cash
 * is EUR-only in V1 (multi-currency cash is out of scope). Deleting the linked
 * transaction cascades its movement away, restoring the balance.
 */
export const cashMovementKindEnum = pgEnum('cash_movement_kind', [
  'deposit',
  'withdrawal',
  'buy',
  'sell_proceeds',
]);

export const portfolioCashMovements = pgTable(
  'portfolio_cash_movements',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    kind: cashMovementKindEnum('kind').notNull(),
    // Signed EUR amount, full precision: inflows (deposit/sell_proceeds) > 0,
    // outflows (withdrawal/buy) < 0. The sign is part of the data, not derived.
    amountEur: numeric('amount_eur', { precision: 20, scale: 6 }).notNull(),
    // Set for internal (buy/sell_proceeds) movements: the transaction they
    // funded. Null for external deposits/withdrawals. Cascade so removing the
    // buy/sell removes its cash movement.
    transactionId: uuid('transaction_id').references(() => transactions.id, {
      onDelete: 'cascade',
    }),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('portfolio_cash_movements_portfolio_idx').on(t.portfolioId, t.executedAt),
    // Defense-in-depth mirror of domain/cashLedger's CASH_MOVEMENT_SIGN: the
    // amount's sign must match the kind, and never zero (the ledger never guesses).
    check(
      'portfolio_cash_movements_sign',
      sql`(${t.kind} in ('deposit','sell_proceeds') and ${t.amountEur} > 0)
          or (${t.kind} in ('withdrawal','buy') and ${t.amountEur} < 0)`,
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

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
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
export type EmailLogRow = typeof emailLog.$inferSelect;
export type NewEmailLogRow = typeof emailLog.$inferInsert;
export type ConglomerateRow = typeof conglomerates.$inferSelect;
export type ConglomeratePositionRow = typeof conglomeratePositions.$inferSelect;
export type ShareLinkRow = typeof shareLinks.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type CashMovementRow = typeof portfolioCashMovements.$inferSelect;
export type NewCashMovementRow = typeof portfolioCashMovements.$inferInsert;
export type FriendRequestRow = typeof friendRequests.$inferSelect;
export type NewFriendRequestRow = typeof friendRequests.$inferInsert;
export type FriendshipRow = typeof friendships.$inferSelect;
export type NewFriendshipRow = typeof friendships.$inferInsert;

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

export const schema = {
  users,
  apiKeys,
  invites,
  passwordResetTokens,
  twoFactorRecoveryCodes,
  auditLog,
  assets,
  priceHistory,
  workboardItems,
  alerts,
  notifications,
  notificationSettings,
  emailLog,
  conglomerates,
  conglomeratePositions,
  shareLinks,
  portfolios,
  transactions,
  portfolioCashMovements,
  friendRequests,
  friendships,
  appSettings,
  userRoleEnum,
  userStatusEnum,
  assetTypeEnum,
  alertKindEnum,
  alertStatusEnum,
  notificationChannelEnum,
  emailStatusEnum,
  conglomerateStatusEnum,
  transactionSideEnum,
  portfolioVisibilityEnum,
  cashMovementKindEnum,
  friendRequestStatusEnum,
};
