import { z } from 'zod';

import { localeSchema } from './i18n';

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
 * clear.
 *
 * New PINs are exactly {@link PIN_LENGTH} digits (owner directive, #288): the
 * gate renders four boxes and auto-submits on the fourth digit. Verification
 * stays deliberately length-agnostic (min {@link MIN_PIN_LENGTH}) so any PIN set
 * before this rule still resolves against its stored hash.
 */
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 10;
/** New/changed PINs are exactly this many digits (#288). */
export const PIN_LENGTH = 4;
export const pinSchema = z
  .string()
  .regex(/^\d+$/, 'PIN must contain digits only')
  .min(MIN_PIN_LENGTH)
  .max(MAX_PIN_LENGTH);

/**
 * `POST /auth/pin/verify` — resume a session by entering the PIN. Length-agnostic
 * (4–10) so a PIN set before the exact-4-digit rule still verifies; the hash, not
 * the contract, is the arbiter.
 */
export const pinVerifyRequestSchema = z.object({ pin: pinSchema }).strict();
export type PinVerifyRequest = z.infer<typeof pinVerifyRequestSchema>;

/**
 * `GET /auth/pin/status` — whether a web login PIN is set on the account (#361).
 * Lets a bearer client (the mobile app-lock's "Use my BetterTrack PIN") hide the
 * option until a PIN exists. Callable by cookie session or a bearer holding
 * `account:security`; reflects the caller's own account only.
 */
export const pinStatusResponseSchema = z.object({ pinSet: z.boolean() }).strict();
export type PinStatusResponse = z.infer<typeof pinStatusResponseSchema>;

/**
 * `PUT /auth/pin` — enable the PIN or change it to a new value. New PINs are
 * constrained to exactly {@link PIN_LENGTH} digits (#288).
 */
export const setPinRequestSchema = z
  .object({ pin: z.string().regex(/^\d{4}$/, 'PIN must be exactly 4 digits') })
  .strict();
export type SetPinRequest = z.infer<typeof setPinRequestSchema>;

/**
 * PIN idle-lock duration (PROJECTPLAN.md §6.1, §13.2 V2-P2; owner directive #304).
 * With the PIN on, the SPA re-asks for it only after the app has sat idle this
 * many minutes — active use (pointer/keys/scroll/touch, a tab regaining focus)
 * continually resets the deadline, so a busy app never locks and reloads/new tabs
 * mid-use pass freely. This is purely client-side timing; the server just stores
 * the preference (no server-timed deauth, no API-level PIN challenge). `null`
 * means "use the default" ({@link DEFAULT_PIN_WINDOW_MINUTES}, client-side).
 * Bounds keep it usable — at least a minute, at most a day.
 */
export const MIN_PIN_LOCK_IDLE_MINUTES = 1;
export const MAX_PIN_LOCK_IDLE_MINUTES = 1440;
/** Default idle-lock length when the user hasn't chosen one (#304). */
export const DEFAULT_PIN_WINDOW_MINUTES = 10;
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
 * Two-factor auth (PROJECTPLAN.md §6.1, §13.2 V2-P5). Two independent methods,
 * each with its own enable/disable toggle:
 *
 *  - **Authenticator app (TOTP).** Two-step: `enroll` returns a provisional
 *    secret + `otpauth://` URI (the enrollment QR) with the method still OFF; a
 *    valid TOTP `code` at `confirm` enables it. Disabling needs a valid factor (a
 *    TOTP code or an unused recovery code) so a bare session can't quietly strip
 *    it.
 *  - **Email codes.** `email/enroll` proves mailbox access by sending a code to
 *    the account email; a valid `email/confirm` code turns the method on. Blocked
 *    when SMTP is unconfigured and it would be the *only* method (no lockout).
 *
 * Recovery codes are issued once — on the FIRST method enabled — and work
 * regardless of the method mix. Enabling either method when 2FA is off starts the
 * login challenge; disabling the last method turns it off again.
 */
export const TOTP_CODE_LENGTH = 6;
export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

/** `POST /auth/2fa/enroll` — provisional TOTP secret + provisioning URI (method not yet on). */
export const twoFactorEnrollResponseSchema = z
  .object({
    /** The `otpauth://totp/...` URI an authenticator app scans as a QR code. */
    otpauthUri: z.string(),
    /** The base32 secret, for manual entry when a QR can't be scanned. */
    secret: z.string(),
  })
  .strict();
export type TwoFactorEnrollResponse = z.infer<typeof twoFactorEnrollResponseSchema>;

/** `POST /auth/2fa/confirm` — enable the TOTP method by proving a current code. */
export const twoFactorConfirmRequestSchema = z.object({ code: totpCodeSchema }).strict();
export type TwoFactorConfirmRequest = z.infer<typeof twoFactorConfirmRequestSchema>;

/** `POST /auth/2fa/email/confirm` — enable the email method with the emailed 6-digit code. */
export const twoFactorEmailConfirmRequestSchema = z.object({ code: totpCodeSchema }).strict();
export type TwoFactorEmailConfirmRequest = z.infer<typeof twoFactorEmailConfirmRequestSchema>;

/**
 * `POST /auth/2fa/disable` — disable the TOTP method. A valid factor authorizes
 * it: either the 6-digit TOTP code or one unused recovery code. Loosely bounded so
 * both forms (and their formatting) pass the contract; the service decides which
 * it is. (The email method disables from the authenticated session alone.)
 */
export const twoFactorDisableRequestSchema = z.object({ code: z.string().min(6).max(32) }).strict();
export type TwoFactorDisableRequest = z.infer<typeof twoFactorDisableRequestSchema>;

/** `GET /auth/2fa/status` — the caller's current 2FA methods (§6.1). */
export const twoFactorStatusResponseSchema = z
  .object({
    /** Authenticator-app (TOTP) method: on once a code has confirmed enrollment. */
    totpEnabled: z.boolean(),
    /** True when a TOTP secret is enrolled but not yet confirmed (awaiting a code). */
    totpPending: z.boolean(),
    /** Email-code method: on once a mailed code has confirmed mailbox access. */
    emailEnabled: z.boolean(),
    /** Count of recovery codes still unused (shared across both methods). */
    recoveryCodesRemaining: z.number().int().nonnegative(),
  })
  .strict();
export type TwoFactorStatusResponse = z.infer<typeof twoFactorStatusResponseSchema>;

/**
 * The plaintext recovery codes — returned once by `POST /auth/2fa/recovery-codes`
 * (regenerate). Never re-fetchable: only their SHA-256 hashes are stored.
 */
export const twoFactorRecoveryCodesResponseSchema = z
  .object({ recoveryCodes: z.array(z.string()).min(1) })
  .strict();
export type TwoFactorRecoveryCodesResponse = z.infer<typeof twoFactorRecoveryCodesResponseSchema>;

/**
 * Result of enabling a 2FA *method* (`confirm` for TOTP, `email/confirm` for the
 * email method). Recovery codes are issued once, on the FIRST method enabled, and
 * shown a single time: `recoveryCodes` carries that fresh set on the first method
 * and is `null` when another method was already active (the existing codes stay
 * valid and are not re-shown).
 */
export const twoFactorMethodEnabledResponseSchema = z
  .object({ recoveryCodes: z.array(z.string()).min(1).nullable() })
  .strict();
export type TwoFactorMethodEnabledResponse = z.infer<typeof twoFactorMethodEnabledResponseSchema>;

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
  /** PIN unlock-window length in minutes; `null` = use the default (§6.1, #288). */
  pinLockIdleMinutes: z.number().int().nullable(),
  baseCurrency: z.string(),
  /** UI language preference; drives the SPA i18n runtime at load (§13.3 V3-P1). */
  locale: localeSchema,
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

/**
 * Session manager (PROJECTPLAN.md §6.1, §6.11 Security, V3-P11a). One active
 * session as shown in Settings → Security. `id` is an OPAQUE public handle — the
 * SHA-256 of the underlying session id, never the raw session token itself — so
 * the raw credential is never exposed to the browser but a specific session can
 * still be addressed for revocation.
 */
export const sessionSummarySchema = z
  .object({
    /** Opaque revocation handle (SHA-256 of the session id), safe to expose. */
    id: z.string(),
    /** Human device/browser label parsed from the User-Agent, or "Unknown device". */
    device: z.string(),
    /** When this session was created — i.e. its login. */
    createdAt: z.string().datetime(),
    /** Last time a request rode this session (throttled), or its creation time. */
    lastSeenAt: z.string().datetime(),
    /** True for the caller's own session — the one making this request. */
    current: z.boolean(),
  })
  .strict();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** `GET /auth/sessions` — the caller's own active sessions (§6.11 Security). */
export const sessionListResponseSchema = z
  .object({ sessions: z.array(sessionSummarySchema) })
  .strict();
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

/** `POST /auth/sessions/revoke-others` — how many other sessions were killed. */
export const revokeSessionsResponseSchema = z
  .object({ revoked: z.number().int().nonnegative() })
  .strict();
export type RevokeSessionsResponse = z.infer<typeof revokeSessionsResponseSchema>;

/** `DELETE /auth/sessions/:id` path param — the opaque session handle. */
export const sessionHandleParamSchema = z.object({ id: z.string().min(1).max(256) }).strict();
export type SessionHandleParam = z.infer<typeof sessionHandleParamSchema>;

export const inviteValidationResponseSchema = z.object({
  valid: z.boolean(),
  email: z.string().nullable(),
});
export type InviteValidationResponse = z.infer<typeof inviteValidationResponseSchema>;

/**
 * `DELETE /account` body — self-service account deletion (§13.4 V4-P2c, #362).
 * Two independent server-side gates:
 *  - **Typed confirmation:** `confirmUsername` must match the account's username
 *    (case-insensitive) — the same guard the admin delete uses.
 *  - **Re-auth:** the current `password`, or — for a 2FA-enrolled account — a
 *    fresh authenticator `code` or an unused `recoveryCode`. Exactly-one is not
 *    required (password wins when several are sent), but at least one must be
 *    present or the request is rejected before any credential check.
 *
 * Callable with a session cookie (web) or a bearer holding `account:security`
 * (the mobile in-app flow) — deletion is irreversible either way.
 */
export const deleteAccountRequestSchema = z
  .object({
    confirmUsername: z.string().trim().min(1).max(40),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH).optional(),
    /** A fresh 6-digit authenticator (TOTP) code — 2FA-enrolled accounts only. */
    code: z.string().trim().min(4).max(16).optional(),
    /** An unused recovery code — consumed on success AND on a failed match. */
    recoveryCode: z.string().trim().min(4).max(64).optional(),
  })
  .strict()
  .refine((b) => b.password !== undefined || b.code !== undefined || b.recoveryCode !== undefined, {
    message: 'Re-authentication is required: send your password or a two-factor code.',
  });
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;
