import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../../data/schema';

/**
 * The account-export completeness contract (§13.4 V4-P6a, #494, "done-when":
 * "Export zip covers every user-owned table incl. cash-source movements and tax
 * rows (completeness sweep vs schema)").
 *
 * Every table in the Drizzle schema is classified EXACTLY once here as either
 * {@link ExportedTable} (its rows are collected into a named export entity) or
 * {@link SkippedTable} (deliberately out of the export, with a stated reason).
 * The completeness test enumerates the schema's tables and fails if any is
 * absent from this map — so a future user-owned table breaks the build until it
 * is either exported or explicitly allow-listed with a reason. It also asserts
 * every `entity` here is actually produced by the collector, so a classification
 * can never claim coverage the collector doesn't deliver.
 */
export type TableClassification =
  | { readonly kind: 'export'; readonly entity: string }
  | { readonly kind: 'skip'; readonly reason: string };

const exported = (entity: string): TableClassification => ({ kind: 'export', entity });
const skipped = (reason: string): TableClassification => ({ kind: 'skip', reason });

/**
 * Table (SQL name) → classification. Grouped by why a table is skipped so the
 * reasons stay auditable. Keys MUST equal `getTableName(table)` for every table
 * in the schema (guarded by the completeness test).
 */
export const EXPORT_TABLE_CLASSIFICATION: Record<string, TableClassification> = {
  // ── Owned entities carried in the export ──────────────────────────────────
  users: exported('account'),
  api_keys: exported('apiKeys'),
  external_identities: exported('externalIdentities'),
  oauth_clients: exported('oauthClients'),
  oauth_grants: exported('oauthGrants'),
  watchlists: exported('watchlists'),
  workboard_items: exported('workboardItems'),
  alerts: exported('alerts'),
  notifications: exported('notifications'),
  notification_settings: exported('notificationSettings'),
  conglomerates: exported('conglomerates'),
  conglomerate_positions: exported('conglomeratePositions'),
  share_links: exported('conglomerateShareLinks'),
  ideas: exported('ideas'),
  portfolios: exported('portfolios'),
  transactions: exported('transactions'),
  portfolio_cash_sources: exported('cashSources'),
  dividends: exported('dividends'),
  // Explicitly covered by the "done-when" completeness requirement:
  portfolio_cash_movements: exported('cashMovements'),
  user_tax_settings: exported('taxSettings'),
  friend_requests: exported('friendRequests'),
  friendships: exported('friendships'),
  user_follows: exported('userFollows'),
  share_audiences: exported('shareAudiences'),
  share_audience_members: exported('shareAudienceMembers'),
  share_audience_links: exported('shareAudienceLinks'),
  shared_item_activity_prefs: exported('sharedItemActivityPrefs'),
  item_follows: exported('itemFollows'),
  chat_conversations: exported('chatConversations'),
  chat_messages: exported('chatMessages'),
  announcement_dismissals: exported('announcementDismissals'),
  // Custom assets (owner_id set) + their user-entered value points.
  assets: exported('customAssets'),
  price_history: exported('customAssetPriceHistory'),

  // ── Global / not user-owned ───────────────────────────────────────────────
  announcements: skipped('Global admin-authored content, not owned by any user.'),
  app_settings: skipped('Global application settings, not user-owned.'),
  invites: skipped('Admin-issued invitations keyed by email/creator, not user data.'),
  registration_tokens: skipped('Admin-managed registration access tokens, not user-owned.'),
  registration_requests: skipped('Pre-account applications; not owned by an existing user.'),
  audit_log: skipped(
    'Security audit trail, retained independently of the user (actor set-null on delete).',
  ),
  email_log: skipped('Email delivery log — a system record retained independently of the user.'),
  problems: skipped(
    'Operational error/insight capture (the Sentry replacement) — a system diagnostics record, not user-owned.',
  ),
  usage_events: skipped(
    'First-party usage telemetry (folded per-feature hit counters, no PII) — an operator-facing analytics record, not user-owned.',
  ),
  usage_daily: skipped(
    'Materialized per-day usage-analytics rollup — an operator-facing aggregate derived from usage_events, not user-owned.',
  ),

  // ── Secrets / transient credentials (nothing meaningful to export) ─────────
  password_reset_tokens: skipped('Single-use password-reset secrets (transient credentials).'),
  two_factor_recovery_codes: skipped('2FA recovery-code hashes (secrets).'),
  passkeys: skipped(
    'WebAuthn passkey credentials (§13.4 V4-P4) — device-bound public keys + counters, authentication material meaningless outside this server/authenticator, not exportable user data.',
  ),
  device_tokens: skipped('Ephemeral FCM push-transport registrations (opaque device secrets).'),
  push_subscriptions: skipped('Ephemeral web-push transport subscriptions (opaque secrets).'),
  notification_digest_queue: skipped(
    'Transient outbound digest delivery queue (V5-P3) — rows are claimed and dropped on delivery, not user data.',
  ),
  notification_cadences: skipped(
    'Per-type outbound digest-cadence preference (V5-P3); absence reconstructs to the `instant` default. Export coverage lands with the V5-P4 export work.',
  ),
  oauth_auth_codes: skipped('Single-use OAuth authorization codes (transient secrets).'),
  oauth_access_tokens: skipped('Short-lived OAuth access-token hashes (transient secrets).'),
  oauth_refresh_tokens: skipped('Rotating OAuth refresh-token hashes (transient secrets).'),
  idempotency_keys: skipped('Transient request-idempotency replay cache (~48 h retention).'),
  telegram_links: skipped(
    'Ephemeral Telegram bot chat-link relationship (opaque chat id + short-lived code).',
  ),
  discord_webhooks: skipped(
    'Per-user Discord webhook URL stored encrypted at rest (opaque outbound-only secret).',
  ),

  // ── Derived caches (recomputable from exported source data) ───────────────
  // V5-P1 daily snapshots (#553): every row is a pure derivation of the
  // exported transactions/dividends/cash movements + market data — the engine
  // rebuilds them from scratch, so exporting them would carry no user data.
  portfolio_daily_snapshots: skipped(
    'Precomputed daily series cache — fully derivable from exported transactions/cash/dividends.',
  ),
  portfolio_snapshot_state: skipped(
    'Snapshot recompute bookkeeping (watermark + dirty marker), not user data.',
  ),

  // ── This feature's own bookkeeping ────────────────────────────────────────
  export_jobs: skipped("Account-export job bookkeeping — this feature's own metadata."),
  // Broker-import staging (V4-P8): applied rows land in transactions/dividends/
  // cash movements — all exported above; what stays here is transient pipeline
  // state (previews, per-row errors, dedupe hashes), not user data to carry out.
  import_batches: skipped(
    'Broker-import staging bookkeeping — applied rows are exported as transactions/dividends/cash movements.',
  ),
  import_rows: skipped(
    'Broker-import staging bookkeeping — applied rows are exported as transactions/dividends/cash movements.',
  ),
  // V5-P6b standing orders (#593): the rows an order books (transactions / cash
  // movements) are exported above; the recurring-action DEFINITIONS are
  // user-owned config whose own export coverage lands with a later export sweep
  // (mirrors notification_cadences), and the per-period runs ledger is internal
  // idempotency bookkeeping, not user data to carry out.
  standing_orders: skipped(
    'Standing-order definitions (user-owned recurring-action config); the rows they book are exported as transactions/cash movements, and definition export lands with a later export sweep.',
  ),
  standing_order_runs: skipped(
    'Standing-order per-period exactly-once ledger — internal idempotency bookkeeping, not user data.',
  ),
  // V5-P8 comments + reactions: social interaction content ON OTHER users' shared
  // items, visible only through that item's audience — not the caller's own
  // portfolio data. Definition export lands with a later export sweep (mirrors
  // notification_cadences / standing_orders).
  item_comments: skipped(
    'Comments authored on shared items (social interaction content); export coverage lands with a later export sweep.',
  ),
  item_reactions: skipped(
    'Emoji reactions on shared items and comments (social interaction content); export coverage lands with a later export sweep.',
  ),
  // V5-P8 friend groups: user-owned named circles + their rosters, used only as a
  // sharing audience. Whom a share reaches is already exported via share_audiences
  // (the group_id reference); the circle DEFINITIONS are owner-owned config whose
  // own export coverage lands with a later export sweep (mirrors item_comments /
  // standing_orders).
  friend_groups: skipped(
    'Friend-group definitions (user-owned circle config used as a sharing audience); export coverage lands with a later export sweep.',
  ),
  friend_group_members: skipped(
    'Friend-group rosters (membership of a user-owned circle); export coverage lands with a later export sweep.',
  ),
};

/** Every entity name the classification claims is exported (dedup, sorted). */
export const EXPORTED_ENTITY_NAMES: readonly string[] = [
  ...new Set(
    Object.values(EXPORT_TABLE_CLASSIFICATION)
      .filter((c): c is Extract<TableClassification, { kind: 'export' }> => c.kind === 'export')
      .map((c) => c.entity),
  ),
].sort();

/**
 * Every SQL table name in the Drizzle schema (derived from the live schema, so a
 * new table shows up automatically). Used by the completeness test to assert the
 * classification map covers the schema with no gaps or stale entries.
 */
export function schemaTableNames(): string[] {
  return Object.values(schema as Record<string, unknown>)
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => getTableName(t))
    .sort();
}
