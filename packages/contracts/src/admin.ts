import { z } from 'zod';

import { emailSchema, roleSchema, userStatusSchema, usernameSchema } from './auth';
import { portfolioVisibilitySchema } from './portfolio';
import { notificationChannelsConfigurableSchema, notificationMatrixSchema } from './settings';

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

export const adminUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  username: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  mustChangePassword: z.boolean(),
  /** Admin chat ban (§13.4 V4-P0d): while true the user cannot send DMs. */
  chatBanned: z.boolean(),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUserListQuerySchema = z
  .object({ search: z.string().max(120).optional() })
  .strict();
export const adminUserListResponseSchema = z.object({ users: z.array(adminUserSchema) });
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

export const updateUserRequestSchema = z
  .object({
    status: userStatusSchema.optional(),
    role: roleSchema.optional(),
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    /** Admin chat ban toggle (§13.4 V4-P0d): true bans, false unbans (instant). */
    chatBanned: z.boolean().optional(),
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
  );
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
  })
  .strict();
export type BulkUserActionRequest = z.infer<typeof bulkUserActionRequestSchema>;

/**
 * Result of a bulk action: how many were actually changed vs. skipped (self,
 * last active admin, or already in the target state).
 */
export const bulkUserActionResponseSchema = z.object({
  action: bulkUserActionSchema,
  disabled: z.number().int(),
  skipped: z.number().int(),
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

export const adminInviteListResponseSchema = z.object({ invites: z.array(adminInviteSchema) });
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

export const registrationTokenListResponseSchema = z.object({
  tokens: z.array(registrationTokenSchema),
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
  createdAt: z.string().datetime(),
});
export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;

export const registrationRequestListResponseSchema = z.object({
  requests: z.array(registrationRequestSchema),
});
export type RegistrationRequestListResponse = z.infer<typeof registrationRequestListResponseSchema>;

export const auditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  meta: z.unknown().nullable(),
  createdAt: z.string().datetime(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditLogListResponseSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  nextCursor: z.string().uuid().nullable(),
});
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;

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
     * the window (a dry-run save). Publishing (flip from off → on) fans an
     * inbox row out to every user (idempotent by the shared eventKey below).
     */
    active: z.boolean(),
    /** When the row was last published (flipped on). NULL until first publish. */
    publishedAt: z.string().datetime().nullable(),
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
 * required; unknown fields rejected. Flipping `active` from off to on triggers
 * the fan-out; a re-publish is a no-op via the shared eventKey.
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
