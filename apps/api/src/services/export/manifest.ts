import {
  PARANOID_REHYDRATION_HANDLERS,
  VAULT_ENTITY_DOC_BUCKETS,
  VAULT_TABLE_ENTITY_KINDS,
  type VaultDocBucket,
  type VaultEntityKind,
} from '@bettertrack/contracts';
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
  // User-authored product feedback and the bounded diagnostics they chose to
  // submit are part of their account data; caller-owned lifecycle read-back
  // deliberately omits those diagnostics, while the full export preserves them.
  feedback: exported('feedback'),
  feedback_messages: exported('feedbackMessages'),
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
  // Per-portfolio setting overrides (issue #636) — the user's own per-portfolio
  // tax choices, exported alongside the user-level default.
  portfolio_settings: exported('portfolioSettings'),
  user_tax_settings: exported('taxSettings'),
  // The durable last-edit marker is part of the user's living tax record.
  tax_year_changes: exported('taxYearChanges'),
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
  asset_identities: skipped(
    'Content-free asset UUID integrity anchors plus opaque account claims; contain no asset or portfolio content.',
  ),

  // Per-account widget compositions (mobile board #68 item 3) — user-owned UI
  // config, one opaque document per client namespace. Export coverage lands with
  // the same later export sweep as standing_orders / cash_* (the composition is
  // a view OF the exported portfolios, not a second copy of them).
  widget_layouts: skipped(
    'Per-namespace dashboard widget compositions (board #68) — user-owned UI config referencing already-exported portfolios; export coverage lands with a later export sweep.',
  ),

  // ── Global / not user-owned ───────────────────────────────────────────────
  announcements: skipped('Global admin-authored content, not owned by any user.'),
  app_settings: skipped('Global application settings, not user-owned.'),
  invites: skipped('Admin-issued invitations keyed by email/creator, not user data.'),
  registration_tokens: skipped('Admin-managed registration access tokens, not user-owned.'),
  registration_requests: skipped('Pre-account applications; not owned by an existing user.'),
  audit_log: skipped(
    'Security audit trail, retained independently of the user (actor set-null on delete).',
  ),
  // ADMIN-ONLY, and deliberately NOT in the subject's own export (#1406 W2,
  // Chief ruling 2026-08-29). An operator note is support/moderation workspace
  // — one operator writing context for the next — not content the account
  // authored or owns. Shipping it in the self-service ZIP would turn every
  // moderation observation into a disclosure and end candid note-taking, which
  // is the same reasoning that keeps the admin-only feedback columns out of the
  // submitter ZIP (#1470). The row still cascades away with the account, so
  // deletion stays total; what is withheld is disclosure, never retention.
  admin_user_notes: skipped(
    'Admin-only operator notes about the account — support/moderation workspace, not user-authored content (#1406 W2; mirrors the #1470 admin-only feedback columns).',
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
  usage_activations: skipped(
    'Durable first-party activation marker (one row: account + first-counted-activity instant) — the registration funnel’s operator-facing counter, not user-owned content.',
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
  // movements) are exported above; the recurring-action definitions and their
  // authoritative per-period exactly-once ledger are user-owned state whose
  // general account-export coverage lands with a later export sweep.
  standing_orders: skipped(
    'Standing-order definitions (user-owned recurring-action config); the rows they book are exported as transactions/cash movements, and definition export lands with a later export sweep.',
  ),
  standing_order_runs: skipped(
    'Standing-order authoritative exactly-once ledger; general account-export coverage lands with the standing-order definition export sweep.',
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
  // V5-P7 MIRRORCHAIN (docs/mirrorchain-design.md §1): the five additive chain
  // link tables. A member's actual data is their real portfolio COPY — already
  // exported above via portfolios/transactions/dividends/cash movements/sources;
  // these tables are the chain link + attribution + oplog bookkeeping layer, not
  // a second copy of the user's rows.
  mirror_chains: skipped(
    'Chain metadata shared across members (name, op counter) — not owned by any one user; the member copy is exported as portfolios/transactions.',
  ),
  mirror_chain_members: skipped(
    'Chain membership + per-copy watermark bookkeeping; the copy itself is exported as portfolios/transactions. Definition export lands with a later export sweep.',
  ),
  mirror_chain_invites: skipped(
    'Transient chain-invite state (friends-only, expiring), not user data to carry out.',
  ),
  mirror_chain_ops: skipped(
    'Chain-level oplog — a shared totally-ordered audit trail retained independently of any one member (actor set-null on delete), not user-owned.',
  ),
  mirror_rows: skipped(
    'Logical↔local identity map + per-row attribution for a copy — derivable bookkeeping that dies with the copy (portfolio_id cascade), not separate user data.',
  ),
  // V5-P9 expense tracking: a NEW top-level area, strictly separate from
  // portfolio money. The categories/transactions/rules/budgets are user-owned
  // config + data whose own export coverage lands with a later export sweep
  // (mirrors standing_orders / item_comments / friend_groups); the per-period
  // fired-marker is internal exactly-once alert bookkeeping, not user data.
  expense_categories: skipped(
    'Expense categories (V5-P9, a new area separate from portfolio money); user-owned config, export coverage lands with a later export sweep.',
  ),
  expense_transactions: skipped(
    'Expense transactions (V5-P9); user-owned spend/income data separate from portfolio, export coverage lands with a later export sweep.',
  ),
  expense_rules: skipped(
    'Expense auto-categorization rules (V5-P9); user-owned config, export coverage lands with a later export sweep.',
  ),
  expense_budgets: skipped(
    'Expense per-category budgets (V5-P9); user-owned config, export coverage lands with a later export sweep.',
  ),
  expense_budget_fires: skipped(
    'Expense budget per-period fired-marker (V5-P9) — internal exactly-once alert bookkeeping, not user data.',
  ),
  // V5 cash fusion (migration 0075): the classification layer ON the exported
  // cash movements — flat tags, the movement↔tag links, portfolio-scoped budgets
  // and tag-assigning rules. The money itself is already exported as
  // `cashMovements`; these are user-owned labels/config whose own export coverage
  // lands with the same later export sweep as expense_*/standing_orders (the
  // phase that also re-points the routes), and the fired-marker is internal
  // exactly-once alert bookkeeping.
  cash_tags: skipped(
    'Cash-flow tags (V5 cash fusion) — user-owned labels on the exported cash movements; export coverage lands with a later export sweep.',
  ),
  cash_movement_tags: skipped(
    'Cash-flow movement↔tag links (V5 cash fusion) — labelling of rows already exported as cashMovements; export coverage lands with a later export sweep.',
  ),
  cash_budgets: skipped(
    'Cash-flow per-tag budgets (V5 cash fusion); user-owned config, export coverage lands with a later export sweep.',
  ),
  cash_budget_fires: skipped(
    'Cash-flow budget per-period fired-marker (V5 cash fusion) — internal exactly-once alert bookkeeping, not user data.',
  ),
  cash_rules: skipped(
    'Cash-flow auto-tagging rules (V5 cash fusion); user-owned config, export coverage lands with a later export sweep.',
  ),
  cash_rule_tags: skipped(
    'Cash-flow rule↔tag links (V5 cash fusion); part of the rule config, export coverage lands with a later export sweep.',
  ),
  // V5-P10 outbound webhooks (#648): the subscription config is user-owned but
  // carries a stored signing secret (encrypted at rest, shown once) that must
  // never leave the server — like discord_webhooks; its non-secret config export
  // lands with a later export sweep (mirrors standing_orders). The delivery log
  // is a bounded, retention-pruned operational record, not user data.
  webhook_subscriptions: skipped(
    'Outbound-webhook subscriptions (V5-P10) — user-owned config carrying a stored signing secret that must not leave the server; non-secret config export lands with a later export sweep.',
  ),
  webhook_deliveries: skipped(
    'Outbound-webhook delivery log (V5-P10) — a bounded, retention-pruned operational record, not user data.',
  ),
  // V5-P10 API-key governance (issue 2/2): admin-owned rate-tier definitions are
  // deployment config, not user data; the per-key request log is a bounded,
  // retention-pruned operational record like webhook_deliveries.
  api_key_tiers: skipped(
    'API-key rate-tier definitions (V5-P10) — admin-owned deployment config, not user data.',
  ),
  api_key_request_log: skipped(
    'API-key request-log audit trail (V5-P10) — a bounded, retention-pruned operational record, not user data.',
  ),
  // V5-P13 paranoid mode (docs/paranoid-design.md §2/§12): the server `blob`
  // medium of a client-encrypted vault. Opaque ciphertext + CAS/version metadata
  // ONLY — never cleartext portfolio data, never key material. Export of the
  // current ciphertext blob (only when the media set includes `server`) rides
  // the PD3 export interplay (§12), not this collector.
  paranoid_vaults: skipped(
    'Paranoid-vault ciphertext (V5-P13) — an opaque encrypted blob + CAS/version metadata, never cleartext; ciphertext export lands with the PD3 export interplay (§12).',
  ),
  paranoid_vault_history: skipped(
    'Paranoid-vault bounded ciphertext history (V5-P13) — the corruption/bad-write safety net; opaque superseded blobs, not user data to carry out.',
  ),
  paranoid_vault_server_candidates: skipped(
    'Paranoid-vault inactive server candidate (V5-P13 PD6) — short-lived opaque ciphertext staged only for a verified media transition.',
  ),
  paranoid_vault_retired: skipped(
    'Paranoid-vault recoverable retired ciphertext (V5-P13 PD6) — opaque copies retained only until a client-proved purge.',
  ),
  paranoid_vault_retirements: skipped(
    'Paranoid-vault retirement proof and retention bookkeeping (V5-P13 PD6) — non-portfolio transition metadata.',
  ),
  paranoid_enable_transitions: skipped(
    'Paranoid-enable staging authorization — short-lived non-portfolio transition metadata.',
  ),
  paranoid_rehydration_receipts: skipped(
    'Paranoid-disable idempotency receipt — non-sensitive internal transition metadata, never portfolio data.',
  ),
  // PARANOID E9 / §17 — the transition gate and its receipt. Neither holds
  // portfolio data: the attestation records that an owner-run ciphertext backup
  // was written and verified (path, digests, row counts), and the receipt records
  // that this account went through the wipe. The ciphertext they are ABOUT lives
  // in the operator's external archive and the `zz_paranoid_v1_backup_*`
  // quarantine, neither of which this collector can or should reach.
  paranoid_v1_backup_attestations: skipped(
    'Paranoid v1 transition backup attestation (§17) — operator audit metadata (archive path, SHA-256 digests, row counts), never user content.',
  ),
  paranoid_v1_wipe_receipts: skipped(
    'Paranoid v1 transition wipe receipt (§17) — internal marker that this account went through the backup+wipe, plus the mode it had before; not portfolio data.',
  ),
  // V5-P13 arc b, the PER-PORTFOLIO vault model (docs/paranoid-design.md §3/§8,
  // epic E0 #1410): raw table rows stay out of the general collector. E1's
  // dedicated `vaults` export section carries the safe { vaultId, media }
  // projection plus current ciphertext for vaults whose media include server.
  vaults: skipped(
    'Per-portfolio vault raw config rows (V5-P13 arc b) are skipped here; E1 exports the safe { vaultId, media } projection through the dedicated vaults manifest section.',
  ),
  vault_blobs: skipped(
    'Per-portfolio vault raw blob rows (V5-P13 arc b) are skipped here; E1 exports current server-backed opaque ciphertext through the dedicated vaults manifest section.',
  ),
  vault_blob_history: skipped(
    'Per-portfolio vault bounded ciphertext history (V5-P13 arc b) — the corruption/bad-write safety net; opaque superseded blobs, not user data to carry out.',
  ),
  vault_server_candidates: skipped(
    'Per-portfolio vault inactive server candidates (V5-P13 arc b) — short-lived opaque ciphertext staged only for a verified media transition.',
  ),
  vault_retirements: skipped(
    'Per-portfolio vault retirement proof and retention bookkeeping (V5-P13 arc b) — non-portfolio transition metadata.',
  ),
  vault_retired: skipped(
    'Per-portfolio vault recoverable retired ciphertext (V5-P13 arc b) — opaque copies retained only until a client-proved purge.',
  ),
  drive_connections: skipped(
    'Separately authenticated Google Drive connection registry (V5-P13 arc b §8) — identity config only (sub/email/display name), never tokens or file ids; config export lands with a later export sweep.',
  ),
  portfolio_vault_transition_states: skipped(
    'Per-portfolio vault capture state and idempotency receipts (E4) — content-free internal transition metadata, never portfolio data.',
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

/**
 * Paranoid-mode data-home axis (§13.5 V5-P13 arc b, `docs/paranoid-design.md`
 * §1) — a SECOND binding classification alongside {@link EXPORT_TABLE_CLASSIFICATION},
 * in the same file and style, decided **mechanically per table**: does the row
 * contain portfolio/money content?
 *
 *  - `vault` — client-only, client-encrypted. Hard-deleted server-side (for the
 *    owning user) when paranoid mode is enabled and never rebuilt there; the
 *    enable-time purge sweep, the zero-cleartext probe test and disable
 *    rehydration all iterate this set (PD3). Some `vault` tables (`assets`,
 *    `price_history`) are SHARED with the global market catalog — the purge/probe
 *    are scoped to the owner's own rows exactly like the export collector, but
 *    the TABLE is classified `vault` because it holds the user's portfolio data.
 *  - `server` — kept unchanged (identity/auth, friends + chat, private
 *    watchlists/conglomerates/ideas, price alerts, notifications, and the vault
 *    ciphertext rows themselves).
 *  - `purge` — SERVER-side rows that are not the client's to hold, but that must
 *    not EXIST for a paranoid account: derived telemetry/operational state whose
 *    columns are portfolio-identifying. Purged and zero-probed at enable exactly
 *    like `vault`, but deliberately NOT part of the encrypted document — it is
 *    never captured, never restored, and (guarded by the completeness test) may
 *    never appear in `VAULT_TABLE_ENTITY_KINDS` or {@link PARANOID_REHYDRATION_POLICY}.
 *    `vault` was not available here: EVERY `vault` table — `purge-only` ones
 *    included — is enrolled in the strict v1 client document, so classifying
 *    telemetry `vault` would mean shipping it into the user's encrypted blob (a
 *    cross-client format change) to hold rows nobody wants back. `server` was
 *    not available either: it means "kept", and the enable transaction deletes
 *    these. See `usage_events` below for the case that forced the third value.
 *
 * The completeness test enforces the SAME "every table classified, CI fails
 * otherwise" contract as the export axis — so a future table cannot silently
 * leak: adding it to the schema forces the author to classify it, and
 * classifying it `vault` automatically enrolls it in purge + probe + rehydration
 * (`purge` in purge + probe alone). That is the rule that keeps the "zero
 * portfolio rows server-side" guarantee durable as the schema grows.
 */
export type ParanoidClassification = 'vault' | 'server' | 'purge';

/**
 * The second compulsory policy for each `vault` table. `restore` means an entity
 * schema and an insert branch must exist in the rehydration service; `purge-only`
 * means the table is derived, staging, or operational state and is deliberately
 * rebuilt/discarded rather than trusting it as encrypted source data.
 */
export type ParanoidRehydrationPolicy =
  | { readonly kind: 'restore'; readonly entity: VaultEntityKind }
  | { readonly kind: 'purge-only' };

const restore = (entity: VaultEntityKind): ParanoidRehydrationPolicy => ({
  kind: 'restore',
  entity,
});
const purgeOnly = (): ParanoidRehydrationPolicy => ({ kind: 'purge-only' });

/**
 * The compulsory reason for each `purge` table — the third axis value's
 * equivalent of `skipped(reason)` on the export axis and of the restore/
 * purge-only declaration on the vault axis, and it exists for a specific
 * reason.
 *
 * BEFORE `purge` existed the invariant was: destroyed ⇒ `vault` ⇒ captured into
 * the encrypted document AND explicitly declared restore-or-discard. `purge`
 * makes "destroyed but never captured" a legal, CI-green state for the FIRST
 * time — which also means flipping an existing `vault` table here (dropping its
 * entity kind, policy and handler) is now a green way to turn a restorable table
 * into a destroyed one, where the only green alternative used to be `server`,
 * i.e. KEPT. It also escapes the `VAULT_TABLE_ENTITY_KINDS` gate, the one thing
 * that forced a change to the destroy-set to be visible outside `apps/api`.
 *
 * So the value carries a stated, auditable why per table, and the completeness
 * test pins the membership list itself: a second table cannot join this axis
 * without a reviewer editing the expected roster in
 * `paranoidClassification.test.ts` on purpose.
 */
export const PARANOID_PURGE_REASONS: Record<string, string> = {
  api_key_request_log:
    'Operational API-key telemetry whose concrete paths can contain portfolio ' +
    'asset UUIDs. Historical rows are destroyed at enable and future paranoid ' +
    'request-log capture is suppressed at its locked write boundary. Not `vault` — request ' +
    'telemetry is not client data and must never enter the encrypted document. ' +
    'Not `server` — that means kept.',
  usage_events:
    'Operator telemetry whose columns are portfolio-identifying: one row per ' +
    '(user, feature, asset, day), and a paranoid client prices every holding ' +
    'itself, so `feature=assets` rows recorded the account holdings ROSTER daily. ' +
    'Not `vault` — it is telemetry no client should hold and nobody wants ' +
    'restored, and enrolling it in the strict v1 document would be a ' +
    'cross-client blob-format change. Not `server` — that means kept.',
  usage_activations:
    'The distillate of `usage_events` (#1680): one row saying this account has ' +
    'produced counted first-party activity, written at the same admitted write ' +
    'boundary. It must not outlive the rows it summarises — keeping it would ' +
    'leave a residue of the purged telemetry AND keep counting a paranoid ' +
    'account in the activated funnel stage it no longer feeds, against §6.12 ' +
    '"vaulted/paranoid data never counted". Not `vault` — an operator counter ' +
    'nobody wants restored. Not `server` — that means kept.',
};

export const PARANOID_TABLE_CLASSIFICATION: Record<string, ParanoidClassification> = {
  // ── vault: portfolio / money content (client-encrypted, purged at enable) ──
  portfolios: 'vault',
  transactions: 'vault',
  dividends: 'vault',
  portfolio_cash_sources: 'vault',
  portfolio_cash_movements: 'vault',
  portfolio_settings: 'vault',
  user_tax_settings: 'vault',
  // Shared with the global catalog — purge/probe scope to owner_id rows (the
  // user's house/car/unlisted-stock ARE portfolio data, §1).
  assets: 'vault',
  price_history: 'vault',
  standing_orders: 'vault',
  // Per-(order, period) exactly-once ledger for a vault standing order — dies
  // with it; server-side standing-order execution is killed for paranoid (§8).
  standing_order_runs: 'vault',
  import_batches: 'vault',
  import_rows: 'vault',
  // Derived series cache — purged, recomputed client-side, never rebuilt
  // server-side (§1, §10).
  portfolio_daily_snapshots: 'vault',
  portfolio_snapshot_state: 'vault',
  // V5-P9 expense tables — a portfolio-adjacent money area, vault-classified so
  // a paranoid account leaks none of it (§1, binding forward).
  expense_categories: 'vault',
  expense_transactions: 'vault',
  expense_rules: 'vault',
  expense_budgets: 'vault',
  expense_budget_fires: 'vault',
  // V5 cash fusion — the tag/budget/rule layer on the cash ledger. Money content
  // by construction (a tag name IS spending information), so it goes where the
  // movements it labels go.
  cash_tags: 'vault',
  cash_movement_tags: 'vault',
  cash_budgets: 'vault',
  cash_budget_fires: 'vault',
  cash_rules: 'vault',
  cash_rule_tags: 'vault',

  // ── server: identity + auth (kept, unchanged) ──────────────────────────────
  users: 'server',
  // Opaque asset UUID + nullable account UUID claim: preserves referential
  // integrity and authorizes same-account restore while content is detached.
  asset_identities: 'server',
  api_keys: 'server',
  api_key_tiers: 'server',
  // Concrete bearer paths can be `/assets/<uuid>/quote`, tied directly to the
  // key owner. Future paranoid writes are suppressed at the locked repository
  // boundary; historical rows are purge-only telemetry, never vault content.
  api_key_request_log: 'purge',
  external_identities: 'server',
  oauth_clients: 'server',
  oauth_grants: 'server',
  oauth_auth_codes: 'server',
  oauth_access_tokens: 'server',
  oauth_refresh_tokens: 'server',
  invites: 'server',
  registration_tokens: 'server',
  registration_requests: 'server',
  password_reset_tokens: 'server',
  two_factor_recovery_codes: 'server',
  passkeys: 'server',
  device_tokens: 'server',
  push_subscriptions: 'server',
  // Account-level server-mode tax-documentation metadata. The surface is
  // killed for paranoid accounts with the rest of server tax reporting.
  tax_year_changes: 'server',

  // ── server: operational / global records (kept) ────────────────────────────
  audit_log: 'server',
  // Operator prose about the account, authored by an admin. Not `vault`: it is
  // not client data and must never enter the encrypted document. Not purged at
  // enable either — going paranoid hides what the account HOLDS, and was never
  // a promise to erase the moderation record kept about it, exactly as
  // `audit_log` above is kept.
  admin_user_notes: 'server',
  email_log: 'server',
  problems: 'server',
  // PURGED, not kept. `usage_events` folds one row per (user, feature, asset,
  // day). A paranoid client values its portfolio locally, which means one
  // `GET /assets/:id/quote` PER HOLDING, every day — so the `feature='assets'`
  // rows recorded that user's complete holdings ROSTER, keyed to their user id,
  // daily. That is precisely what the mode promises the server cannot learn, so
  // the rows must not exist for a paranoid account: capture is suppressed going
  // forward (`usageCapture` + the `upsertEvents` write boundary) and the enable
  // transaction deletes the history a converting user brings with them.
  //
  // `purge` rather than `vault`: this is operator telemetry, not user data worth
  // restoring, and `vault` would force it into the strict v1 encrypted document
  // (see the axis doc above). The user-level counters simply end at the moment
  // the account turns paranoid.
  usage_events: 'purge',
  // PURGED for the same reason, one step downstream: the activation marker is
  // written from the very rows above and says "this account was active". It
  // survives retention on purpose (#1680), so unlike the raw events it would
  // NOT age away on its own — a converting account would stay counted in the
  // activated funnel stage forever. Destroyed at enable; a paranoid account
  // then produces no admitted signal, so nothing re-creates it.
  usage_activations: 'purge',
  // The (day, feature) rollup carries NO user id and NO asset id — a global
  // aggregate over all accounts, so it identifies nothing and stays server-side.
  //
  // ACCEPTED SIDE EFFECT: `rollupDay` recomputes a day's aggregate from the raw
  // events, and the cron re-materializes a trailing 3-day window, so purging a
  // converting user retroactively lowers the already-published `usage_daily`
  // numbers for those days (older days keep their historical values). Admin
  // analytics losing a few counts for a privacy guarantee is the intended trade,
  // and it is preferable to the alternative — keeping the raw rows alive to
  // protect an aggregate.
  usage_daily: 'server',
  app_settings: 'server',
  idempotency_keys: 'server',
  export_jobs: 'server',
  announcements: 'server',
  announcement_dismissals: 'server',

  // Per-namespace widget compositions (mobile board #68 item 3) — classified
  // `server` for the SAME reason `users.home_layout` is: this is UI composition,
  // and the paranoid guarantee for a board is enforced at the ACCESS layer, not
  // by purging it. `/settings/widget-layout/*` is killed for a paranoid account
  // by the `portfolioServer` capability exactly as `/settings/home` is, so no
  // paranoid account can read or write one.
  //
  // KNOWN RESIDUE (identical to `home_layout`, and to be resolved with it): rows
  // saved BEFORE an account enables paranoid mode survive the enable purge. The
  // `vault` axis is not the fix available here — it would require enrolling this
  // table in the strict v1 encrypted-vault document contract
  // (`VAULT_TABLE_ENTITY_KINDS`), a cross-client format change, to hold a
  // document this server cannot even parse.
  widget_layouts: 'server',

  // ── server: kept product surfaces (no portfolio content, §8 "kept" list) ───
  // Private watchlists/conglomerates/ideas/backtest configs (hypothetical
  // baskets — interest, not holdings; only their SHARING dies, §8).
  watchlists: 'server',
  workboard_items: 'server',
  conglomerates: 'server',
  conglomerate_positions: 'server',
  share_links: 'server',
  ideas: 'server',
  // Price alerts stay ordinary server rows — asset-price predicates with zero
  // portfolio reference (§9).
  alerts: 'server',
  notifications: 'server',
  notification_settings: 'server',
  notification_cadences: 'server',
  notification_digest_queue: 'server',
  // Voluntary feedback and bounded client diagnostics contain no portfolio or
  // money data, so paranoid accounts keep (and can export) these rows normally.
  feedback: 'server',
  feedback_messages: 'server',
  // Friendships + chat REMAIN — they carry no portfolio data (§8, §16).
  friend_requests: 'server',
  friendships: 'server',
  friend_groups: 'server',
  friend_group_members: 'server',
  user_follows: 'server',
  item_follows: 'server',
  share_audiences: 'server',
  share_audience_members: 'server',
  share_audience_links: 'server',
  shared_item_activity_prefs: 'server',
  item_comments: 'server',
  item_reactions: 'server',
  chat_conversations: 'server',
  chat_messages: 'server',
  telegram_links: 'server',
  discord_webhooks: 'server',
  // MIRRORCHAIN link/attribution tables. An ACTIVE membership is mutually
  // exclusive with paranoid (§7 precondition, §8 item 5), but a member who left
  // with a fork keeps its rows until enable purges the copy — and the chain-level
  // tables stay populated forever by design. They are all `server` deliberately:
  //  - `mirror_chains` / `mirror_chain_ops` / `mirror_chain_members` are
  //    chain-level and shared; the oplog + the ended membership's watermark are
  //    exactly the retained proof surface disable-time provenance validation
  //    checks against (docs/paranoid-design.md §7.1).
  //  - `mirror_rows` is the fork's logical↔local identity map. It DIES with the
  //    copy at enable (portfolio_id cascade), leaving zero cleartext alias rows,
  //    and it can never become `vault`-classified: its attribution columns are a
  //    co-member's identity, which the encrypted document must not carry. Its
  //    logical half rides the vault as `mirrorProvenance` instead, and is proof
  //    material only — no row is ever restored from it.
  mirror_chains: 'server',
  mirror_chain_members: 'server',
  mirror_chain_invites: 'server',
  mirror_chain_ops: 'server',
  mirror_rows: 'server',
  // Outbound webhooks — never fire portfolio-content events for paranoid
  // accounts (none exist server-side to fire, §8 item 8).
  webhook_subscriptions: 'server',
  webhook_deliveries: 'server',
  // The vault ciphertext rows themselves — ciphertext + version metadata only,
  // explicitly server-classified (§1).
  paranoid_vaults: 'server',
  paranoid_vault_history: 'server',
  paranoid_vault_server_candidates: 'server',
  paranoid_vault_retired: 'server',
  paranoid_vault_retirements: 'server',
  paranoid_enable_transitions: 'server',
  // PD3a completion receipt + non-sensitive data-home metadata remain server-side.
  paranoid_rehydration_receipts: 'server',
  // §17 transition gate + receipt (E9): server-side operator/audit metadata. The
  // attestation is deliberately never exported — it names a host-local archive
  // path and the digests that authorize destruction.
  paranoid_v1_backup_attestations: 'server',
  paranoid_v1_wipe_receipts: 'server',
  // The PER-PORTFOLIO vault surface (V5-P13 arc b, E0 #1410): config rows +
  // opaque ciphertext + Drive-connection identities — all `server` for the same
  // reason the v1 rows above are: knowing THAT a vault exists, where it stores
  // and which portfolios are inside is account config the server must keep to
  // enforce §11 and render locked stubs; none of it is portfolio content.
  vaults: 'server',
  vault_blobs: 'server',
  vault_blob_history: 'server',
  vault_server_candidates: 'server',
  vault_retirements: 'server',
  vault_retired: 'server',
  drive_connections: 'server',
  portfolio_vault_transition_states: 'server',
};

/**
 * Explicit restore policy for every table on the encrypted vault axis. This map
 * intentionally keys table names (not entity kinds), so a future vault table
 * cannot enter the enable/disable sweep without choosing restore or discard.
 */
export const PARANOID_REHYDRATION_POLICY: Record<string, ParanoidRehydrationPolicy> = {
  portfolios: restore('portfolio'),
  transactions: restore('transaction'),
  dividends: restore('dividend'),
  portfolio_cash_sources: restore('cashSource'),
  portfolio_cash_movements: restore('cashMovement'),
  portfolio_settings: restore('portfolioSetting'),
  user_tax_settings: restore('taxSetting'),
  assets: restore('customAsset'),
  price_history: restore('customAssetValue'),
  standing_orders: restore('standingOrder'),
  standing_order_runs: restore('standingOrderRun'),
  expense_categories: restore('expenseCategory'),
  expense_transactions: restore('expenseTransaction'),
  expense_rules: restore('expenseRule'),
  expense_budgets: restore('expenseBudget'),
  import_batches: purgeOnly(),
  import_rows: purgeOnly(),
  portfolio_daily_snapshots: purgeOnly(),
  portfolio_snapshot_state: purgeOnly(),
  expense_budget_fires: purgeOnly(),
  // V5 cash fusion — FLIPPED TO `restore` in phase 2, which is the phase that
  // gave these tables their writers (`/api/v1/cash`, `cashTagRepository`,
  // `cashBudgetRepository`, `cashRuleRepository`, and the auto-tagging stamp on
  // every movement INSERT). Phase 1 left them `purge-only` because nothing wrote
  // them; leaving them so now would mean a paranoid user disabling the mode
  // silently loses every tag, budget and rule they have.
  cash_tags: restore('cashTag'),
  cash_movement_tags: restore('cashMovementTag'),
  cash_budgets: restore('cashBudget'),
  cash_rules: restore('cashRule'),
  cash_rule_tags: restore('cashRuleTag'),
  // The per-period fired marker stays derived: it is exactly-once ALERT
  // bookkeeping, not user data. Restoring it from a client-held document would
  // let an edited vault suppress a real alert forever, and rebuilding it costs
  // at most one re-alert of a month that is genuinely over budget.
  cash_budget_fires: purgeOnly(),
};

/** Shared with the web capture completeness gate; never duplicate this tuple. */
export { PARANOID_REHYDRATION_HANDLERS };

/** The `vault`-classified table names (the encrypted document + rehydration). */
export const PARANOID_VAULT_TABLE_NAMES: readonly string[] = Object.entries(
  PARANOID_TABLE_CLASSIFICATION,
)
  .filter(([, c]) => c === 'vault')
  .map(([table]) => table)
  .sort();

/**
 * THE DOC-BUCKET AXIS of the per-portfolio vault model (docs/paranoid-design.md
 * §5, epic E0 #1410): which encrypted doc carries each `vault`-classified
 * table — `portfolio` (the member portfolio's own doc) or `common` (the
 * vault-wide account-scoped doc). Decided mechanically by the row's actual
 * scoping column: portfolio-scoped ⇒ `portfolio`, account-scoped-but-vault-
 * referenced ⇒ `common`.
 *
 * DERIVED, never hand-listed twice: table → entity kind is the existing
 * `VAULT_TABLE_ENTITY_KINDS` enrollment (whose completeness against the
 * `vault` classification is already CI-gated), and entity kind → bucket is the
 * contracts' `VAULT_ENTITY_DOC_BUCKETS`, a typed `Record` over the FULL kind
 * enum — so a future vault table cannot exist without a doc bucket: skipping
 * the enrollment fails the existing completeness test, and skipping the bucket
 * fails the contracts typecheck. The classification test additionally asserts
 * the exhaustiveness at runtime (every `vault` table has exactly one bucket;
 * no other table has one).
 */
export const PARANOID_VAULT_DOC_BUCKETS: Record<string, VaultDocBucket> = Object.fromEntries(
  Object.entries(VAULT_TABLE_ENTITY_KINDS).map(([table, kind]) => [
    table,
    VAULT_ENTITY_DOC_BUCKETS[kind],
  ]),
);

/** The `purge`-classified table names — destroyed at enable, never captured. */
export const PARANOID_PURGE_ONLY_TABLE_NAMES: readonly string[] = Object.entries(
  PARANOID_TABLE_CLASSIFICATION,
)
  .filter(([, c]) => c === 'purge')
  .map(([table]) => table)
  .sort();

/**
 * Everything the enable sweep destroys and then zero-probes: both classifications
 * that must leave no row behind. The purge/probe handler sets and the purge order
 * are checked against THIS list, so a new table on either axis cannot join the
 * classification without also joining the sweep.
 */
export const PARANOID_PURGED_TABLE_NAMES: readonly string[] = [
  ...PARANOID_VAULT_TABLE_NAMES,
  ...PARANOID_PURGE_ONLY_TABLE_NAMES,
].sort();

/**
 * The subset whose rows the enable purge destroys IRREVERSIBLY — everything the
 * encrypted document is the only surviving copy of. The capture↔commit revision
 * (`computeNormalDataRevision`) hashes exactly these: a write to a `purge-only`
 * table (a snapshot reroll, a fired-marker, import staging) loses nothing on the
 * round trip, so including it would only manufacture spurious enable conflicts
 * from background jobs.
 */
export const PARANOID_RESTORABLE_TABLE_NAMES: readonly string[] = Object.entries(
  PARANOID_REHYDRATION_POLICY,
)
  .filter(
    ([table, policy]) => policy.kind === 'restore' && PARANOID_VAULT_TABLE_NAMES.includes(table),
  )
  .map(([table]) => table)
  .sort();

/**
 * Normal account-export entities that remain safe as cleartext for a paranoid
 * account. Deriving this from both compulsory table classifications means a new
 * exported money table cannot silently enter the paranoid archive.
 */
export const PARANOID_SERVER_EXPORTED_ENTITY_NAMES: readonly string[] = [
  ...new Set(
    Object.entries(EXPORT_TABLE_CLASSIFICATION)
      .filter(
        ([table, classification]) =>
          classification.kind === 'export' && PARANOID_TABLE_CLASSIFICATION[table] === 'server',
      )
      .map(([, classification]) => (classification as { entity: string }).entity),
  ),
].sort();
