import { z } from 'zod';

import { emailSchema, roleSchema, userStatusSchema, usernameSchema } from './auth';

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
  })
  .strict()
  .refine((d) => d.status !== undefined || d.role !== undefined, {
    message: 'Provide at least one of status or role.',
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

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
