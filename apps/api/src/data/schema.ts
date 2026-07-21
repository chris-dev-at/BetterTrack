import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
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

/**
 * Admin "Problems" capture (§13.5 V5-P2 arc (d), the Sentry replacement).
 * `kind` records what produced the problem; `status` drives the resolve flow.
 */
export const problemKindEnum = pgEnum('problem_kind', ['error', 'job', 'provider']);
export const problemStatusEnum = pgEnum('problem_status', ['open', 'resolved']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    email: varchar('email', { length: 320 }).notNull(),
    username: varchar('username', { length: 40 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    // Whether `password_hash` is a real, user-chosen credential (§13.4 V4-P4b).
    // A Google-registered account is created password-less: it still carries a
    // random (unusable) hash to satisfy the NOT NULL, but this flag is false, so
    // password login never succeeds and Google-unlink is refused (Google is the
    // only sign-in method). Setting a password — via reset — flips it true. Every
    // existing / password account is true (the column default), unchanged.
    hasUsablePassword: boolean('has_usable_password').notNull().default(true),
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
    // the user. Originally user-kind only; as of the mandatory admin-login 2FA
    // (§6.12, #400) these same columns also back admin-kind accounts — the login
    // challenge reuses the exact user machinery, with only the email target
    // differing (see `twoFactorEmail`).
    twoFactorSecret: text('two_factor_secret'),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    twoFactorConfirmedAt: timestamp('two_factor_confirmed_at', { withTimezone: true }),
    // Standalone email-code 2FA method (§6.1, §13.2 V2-P5 addendum, #298).
    // Independent of the TOTP flag above: either method being on arms the login
    // challenge. Enabled only after an emailed code proves mailbox access; the
    // shared recovery codes are issued on the FIRST method enabled and wiped when
    // the last one goes off. For a user-kind account the code is sent to the
    // account email; for an admin-kind account it is sent to `twoFactorEmail`.
    twoFactorEmailEnabled: boolean('two_factor_email_enabled').notNull().default(false),
    // Admin-login email-OTP target (§6.12, #400). Admin-kind accounts ONLY: the
    // separately-set "2FA email" the login email code is delivered to, which may
    // differ from the account email. NULL until an admin turns the email method
    // on; the user-kind email method never reads it (it codes to the account
    // email). Set/changed only with a fresh 2FA proof once the admin is already
    // enrolled — the first-time set during forced enrollment needs none.
    twoFactorEmail: varchar('two_factor_email', { length: 320 }),
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
    // Quiet hours (§13.5 V5-P3). An optional per-user window that defers the
    // OUTBOUND channels (email/push/webpush) — the in-app bell is never touched.
    // OFF by default so existing users behave byte-identically; when enabled, a
    // non-urgent outbound notification fired inside the window is queued and
    // delivered at window end. `start`/`end` are minutes-since-local-midnight
    // (an overnight window is start > end). `timezone` is a nullable IANA name —
    // NULL = UTC / server-global (the pre-quiet-hours behaviour); it is stored
    // independently of the flag because the V5-P3 digest boundaries also align
    // to it (a daily digest lands in the user's local morning).
    quietHoursEnabled: boolean('quiet_hours_enabled').notNull().default(false),
    quietHoursStartMinute: integer('quiet_hours_start_minute')
      .notNull()
      .default(22 * 60),
    quietHoursEndMinute: integer('quiet_hours_end_minute')
      .notNull()
      .default(7 * 60),
    timezone: text('timezone'),
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
    // Curated profile icon id (§13.5 V5-P0c). NULL = no choice — every render
    // surface falls back to a deterministic id-derived default, so existing rows
    // and never-picked accounts still render an avatar. The allowed id set is
    // finite (`PROFILE_ICON_IDS` in contracts) and validated at the service
    // write path; storing bare text (no enum, no CHECK) means adding a new
    // curated avatar is a code-only change.
    profileIcon: text('profile_icon'),
    // Opt-in alert visibility (#455). While true, the user's price alerts are
    // exposed to their FOLLOWERS: a follower's per-follow alert triggers
    // (`user_follows.notify_on_alert_*`) may then deliver `follow.alert.created`
    // / `follow.alert.fired` news. OFF (default) means no follower ever sees or
    // is notified about an alert — the fan-out queries join on this flag at
    // emission time, so flipping it off stops delivery immediately. Per-user
    // over the whole alert list, NOT the V3-P5 audience model: followers are
    // not friends, so the friend-scoped rungs don't map (§16 2026-07-14).
    alertsVisibleToFollowers: boolean('alerts_visible_to_followers').notNull().default(false),
    // Per-user chat ban (§13.4 V4-P0d). While true the send path (chatService)
    // rejects a DM with CHAT_BANNED for both a cookie session and a `chat:write`
    // bearer token; reading existing threads stays allowed and unban is instant —
    // this column IS the state, so there is no cached ban to flush. It doubles as
    // the chat-off account default: a NEW account registered while the admin's
    // account-default has chat disabled starts with this flag set (never applied
    // retroactively to existing accounts).
    chatBanned: boolean('chat_banned').notNull().default(false),
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
 * Registration access tokens (PROJECTPLAN.md §6.12, §13.4 V4-P4a). Gate the
 * `invite_token` registration mode. Unlike the per-email `invites` above, a token
 * is not bound to an email and may be single- OR multi-use: `max_uses` is the cap
 * and `use_count` the running tally (a registration succeeds only while
 * use_count < max_uses AND not revoked AND not past `expires_at`). Only the
 * SHA-256 `token_hash` is stored — the raw token lives in the register URL shown
 * to the admin once. NULL `expires_at` = never expires. Admin-managed; the
 * creating admin is nulled out (not cascaded) if their account is later removed.
 */
export const registrationTokens = pgTable(
  'registration_tokens',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tokenHash: text('token_hash').notNull(),
    label: varchar('label', { length: 80 }),
    maxUses: integer('max_uses').notNull().default(1),
    useCount: integer('use_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('registration_tokens_token_hash_unique').on(t.tokenHash)],
);

/**
 * Approval-queue applications (PROJECTPLAN.md §6.12, §13.4 V4-P4a). In `approval`
 * registration mode a self-serve registrant's details land here as a PENDING
 * application — deliberately NOT a `users` row, so a pending applicant has no
 * usable account and cannot log in. The chosen password is argon2id-hashed at
 * request time and carried through to account creation on admin approval;
 * `locale` records the register-form language so the decision email localizes.
 * Approve creates the account + drops the row; reject just drops the row. Email +
 * username are unique (case-insensitively) so a duplicate application is refused.
 */
export const registrationRequests = pgTable(
  'registration_requests',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    email: varchar('email', { length: 320 }).notNull(),
    username: varchar('username', { length: 40 }).notNull(),
    // Nullable as of the Google-login approval path (§13.4 V4-P4b): a federated
    // applicant has no password, so this is NULL for a `provider` request and
    // approval mints a random (unusable) hash on the created account. A normal
    // (password) application still carries the argon2id hash chosen at request
    // time, exactly as before.
    passwordHash: text('password_hash'),
    locale: varchar('locale', { length: 5 }).notNull().default('en'),
    // Federated-registration application (§13.4 V4-P4b). NULL provider = a normal
    // password application (the pre-existing path). `provider`='google' carries
    // the verified Google identity so admin approval both creates the account AND
    // links it (the applicant then signs in via Google).
    provider: text('provider'),
    providerSubject: text('provider_subject'),
    providerEmailVerified: boolean('provider_email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('registration_requests_email_unique').on(t.email),
    uniqueIndex('registration_requests_username_lower_unique').on(sql`lower(${t.username})`),
  ],
);

/**
 * External (federated) sign-in identities (PROJECTPLAN.md §13.4 V4-P4b). One row
 * per linked provider account — today only Google. `subject` is the provider's
 * stable user id (the OIDC `sub` claim); (`provider`, `subject`) is globally
 * unique so a given Google account maps to exactly one BetterTrack user, and
 * (`provider`, `user_id`) is unique so a user links at most one account per
 * provider. `email` / `email_verified` snapshot what the provider asserted at
 * link time. Cascades away with the owning user.
 */
export const externalIdentities = pgTable(
  'external_identities',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_identities_provider_subject_unique').on(t.provider, t.subject),
    uniqueIndex('external_identities_provider_user_unique').on(t.provider, t.userId),
    index('external_identities_user_idx').on(t.userId),
  ],
);

/**
 * Single-use 2FA recovery codes (PROJECTPLAN.md §6.1, §13.2 V2-P5). Only the
 * SHA-256 `code_hash` is stored — the plaintext codes are shown once at
 * generation and never persisted. A code is consumed by stamping `used_at`
 * (single-use); regenerating wipes the whole set and issues a fresh batch, and
 * disabling 2FA clears them entirely. Cascades away with the owning user. Backs
 * both user-kind and (as of #400) admin-kind 2FA — the owner is a `users` row
 * either way, so no schema change was needed here for the admin surface.
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

/**
 * Passkeys / WebAuthn credentials (PROJECTPLAN.md §13.4 V4-P4). Each row is one
 * passwordless sign-in credential registered to an existing account. The public
 * key + signature counter + transports come from the authenticator at registration
 * and are used to verify (and clone-detect) every later assertion:
 *
 *  - `credentialId` — the authenticator's opaque credential id (base64url), globally
 *    unique; it is what a login assertion is looked up by.
 *  - `publicKey` — the credential's COSE public key (base64url-encoded bytes). No
 *    private key ever reaches the server — that stays on the authenticator.
 *  - `counter` — the signature counter last seen. A later assertion whose counter is
 *    not strictly greater is a cloned-authenticator signal and is rejected. Stored as
 *    `bigint` because the WebAuthn counter is a full 32-bit unsigned value.
 *  - `transports` — the browser-reported transport hints (`internal`, `usb`, …), fed
 *    back into future `allowCredentials` for a smoother prompt.
 *
 * Cascades away with the owning user. Never a second factor for password login and
 * never a registration path — a passkey only ever attaches to an existing account.
 */
export const passkeys = pgTable(
  'passkeys',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports').$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('passkeys_credential_id_unique').on(t.credentialId),
    index('passkeys_user_idx').on(t.userId),
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

/**
 * Admin "Problems" (§13.5 V5-P2 arc (d)): the DB-backed error/insight capture
 * that replaces Sentry. Unhandled request errors, permanently-failed jobs and
 * provider failures are folded by `fingerprint` (a stable hash of kind + name +
 * normalized message) into one row per distinct problem, with an occurrence
 * count and first/last-seen stamps. Every stored string is PII-scrubbed before
 * it lands here (no email/token/cookie). Resolving points `resolvedBy` at the
 * admin who cleared it (nulled if that account is deleted).
 */
export const problems = pgTable(
  'problems',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    fingerprint: text('fingerprint').notNull(),
    kind: problemKindEnum('kind').notNull(),
    status: problemStatusEnum('status').notNull().default('open'),
    title: text('title').notNull(),
    message: text('message').notNull().default(''),
    context: jsonb('context'),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('problems_fingerprint_unique').on(t.fingerprint),
    index('problems_status_last_seen_idx').on(t.status, t.lastSeenAt),
    index('problems_kind_idx').on(t.kind),
  ],
);

/**
 * First-party usage capture (§13.5 V5-P2 arc (b), admin usage analytics). One
 * row per (user, feature, asset, UTC day) with a hit counter — NOT a raw
 * per-request log, so it can never grow unbounded: repeated hits of the same
 * feature on the same day fold into `hits` via the unique index. `asset_id` is
 * the empty string when the request had no asset (kept non-null so the unique
 * index folds those rows too — Postgres treats NULLs as distinct). Deleting a
 * user cascades their rows away. No PII: only ids, a low-cardinality feature
 * bucket and a day.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feature: text('feature').notNull(),
    assetId: text('asset_id').notNull().default(''),
    day: date('day').notNull(),
    hits: integer('hits').notNull().default(1),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('usage_events_unique').on(t.userId, t.feature, t.assetId, t.day),
    index('usage_events_day_idx').on(t.day),
    index('usage_events_asset_day_idx').on(t.assetId, t.day),
  ],
);

/**
 * Materialized daily rollup of {@link usageEvents}, refreshed by the
 * `usage.rollup` cron. One row per (day, feature): `events` sums hits and
 * `active_users` is the distinct-user count for that day+feature. The special
 * sentinel feature `'*'` ({@link USAGE_TOTAL_FEATURE}) holds the all-features
 * per-day totals (its `active_users` is the day's distinct-user count) — the
 * source for the admin activity series, which can't be summed from the
 * per-feature rows without double-counting users.
 */
export const usageDaily = pgTable(
  'usage_daily',
  {
    day: date('day').notNull(),
    feature: text('feature').notNull(),
    events: integer('events').notNull().default(0),
    activeUsers: integer('active_users').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'usage_daily_pk', columns: [t.day, t.feature] })],
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
    // #437: set = archived (explicitly by the user, or by the auto-archive
    // sweep once the read is older than the service threshold); NULL = active.
    // The default list view and the unread badge only see active rows.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
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
 * Per-user per-type OUTBOUND delivery cadence (V5-P3 digest mode). `instant`
 * (the pre-digest behaviour) delivers each event immediately; `daily`/`weekly`
 * defer the outbound channels (email/push/webpush) into ONE grouped digest per
 * period. Absence of a row = `instant` — so the whole feature is additive and no
 * existing user is migrated. Governs outbound channels only; the in-app bell is
 * always instant (§13.5 V5-P3).
 */
export const notificationCadenceEnum = pgEnum('notification_cadence', [
  'instant',
  'daily',
  'weekly',
]);

export const notificationCadences = pgTable(
  'notification_cadences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    cadence: notificationCadenceEnum('cadence').notNull(),
  },
  (t) => [primaryKey({ name: 'notification_cadences_user_type_pk', columns: [t.userId, t.type] })],
);

/**
 * The digest queue (V5-P3). A deferred (daily/weekly) notification lands here as
 * ONE row per outbound channel it routes to, carrying the already-rendered
 * title/body (+ push deep-link `data`) and the `period` key the digest job
 * groups by. The digest job claims a whole (user, period) group atomically —
 * stamping `delivered_at` in the same UPDATE it reads the rows — so a re-run or
 * a second worker never double-sends (idempotent per (user, period)). `channel`
 * reuses the notification_channel enum but only ever holds email/push/webpush.
 * The `period` is computed per user at enqueue in the user's timezone (§13.5
 * V5-P3 quiet hours) so a daily/weekly digest buckets by the user's LOCAL day.
 *
 * The same table doubles as the quiet-hours **deferral store** (§13.5 V5-P3):
 * an INSTANT-cadence outbound notification fired inside a user's quiet window is
 * queued here with `cadence = 'instant'` and a `deliver_after` = window end, and
 * the deferred-delivery job sends each such row INDIVIDUALLY once due (never
 * grouped — the grouped-summary path only ever queries the daily/weekly
 * cadences). `deliver_after` is NULL for the grouped digest rows.
 */
export const notificationDigestQueue = pgTable(
  'notification_digest_queue',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    cadence: notificationCadenceEnum('cadence').notNull(),
    period: text('period').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    data: jsonb('data'),
    // Quiet-hours deferral (V5-P3): the wall-clock moment a deferred INSTANT row
    // becomes due for individual delivery (= the user's quiet-window end). NULL
    // for grouped daily/weekly digest rows, which deliver on the digest cron.
    deliverAfter: timestamp('deliver_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    // The job scans pending rows by cadence and groups by (user, period); the
    // claim UPDATE filters (user, period, cadence) WHERE delivered_at IS NULL.
    // Partial on the pending set keeps the scan/claim off delivered history.
    index('notification_digest_queue_pending_idx')
      .on(t.cadence, t.userId, t.period)
      .where(sql`${t.deliveredAt} is null`),
    index('notification_digest_queue_user_idx').on(t.userId),
    // The quiet-hours deferred-delivery job claims due rows by `deliver_after`;
    // partial on the still-pending deferred set keeps the scan off history.
    index('notification_digest_queue_deferred_idx')
      .on(t.deliverAfter)
      .where(sql`${t.deliveredAt} is null and ${t.deliverAfter} is not null`),
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

/**
 * Ideas — saved & shareable Workboard analyses (§13.4 V4-P9). One row per saved
 * idea: a name, an optional free-text thesis note, and the exact Workboard
 * `state` (basket source — a conglomerate ref or an ad-hoc weighted asset set —
 * plus the backtest parameters) carried as jsonb so a save→reopen roundtrip is
 * byte-exact and the shape stays additive. Owner-scoped (cascade on account
 * delete); sharing is governed by the polymorphic {@link shareAudiences} model
 * as the fourth `share_kind`, never a column here.
 */
export const ideas = pgTable(
  'ideas',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    thesis: text('thesis'),
    // The verbatim Workboard state (contracts' IdeaWorkboardState). Untyped jsonb
    // here (mirrors other jsonb columns); the repository casts on read.
    state: jsonb('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ideas_owner_idx').on(t.ownerId)],
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
export const taxModeEnum = pgEnum('tax_mode', [
  'none',
  'manual_per_trade',
  'country_specific',
  'custom',
]);

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
    // Custom-mode parameter snapshot (V5-P4c, #584): the exact rule set this
    // row was taxed under, frozen like the mode itself (§16 cutover — a
    // parameter change is a mode switch, forward-only). NULL on non-custom rows.
    taxParams: jsonb('tax_params'),
    // Uncovered sell (issue #369): a SELL recorded against an insufficient/zero
    // holding behind the explicit acknowledgment closes the position at 0 (no
    // shorts). `allow_uncovered` is the persisted acknowledgment — it also keeps
    // a later edit/delete replay from silently rejecting the (already accepted)
    // oversell. `uncovered_entry_price` is the native per-unit basis the user
    // supplied for the uncovered shares (NULL = the sale price is used → 0 %
    // realized on that portion, so no phantom gain reaches the tax ledger).
    allowUncovered: boolean('allow_uncovered').notNull().default(false),
    uncoveredEntryPrice: numeric('uncovered_entry_price', { precision: 20, scale: 6 }),
    // Source tag (V5-P0c, §13.5): how this row entered the ledger — `manual`
    // (hand entry), `import:<broker>` (CSV apply), later `sync:<provider>` /
    // `standing-order`. Server-assigned only; a client never supplies it. The
    // allowed format is validated in contracts (sourceTagSchema); no CHECK here
    // so a new provider slug is a code-only change.
    source: text('source').notNull().default('manual'),
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
    // Custom-mode parameter snapshot (V5-P4c) — same freezing semantics as the
    // transaction column. NULL on non-custom rows.
    taxParams: jsonb('tax_params'),
    // Source tag (V5-P0c): `manual` / `import:<broker>` / `sync:<provider>`.
    // Server-assigned only; validated in contracts (sourceTagSchema).
    source: text('source').notNull().default('manual'),
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
    // Source tag (V5-P0c): `manual` / `import:<broker>` / `sync:<provider>`. A
    // linked movement (buy/sell_proceeds/dividend/tax) inherits its parent
    // transaction's or dividend's tag; an external deposit/withdrawal takes the
    // tag of the write path. Server-assigned only; validated in contracts.
    source: text('source').notNull().default('manual'),
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
 * Precomputed per-portfolio daily series (V5-P1 arc a, issue #553): one row per
 * (portfolio, calendar day) from the portfolio's first event through
 * *yesterday* — the live "today" point is always computed fresh from quotes and
 * NEVER persisted. Graphs/analytics read these rows instead of re-running the
 * value engine; the engine itself remains the single writer ("one math, two
 * uses"). All money columns are unconstrained `numeric` holding the engine's
 * full-precision output verbatim (§5.4 — no snapshot-side rounding), so a
 * stored day round-trips bit-identical to a fresh recompute.
 *
 * Invalidation (§16 2026-07-17): every history-mutating write deletes the rows
 * from its earliest affected day and marks `portfolio_snapshot_state` dirty;
 * rows strictly before that day are never touched. Portfolio deletion cascades
 * both tables away.
 */
export const portfolioDailySnapshots = pgTable(
  'portfolio_daily_snapshots',
  {
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    /** Net worth: holdings value + EOD cash balance (#311 semantics), EUR. */
    valueEur: numeric('value_eur').notNull(),
    /** Open cost basis (Σ held qty · avg cost) at that day's FX, EUR. */
    costBasisEur: numeric('cost_basis_eur').notNull(),
    /** Unrealized P/L of the holdings leg: holdings value − cost basis, EUR. */
    plEur: numeric('pl_eur').notNull(),
    /** Net external TWR flow that day (0 = none), EUR — feeds timeWeightedReturn. */
    flowEur: numeric('flow_eur').notNull(),
    /** Per-source EOD cash split: `{ [sourceId]: balanceEur }` (V3-P3 sources). */
    cashBySource: jsonb('cash_by_source').notNull(),
    /** Per-asset EUR value that day: `{ [assetId]: valueEur }` — the analytics feed. */
    assetValues: jsonb('asset_values').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'portfolio_daily_snapshots_pk', columns: [t.portfolioId, t.date] })],
);

/**
 * Per-portfolio snapshot bookkeeping (issue #553): `computed_through` is the
 * last day the writer fully computed (always yesterday at write time);
 * `dirty_from` non-null means a history-mutating write invalidated the tail
 * from that day and a recompute is owed — readers must not serve the rows.
 * Rows are valid exactly when `dirty_from IS NULL AND computed_through ≥
 * yesterday`; anything else falls back to the live engine (which refills).
 */
export const portfolioSnapshotState = pgTable('portfolio_snapshot_state', {
  portfolioId: uuid('portfolio_id')
    .primaryKey()
    .references(() => portfolios.id, { onDelete: 'cascade' }),
  computedThrough: date('computed_through').notNull(),
  dirtyFrom: date('dirty_from'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PortfolioDailySnapshotRow = typeof portfolioDailySnapshots.$inferSelect;
export type NewPortfolioDailySnapshotRow = typeof portfolioDailySnapshots.$inferInsert;
export type PortfolioSnapshotStateRow = typeof portfolioSnapshotState.$inferSelect;

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
    // Manual mode's configurable default (V5-P4c, #584): prefilled into every
    // entry-less sell/dividend, editable per trade. Amount OR rate, never both;
    // both NULL = no default (exact pre-V5-P4 behavior).
    manualDefaultAmountEur: numeric('manual_default_amount_eur', { precision: 20, scale: 6 }),
    manualDefaultRatePct: numeric('manual_default_rate_pct', { precision: 9, scale: 6 }),
    // The custom engine's parameter set (V5-P4c); present exactly in 'custom'
    // mode (CHECK below), validated by the contract at the service edge.
    customParams: jsonb('custom_params'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'user_tax_settings_country',
      sql`(${t.mode} = 'country_specific') = (${t.country} is not null)`,
    ),
    check(
      'user_tax_settings_custom_params',
      sql`(${t.mode} = 'custom') = (${t.customParams} is not null)`,
    ),
    check(
      'user_tax_settings_manual_default',
      sql`(${t.mode} = 'manual_per_trade') or (${t.manualDefaultAmountEur} is null and ${t.manualDefaultRatePct} is null)`,
    ),
    check(
      'user_tax_settings_manual_default_single',
      sql`${t.manualDefaultAmountEur} is null or ${t.manualDefaultRatePct} is null`,
    ),
  ],
);

/**
 * Per-portfolio setting overrides (issue #636). The override layer of the
 * scoping cascade `effective = portfolio override ?? user default ?? system
 * default`: one row per (portfolio, setting key) that pins a value for THAT
 * portfolio, shadowing the user-level default. A generic key/jsonb store so any
 * scopeable setting opts in without a migration — the first key is `'tax'`
 * (value `{ mode, country }`, validated by the tax contract at the service
 * edge). A missing row means "inheriting the default"; deleting a row is the
 * reset-to-default affordance. The user-level default itself keeps its typed
 * home per setting (tax → {@link userTaxSettings}). Cascades away with the
 * portfolio, and `updated_at` records when the override last moved.
 */
export const portfolioSettings = pgTable(
  'portfolio_settings',
  {
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.portfolioId, t.key] })],
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
 * `friend_groups` — a named friend circle owned by one user (§13.5 V5-P8),
 * usable as a sharing audience between `specific_friends` and `all_friends`. The
 * group is private to its owner; nobody else can see or use it. Deleting a group
 * cascades its membership rows away and SET-NULLs any `share_audiences.group_id`
 * that referenced it, so a share pointing at a deleted group resolves to nobody
 * (fail-closed, §6.9) rather than widening.
 */
export const friendGroups = pgTable(
  'friend_groups',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('friend_groups_owner_idx').on(t.ownerId)],
);

/**
 * `friend_group_members` — the roster of one {@link friendGroups} circle. Every
 * member must be an accepted friend of the group's owner (enforced by the
 * service on add); unfriending removes the ex-friend from all of the owner's
 * groups (and vice-versa). One row per (group, member); both sides cascade on
 * user/group deletion.
 */
export const friendGroupMembers = pgTable(
  'friend_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => friendGroups.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'friend_group_members_pk', columns: [t.groupId, t.memberId] }),
    index('friend_group_members_member_idx').on(t.memberId),
  ],
);

/**
 * `user_follows` — one-directional PERSON follow (#438). The follower opts into
 * `follow.published` news about a followed user's items that become newly visible
 * to them. Unlike {@link friendships} this is asymmetric with NO accept step, and
 * it grants no read access on its own — visibility stays enforced by the audience
 * layer. One row per ordered (follower, followed) pair (PK dedupes a repeat
 * follow); a self-follow is rejected by the CHECK. Deleting either user cascades
 * the row away, so an account deletion stops all its news both ways.
 */
export const userFollows = pgTable(
  'user_follows',
  {
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followedId: uuid('followed_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Per-followed-person opt-in (#439, default OFF): when true, every item of
     * theirs that becomes newly visible to the follower (the same #438 event
     * matrix that fires `follow.published`) is auto-added to the follower's
     * {@link itemFollows} — in addition to the news notification.
     */
    autoFollowItems: boolean('auto_follow_items').notNull().default(false),
    /**
     * Alert-follow triggers (#455, both default OFF, independent): notify the
     * follower when the followed person CREATES a new alert / when one of their
     * alerts FIRES. Notify-only — no alert is ever copied into the follower's
     * own list — and both are gated at emission time on the owner's
     * {@link users.alertsVisibleToFollowers} opt-in.
     */
    notifyOnAlertCreate: boolean('notify_on_alert_create').notNull().default(false),
    notifyOnAlertFire: boolean('notify_on_alert_fire').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'user_follows_pk', columns: [t.followerId, t.followedId] }),
    // Reverse lookup: "who follows this user" (the emission fan-out reads it).
    index('user_follows_followed_idx').on(t.followedId),
    check('user_follows_no_self', sql`${t.followerId} <> ${t.followedId}`),
  ],
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
export const shareKindEnum = pgEnum('share_kind', [
  'portfolio',
  'conglomerate',
  'watchlist',
  'idea',
]);
export const shareAudienceEnum = pgEnum('share_audience', [
  'private',
  'specific_friends',
  'group',
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
    /**
     * The referenced friend circle when audience = `group` (V5-P8), else NULL.
     * `ON DELETE SET NULL`: deleting the group leaves the audience row at
     * `group` with a null reference, which resolves to NOBODY (fail-closed) —
     * the share goes dark rather than widening (§6.9, §16 planner decision).
     */
    groupId: uuid('group_id').references(() => friendGroups.id, { onDelete: 'set null' }),
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

/**
 * `item_follows` — a bookmark of ANOTHER user's shareable item (#439): one row
 * per (user, kind, subject) the user follows. Like {@link sharedItemActivityPrefs}
 * the `subject_id` is polymorphic (portfolio / conglomerate / watchlist id, no
 * FK); a follow grants NO read access — the Following view re-authorizes every
 * row through the audience layer at read time, so an item that loses visibility
 * renders as gone (the chat-chip `viewable:false` precedent) and one that is
 * deleted is purged via the same `clearForSubject` hygiene hook the audience
 * rows use. Rows are written either explicitly (follow action on a visible
 * item) or by the auto-follow fan-out ({@link userFollows.autoFollowItems}).
 */
export const itemFollows = pgTable(
  'item_follows',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: shareKindEnum('kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The unique triple — a repeat follow (manual or auto) is a no-op upsert.
    primaryKey({ name: 'item_follows_pk', columns: [t.userId, t.kind, t.subjectId] }),
    // Reverse lookup for the subject-deletion purge (clearForSubject).
    index('item_follows_subject_idx').on(t.kind, t.subjectId),
  ],
);

// --- Comments + reactions on shared items (§13.5 V5-P8) ---------------------

/**
 * A comment on a shareable item (§13.5 V5-P8). `subject_id` is polymorphic
 * (portfolio / conglomerate / watchlist / idea id, no FK), mirroring
 * {@link shareAudiences}: the comment service authorizes read AND write through
 * the ONE audience-enforcement layer, so a comment is visible to exactly the
 * item's current audience — narrowing the audience narrows the thread on the
 * next read, no denormalized copy to invalidate.
 *
 * **Soft delete.** A removed comment keeps its row with `deleted_at` set and
 * `deleted_by` recording who removed it (its author, or the item owner who
 * moderates every comment). Reads filter deleted rows out; the row is retained
 * so a moderation action is auditable, and its reactions cascade away with it.
 */
export const itemComments = pgTable(
  'item_comments',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    kind: shareKindEnum('kind').notNull(),
    subjectId: uuid('subject_id').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Soft-delete tombstone (§13.5 V5-P8): non-null → hidden from every read.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // Who deleted it (author or item owner); set-null keeps the tombstone if
    // that account is later deleted.
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    // Thread read: every live comment on one item, oldest-first at read time.
    index('item_comments_subject_idx').on(t.kind, t.subjectId),
    index('item_comments_author_idx').on(t.authorId),
  ],
);

/** A reaction targets either a shared item or a single comment. */
export const reactionTargetEnum = pgEnum('reaction_target', ['item', 'comment']);

/**
 * A single emoji reaction (§13.5 V5-P8) on a shared item OR a comment — the ONE
 * reaction table, discriminated by `target_type`. For an `item` target the
 * (kind, subject_id) columns are set (polymorphic, no FK, like the audience
 * model); for a `comment` target `comment_id` is set (FK → {@link itemComments},
 * cascade). The curated emoji set is enforced by the contract, so only the
 * fixed six ever land here. A user can hold at most one row per (target, emoji)
 * — the two partial unique indexes make a repeat "react" a no-op the service
 * turns into a toggle-off.
 */
export const itemReactions = pgTable(
  'item_reactions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: reactionTargetEnum('target_type').notNull(),
    // Item target (target_type = 'item'): polymorphic subject, no FK.
    kind: shareKindEnum('kind'),
    subjectId: uuid('subject_id'),
    // Comment target (target_type = 'comment'): FK into item_comments.
    commentId: uuid('comment_id').references(() => itemComments.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One reaction per (user, item, emoji) — partial so the NULL comment_id of
    // item rows doesn't defeat uniqueness.
    uniqueIndex('item_reactions_item_unique')
      .on(t.userId, t.kind, t.subjectId, t.emoji)
      .where(sql`${t.targetType} = 'item'`),
    // One reaction per (user, comment, emoji).
    uniqueIndex('item_reactions_comment_unique')
      .on(t.userId, t.commentId, t.emoji)
      .where(sql`${t.targetType} = 'comment'`),
    // Aggregate a whole item's reactions in one scan.
    index('item_reactions_item_idx').on(t.kind, t.subjectId),
    // Aggregate one comment's reactions.
    index('item_reactions_comment_idx').on(t.commentId),
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
  'idea',
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

/**
 * Admin-composed in-app announcements (§13.4 V4-P5b). One row per composed
 * announcement — severity + per-locale (EN + DE) title/body + an optional
 * active window (start/end, inclusive; NULL start = start immediately, NULL end
 * = no auto-off) — plus an `active` flag the admin toggles independently of the
 * window (a dry-run save stays off). `published_at` is stamped when the row is
 * flipped active for the first time; it drives the one-time fan-out into every
 * user's inbox (`account.notice` type, deduped per-user by a shared eventKey).
 * The composer is nulled out (not cascaded) if their admin account is later
 * removed, so the announcement itself survives (audit + inbox history stay).
 *
 * Delivery is banner + inbox only — no email/push/Telegram/Discord routing goes
 * through the notification matrix. Dismissal is per-user (see
 * {@link announcementDismissals}); a newly published announcement re-appears
 * for every user even if they dismissed a prior one.
 */
export const announcementSeverityEnum = pgEnum('announcement_severity', [
  'info',
  'warning',
  'critical',
]);

export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    severity: announcementSeverityEnum('severity').notNull().default('info'),
    // Per-locale content stored server-side; the API resolves the viewer locale
    // (via `resolveEmailLocale`, the same seam the notification emails use) and
    // renders the matching pair. EN is the source-of-truth fallback.
    titleEn: text('title_en').notNull(),
    bodyEn: text('body_en').notNull(),
    titleDe: text('title_de').notNull(),
    bodyDe: text('body_de').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    active: boolean('active').notNull().default(false),
    // Stamped the first time `active` flips on — the moment the fan-out job runs.
    // Later re-publishes update this to the latest publish timestamp; the shared
    // eventKey (announcement:<id>:v1) keeps a re-publish idempotent per user.
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('announcements_active_window_idx').on(t.active, t.startsAt, t.endsAt),
    check(
      'announcements_window_order',
      sql`${t.startsAt} is null or ${t.endsAt} is null or ${t.startsAt} <= ${t.endsAt}`,
    ),
  ],
);

/**
 * Per-user announcement dismissal (§13.4 V4-P5b). One row per (user × announcement);
 * a dismissed row stops appearing in the user's banner list forever. Idempotent by
 * PK (a repeat dismissal is a no-op). Cascades away with the user OR with the
 * announcement — a deleted announcement is gone; its dismissal history is not load
 * bearing. Rows are the audit trail: created_at doubles as the dismiss timestamp.
 */
export const announcementDismissals = pgTable(
  'announcement_dismissals',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    announcementId: uuid('announcement_id')
      .notNull()
      .references(() => announcements.id, { onDelete: 'cascade' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'announcement_dismissals_pk',
      columns: [t.userId, t.announcementId],
    }),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type AnnouncementRow = typeof announcements.$inferSelect;
export type NewAnnouncementRow = typeof announcements.$inferInsert;
export type AnnouncementDismissalRow = typeof announcementDismissals.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type OAuthGrantRow = typeof oauthGrants.$inferSelect;
export type OAuthAuthCodeRow = typeof oauthAuthCodes.$inferSelect;
export type OAuthAccessTokenRow = typeof oauthAccessTokens.$inferSelect;
export type OAuthRefreshTokenRow = typeof oauthRefreshTokens.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type RegistrationTokenRow = typeof registrationTokens.$inferSelect;
export type RegistrationRequestRow = typeof registrationRequests.$inferSelect;
export type ExternalIdentityRow = typeof externalIdentities.$inferSelect;
export type TwoFactorRecoveryCodeRow = typeof twoFactorRecoveryCodes.$inferSelect;
export type PasskeyRow = typeof passkeys.$inferSelect;
export type NewPasskeyRow = typeof passkeys.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type ProblemRow = typeof problems.$inferSelect;
export type NewProblemRow = typeof problems.$inferInsert;
export type UsageEventRow = typeof usageEvents.$inferSelect;
export type NewUsageEventRow = typeof usageEvents.$inferInsert;
export type UsageDailyRow = typeof usageDaily.$inferSelect;
export type NewUsageDailyRow = typeof usageDaily.$inferInsert;
export type AssetRow = typeof assets.$inferSelect;
export type PriceHistoryRow = typeof priceHistory.$inferSelect;
export type WorkboardItemRow = typeof workboardItems.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationSettingRow = typeof notificationSettings.$inferSelect;
export type NotificationCadenceRow = typeof notificationCadences.$inferSelect;
export type NotificationDigestQueueRow = typeof notificationDigestQueue.$inferSelect;
export type NewNotificationDigestQueueRow = typeof notificationDigestQueue.$inferInsert;
export type DeviceTokenRow = typeof deviceTokens.$inferSelect;
export type NewDeviceTokenRow = typeof deviceTokens.$inferInsert;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscriptionRow = typeof pushSubscriptions.$inferInsert;
export type EmailLogRow = typeof emailLog.$inferSelect;
export type NewEmailLogRow = typeof emailLog.$inferInsert;
export type ConglomerateRow = typeof conglomerates.$inferSelect;
export type ConglomeratePositionRow = typeof conglomeratePositions.$inferSelect;
export type ShareLinkRow = typeof shareLinks.$inferSelect;
export type IdeaRow = typeof ideas.$inferSelect;
export type NewIdeaRow = typeof ideas.$inferInsert;
export type PortfolioRow = typeof portfolios.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type CashMovementRow = typeof portfolioCashMovements.$inferSelect;
export type NewCashMovementRow = typeof portfolioCashMovements.$inferInsert;
export type CashSourceRow = typeof portfolioCashSources.$inferSelect;
export type NewCashSourceRow = typeof portfolioCashSources.$inferInsert;
export type DividendRow = typeof dividends.$inferSelect;
export type NewDividendRow = typeof dividends.$inferInsert;
export type UserTaxSettingsRow = typeof userTaxSettings.$inferSelect;
export type PortfolioSettingsRow = typeof portfolioSettings.$inferSelect;
export type FriendRequestRow = typeof friendRequests.$inferSelect;
export type NewFriendRequestRow = typeof friendRequests.$inferInsert;
export type FriendshipRow = typeof friendships.$inferSelect;
export type NewFriendshipRow = typeof friendships.$inferInsert;
export type UserFollowRow = typeof userFollows.$inferSelect;
export type NewUserFollowRow = typeof userFollows.$inferInsert;
export type ItemFollowRow = typeof itemFollows.$inferSelect;
export type NewItemFollowRow = typeof itemFollows.$inferInsert;
export type WatchlistRow = typeof watchlists.$inferSelect;
export type NewWatchlistRow = typeof watchlists.$inferInsert;
export type FriendGroupRow = typeof friendGroups.$inferSelect;
export type NewFriendGroupRow = typeof friendGroups.$inferInsert;
export type FriendGroupMemberRow = typeof friendGroupMembers.$inferSelect;
export type NewFriendGroupMemberRow = typeof friendGroupMembers.$inferInsert;
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

/**
 * Account data-export jobs (PROJECTPLAN.md §13.4 V4-P6a, #494). One row per
 * "Export my data" request: a background job assembles a zip of every
 * user-owned entity and lands it under the env-configured export directory.
 * `status` walks `pending → ready` (or `failed`); `ready` carries the on-disk
 * `file_path`/`file_size` plus the download gate — only the SHA-256
 * `download_token_hash` is stored (never the raw token, which is handed to the
 * requester once), and `expires_at` bounds the download window. The cleanup job
 * deletes the file and the row once past expiry. Rate-limited to 1/day per user
 * off `created_at`. Cascades away with the owning user.
 */
export const exportJobStatusEnum = pgEnum('export_job_status', ['pending', 'ready', 'failed']);

export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: exportJobStatusEnum('status').notNull().default('pending'),
    // Absolute path of the assembled zip under the export dir; NULL until ready.
    filePath: text('file_path'),
    fileSize: integer('file_size'),
    // SHA-256 of the ≥256-bit download token; the raw token is returned to the
    // requester once and never persisted. The download join matches this hash.
    downloadTokenHash: text('download_token_hash'),
    // When the ready file stops being downloadable — the cleanup job deletes
    // past this. NULL until the job is ready.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Coarse failure reason for the status surface (never a stack/secret).
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
  },
  (t) => [
    index('export_jobs_user_created_idx').on(t.userId, t.createdAt),
    uniqueIndex('export_jobs_download_token_hash_unique').on(t.downloadTokenHash),
    index('export_jobs_expires_at_idx').on(t.expiresAt),
  ],
);

export type ExportJobRow = typeof exportJobs.$inferSelect;
export type NewExportJobRow = typeof exportJobs.$inferInsert;

/**
 * Per-user Telegram chat link (§13.4 V4-P10). One row per user (PK on `user_id`)
 * carrying either a **pending** link code (`chat_id` NULL, `link_code`/
 * `link_code_expires_at` set) or a **linked** chat (`chat_id` set,
 * `link_code`/`link_code_expires_at` NULL, `linked_at` stamped). A repeat
 * link-start replaces the pending pair; unlink deletes the row. The bot token
 * itself lives in env (`BT_TELEGRAM_BOT_TOKEN`) — this table only carries the
 * per-user relationship + code state.
 *
 * `chat_id` is a Telegram numeric id (bigint would fit; text keeps it fully
 * opaque and future-proof). The code is a URL-safe random string (SHA-hash of
 * the raw plaintext would add nothing — its expiry is short, its space large,
 * and it exists only in-flight between the SPA and Telegram). The row cascades
 * away with the owner (§10 scoping).
 */
export const telegramLinks = pgTable(
  'telegram_links',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Numeric Telegram chat id (as text — Telegram's ids can exceed int4 range
    // and are opaque to us). NULL while a link is pending.
    chatId: text('chat_id'),
    // The bot's @username at link time — cached so /settings/telegram can
    // return the deep link without a fresh getMe roundtrip on every read.
    botUsername: text('bot_username'),
    // Pending link code the user pastes into the Telegram bot with `/start`.
    // Cleared once the code is confirmed. NOT unique — code space is large
    // enough that a collision is a fresh row, and we look up by (userId, code)
    // through the row's own PK anyway.
    linkCode: text('link_code'),
    linkCodeExpiresAt: timestamp('link_code_expires_at', { withTimezone: true }),
    // Stamped when a chatId lands. NULL while pending.
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Speeds up the confirm flow's "does anyone have this pending code?" lookup
    // (Telegram's `/start <code>` webhook arrives without a user context).
    index('telegram_links_link_code_idx').on(t.linkCode),
  ],
);

export type TelegramLinkRow = typeof telegramLinks.$inferSelect;
export type NewTelegramLinkRow = typeof telegramLinks.$inferInsert;

/**
 * Per-user Discord webhook (§13.4 V4-P10). One row per user (PK on `user_id`)
 * carrying the ENCRYPTED webhook URL (via `services/crypto/secretBox`) plus a
 * short masked identifier the settings surface renders back so the user can
 * recognize it. The plaintext URL never leaves the API process. Rows cascade
 * with the owner.
 */
export const discordWebhooks = pgTable('discord_webhooks', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // secretBox envelope (`v1.<iv>.<tag>.<ct>`) of the raw webhook URL.
  encryptedUrl: text('encrypted_url').notNull(),
  // Short masked slug of the webhook id segment for the settings UI.
  webhookIdMasked: text('webhook_id_masked').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DiscordWebhookRow = typeof discordWebhooks.$inferSelect;
export type NewDiscordWebhookRow = typeof discordWebhooks.$inferInsert;
// --- Broker CSV imports (§13.4 V4-P8) ---------------------------------------

/** Batch lifecycle: staged (`pending`) until confirmed (`applied`). */
export const importBatchStatusEnum = pgEnum('import_batch_status', ['pending', 'applied']);

/** Normalized row kinds a broker CSV maps to (mirrors contracts' IMPORT_ROW_KINDS). */
export const importRowKindEnum = pgEnum('import_row_kind', [
  'buy',
  'sell',
  'dividend',
  'deposit',
  'withdrawal',
]);

/** Preview flag per staged row (mirrors contracts' IMPORT_ROW_FLAGS). */
export const importRowFlagEnum = pgEnum('import_row_flag', [
  'mapped',
  'unmapped',
  'duplicate',
  'error',
]);

/** Apply outcome per staged row (mirrors contracts' IMPORT_ROW_RESULTS). */
export const importRowResultEnum = pgEnum('import_row_result', [
  'applied',
  'skipped_duplicate',
  'skipped_unmapped',
  'skipped_error',
  'failed',
]);

/**
 * One uploaded broker CSV, staged for preview (§13.4 V4-P8). Nothing in the
 * portfolio is written while a batch is `pending` — apply happens only on the
 * explicit confirm, through the portfolio/tax services. Owner- and portfolio-
 * scoped; both FKs cascade so an account or portfolio deletion takes its staged
 * imports with it. `broker_id` is a mapper id string (never an enum — adding a
 * broker must not need a migration). `cash_source_id` is recorded at apply time.
 */
export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    brokerId: text('broker_id').notNull(),
    filename: text('filename').notNull(),
    status: importBatchStatusEnum('status').notNull().default('pending'),
    cashSourceId: uuid('cash_source_id').references(() => portfolioCashSources.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [index('import_batches_owner_idx').on(t.ownerId)],
);

/**
 * One normalized staging row of an import batch (§13.4 V4-P8). Carries the
 * original CSV line (`raw`, 1-based `row_index`) beside the normalized fields:
 * trades keep native-currency quantity/price/fee, dividend + cash rows keep the
 * EUR magnitude in `amount_eur` (the cash ledger is EUR-only, §14). `flag` is
 * the preview verdict; `message` explains error/unmapped rows. `content_hash`
 * (date+instrument+qty+price, §13.4) drives dedupe within the file and against
 * already-recorded data. `asset_id` is the resolved catalog instrument (SET NULL
 * on catalog deletion — the row then re-reads as unresolved rather than
 * vanishing). `result`/`result_message` record the per-row apply outcome.
 */
export const importRows = pgTable(
  'import_rows',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    rowIndex: integer('row_index').notNull(),
    raw: text('raw').notNull(),
    kind: importRowKindEnum('kind'),
    flag: importRowFlagEnum('flag').notNull(),
    message: text('message'),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    isin: text('isin'),
    symbol: text('symbol'),
    name: text('name'),
    quantity: numeric('quantity', { precision: 20, scale: 8 }),
    price: numeric('price', { precision: 20, scale: 6 }),
    fee: numeric('fee', { precision: 20, scale: 6 }),
    amountEur: numeric('amount_eur', { precision: 20, scale: 6 }),
    currency: char('currency', { length: 3 }),
    note: text('note'),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    contentHash: text('content_hash'),
    result: importRowResultEnum('result'),
    resultMessage: text('result_message'),
  },
  (t) => [index('import_rows_batch_idx').on(t.batchId)],
);

export type ImportBatchRow = typeof importBatches.$inferSelect;
export type NewImportBatchRow = typeof importBatches.$inferInsert;
export type ImportRowRow = typeof importRows.$inferSelect;
export type NewImportRowRow = typeof importRows.$inferInsert;

// --- Standing orders (V5-P6b arc a, issue #593) ----------------------------

export const standingOrderKindEnum = pgEnum('standing_order_kind', [
  'buy-asset',
  'cash-add',
  'cash-deduct',
]);
export const standingOrderCadenceEnum = pgEnum('standing_order_cadence', ['daily', 'monthly']);
export const standingOrderStatusEnum = pgEnum('standing_order_status', ['active', 'paused']);

/**
 * Standing orders (PROJECTPLAN.md §13.5 V5-P6b arc (a), issue #593): scheduled
 * recurring actions a daily job auto-records on their schedule. A `buy-asset`
 * books a BUY of `amount` units at the current quote; `cash-add` / `cash-deduct`
 * book a cash deposit / withdrawal of `amount` EUR (the sign is assigned by kind
 * downstream, never stored here). `asset_id` is set exactly for `buy-asset`;
 * `anchor_day` (1–31, clamped to month-end when the month is shorter) exactly
 * for `monthly`. `last_run_at` / `last_period_key` are denormalized display
 * bookkeeping of the newest booked occurrence — the authoritative exactly-once
 * ledger is `standing_order_runs`. `currency` is descriptive (EUR for cash, the
 * asset's native currency for a buy). Deleting the portfolio (or the referenced
 * asset) cascades the order away.
 */
export const standingOrders = pgTable(
  'standing_orders',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    portfolioId: uuid('portfolio_id')
      .notNull()
      .references(() => portfolios.id, { onDelete: 'cascade' }),
    kind: standingOrderKindEnum('kind').notNull(),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    label: text('label'),
    cadence: standingOrderCadenceEnum('cadence').notNull(),
    anchorDay: integer('anchor_day'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    status: standingOrderStatusEnum('status').notNull().default('active'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastPeriodKey: date('last_period_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('standing_orders_user_idx').on(t.userId),
    index('standing_orders_portfolio_idx').on(t.portfolioId),
    // The daily scan reads active orders; keep the sweep cheap.
    index('standing_orders_status_idx').on(t.status),
    check('standing_orders_amount_positive', sql`${t.amount} > 0`),
    // A buy always names an asset; a cash kind never does.
    check(
      'standing_orders_asset_for_buy',
      sql`(${t.kind} = 'buy-asset') = (${t.assetId} is not null)`,
    ),
    // A monthly order always carries a 1–31 anchor day; a daily order never does.
    check(
      'standing_orders_anchor_for_monthly',
      sql`(${t.cadence} = 'monthly') = (${t.anchorDay} is not null)`,
    ),
    check(
      'standing_orders_anchor_range',
      sql`${t.anchorDay} is null or (${t.anchorDay} between 1 and 31)`,
    ),
    // The optional (inclusive) end date never precedes the start.
    check(
      'standing_orders_end_after_start',
      sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);

/**
 * Per-period exactly-once ledger for {@link standingOrders} (issue #593). One
 * row records that a single occurrence (`period_key` = the occurrence's ISO
 * `YYYY-MM-DD` day) has been claimed. The UNIQUE(order, period) index IS the
 * idempotency key: the job claims a period with `INSERT … ON CONFLICT DO
 * NOTHING` before booking, so a double-run — or a concurrent worker — books at
 * most once. Deleting the order cascades its run history away.
 */
export const standingOrderRuns = pgTable(
  'standing_order_runs',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    standingOrderId: uuid('standing_order_id')
      .notNull()
      .references(() => standingOrders.id, { onDelete: 'cascade' }),
    periodKey: date('period_key').notNull(),
    bookedAt: timestamp('booked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('standing_order_runs_period_unique').on(t.standingOrderId, t.periodKey)],
);

export type StandingOrderRow = typeof standingOrders.$inferSelect;
export type NewStandingOrderRow = typeof standingOrders.$inferInsert;
export type StandingOrderRunRow = typeof standingOrderRuns.$inferSelect;
export type NewStandingOrderRunRow = typeof standingOrderRuns.$inferInsert;

export type ItemCommentRow = typeof itemComments.$inferSelect;
export type NewItemCommentRow = typeof itemComments.$inferInsert;
export type ItemReactionRow = typeof itemReactions.$inferSelect;
export type NewItemReactionRow = typeof itemReactions.$inferInsert;

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
  passkeys,
  auditLog,
  problems,
  assets,
  priceHistory,
  watchlists,
  workboardItems,
  alerts,
  notifications,
  notificationSettings,
  notificationCadences,
  notificationDigestQueue,
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
  portfolioDailySnapshots,
  portfolioSnapshotState,
  userTaxSettings,
  portfolioSettings,
  friendRequests,
  friendships,
  friendGroups,
  friendGroupMembers,
  userFollows,
  itemFollows,
  shareAudiences,
  shareAudienceMembers,
  shareAudienceLinks,
  sharedItemActivityPrefs,
  itemComments,
  itemReactions,
  appSettings,
  idempotencyKeys,
  exportJobs,
  announcements,
  announcementDismissals,
  telegramLinks,
  discordWebhooks,
  announcementSeverityEnum,
  exportJobStatusEnum,

  importBatches,
  importRows,
  standingOrders,
  standingOrderRuns,
  userRoleEnum,
  userStatusEnum,
  assetTypeEnum,
  alertKindEnum,
  alertStatusEnum,
  notificationChannelEnum,
  notificationCadenceEnum,
  devicePlatformEnum,
  emailStatusEnum,
  conglomerateStatusEnum,
  transactionSideEnum,
  taxModeEnum,
  portfolioVisibilityEnum,
  cashMovementKindEnum,
  cashSourceTypeEnum,
  problemKindEnum,
  problemStatusEnum,
  friendRequestStatusEnum,
  shareKindEnum,
  shareAudienceEnum,
  reactionTargetEnum,
  importBatchStatusEnum,
  importRowKindEnum,
  importRowFlagEnum,
  importRowResultEnum,
  standingOrderKindEnum,
  standingOrderCadenceEnum,
  standingOrderStatusEnum,
};
