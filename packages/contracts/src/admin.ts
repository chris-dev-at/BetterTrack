import { z } from 'zod';

import { emailSchema, roleSchema, userStatusSchema, usernameSchema } from './auth';
import { adminListPageSchema } from './common';
import { portfolioVisibilitySchema } from './portfolio';
import { notificationChannelsConfigurableSchema, notificationMatrixSchema } from './settings';
import { vaultMediaSetSchema } from './vault';

/**
 * Global registration mode (PROJECTPLAN.md §4, §6.12, §13.4 V4-P4a). Governs how
 * accounts come to exist and is admin-switchable at runtime:
 *  - `closed` — admin-created users + per-email invite links only (the default).
 *  - `invite_token` — self-serve registration gated by an admin-issued token.
 *  - `approval` — open registration form; accounts wait in an admin approval queue.
 *  - `open` — automatic self-serve registration.
 * All four are live as of V4-P4a; switching modes takes effect without a restart.
 */
export const REGISTRATION_MODES = ['closed', 'invite_token', 'approval', 'open'] as const;
export const registrationModeSchema = z.enum(REGISTRATION_MODES);
export type RegistrationMode = z.infer<typeof registrationModeSchema>;

/**
 * `GET /auth/registration-info` — the PUBLIC (unauthenticated) discovery shape the
 * login / register surfaces and the landing page read to reflect the active mode
 * (§13.4 V4-P4a). It leaks nothing beyond the mode itself — no token, no counts,
 * no user data — so an anonymous visitor learns only whether (and how) they may
 * sign up.
 */
export const publicRegistrationInfoResponseSchema = z
  .object({
    mode: registrationModeSchema,
    /**
     * Whether Google sign-in is configured on this deployment (§13.4 V4-P4b).
     * Env-gated: `false` ⇒ the auth surfaces render no "Continue with Google"
     * button and `/auth/google/*` 404s. Leaks only the on/off bit.
     */
    googleEnabled: z.boolean(),
  })
  .strict();
export type PublicRegistrationInfoResponse = z.infer<typeof publicRegistrationInfoResponseSchema>;

/** `GET /admin/settings` — current global app settings (defaults when unset). */
export const appSettingsResponseSchema = z.object({
  registrationMode: registrationModeSchema,
  betaMode: z.boolean(),
  /** When any setting was last written; null while every key is at its default. */
  updatedAt: z.string().datetime().nullable(),
  /** The admin who last wrote a setting; null if unset or that account is gone. */
  updatedBy: z.string().uuid().nullable(),
});
export type AppSettingsResponse = z.infer<typeof appSettingsResponseSchema>;

/**
 * `PATCH /admin/settings` — partial update. At least one field required; unknown
 * fields rejected. All four registration modes are accepted as of V4-P4a (the
 * enforcement layer honours each one), so switching the mode is a live change.
 */
export const updateAppSettingsRequestSchema = z
  .object({
    registrationMode: registrationModeSchema.optional(),
    betaMode: z.boolean().optional(),
  })
  .strict()
  .refine((d) => d.registrationMode !== undefined || d.betaMode !== undefined, {
    message: 'Provide at least one setting to update.',
  });
export type UpdateAppSettingsRequest = z.infer<typeof updateAppSettingsRequestSchema>;

/**
 * Admin session policy (PROJECTPLAN.md §13.5 V5-P13c, settles #430). Admin
 * sessions carry an ABSOLUTE lifetime measured from login and expire early —
 * independent of the user-app session lifetime rules (#418): "log in with 2FA,
 * then peace" — NO step-up / re-prompt 2FA on destructive actions (#430
 * rejected), the session simply ends early instead. The lifetime is
 * admin-configurable at runtime within a fixed 6–24 h window (default 12 h).
 */
export const ADMIN_SESSION_LIFETIME_MIN_HOURS = 6;
export const ADMIN_SESSION_LIFETIME_MAX_HOURS = 24;
export const DEFAULT_ADMIN_SESSION_LIFETIME_HOURS = 12;

/** Admin session lifetime in whole hours, clamped to the plan's 6–24 h window. */
export const adminSessionLifetimeHoursSchema = z
  .number()
  .int()
  .min(ADMIN_SESSION_LIFETIME_MIN_HOURS)
  .max(ADMIN_SESSION_LIFETIME_MAX_HOURS);

/** `GET /admin/security/session-policy` — the current admin session lifetime. */
export const adminSessionPolicyResponseSchema = z.object({
  sessionLifetimeHours: adminSessionLifetimeHoursSchema,
  /** The window bounds, so the admin UI renders the range without hardcoding. */
  minHours: z.literal(ADMIN_SESSION_LIFETIME_MIN_HOURS),
  maxHours: z.literal(ADMIN_SESSION_LIFETIME_MAX_HOURS),
  /** When the lifetime was last written; null while it sits at the env default. */
  updatedAt: z.string().datetime().nullable(),
  /** The admin who last wrote it; null if unset or that account is gone. */
  updatedBy: z.string().uuid().nullable(),
});
export type AdminSessionPolicyResponse = z.infer<typeof adminSessionPolicyResponseSchema>;

/**
 * `PATCH /admin/security/session-policy` — set the admin session lifetime. Values
 * outside 6–24 h are rejected here; the change applies to session reads on the
 * next request with no redeploy.
 */
export const updateAdminSessionPolicyRequestSchema = z
  .object({ sessionLifetimeHours: adminSessionLifetimeHoursSchema })
  .strict();
export type UpdateAdminSessionPolicyRequest = z.infer<typeof updateAdminSessionPolicyRequestSchema>;

/**
 * Account defaults (§13.4 V4-P0d) — what a NEW account starts with. The admin
 * configures these once; they are applied at REGISTRATION only and never touch
 * an existing account. Every field carries its own registration-time meaning:
 *  - `chatEnabled` — a `false` default registers the account chat-disabled (its
 *    `chatBanned` flag is set); `true` (the default) leaves the account able to chat.
 *  - `defaultPortfolioVisibility` — the new account's default portfolio visibility
 *    for portfolios they create later (the auto-provisioned "Main" stays private).
 *  - `developerStatus` — a stored, INERT flag consumed only when V6-9 ships; it
 *    has zero behavioral effect today.
 *  - `notificationMatrix` — the per-type × channel matrix a new account is seeded
 *    with, pre-filled with the V4-P0c lean email default. Only cells that differ
 *    from the code lean default are written as overrides at registration.
 */
export const accountDefaultsSchema = z
  .object({
    chatEnabled: z.boolean(),
    defaultPortfolioVisibility: portfolioVisibilitySchema,
    developerStatus: z.boolean(),
    notificationMatrix: notificationMatrixSchema,
  })
  .strict();
export type AccountDefaults = z.infer<typeof accountDefaultsSchema>;

/**
 * `GET /admin/account-defaults` — the current defaults, lean values filled in,
 * plus which of the V4-P10 additive channels this deployment offers at all
 * (V5-P0 kill-switch). The admin matrix editor hides the Telegram/Discord
 * columns when both are off so the surface never looks configurable while the
 * channels are deactivated.
 */
export const accountDefaultsResponseSchema = accountDefaultsSchema.extend({
  channelsConfigurable: notificationChannelsConfigurableSchema,
});
export type AccountDefaultsResponse = z.infer<typeof accountDefaultsResponseSchema>;

/** `PATCH /admin/account-defaults` — partial update; at least one field required. */
export const updateAccountDefaultsRequestSchema = z
  .object({
    chatEnabled: z.boolean().optional(),
    defaultPortfolioVisibility: portfolioVisibilitySchema.optional(),
    developerStatus: z.boolean().optional(),
    notificationMatrix: notificationMatrixSchema.optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.chatEnabled !== undefined ||
      d.defaultPortfolioVisibility !== undefined ||
      d.developerStatus !== undefined ||
      d.notificationMatrix !== undefined,
    { message: 'Provide at least one default to update.' },
  );
export type UpdateAccountDefaultsRequest = z.infer<typeof updateAccountDefaultsRequestSchema>;

export const adminUserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    username: z.string(),
    role: roleSchema,
    status: userStatusSchema,
    mustChangePassword: z.boolean(),
    /** Admin chat ban (§13.4 V4-P0d): while true the user cannot send DMs. */
    chatBanned: z.boolean(),
    /**
     * Additive only for paranoid accounts. Normal-account admin payloads predate
     * this metadata and remain byte-for-byte unchanged.
     */
    privacyMode: z.literal('paranoid').optional(),
    paranoid: z
      .object({
        mediaSet: vaultMediaSetSchema,
        vault: z
          .object({
            version: z.number().int().positive(),
            sizeBytes: z.number().int().nonnegative(),
            updatedAt: z.string().datetime(),
          })
          .nullable(),
        historyCount: z.number().int().nonnegative(),
      })
      .optional(),
    /**
     * Review flag (#1907 ADMIN-W5). Additive and present ONLY when the account
     * is flagged, exactly as `privacyMode` above is: an unflagged account's
     * payload stays byte-for-byte what it was before this wave. The flag is a
     * marker, not a suspension — see `admin_user_flags`.
     */
    flagged: z.literal(true).optional(),
    lastLoginAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .superRefine((value, ctx) => {
    if ((value.privacyMode === 'paranoid') !== (value.paranoid !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paranoid'],
        message: 'paranoid metadata and privacyMode must be present together',
      });
    }
  });
export type AdminUser = z.infer<typeof adminUserSchema>;

// --- Users list: filter, sort, page (#1406 W2) --------------------------------
// Before W2 the list query was `{ search? }` and the response an unbounded array:
// every mount of the detail page downloaded the whole table to find one row. The
// query below adds the filters the operator list actually needs and a bounded
// page; `GET /admin/users/:id` (below) retires the download-everything read.

/** Columns the operator list may be ordered by. */
export const ADMIN_USER_SORTS = ['createdAt', 'lastLoginAt', 'username', 'email'] as const;
export const adminUserSortSchema = z.enum(ADMIN_USER_SORTS);
export type AdminUserSort = z.infer<typeof adminUserSortSchema>;

export const ADMIN_USER_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const adminUserSortDirectionSchema = z.enum(ADMIN_USER_SORT_DIRECTIONS);
export type AdminUserSortDirection = z.infer<typeof adminUserSortDirectionSchema>;

/**
 * Privacy-mode filter. `paranoid` selects encrypted accounts; the mode is the
 * ONLY thing about a paranoid account this filter can reach — the vault itself
 * stays unreadable to everyone including the operator (§16 2026-07-21: "admin
 * sees mode/media/blob metadata only").
 */
export const ADMIN_USER_PRIVACY_FILTERS = ['normal', 'paranoid'] as const;
export const adminUserPrivacyFilterSchema = z.enum(ADMIN_USER_PRIVACY_FILTERS);
export type AdminUserPrivacyFilter = z.infer<typeof adminUserPrivacyFilterSchema>;

export const ADMIN_USER_PAGE_SIZE_DEFAULT = 25;
export const ADMIN_USER_PAGE_SIZE_MAX = 200;
/**
 * Deep-paging bound. Paging past this is a symptom of a missing filter, not a
 * real operator need, and an unbounded offset is a cheap way to make the
 * database sort the whole table on every request.
 */
export const ADMIN_USER_PAGE_OFFSET_MAX = 100_000;

/**
 * Offset paging rather than the cursor shape the audit log uses. A cursor is
 * only stable while the ordering is: this list is sortable on four columns in
 * both directions, so a cursor would have to encode the sort key and be
 * re-issued whenever the operator clicks a column head. The mockup's own footer
 * ("Page 1 of 3 · 47 accounts") is page-shaped for the same reason, and a total
 * is worth more to an operator than an opaque token.
 */
export const adminUserListQuerySchema = z
  .object({
    search: z.string().max(120).optional(),
    role: roleSchema.optional(),
    status: userStatusSchema.optional(),
    privacyMode: adminUserPrivacyFilterSchema.optional(),
    /**
     * Review flag (#1907 ADMIN-W5). Tri-state on purpose, exactly as the
     * helpdesk queue's `unread` is: absent means "don't filter on the flag",
     * which is a different request from `flagged=false` ("only accounts that
     * are NOT flagged"). `.optional()` sits OUTSIDE the transform so an omitted
     * key stays `undefined` instead of collapsing to `false` and silently
     * hiding every flagged account from the default list.
     */
    flagged: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    sort: adminUserSortSchema.default('createdAt'),
    direction: adminUserSortDirectionSchema.default('desc'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ADMIN_USER_PAGE_SIZE_MAX)
      .default(ADMIN_USER_PAGE_SIZE_DEFAULT),
    offset: z.coerce.number().int().min(0).max(ADMIN_USER_PAGE_OFFSET_MAX).default(0),
  })
  .strict();
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

/** Where this page sits in the filtered result set. */
export const adminUserListPageSchema = z
  .object({
    /** Rows matching the filter, ignoring the page window. */
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .strict();
export type AdminUserListPage = z.infer<typeof adminUserListPageSchema>;

export const adminUserListResponseSchema = z.object({
  users: z.array(adminUserSchema),
  page: adminUserListPageSchema,
});
export type AdminUserListResponse = z.infer<typeof adminUserListResponseSchema>;

export const createUserRequestSchema = z
  .object({
    email: emailSchema,
    username: usernameSchema,
    role: roleSchema.default('user'),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/** Temp password is shown to the admin exactly once (PROJECTPLAN.md §6.1, §6.12). */
export const createUserResponseSchema = z.object({
  user: adminUserSchema,
  tempPassword: z.string(),
});
export type CreateUserResponse = z.infer<typeof createUserResponseSchema>;

// ── Moderation depth (#1907 ADMIN-W5) ────────────────────────────────────────
// Every moderation action carries a REASON, is attributed to a named operator,
// and lands in a record the next operator can read. Before this wave disabling
// an account, banning it from chat or changing its role recorded what happened
// and never why.

/**
 * Same bound the operator-note body has, and for the same reason: the column's
 * CHECK repeats it, so no caller can write unbounded prose past the route.
 */
export const ADMIN_MODERATION_REASON_MAX_LENGTH = 2000;
export const ADMIN_MODERATION_PAGE_SIZE_DEFAULT = 25;

/**
 * Why an operator did it. Trimmed and non-empty: a reason made of spaces is the
 * same unattributed suspension this wave exists to end, and the
 * `admin_moderation_actions.reason` CHECK refuses it at the column too.
 */
export const adminModerationReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(ADMIN_MODERATION_REASON_MAX_LENGTH);

/**
 * Short state labels (`active`, `disabled`, `admin`) — never free text, and
 * never anything that came out of a portfolio (§6.12). Bounded so the column
 * cannot become a second, unbounded prose field beside `reason`.
 */
export const ADMIN_MODERATION_VALUE_MAX_LENGTH = 64;

/**
 * What the record can hold.
 *
 * `delete_reservation` is the row an admin DELETE writes when it disables the
 * account to reserve the removal: that suspension is durable and survives a
 * failed delete, so it has to be explainable like any other (#1907).
 *
 * `password_reset` is reserved by the table's CHECK and this enum but is not
 * written by any route today: `POST /admin/users/:id/reset-password` takes no
 * body, and giving it a mandatory one is a breaking change to a shipped route
 * that #1907 §1 did not ask for.
 */
export const ADMIN_MODERATION_ACTIONS = [
  'disable',
  'enable',
  'chat_ban',
  'chat_unban',
  'role_change',
  'flag',
  'unflag',
  'delete_reservation',
  'password_reset',
] as const;
export const adminModerationActionSchema = z.enum(ADMIN_MODERATION_ACTIONS);
export type AdminModerationAction = z.infer<typeof adminModerationActionSchema>;

/**
 * One row of the moderation record. The actor is resolved to a USERNAME — never
 * an e-mail, a session id or any other handle — and goes null-with-tombstone
 * when that operator's account is gone, exactly as an operator note does.
 * `previousValue` / `nextValue` are short state labels (`active`, `admin`);
 * nothing portfolio-derived may ever be written into them (§6.12).
 */
export const adminModerationEntrySchema = z
  .object({
    id: z.string().uuid(),
    action: adminModerationActionSchema,
    reason: z.string(),
    previousValue: z.string().max(ADMIN_MODERATION_VALUE_MAX_LENGTH).nullable(),
    nextValue: z.string().max(ADMIN_MODERATION_VALUE_MAX_LENGTH).nullable(),
    actorId: z.string().uuid().nullable(),
    actorUsername: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminModerationEntry = z.infer<typeof adminModerationEntrySchema>;

export const adminModerationListResponseSchema = z
  .object({
    actions: z.array(adminModerationEntrySchema),
    page: adminListPageSchema,
  })
  .strict();
export type AdminModerationListResponse = z.infer<typeof adminModerationListResponseSchema>;

/**
 * `POST /admin/users/:id/flag` — mark an account for a second look WITHOUT
 * suspending it. The reason is mandatory here with no exceptions: a flag whose
 * reason is optional is the unattributed suspicion this wave replaces.
 */
export const adminUserFlagRequestSchema = z
  .object({ reason: adminModerationReasonSchema })
  .strict();
export type AdminUserFlagRequest = z.infer<typeof adminUserFlagRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    status: userStatusSchema.optional(),
    role: roleSchema.optional(),
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    /** Admin chat ban toggle (§13.4 V4-P0d): true bans, false unbans (instant). */
    chatBanned: z.boolean().optional(),
    /**
     * Why. Required when the request MODERATES, optional otherwise — a rename
     * or an e-mail correction is administration, not moderation, and demanding
     * prose for one would train operators to type filler into the field the
     * suspensions depend on. The requirement is expressed HERE rather than in
     * the route handler so the OpenAPI document, the SPA and the server refuse
     * identically.
     */
    reason: adminModerationReasonSchema.optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.status !== undefined ||
      d.role !== undefined ||
      d.username !== undefined ||
      d.email !== undefined ||
      d.chatBanned !== undefined,
    { message: 'Provide at least one field to update.' },
  )
  .superRefine((d, ctx) => {
    // Suspending, chat-banning and role changes are the three moderating
    // writes. Reversals (`status: 'active'`, `chatBanned: false`) deliberately
    // stay optional — the console always sends one, and the server records the
    // reversal in the moderation record whenever it does.
    const moderates = d.status === 'disabled' || d.chatBanned === true || d.role !== undefined;
    if (moderates && d.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        // Generic, state-free (§10): it says what the REQUEST is missing and
        // discloses nothing about the account it names.
        message: 'A reason is required for this change.',
      });
    }
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

/**
 * Bulk user actions from the admin user list (PROJECTPLAN.md §6.12, §13.2).
 * V1 ships bulk-disable; the enum leaves room for more without a shape change.
 */
export const BULK_USER_ACTIONS = ['disable'] as const;
export const bulkUserActionSchema = z.enum(BULK_USER_ACTIONS);
export type BulkUserAction = z.infer<typeof bulkUserActionSchema>;

export const bulkUserActionRequestSchema = z
  .object({
    action: bulkUserActionSchema,
    userIds: z.array(z.string().uuid()).min(1).max(200),
    /**
     * Mandatory with no exception: every action a batch can take today is a
     * suspension, and 200 unattributed suspensions is the gap this wave closes
     * multiplied by 200. The one reason is copied onto every affected row's
     * moderation record, so each account carries its own answer to "why".
     */
    reason: adminModerationReasonSchema,
  })
  .strict();
export type BulkUserActionRequest = z.infer<typeof bulkUserActionRequestSchema>;

/**
 * What a bulk action did to ONE row. A batch never collapses into a bare 500:
 * a suspension commits durably before its credential/session cleanup runs, so a
 * row whose cleanup threw is reported as `cleanup_failed` (and audited as
 * needing repair) while the rest of the batch still completes.
 */
export const BULK_USER_OUTCOMES = ['disabled', 'repaired', 'skipped', 'cleanup_failed'] as const;
export const bulkUserActionOutcomeSchema = z.object({
  userId: z.string().uuid(),
  outcome: z.enum(BULK_USER_OUTCOMES),
});
export type BulkUserActionOutcome = z.infer<typeof bulkUserActionOutcomeSchema>;

/**
 * Result of a bulk action: how many were actually changed vs. skipped (self,
 * last active admin, or unknown id). `repaired`, `failed` and `results` are
 * additive detail beside those two counts — the operator list renders the
 * tallies, so a client that only reads `disabled`/`skipped` stays valid.
 */
export const bulkUserActionResponseSchema = z.object({
  action: bulkUserActionSchema,
  disabled: z.number().int(),
  skipped: z.number().int(),
  /** Already-disabled rows whose credential/session cleanup was re-run. */
  repaired: z.number().int().optional(),
  /** Rows durably suspended whose cleanup did not complete (audited as such). */
  failed: z.number().int().optional(),
  results: z.array(bulkUserActionOutcomeSchema).optional(),
});
export type BulkUserActionResponse = z.infer<typeof bulkUserActionResponseSchema>;

export const resetPasswordResponseSchema = z.object({
  user: adminUserSchema,
  tempPassword: z.string(),
});
export type ResetPasswordResponse = z.infer<typeof resetPasswordResponseSchema>;

/** Type-username-to-confirm guard for destructive delete (PROJECTPLAN.md §6.12). */
export const deleteUserRequestSchema = z
  .object({ confirmUsername: z.string().min(1).max(40) })
  .strict();
export type DeleteUserRequest = z.infer<typeof deleteUserRequestSchema>;

// ── User 360 (#1406 W2) ──────────────────────────────────────────────────────
// Four read-only projections behind the detail page's tabs. Every one of them is
// deliberately a PROJECTION and not a handle: none carries a raw token, a
// provider subject, a portfolio name, a holding, or anything that came out of a
// vault. What an operator may see here is bounded by §3 ("Admin cannot browse
// users' portfolios — privacy stance, deliberate") and by the #1406 kill list
// (no impersonation, no vault or Drive inspection, no data-export download).

/**
 * One live session of this account (`GET /admin/users/:id/access`). `id` is the
 * public revocation handle — SHA-256 of the session id — never the session
 * token itself, so this response cannot be replayed into a session.
 */
export const adminUserSessionSchema = z
  .object({
    id: z.string(),
    /** Device label derived from the stored User-Agent, never the raw string. */
    device: z.string(),
    createdAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    /** True = "stay signed in"; false = an ephemeral, hard-capped session. */
    persistent: z.boolean(),
  })
  .strict();
export type AdminUserSession = z.infer<typeof adminUserSessionSchema>;

/** One of this account's API keys. The key material itself is hash-only at rest. */
export const adminUserApiKeySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    scopes: z.array(z.string()),
    lastUsedAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminUserApiKey = z.infer<typeof adminUserApiKeySchema>;

/** One OAuth grant this account has issued to an app (§6.13). */
export const adminUserOAuthGrantSchema = z
  .object({
    id: z.string().uuid(),
    clientName: z.string(),
    /** True for the official BetterTrack apps (system-owned trusted clients). */
    firstParty: z.boolean(),
    scopes: z.array(z.string()),
    lastUsedAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminUserOAuthGrant = z.infer<typeof adminUserOAuthGrantSchema>;

/**
 * A linked external identity (today only Google). The provider `subject` is
 * deliberately absent: it is a stable cross-service identifier for a real
 * person and an operator has no support question that it answers. The linked
 * address is also absent — the account's own email is already on the page, and
 * a *different* provider address would be new PII this surface never needed.
 */
export const adminUserIdentitySchema = z
  .object({
    provider: z.string(),
    emailVerified: z.boolean(),
    linkedAt: z.string().datetime(),
  })
  .strict();
export type AdminUserIdentity = z.infer<typeof adminUserIdentitySchema>;

/** `GET /admin/users/:id/access` — the Access tab, in one read. */
export const adminUserAccessResponseSchema = z
  .object({
    sessions: z.array(adminUserSessionSchema),
    apiKeys: z.array(adminUserApiKeySchema),
    oauthGrants: z.array(adminUserOAuthGrantSchema),
    identities: z.array(adminUserIdentitySchema),
  })
  .strict();
export type AdminUserAccessResponse = z.infer<typeof adminUserAccessResponseSchema>;

/**
 * `GET /admin/users/:id/sharing` — the Sharing tab. COUNTS ONLY, on purpose.
 * The #1406 decision defers the sharing inventory ("cheap public-link view
 * later") and forbids browsing a user's portfolios or watchlists outright, so
 * this answers "how exposed is this account?" without naming a single thing
 * they own. No portfolio names, no share tokens, no friend identities.
 */
export const adminUserSharingResponseSchema = z
  .object({
    portfolioCount: z.number().int().nonnegative(),
    /**
     * Of those, the ones visible to this account's friends. There is no
     * "public" portfolio in the product — `portfolioVisibilitySchema` is
     * `private | friends` — so `friends` is the widest a portfolio ever gets,
     * and the anyone-with-the-link surface is the share LINKS below.
     */
    sharedPortfolioCount: z.number().int().nonnegative(),
    /** Non-private share-audience rows across every shareable kind (§6.9). */
    shareAudienceCount: z.number().int().nonnegative(),
    /** Tokenized conglomerate links: live vs. already revoked. */
    activeShareLinkCount: z.number().int().nonnegative(),
    revokedShareLinkCount: z.number().int().nonnegative(),
    friendCount: z.number().int().nonnegative(),
    followerCount: z.number().int().nonnegative(),
    followingCount: z.number().int().nonnegative(),
  })
  .strict();
export type AdminUserSharingResponse = z.infer<typeof adminUserSharingResponseSchema>;

/**
 * One of this account's support submissions, summarized for the User 360
 * Support tab. The message BODY is not here: the thread is W3's surface and
 * lives on the helpdesk, and a detail page has no reason to render support
 * prose it cannot reply to.
 */
export const adminUserSupportItemSchema = z
  .object({
    id: z.string().uuid(),
    category: z.string(),
    subject: z.string().nullable(),
    status: z.string(),
    /** True once the submitter has tombstoned it (#1400); the row survives. */
    deletedByUser: z.boolean(),
    archived: z.boolean(),
    /** True when the last message in the thread is still unread by an admin. */
    unreadByAdmin: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminUserSupportItem = z.infer<typeof adminUserSupportItemSchema>;

export const ADMIN_USER_SUPPORT_LIMIT_MAX = 50;
export const ADMIN_USER_SUPPORT_LIMIT_DEFAULT = 20;

export const adminUserSupportQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ADMIN_USER_SUPPORT_LIMIT_MAX)
      .default(ADMIN_USER_SUPPORT_LIMIT_DEFAULT),
  })
  .strict();
export type AdminUserSupportQuery = z.infer<typeof adminUserSupportQuerySchema>;

export const adminUserSupportResponseSchema = z
  .object({
    items: z.array(adminUserSupportItemSchema),
    /** Every submission this account has ever filed, not just the page above. */
    total: z.number().int().nonnegative(),
    openCount: z.number().int().nonnegative(),
  })
  .strict();
export type AdminUserSupportResponse = z.infer<typeof adminUserSupportResponseSchema>;

// ── Operator notes (#1406 W2) ────────────────────────────────────────────────
// Admin-private annotations on an account: "prefers German copy", "reported the
// same rounding bug twice". They are never shown to the user, carry no
// behaviour, and every write is audited with the operator as actor. This is the
// one capability W2 adds that is not a read — and it is additive by
// construction: deleting every note would leave the account byte-identical.

export const ADMIN_USER_NOTE_MAX_LENGTH = 2000;
export const ADMIN_USER_NOTE_PAGE_LIMIT = 100;

export const adminUserNoteSchema = z
  .object({
    id: z.string().uuid(),
    body: z.string(),
    /** The operator who wrote it; null once that admin account is deleted. */
    authorId: z.string().uuid().nullable(),
    authorUsername: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminUserNote = z.infer<typeof adminUserNoteSchema>;

export const adminUserNoteListResponseSchema = z
  .object({ notes: z.array(adminUserNoteSchema) })
  .strict();
export type AdminUserNoteListResponse = z.infer<typeof adminUserNoteListResponseSchema>;

export const createAdminUserNoteRequestSchema = z
  .object({ body: z.string().trim().min(1).max(ADMIN_USER_NOTE_MAX_LENGTH) })
  .strict();
export type CreateAdminUserNoteRequest = z.infer<typeof createAdminUserNoteRequestSchema>;

/**
 * `DELETE /admin/users/:id/notes/:noteId` — both ids, because the delete is
 * scoped by both. A note id alone would let a stale account id remove a note
 * from a different account.
 */
export const adminUserNoteParamSchema = z
  .object({ id: z.string().uuid(), noteId: z.string().uuid() })
  .strict();
export type AdminUserNoteParam = z.infer<typeof adminUserNoteParamSchema>;

export const INVITE_STATUSES = ['pending', 'used', 'revoked', 'expired'] as const;
export const inviteStatusSchema = z.enum(INVITE_STATUSES);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

export const adminInviteSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  status: inviteStatusSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  usedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type AdminInvite = z.infer<typeof adminInviteSchema>;

export const createInviteRequestSchema = z.object({ email: emailSchema }).strict();
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

/** Invite URL is shown to the admin once (to copy or, later, email). */
export const createInviteResponseSchema = z.object({
  invite: adminInviteSchema,
  inviteUrl: z.string().url(),
});
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

/**
 * `GET /admin/invites`. Bounded since V5-P2 (#1814): nothing prunes invites, so
 * an instance that has been running for a year answered with every row it had
 * ever written. `page` carries the window the same way the users list does.
 */
export const adminInviteListResponseSchema = z.object({
  invites: z.array(adminInviteSchema),
  page: adminListPageSchema,
});
export type AdminInviteListResponse = z.infer<typeof adminInviteListResponseSchema>;

// --- Registration access tokens (§6.12, §13.4 V4-P4a) ------------------------
// The `invite_token` registration mode is gated by admin-issued access tokens.
// Distinct from the V1 per-email invites above: a token is not bound to an email,
// may be single- OR multi-use (a use counter + limit), and carries its own
// optional expiry. Only the SHA-256 hash is stored; the raw token rides the
// register URL shown to the admin once.

/** How many accounts a single token may create at most. */
export const MAX_REGISTRATION_TOKEN_USES = 1000;
/** Optional expiry window bound, in days. */
export const MAX_REGISTRATION_TOKEN_TTL_DAYS = 365;

/** Derived lifecycle of a registration token — computed server-side, never stored. */
export const REGISTRATION_TOKEN_STATUSES = ['active', 'exhausted', 'expired', 'revoked'] as const;
export const registrationTokenStatusSchema = z.enum(REGISTRATION_TOKEN_STATUSES);
export type RegistrationTokenStatus = z.infer<typeof registrationTokenStatusSchema>;

export const registrationTokenSchema = z.object({
  id: z.string().uuid(),
  /** Optional admin-facing label ("beta wave 1"); never shown to registrants. */
  label: z.string().nullable(),
  status: registrationTokenStatusSchema,
  maxUses: z.number().int().positive(),
  useCount: z.number().int().nonnegative(),
  /** Null = never expires. */
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type RegistrationToken = z.infer<typeof registrationTokenSchema>;

export const createRegistrationTokenRequestSchema = z
  .object({
    label: z.string().trim().max(80).optional(),
    /** 1 = single-use; >1 = multi-use with this cap. Defaults to single-use. */
    maxUses: z.number().int().min(1).max(MAX_REGISTRATION_TOKEN_USES).default(1),
    /** Days until expiry; omit for a token that never expires. */
    expiresInDays: z.number().int().min(1).max(MAX_REGISTRATION_TOKEN_TTL_DAYS).optional(),
  })
  .strict();
export type CreateRegistrationTokenRequest = z.infer<typeof createRegistrationTokenRequestSchema>;

/** The register URL (carrying the raw token) is shown to the admin exactly once. */
export const createRegistrationTokenResponseSchema = z.object({
  token: registrationTokenSchema,
  registerUrl: z.string().url(),
});
export type CreateRegistrationTokenResponse = z.infer<typeof createRegistrationTokenResponseSchema>;

/** `GET /admin/registration-tokens`. Bounded since V5-P2 (#1814). */
export const registrationTokenListResponseSchema = z.object({
  tokens: z.array(registrationTokenSchema),
  page: adminListPageSchema,
});
export type RegistrationTokenListResponse = z.infer<typeof registrationTokenListResponseSchema>;

// --- Approval queue (§6.12, §13.4 V4-P4a) ------------------------------------
// In `approval` mode a registrant's details land here as a pending application —
// NOT a usable account — until an admin approves (creates the account + sends a
// decision email) or rejects (drops the application + sends a decision email).

export const registrationRequestSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  username: z.string(),
  /**
   * How they applied (#1406 W2): the federated provider id (`google`) or null
   * for a password application. Already stored on the row and consumed at
   * approval time to link the identity — it was simply never exposed, so an
   * operator could not tell a Google applicant from a password one. Additive:
   * the provider SUBJECT stays server-side.
   */
  provider: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;

/** `GET /admin/registration-requests`. Bounded since V5-P2 (#1814). */
export const registrationRequestListResponseSchema = z.object({
  requests: z.array(registrationRequestSchema),
  page: adminListPageSchema,
});
export type RegistrationRequestListResponse = z.infer<typeof registrationRequestListResponseSchema>;

/**
 * How an audit row's actor is answerable (#1908, ADMIN-W6).
 *
 * Before this wave every un-attributed row rendered as one word, "system": an
 * anonymous failed login, a server-initiated write and the shell BREAK-GLASS 2FA
 * reset — the single highest-privilege event in the product — were
 * indistinguishable in the console.
 *
 *  - `account`  — `actor_id` resolved to a live account; `actor` carries it.
 *  - `shell`    — `meta.via === 'break_glass_script'`: written by the shell-only
 *                 break-glass script (`scripts/adminTwoFactorBreakGlass.ts`),
 *                 which deliberately has no session and no actor. A FACT stamped
 *                 by the writer, not a guess.
 *  - `unattributed` — `actor_id` is NULL and nothing says why. This is the
 *    HONEST union of the issue's "system" and "deleted actor": `ON DELETE SET
 *    NULL` destroys the only evidence that could tell them apart, so claiming
 *    "the acting account was deleted" from a NULL column would be a heuristic
 *    presented as a record. The copy says "no longer resolvable" instead.
 */
export const AUDIT_ACTOR_KINDS = ['account', 'shell', 'unattributed'] as const;
export const auditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS);
export type AuditActorKind = z.infer<typeof auditActorKindSchema>;

/**
 * The resolved actor, joined on the audit page's own rows. Username and account
 * kind ONLY — never the e-mail: an operator reading the log needs to know WHO
 * acted, not how to reach them (§6.12, §10).
 */
export const auditActorSchema = z
  .object({
    id: z.string().uuid(),
    username: usernameSchema,
    kind: roleSchema,
  })
  .strict();
export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  /** Resolved from `actorId` in the same statement as the page (#1908). */
  actor: auditActorSchema.nullable(),
  actorKind: auditActorKindSchema,
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  /**
   * Free-form context. Secret-shaped keys are replaced with a fixed marker on
   * the WRITE path (`auditService`), so what is stored is already redacted and
   * no reader can reconstruct a value this field never held.
   */
  meta: z.unknown().nullable(),
  createdAt: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

/**
 * Named filter sets, so the queries worth running are one click instead of
 * folklore an operator has to remember (#1908 §3).
 *
 *  - `break_glass`   — the shell 2FA reset, the product's highest-privilege event.
 *  - `auth_failures` — every failed authentication signal in one view.
 *  - `admin_actions` — what the console itself did, as opposed to what accounts did.
 *
 * The action vocabulary each expands to lives in `auditService` beside
 * `AuditAction`, so a preset can never name a string the product does not write.
 */
export const AUDIT_PRESETS = ['break_glass', 'auth_failures', 'admin_actions'] as const;
export const auditPresetSchema = z.enum(AUDIT_PRESETS);
export type AuditPreset = z.infer<typeof auditPresetSchema>;

/**
 * The audit vocabulary's own shape: `<domain>.<snake_case_event>`, plus the
 * TRAILING-DOT form (`user.`) that means "every event in this domain".
 *
 * Deliberately a charset, not a free string. `action` is the one filter that
 * reaches a pattern match, and a value that cannot contain `%`, `_` or a
 * backslash cannot become a wildcard no matter what the repository does with it
 * — the escaping there is then belt to this braces, not the only guard (§10).
 */
const AUDIT_ACTION_FILTER = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.?$/;

/**
 * `GET /admin/audit` and `GET /admin/users/{id}/audit`.
 *
 * Still `.strict()`: an unknown key is still a 400. Every added key is OPTIONAL,
 * so every caller that shipped before this wave keeps working unchanged.
 *
 * Paging is unchanged on purpose — keyset on `desc(id)`, and NO filter-scoped
 * total. A `COUNT(*)` over a filtered 400-day audit table (`BT_AUDIT_RETENTION_
 * DAYS` defaults to 400) is the one query on this page that can hurt production,
 * and W2's reason for a total — a multi-column sort whose cursor would have to
 * encode the sort key — does not apply here: the ordering is fixed and the ids
 * are UUIDv7, i.e. time-sortable. Please do not "fix" this into offset paging.
 */
export const auditQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Exact action, or a trailing-dot domain prefix (`user.` ⇒ every `user.*`). */
    action: z.string().trim().min(1).max(64).regex(AUDIT_ACTION_FILTER).optional(),
    actorId: z.string().uuid().optional(),
    targetId: z.string().uuid().optional(),
    targetType: z.string().trim().min(1).max(32).optional(),
    /** Half-open window `[from, to)` on `created_at`. */
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    preset: auditPresetSchema.optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.from === undefined || query.to === undefined) return;
    if (Date.parse(query.from) < Date.parse(query.to)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'The end of the range must be after its start.',
    });
  });
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditLogListResponseSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  nextCursor: z.string().uuid().nullable(),
});
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;

/**
 * `GET /admin/security/signals` — aggregate authentication signals (#1908 §5).
 *
 * DERIVED, never captured. Every number here is a `GROUP BY` over `audit_log`
 * rows the product already writes; this wave adds no column, no table and no new
 * capture. In particular there is deliberately NO `user_agent` on `audit_log`:
 * sessions keep their raw UA in Redis and the admin projection already reduces
 * it to a coarse device label, and that boundary stays where it is.
 *
 * It is also a READ and only a read. No lockout, no forced logout, no session
 * revoke — those are §6.12 kill-list capabilities and none of them is built.
 *
 * The payload is COUNTS ONLY: no user id, no IP, no device, no geo, no
 * per-account profile. `.strict()` is half of what holds that line; the other
 * half is an explicit no-identifiers assertion over the serialized body in
 * `adminAudit.test.ts`.
 */
export const AUDIT_SIGNAL_WINDOWS = ['24h', '7d'] as const;
export const auditSignalWindowSchema = z.enum(AUDIT_SIGNAL_WINDOWS);
export type AuditSignalWindow = z.infer<typeof auditSignalWindowSchema>;

export const adminSecuritySignalsQuerySchema = z
  .object({
    window: auditSignalWindowSchema.default('24h'),
  })
  .strict();
export type AdminSecuritySignalsQuery = z.infer<typeof adminSecuritySignalsQuerySchema>;

/**
 * The four reasons `authService` records on `login.fail`, plus `other` for a
 * row whose reason this build does not know. An unrecognised value is BUCKETED
 * rather than echoed: `meta.reason` is server-written today, and a projection
 * that passes arbitrary meta text through to the console would be a seam for
 * whatever a future writer puts there.
 */
export const LOGIN_FAILURE_REASONS = [
  'unknown_user',
  'locked',
  'bad_password',
  'disabled',
  'other',
] as const;
export const loginFailureReasonSchema = z.enum(LOGIN_FAILURE_REASONS);
export type LoginFailureReason = z.infer<typeof loginFailureReasonSchema>;

export const adminSecuritySignalsResponseSchema = z
  .object({
    window: auditSignalWindowSchema,
    /** The half-open window `[from, to)` the counts were taken over. */
    from: z.string().datetime(),
    to: z.string().datetime(),
    loginFailures: z
      .object({
        total: z.number().int().nonnegative(),
        byReason: z.array(
          z
            .object({
              reason: loginFailureReasonSchema,
              count: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
    twoFactorVerifyFail: z.number().int().nonnegative(),
    passkeyLoginFail: z.number().int().nonnegative(),
    pinVerifyFail: z.number().int().nonnegative(),
    reauthFail: z.number().int().nonnegative(),
    apiKeyScopeDenied: z.number().int().nonnegative(),
    adminLogins: z.number().int().nonnegative(),
    /** How many DISTINCT admin accounts signed in — a count, never a roster. */
    adminActors: z.number().int().nonnegative(),
    breakGlass: z.number().int().nonnegative(),
    /**
     * Break-glass events across the whole retention window, not just this one —
     * what the standing banner reports, so the product's highest-privilege event
     * is visible without anyone thinking to look for it. Counted through a
     * bounded subquery; `retentionTotalCapped` says the true figure is larger.
     */
    breakGlassRetentionTotal: z.number().int().nonnegative(),
    breakGlassRetentionCapped: z.boolean(),
  })
  .strict();
export type AdminSecuritySignalsResponse = z.infer<typeof adminSecuritySignalsResponseSchema>;

/** One email send-log row (PROJECTPLAN.md §6.10) — no body, no secrets. */
export const emailLogEntrySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  recipient: z.string(),
  template: z.string(),
  subject: z.string(),
  status: z.enum(['sent', 'failed', 'suppressed']),
  errorCode: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type EmailLogEntry = z.infer<typeof emailLogEntrySchema>;

export const emailLogQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type EmailLogQuery = z.infer<typeof emailLogQuerySchema>;

export const emailLogListResponseSchema = z.object({
  entries: z.array(emailLogEntrySchema),
  nextCursor: z.string().uuid().nullable(),
});
export type EmailLogListResponse = z.infer<typeof emailLogListResponseSchema>;

export const adminStatsSchema = z.object({
  userCount: z.number().int(),
  activeUserCount: z.number().int(),
  disabledUserCount: z.number().int(),
  pendingInviteCount: z.number().int(),
  /**
   * Pending approval-queue applications (#1406 W1). A COUNT, deliberately: the
   * operator Overview only needs the number for its attention row, and reading
   * `.length` off the unbounded list read would have grown with the queue.
   */
  pendingRegistrationCount: z.number().int(),
});
export type AdminStats = z.infer<typeof adminStatsSchema>;

// --- Email channel (test/diagnostic) — PROJECTPLAN.md §6.11, §6.12 -----------

/** Whether outbound email is configured + wired (SMTP_HOST + SMTP_FROM set). */
export const emailStatusResponseSchema = z.object({ enabled: z.boolean() });
export type EmailStatusResponse = z.infer<typeof emailStatusResponseSchema>;

/** Admin-only diagnostic: send a throwaway email to confirm SMTP works. */
export const testEmailRequestSchema = z.object({ to: emailSchema.optional() }).strict();
export type TestEmailRequest = z.infer<typeof testEmailRequestSchema>;

export const EMAIL_SEND_STATUSES = ['sent', 'skipped', 'failed'] as const;
export const emailSendStatusSchema = z.enum(EMAIL_SEND_STATUSES);
export type EmailSendStatus = z.infer<typeof emailSendStatusSchema>;

/**
 * Mirrors the service's EmailSendResult plus the resolved recipient.
 * `code` is a coarse, secret-free error tag — never the raw SMTP response.
 */
export const testEmailResponseSchema = z.object({
  status: emailSendStatusSchema,
  to: z.string(),
  code: z.string().optional(),
});
export type TestEmailResponse = z.infer<typeof testEmailResponseSchema>;

/**
 * Mandatory admin-login two-factor auth (PROJECTPLAN.md §6.12, #400).
 *
 * Every `role='admin'` account must pass 2FA to use the admin surface — there is
 * no opt-in and no "root admin" exemption. The login challenge REUSES the shared
 * `two_factor_required` flow (`/auth/login` → `/auth/2fa/verify`), so the schemas
 * for enrolling TOTP, confirming a method, disabling it and (re)issuing recovery
 * codes are the SAME ones the user surface uses (`twoFactorEnrollResponseSchema`,
 * `twoFactorConfirmRequestSchema`, `twoFactorEmailConfirmRequestSchema`,
 * `twoFactorDisableRequestSchema`, `twoFactorMethodEnabledResponseSchema`,
 * `twoFactorRecoveryCodesResponseSchema` — all in `./auth`). Only two things are
 * admin-specific and defined here: the status shape (it carries the setup-gate
 * flag + the separate 2FA email) and the email-method start request (it names the
 * target 2FA email, with an optional fresh-proof for a change once enrolled).
 */

/**
 * Error code returned (403) by every admin endpoint EXCEPT the 2FA enroll/confirm
 * set while a logged-in admin has no confirmed 2FA method. The admin SPA detects
 * it and forces the enrollment wizard (bootstrap for "mandatory", #400).
 */
export const ADMIN_2FA_SETUP_REQUIRED = 'ADMIN_2FA_SETUP_REQUIRED';

/** `GET /admin/security/2fa/status` — the admin's own 2FA methods + setup gate state. */
export const adminTwoFactorStatusResponseSchema = z
  .object({
    /**
     * True when the admin has NO confirmed 2FA method yet — the mandatory-2FA
     * bootstrap state in which every other admin endpoint answers 403
     * `ADMIN_2FA_SETUP_REQUIRED` and the SPA forces the enrollment wizard.
     */
    setupRequired: z.boolean(),
    /** Authenticator-app (TOTP) method: on once a code has confirmed enrollment. */
    totpEnabled: z.boolean(),
    /** True when a TOTP secret is enrolled but not yet confirmed (awaiting a code). */
    totpPending: z.boolean(),
    /** Email-OTP method: on once a code mailed to the 2FA email confirmed it. */
    emailEnabled: z.boolean(),
    /** The separately-set 2FA email the login code is delivered to; NULL if unset. */
    twoFactorEmail: z.string().nullable(),
    /** Count of recovery codes still unused (shared across both methods). */
    recoveryCodesRemaining: z.number().int().nonnegative(),
  })
  .strict();
export type AdminTwoFactorStatusResponse = z.infer<typeof adminTwoFactorStatusResponseSchema>;

/**
 * `POST /admin/security/2fa/email/start` — set (first time) or change the admin's
 * 2FA email and send a confirmation code to it. `proof` (a current TOTP code or an
 * unused recovery code) is REQUIRED once the admin is already enrolled — changing
 * the address must clear a fresh 2FA proof (decision 3, #400) — and ignored on the
 * first-time set during forced enrollment (no method on yet).
 */
export const adminTwoFactorEmailStartRequestSchema = z
  .object({
    email: emailSchema,
    proof: z.string().trim().min(6).max(64).optional(),
  })
  .strict();
export type AdminTwoFactorEmailStartRequest = z.infer<typeof adminTwoFactorEmailStartRequestSchema>;

// ── Admin health page (§13.4 V4-P5a) ────────────────────────────────────────
// The richer, admin-only companion to the public `/health` liveness probe: a
// per-component status snapshot the admin Health page renders. The public probe
// (`apps/api/src/http/healthRouter.ts`) stays the deploy/liveness marker; this is
// the operator diagnostics surface (DB/Redis/provider/queue/gateway + version +
// uptime). Every component reports one of three states so a partial outage (a
// stopped Redis, an open provider breaker) is visible without failing the whole
// page.

/** Per-component and overall health verdict. `down` is a hard outage; `degraded`
 *  is a soft/partial fault (an open breaker, a stale heartbeat) that still serves. */
export const HEALTH_STATUSES = ['ok', 'degraded', 'down'] as const;
export const healthStatusSchema = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

/** A single dependency's status with an optional human detail + probe latency. */
export const adminHealthComponentSchema = z
  .object({
    status: healthStatusSchema,
    /** Short human note (e.g. an error class); never carries PII or secrets. */
    detail: z.string().optional(),
    /** Round-trip of the probe in ms, when measured (DB/Redis pings). */
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict();
export type AdminHealthComponent = z.infer<typeof adminHealthComponentSchema>;

/** Circuit-breaker state, mirroring the provider layer's own enum (§5.1). */
export const HEALTH_CIRCUIT_STATES = ['closed', 'open', 'half-open'] as const;
export const healthCircuitStateSchema = z.enum(HEALTH_CIRCUIT_STATES);
export type HealthCircuitState = z.infer<typeof healthCircuitStateSchema>;

/**
 * One provider failover chain (§13.5 V5-P1c): the ordered candidate providers
 * for a primary source, and which one is currently serving its traffic. When
 * the primary is healthy `serving === primaryId`; when it is unhealthy (circuit
 * open) and a secondary is serving, `serving` is that secondary and `since`
 * marks when the switch happened.
 */
export const adminHealthProviderChainSchema = z
  .object({
    /** The asset's own provider id, i.e. the chain root (e.g. `yahoo`). */
    primaryId: z.string(),
    /** Provider currently serving this chain, or null before any traffic. */
    serving: z.string().nullable(),
    /** ISO-8601 time the current serving provider took over; null if none yet. */
    since: z.string().nullable(),
    /** Full ordered candidate chain (primary first, then failover sources). */
    providerIds: z.array(z.string()),
  })
  .strict();
export type AdminHealthProviderChain = z.infer<typeof adminHealthProviderChainSchema>;

/** One recorded failover/recovery switch: the serving provider changed (§13.5 V5-P1c). */
export const adminHealthProviderSwitchSchema = z
  .object({
    primaryId: z.string(),
    /** Previously-serving provider, or null when nothing had served yet. */
    from: z.string().nullable(),
    /** Now-serving provider. */
    to: z.string(),
    /** ISO-8601 timestamp of the switch. */
    at: z.string(),
  })
  .strict();
export type AdminHealthProviderSwitch = z.infer<typeof adminHealthProviderSwitchSchema>;

/** Per-provider attribution: how many reads this provider served (§13.5 V5-P1c). */
export const adminHealthProviderServeSchema = z
  .object({
    providerId: z.string(),
    /** Count of quote/history/meta reads served by this provider since boot. */
    serves: z.number().int().nonnegative(),
    /** ISO-8601 time of the most recent read this provider served, or null. */
    lastServedAt: z.string().nullable(),
  })
  .strict();
export type AdminHealthProviderServe = z.infer<typeof adminHealthProviderServeSchema>;

/**
 * Market-data providers: overall status, each provider's breaker state (§5.1),
 * plus the failover chains, currently-serving provider, recent switch events and
 * which-provider-served-what attribution (§13.5 V5-P1c). The failover arrays are
 * empty when no secondary source is configured — the byte-identical default.
 */
export const adminHealthProvidersSchema = z
  .object({
    status: healthStatusSchema,
    breakers: z.array(
      z.object({ providerId: z.string(), state: healthCircuitStateSchema }).strict(),
    ),
    chains: z.array(adminHealthProviderChainSchema),
    switches: z.array(adminHealthProviderSwitchSchema),
    attribution: z.array(adminHealthProviderServeSchema),
  })
  .strict();
export type AdminHealthProviders = z.infer<typeof adminHealthProvidersSchema>;

/** One BullMQ queue's depth counts (§9). */
export const adminHealthQueueDepthSchema = z
  .object({
    name: z.string(),
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
  })
  .strict();
export type AdminHealthQueueDepth = z.infer<typeof adminHealthQueueDepthSchema>;

/**
 * Job system status: per-queue depths + the `system.heartbeat` freshness. When
 * the process holds no live queue registry (tests / an API without the worker's
 * Redis-backed queues) `available` is false and depths are empty.
 */
export const adminHealthQueuesSchema = z
  .object({
    status: healthStatusSchema,
    available: z.boolean(),
    depths: z.array(adminHealthQueueDepthSchema),
    heartbeat: z
      .object({
        status: healthStatusSchema,
        /** Seconds since the last heartbeat tick; null when none has been seen. */
        ageSeconds: z.number().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();
export type AdminHealthQueues = z.infer<typeof adminHealthQueuesSchema>;

/** Realtime gateway (§4.5): whether it is enabled/attached + live socket count. */
export const adminHealthGatewaySchema = z
  .object({
    status: healthStatusSchema,
    enabled: z.boolean(),
    attached: z.boolean(),
    connections: z.number().int().nonnegative(),
  })
  .strict();
export type AdminHealthGateway = z.infer<typeof adminHealthGatewaySchema>;

/** `GET /admin/health` — the operator diagnostics snapshot (§13.4 V4-P5a). */
export const adminHealthResponseSchema = z
  .object({
    /** Overall verdict: `down` if the database (system of record) is down, else
     *  `degraded` if any component is faulted (a stopped Redis, an open breaker,
     *  a stale heartbeat), else `ok`. */
    status: healthStatusSchema,
    version: z.string(),
    uptimeSeconds: z.number().nonnegative(),
    checkedAt: z.string(),
    components: z
      .object({
        database: adminHealthComponentSchema,
        redis: adminHealthComponentSchema,
        providers: adminHealthProvidersSchema,
        queues: adminHealthQueuesSchema,
        gateway: adminHealthGatewaySchema,
      })
      .strict(),
  })
  .strict();
export type AdminHealthResponse = z.infer<typeof adminHealthResponseSchema>;

// ── Announcements (§13.4 V4-P5b) ────────────────────────────────────────────
// Admin-composed in-app notices with a dismissible banner + one inbox entry per
// user. Content is stored per-locale (EN + DE fields) server-side and rendered
// in the viewer's locale; only UI chrome flows through the SPA message catalog.
// Delivery is banner + inbox only — no email, push or channel routing (out of
// scope, and out of the V4-P5b acceptance).

/** Banner severity — drives distinct styling (info + warning at minimum). */
export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const announcementSeveritySchema = z.enum(ANNOUNCEMENT_SEVERITIES);
export type AnnouncementSeverity = z.infer<typeof announcementSeveritySchema>;

/** Max title/body lengths — bounded so the banner render stays predictable. */
export const ANNOUNCEMENT_TITLE_MAX = 120;
export const ANNOUNCEMENT_BODY_MAX = 2000;

/**
 * The notification `type` reused by V4-P0c for the one-off lean-email-defaults
 * notice — announcement inbox entries share it so the deep-link route key
 * (V4-P0c's `NotificationBell.notificationLink`) resolves identically. Deep-link
 * is `/announcements/:id` (a Settings landing page is out of scope); the banner
 * carries the same route in its data. Kept in lockstep with the API constant.
 */
export const ANNOUNCEMENT_NOTIFICATION_TYPE = 'account.notice';

/**
 * Where one announcement stands in the delivery lifecycle (#1909).
 *
 * Derived **server-side** from `active` / `startsAt` / `endsAt` / `publishedAt`
 * and the server clock, never in the browser: two clients on two machines with
 * two clock skews would otherwise disagree about whether a row is `scheduled`
 * or `publishing`, and the operator screen would contradict the job.
 *
 * - `draft` — not flagged active. Nothing is shown and nothing is delivered.
 * - `scheduled` — active, `startsAt` still in the future. The publish job
 *   defers BOTH the banner and the inbox fan-out until the window opens.
 * - `publishing` — active and due now; the job owns it and has not stamped
 *   `publishedAt` yet (a sweep tick away, or mid-walk).
 * - `published` — the fan-out completed and `publishedAt` is stamped.
 * - `expired` — `endsAt` has passed. Terminal: the banner hides it and the job
 *   refuses it, so it can never be delivered however it is re-saved.
 */
export const ANNOUNCEMENT_DELIVERY_STATES = [
  'draft',
  'scheduled',
  'publishing',
  'published',
  'expired',
] as const;
export const announcementDeliveryStateSchema = z.enum(ANNOUNCEMENT_DELIVERY_STATES);
export type AnnouncementDeliveryState = z.infer<typeof announcementDeliveryStateSchema>;

/** One admin-composed announcement — reads and writes share this shape. */
export const announcementSchema = z
  .object({
    id: z.string().uuid(),
    severity: announcementSeveritySchema,
    /** English title/body — always required (§13.4 EN + DE binding rule). */
    titleEn: z.string(),
    bodyEn: z.string(),
    /** German title/body — always required (§13.4 EN + DE binding rule). */
    titleDe: z.string(),
    bodyDe: z.string(),
    /**
     * Active window (both inclusive): the banner and the fan-out gate honor
     * this window and hide the announcement before start / after end. NULL
     * start = start immediately; NULL end = no auto-off. Nothing about time
     * is inferred from `createdAt` — the window is explicit.
     */
    startsAt: z.string().datetime().nullable(),
    endsAt: z.string().datetime().nullable(),
    /**
     * The active flag the admin toggles: `false` hides it entirely, even inside
     * the window (a dry-run save). `true` ARMS the announcement — it does not
     * send it (#1909). The `announcements.publishDue` job fans one inbox row
     * out to every user once the window has opened, idempotently per recipient
     * via the shared eventKey below. Saving never delivers anything.
     */
    active: z.boolean(),
    /** When the fan-out completed. NULL until the publish job stamps it. */
    publishedAt: z.string().datetime().nullable(),
    /**
     * Server-derived lifecycle state (#1909). The browser renders this; it does
     * not compute it — see {@link announcementDeliveryStateSchema}.
     */
    deliveryState: announcementDeliveryStateSchema,
    /**
     * The outcome of the last completed publication pass: recipients confirmed
     * to hold their inbox row, and recipients whose insert failed.
     * `deliveredCount + failedCount` is the number of accounts walked.
     *
     * NULL on a row that has never been through the job (pre-#1909 rows keep
     * NULL forever — the counts were not recorded then, and inventing a zero
     * would be indistinguishable from "measured, and nothing failed").
     */
    deliveredCount: z.number().int().nullable(),
    failedCount: z.number().int().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Announcement = z.infer<typeof announcementSchema>;

/** `GET /admin/announcements` — every announcement, newest first. */
export const announcementListResponseSchema = z
  .object({ announcements: z.array(announcementSchema) })
  .strict();
export type AnnouncementListResponse = z.infer<typeof announcementListResponseSchema>;

/**
 * `POST /admin/announcements` — create a new (possibly inactive) announcement.
 * EN and DE title/body are ALL required (§13.4 binding — every user-facing
 * string ships with both keys).
 *
 * The request persists and returns; it never walks the user table (#1909). The
 * `announcements.publishDue` job owns delivery.
 */
export const createAnnouncementRequestSchema = z
  .object({
    severity: announcementSeveritySchema,
    titleEn: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
    bodyEn: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX),
    titleDe: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
    bodyDe: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    /** Defaults to `false`; the admin flips it on separately to publish. */
    active: z.boolean().optional(),
  })
  .strict()
  .refine(
    (d) =>
      !d.startsAt || !d.endsAt || new Date(d.startsAt).getTime() <= new Date(d.endsAt).getTime(),
    { message: 'endsAt must be at or after startsAt.', path: ['endsAt'] },
  );
export type CreateAnnouncementRequest = z.infer<typeof createAnnouncementRequestSchema>;

/**
 * `PATCH /admin/announcements/:id` — partial update. At least one field
 * required; unknown fields rejected. Saving never fans out on the request
 * path (#1909): the publish job picks the row up once its window has opened,
 * and a re-publish is a no-op per recipient via the shared eventKey.
 */
export const updateAnnouncementRequestSchema = z
  .object({
    severity: announcementSeveritySchema.optional(),
    titleEn: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX).optional(),
    bodyEn: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX).optional(),
    titleDe: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX).optional(),
    bodyDe: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX).optional(),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.severity !== undefined ||
      d.titleEn !== undefined ||
      d.bodyEn !== undefined ||
      d.titleDe !== undefined ||
      d.bodyDe !== undefined ||
      d.startsAt !== undefined ||
      d.endsAt !== undefined ||
      d.active !== undefined,
    { message: 'Provide at least one field to update.' },
  );
export type UpdateAnnouncementRequest = z.infer<typeof updateAnnouncementRequestSchema>;

// ── Backup / restore-drill readiness (#1406 W1) ──────────────────────────────
// The production stack's `backup-scheduler` writes a machine-readable status
// file after every dump, offsite upload, restore drill and healthcheck (see
// docs/ops.md, "Local schedule, status, and health"). `GET /admin/ops/backup-status`
// is a READ-ONLY projection of that file for the operator Overview: it starts
// nothing, retries nothing, and carries no artifact paths, checksums or remote
// credentials — only freshness, outcome tags and the documented thresholds.

/** Age limits the deploy documents (docs/ops.md): 26 h dump, 35 d restore drill. */
export const BACKUP_FRESHNESS_MAX_HOURS = 26;
export const BACKUP_RESTORE_DRILL_MAX_DAYS = 35;

/**
 * Operator verdict for the readiness tile:
 *  - `ok` — a recent dump AND a recent restore drill.
 *  - `warn` — the recovery point is fresh but its proof is not (missing or stale
 *    restore drill, or a failed offsite upload): recovery is untested, not lost.
 *  - `critical` — no fresh recovery point, or the scheduler's own healthcheck
 *    reports a stale/failed dump.
 *  - `unknown` — no status file is wired into this deployment.
 */
export const ADMIN_BACKUP_STATUS_LEVELS = ['ok', 'warn', 'critical', 'unknown'] as const;
export const adminBackupStatusLevelSchema = z.enum(ADMIN_BACKUP_STATUS_LEVELS);
export type AdminBackupStatusLevel = z.infer<typeof adminBackupStatusLevelSchema>;

/** Why the verdict is what it is — a coarse, secret-free tag the UI localizes. */
export const ADMIN_BACKUP_STATUS_REASONS = [
  'not_configured',
  /**
   * A path IS configured but the API cannot read it — the mount is missing, or
   * the file's mode/owner locks the unprivileged api user out. Kept distinct from
   * `not_configured` because the two need opposite actions: one is "this deploy
   * has no backup sidecar", the other is "your backup evidence exists and you
   * cannot see it", which must never read as benign.
   */
  'permission_denied',
  'unreadable',
  'backup_missing',
  'backup_stale',
  /** Recorded success lies in the future — the evidence cannot be trusted. */
  'clock_skew',
  'restore_missing',
  'restore_stale',
  'offsite_failed',
  'scheduler_unhealthy',
  'healthy',
] as const;
export const adminBackupStatusReasonSchema = z.enum(ADMIN_BACKUP_STATUS_REASONS);
export type AdminBackupStatusReason = z.infer<typeof adminBackupStatusReasonSchema>;

/** A short outcome tag copied verbatim from the status file, or null when absent. */
const backupOutcomeTagSchema = z.string().max(48).nullable();

export const adminBackupStatusResponseSchema = z
  .object({
    /**
     * False when this deployment wires no status file (local dev, or a stack
     * without the backup sidecar). The tile then reads "not configured" — never
     * an error, and never a claim that backups are missing.
     */
    configured: z.boolean(),
    level: adminBackupStatusLevelSchema,
    reason: adminBackupStatusReasonSchema,
    /** When the API read the file. */
    checkedAt: z.string().datetime(),
    backup: z
      .object({
        lastSuccessAt: z.string().datetime().nullable(),
        ageSeconds: z.number().int().nonnegative().nullable(),
        lastAttemptOutcome: backupOutcomeTagSchema,
        artifactBytes: z.number().int().nonnegative().nullable(),
        maxAgeSeconds: z.number().int().positive(),
      })
      .strict(),
    restore: z
      .object({
        lastSuccessAt: z.string().datetime().nullable(),
        ageSeconds: z.number().int().nonnegative().nullable(),
        lastOutcome: backupOutcomeTagSchema,
        maxAgeSeconds: z.number().int().positive(),
      })
      .strict(),
    offsite: z
      .object({
        outcome: backupOutcomeTagSchema,
        uploadedCount: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    /**
     * The scheduler's own last healthcheck verdict. Authoritative when present:
     * it is evaluated against that deployment's configured thresholds, which an
     * operator may have tuned away from the documented defaults above.
     */
    scheduler: z
      .object({
        outcome: backupOutcomeTagSchema,
        reason: backupOutcomeTagSchema,
        checkedAt: z.string().datetime().nullable(),
      })
      .strict(),
  })
  .strict();
export type AdminBackupStatusResponse = z.infer<typeof adminBackupStatusResponseSchema>;
