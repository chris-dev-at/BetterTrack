import { z } from 'zod';

import { emailSchema, roleSchema, userStatusSchema, usernameSchema } from './auth';

/**
 * Global registration mode (PROJECTPLAN.md §4, §6.12). Governs how accounts come
 * to exist. V1 runs `closed` (admin-created users + invite links only) and fully
 * enforces it; the other three modes are designed and stored but inactive until
 * post-v1, so activating one later is a data switch, not a rebuild.
 */
export const REGISTRATION_MODES = ['closed', 'invite_token', 'approval', 'open'] as const;
export const registrationModeSchema = z.enum(REGISTRATION_MODES);
export type RegistrationMode = z.infer<typeof registrationModeSchema>;

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
 * fields rejected. V1 only accepts `registrationMode: 'closed'` (the API rejects
 * any other mode) so the stored state can never claim a mode the guard would not
 * enforce.
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

export const adminUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  username: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  mustChangePassword: z.boolean(),
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
  })
  .strict()
  .refine(
    (d) =>
      d.status !== undefined ||
      d.role !== undefined ||
      d.username !== undefined ||
      d.email !== undefined,
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
