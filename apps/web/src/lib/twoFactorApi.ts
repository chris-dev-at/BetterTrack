import {
  okResponseSchema,
  twoFactorEnrollResponseSchema,
  twoFactorMethodEnabledResponseSchema,
  twoFactorRecoveryCodesResponseSchema,
  twoFactorStatusResponseSchema,
  type TwoFactorDisableRequest,
  type TwoFactorEnrollResponse,
  type TwoFactorMethodEnabledResponse,
  type TwoFactorRecoveryCodesResponse,
  type TwoFactorStatusResponse,
  type TwoFactorStepUpConfirmRequest,
  type TwoFactorStepUpCredential,
} from '@bettertrack/contracts';

import { apiRequest, STEP_UP_GATED_REQUEST } from './apiClient';

/**
 * Typed client for the two-factor auth surface (PROJECTPLAN.md §6.1, §13.2
 * V2-P5, #298): two independently-toggleable methods — the authenticator app
 * (TOTP) and email codes — plus shared status and recovery codes.
 *
 * Every call that mints or removes a factor carries a credential in its body
 * (R-05: the `stepUp` — current password, or an existing TOTP / recovery code —
 * on enroll/confirm, email enroll/confirm/disable and regenerate; the factor
 * code on disable). The server refuses a wrong one with a generic `401`, which
 * the app-wide policy cannot tell from an expired session, so EVERY mutation
 * here spreads {@link STEP_UP_GATED_REQUEST}: a typo is an in-form error, never
 * a logout (#2026). The status read is the one credential-free call left, and a
 * 401 there still bounces to login.
 */

/** `GET /auth/2fa/status` — the caller's current per-method 2FA state. */
export async function getTwoFactorStatus(signal?: AbortSignal): Promise<TwoFactorStatusResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/status', { signal });
  return twoFactorStatusResponseSchema.parse(data);
}

/** `POST /auth/2fa/enroll` — provisional TOTP secret + `otpauth://` URI (method not yet on). */
export async function enrollTwoFactor(
  stepUp: TwoFactorStepUpCredential,
): Promise<TwoFactorEnrollResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/enroll', {
    method: 'POST',
    body: { stepUp },
    ...STEP_UP_GATED_REQUEST,
  });
  return twoFactorEnrollResponseSchema.parse(data);
}

/**
 * `POST /auth/2fa/confirm` — enables the authenticator method. `recoveryCodes` is
 * the fresh set when this is the first method enabled, else `null`.
 */
export async function confirmTwoFactor(
  body: TwoFactorStepUpConfirmRequest,
): Promise<TwoFactorMethodEnabledResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/confirm', {
    method: 'POST',
    body,
    ...STEP_UP_GATED_REQUEST,
  });
  return twoFactorMethodEnabledResponseSchema.parse(data);
}

/**
 * `POST /auth/2fa/disable` — a valid TOTP code or recovery code authorizes
 * turning it off.
 *
 * Like every mutation here it spreads {@link STEP_UP_GATED_REQUEST} (#2026):
 * `disableTotp` refuses a wrong code GENERICALLY with `401
 * TWO_FACTOR_INVALID_CODE`, which the app-wide policy would read as an expired
 * session and bounce the owner to `/login` mid-dialog.
 *
 * Accepted trade-off (the same one #2000 took): a session that genuinely expired
 * while one of these forms was open shows the form's error instead of bouncing,
 * and a 429 shows there too rather than raising the app-wide "too fast" toast.
 * Nothing is lost — the credential is refused either way, the dialog prints the
 * server's own message, and the next non-suppressed request (the 2FA status
 * read behind this panel) still bounces to login.
 */
export async function disableTwoFactor(body: TwoFactorDisableRequest): Promise<void> {
  const data = await apiRequest<unknown>('/auth/2fa/disable', {
    method: 'POST',
    body,
    ...STEP_UP_GATED_REQUEST,
  });
  okResponseSchema.parse(data);
}

/** `POST /auth/2fa/email/enroll` — send a mailbox-proof code to begin email-method enrollment. */
export async function enrollEmailTwoFactor(stepUp: TwoFactorStepUpCredential): Promise<void> {
  const data = await apiRequest<unknown>('/auth/2fa/email/enroll', {
    method: 'POST',
    body: { stepUp },
    ...STEP_UP_GATED_REQUEST,
  });
  okResponseSchema.parse(data);
}

/**
 * `POST /auth/2fa/email/confirm` — enables the email method with the emailed code.
 * `recoveryCodes` is the fresh set when this is the first method enabled, else `null`.
 */
export async function confirmEmailTwoFactor(
  body: TwoFactorStepUpConfirmRequest,
): Promise<TwoFactorMethodEnabledResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/email/confirm', {
    method: 'POST',
    body,
    ...STEP_UP_GATED_REQUEST,
  });
  return twoFactorMethodEnabledResponseSchema.parse(data);
}

/** `POST /auth/2fa/email/disable` — turn the email method off behind the step-up. */
export async function disableEmailTwoFactor(stepUp: TwoFactorStepUpCredential): Promise<void> {
  const data = await apiRequest<unknown>('/auth/2fa/email/disable', {
    method: 'POST',
    body: { stepUp },
    ...STEP_UP_GATED_REQUEST,
  });
  okResponseSchema.parse(data);
}

/** `POST /auth/2fa/recovery-codes` — regenerate behind the step-up; voids any prior unused codes. */
export async function regenerateRecoveryCodes(
  stepUp: TwoFactorStepUpCredential,
): Promise<TwoFactorRecoveryCodesResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/recovery-codes', {
    method: 'POST',
    body: { stepUp },
    ...STEP_UP_GATED_REQUEST,
  });
  return twoFactorRecoveryCodesResponseSchema.parse(data);
}
