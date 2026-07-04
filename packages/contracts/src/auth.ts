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

/**
 * Public self-serve registration (PROJECTPLAN.md §4, §6.12). The route exists as
 * enforcement plumbing from day one: it reads the stored registration mode and,
 * in V1's `closed` mode, always rejects with 403 `REGISTRATION_CLOSED`. The body
 * is validated here so the concrete self-serve flow (post-v1) needs no reshape.
 */
export const registerRequestSchema = z
  .object({
    email: emailSchema,
    username: usernameSchema,
    password: passwordSchema,
  })
  .strict();
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * PIN gate (PROJECTPLAN.md §6.1, §5.5). A short numeric code the user enters to
 * resume an existing session; a correct PIN renews the session's 30-day window.
 * Stored argon2id-hashed server-side exactly like a password — never in the
 * clear. 4–10 digits: long enough to matter, short enough to type on every
 * app open.
 */
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 10;
export const pinSchema = z
  .string()
  .regex(/^\d+$/, 'PIN must contain digits only')
  .min(MIN_PIN_LENGTH)
  .max(MAX_PIN_LENGTH);

/** `POST /auth/pin/verify` — resume a session by entering the PIN. */
export const pinVerifyRequestSchema = z.object({ pin: pinSchema }).strict();
export type PinVerifyRequest = z.infer<typeof pinVerifyRequestSchema>;

/** `PUT /auth/pin` — enable the PIN or change it to a new value. */
export const setPinRequestSchema = z.object({ pin: pinSchema }).strict();
export type SetPinRequest = z.infer<typeof setPinRequestSchema>;

/** The authenticated-user view returned by `/auth/me`, `/auth/login`, etc. */
export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  username: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  mustChangePassword: z.boolean(),
  /** Whether the account has the PIN gate turned on (§6.1). */
  pinEnabled: z.boolean(),
  baseCurrency: z.string(),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * `GET /auth/session` — the caller's own current session timestamps
 * (PROJECTPLAN.md §6.11 Security). `expiresAt` is `renewedAt` plus the fixed
 * 30-day window (§6.1).
 */
export const sessionInfoResponseSchema = z
  .object({
    /** When the session was created — i.e. the last login. */
    signedInAt: z.string().datetime(),
    /** Last time the 30-day window was reset (login / PIN verify). */
    renewedAt: z.string().datetime(),
    /** When the session lapses: `renewedAt` + the 30-day window. */
    expiresAt: z.string().datetime(),
  })
  .strict();
export type SessionInfoResponse = z.infer<typeof sessionInfoResponseSchema>;

export const inviteValidationResponseSchema = z.object({
  valid: z.boolean(),
  email: z.string().nullable(),
});
export type InviteValidationResponse = z.infer<typeof inviteValidationResponseSchema>;
