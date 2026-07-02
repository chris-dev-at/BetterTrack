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

export const portfolios = pgTable(
  'portfolios',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('Main'),
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

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type InviteRow = typeof invites.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type PriceHistoryRow = typeof priceHistory.$inferSelect;
export type WorkboardItemRow = typeof workboardItems.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationSettingRow = typeof notificationSettings.$inferSelect;
export type ConglomerateRow = typeof conglomerates.$inferSelect;
export type ConglomeratePositionRow = typeof conglomeratePositions.$inferSelect;
export type ShareLinkRow = typeof shareLinks.$inferSelect;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;

export const schema = {
  users,
  invites,
  auditLog,
  assets,
  priceHistory,
  workboardItems,
  alerts,
  notifications,
  notificationSettings,
  conglomerates,
  conglomeratePositions,
  shareLinks,
  portfolios,
  transactions,
  userRoleEnum,
  userStatusEnum,
  assetTypeEnum,
  alertKindEnum,
  alertStatusEnum,
  notificationChannelEnum,
  conglomerateStatusEnum,
  transactionSideEnum,
};
