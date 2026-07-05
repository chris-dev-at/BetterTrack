import { z } from 'zod';

export const ROLES = ['user', 'admin'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const USER_STATUSES = ['active', 'disabled'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** Password policy length floor (PROJECTPLAN.md §6.1, owner-tunable per §13.2). Blocklist enforced server-side. */
export const MIN_PASSWORD_LENGTH = 8;
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
    /**
     * The account's current password. Required for a voluntary change from
     * Settings; omitted for a forced change after an admin reset, where the
     * session just minted by logging in with the temp password is itself proof
     * of the current credential — so it is never asked for twice (§6.1, #248
     * items 6/7). The server enforces it for voluntary changes and ignores it
     * for forced ones.
     */
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH).optional(),
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
 * Self-service password reset (PROJECTPLAN.md §6.1, §14, §13.2 V2-P4). Two public
 * steps: request a reset by email, then complete it with the emailed token and a
 * new password. The request response is always the same generic acknowledgement
 * regardless of whether the email matches an account — no user enumeration.
 */
export const passwordResetRequestSchema = z.object({ email: emailSchema }).strict();
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetCompleteSchema = z
  .object({
    token: z.string().min(1).max(256),
    newPassword: passwordSchema,
  })
  .strict();
export type PasswordResetComplete = z.infer<typeof passwordResetCompleteSchema>;

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

/**
 * AFK auto-lock (PROJECTPLAN.md §6.1, §13.2 V2-P2). With the PIN on, the SPA can
 * re-show the lock overlay after this many minutes of inactivity. `null` = off,
 * the opt-in default: the lock is then only required on app (re)open, never on
 * idle. Bounds keep it usable — at least a minute, at most a day.
 */
export const MIN_PIN_LOCK_IDLE_MINUTES = 1;
export const MAX_PIN_LOCK_IDLE_MINUTES = 1440;
export const pinLockIdleMinutesSchema = z
  .number()
  .int()
  .min(MIN_PIN_LOCK_IDLE_MINUTES)
  .max(MAX_PIN_LOCK_IDLE_MINUTES)
  .nullable();

/** `PUT /auth/pin/idle-timeout` — set (or clear with `null`) the AFK auto-lock. */
export const setPinLockRequestSchema = z.object({ idleMinutes: pinLockIdleMinutesSchema }).strict();
export type SetPinLockRequest = z.infer<typeof setPinLockRequestSchema>;

/**
 * Two-factor auth — TOTP (PROJECTPLAN.md §6.1, §13.2 V2-P5). Enrollment is
 * two-step: `enroll` returns a provisional secret + `otpauth://` URI (for the
 * authenticator QR) with 2FA still OFF; a valid TOTP `code` at `confirm` enables
 * it and hands back the one-time recovery codes. Disabling requires a valid
 * factor (a TOTP code or an unused recovery code) so a bare session can't quietly
 * remove the protection. This contract is the backend core; the login-time
 * challenge and Settings UI are separate V2-P5 issues.
 */
export const TOTP_CODE_LENGTH = 6;
export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

/** `POST /auth/2fa/enroll` — provisional secret + provisioning URI (2FA not yet on). */
export const twoFactorEnrollResponseSchema = z
  .object({
    /** The `otpauth://totp/...` URI an authenticator app scans as a QR code. */
    otpauthUri: z.string(),
    /** The base32 secret, for manual entry when a QR can't be scanned. */
    secret: z.string(),
  })
  .strict();
export type TwoFactorEnrollResponse = z.infer<typeof twoFactorEnrollResponseSchema>;

/** `POST /auth/2fa/confirm` — enable 2FA by proving a current TOTP code. */
export const twoFactorConfirmRequestSchema = z.object({ code: totpCodeSchema }).strict();
export type TwoFactorConfirmRequest = z.infer<typeof twoFactorConfirmRequestSchema>;

/**
 * `POST /auth/2fa/disable` — a valid factor authorizes the disable: either the
 * 6-digit TOTP code or one unused recovery code. Loosely bounded so both forms
 * (and their formatting) pass the contract; the service decides which it is.
 */
export const twoFactorDisableRequestSchema = z.object({ code: z.string().min(6).max(32) }).strict();
export type TwoFactorDisableRequest = z.infer<typeof twoFactorDisableRequestSchema>;

/** `GET /auth/2fa/status` — the caller's current 2FA state. */
export const twoFactorStatusResponseSchema = z
  .object({
    /** True once a TOTP code has confirmed enrollment. */
    enabled: z.boolean(),
    /** True when a secret is enrolled but not yet confirmed (awaiting a code). */
    pending: z.boolean(),
    /** Count of recovery codes still unused. */
    recoveryCodesRemaining: z.number().int().nonnegative(),
  })
  .strict();
export type TwoFactorStatusResponse = z.infer<typeof twoFactorStatusResponseSchema>;

/**
 * The plaintext recovery codes — returned once by `confirm` and by
 * `POST /auth/2fa/recovery-codes` (regenerate). Never re-fetchable: only their
 * SHA-256 hashes are stored server-side.
 */
export const twoFactorRecoveryCodesResponseSchema = z
  .object({ recoveryCodes: z.array(z.string()).min(1) })
  .strict();
export type TwoFactorRecoveryCodesResponse = z.infer<typeof twoFactorRecoveryCodesResponseSchema>;

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
  /** AFK auto-lock idle timeout in minutes; `null` = off (§6.1, §13.2 V2-P2). */
  pinLockIdleMinutes: z.number().int().nullable(),
  baseCurrency: z.string(),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * Login-time 2FA challenge (PROJECTPLAN.md §6.1, §13.2 V2-P5). When an account
 * has 2FA enabled, a correct password does **not** mint a session: the API
 * returns this challenge carrying a short-lived, single-purpose `pendingToken`
 * that only the 2FA verify / email-code endpoints accept — no protected route
 * honours it. The client presents a second factor to promote it to a real
 * session. `channels` tells the UI which factors to offer.
 */
export const TWO_FACTOR_CHANNELS = ['totp', 'email', 'recovery'] as const;
export const twoFactorChannelSchema = z.enum(TWO_FACTOR_CHANNELS);
export type TwoFactorChannel = z.infer<typeof twoFactorChannelSchema>;

export const twoFactorChallengeResponseSchema = z
  .object({
    /** Discriminant: always true on the challenge branch of the login response. */
    twoFactorRequired: z.literal(true),
    /** Opaque bearer for the pending challenge; only verify/email-code accept it. */
    pendingToken: z.string(),
    /** Which second-factor channels the client may offer. */
    channels: z.array(twoFactorChannelSchema).min(1),
  })
  .strict();
export type TwoFactorChallengeResponse = z.infer<typeof twoFactorChallengeResponseSchema>;

/**
 * `POST /auth/login` response. Either the signed-in user (no 2FA — a session
 * cookie is set exactly as before) or a {@link twoFactorChallengeResponseSchema}
 * (session withheld until a second factor verifies). The two branches are
 * disjoint: only the challenge carries `twoFactorRequired`.
 */
export const loginResponseSchema = z.union([meResponseSchema, twoFactorChallengeResponseSchema]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * `POST /auth/2fa/verify` — present a second factor for a pending challenge.
 * Exactly one of `code` (a 6-digit TOTP or emailed login code) or `recoveryCode`
 * (a dashed recovery code). `pendingToken` came from the login challenge; a valid
 * factor promotes it to a full session.
 */
export const twoFactorVerifyRequestSchema = z
  .object({
    pendingToken: z.string().min(1).max(256),
    code: z.string().min(6).max(10).optional(),
    recoveryCode: z.string().min(8).max(64).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Provide either a code or a recovery code.',
  });
export type TwoFactorVerifyRequest = z.infer<typeof twoFactorVerifyRequestSchema>;

/**
 * `POST /auth/2fa/email-code` — send a one-time, short-lived login code to the
 * account's email for a pending challenge. Best-effort: with no SMTP the send is
 * logged `suppressed` and the request still succeeds (the code is unusable, but
 * the caller can fall back to TOTP or a recovery code).
 */
export const twoFactorEmailCodeRequestSchema = z
  .object({ pendingToken: z.string().min(1).max(256) })
  .strict();
export type TwoFactorEmailCodeRequest = z.infer<typeof twoFactorEmailCodeRequestSchema>;

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
