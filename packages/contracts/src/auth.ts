import { z } from 'zod';

export const ROLES = ['user', 'admin'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const USER_STATUSES = ['active', 'disabled'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** Password policy length floor (PROJECTPLAN.md §6.1). Blocklist enforced server-side. */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;
export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

export const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
export const usernameSchema = z.string().min(3).max(40).regex(USERNAME_PATTERN);
export const emailSchema = z.string().email().max(320);

export const loginRequestSchema = z
  .object({
    identifier: z.string().min(1).max(320),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
    newPassword: passwordSchema,
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const acceptInviteRequestSchema = z
  .object({
    token: z.string().min(1).max(256),
    username: usernameSchema,
    password: passwordSchema,
  })
  .strict();
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;

/** The authenticated-user view returned by `/auth/me`, `/auth/login`, etc. */
export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  username: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  mustChangePassword: z.boolean(),
  baseCurrency: z.string(),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const inviteValidationResponseSchema = z.object({
  valid: z.boolean(),
  email: z.string().nullable(),
});
export type InviteValidationResponse = z.infer<typeof inviteValidationResponseSchema>;
