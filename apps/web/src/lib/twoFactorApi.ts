import {
  okResponseSchema,
  twoFactorEnrollResponseSchema,
  twoFactorMethodEnabledResponseSchema,
  twoFactorRecoveryCodesResponseSchema,
  twoFactorStatusResponseSchema,
  type TwoFactorConfirmRequest,
  type TwoFactorDisableRequest,
  type TwoFactorEmailConfirmRequest,
  type TwoFactorEnrollResponse,
  type TwoFactorMethodEnabledResponse,
  type TwoFactorRecoveryCodesResponse,
  type TwoFactorStatusResponse,
} from '@bettertrack/contracts';

import { apiRequest, STEP_UP_GATED_REQUEST } from './apiClient';

/**
 * Typed client for the two-factor auth surface (PROJECTPLAN.md §6.1, §13.2
 * V2-P5, #298): two independently-toggleable methods — the authenticator app
 * (TOTP) and email codes — plus shared status and recovery codes.
 */

/** `GET /auth/2fa/status` — the caller's current per-method 2FA state. */
export async function getTwoFactorStatus(signal?: AbortSignal): Promise<TwoFactorStatusResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/status', { signal });
  return twoFactorStatusResponseSchema.parse(data);
}

/** `POST /auth/2fa/enroll` — provisional TOTP secret + `otpauth://` URI (method not yet on). */
export async function enrollTwoFactor(): Promise<TwoFactorEnrollResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/enroll', { method: 'POST' });
  return twoFactorEnrollResponseSchema.parse(data);
}

/**
 * `POST /auth/2fa/confirm` — enables the authenticator method. `recoveryCodes` is
 * the fresh set when this is the first method enabled, else `null`.
 */
export async function confirmTwoFactor(
  body: TwoFactorConfirmRequest,
): Promise<TwoFactorMethodEnabledResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/confirm', { method: 'POST', body });
  return twoFactorMethodEnabledResponseSchema.parse(data);
}

/**
 * `POST /auth/2fa/disable` — a valid TOTP code or recovery code authorizes
 * turning it off.
 *
 * The ONE call on this surface that spreads {@link STEP_UP_GATED_REQUEST}, and
 * the reason is the server's answer, not the §-number (#2026): the code travels
 * in the body, and `disableTotp` refuses a wrong one GENERICALLY with
 * `401 TWO_FACTOR_INVALID_CODE` — it never says whether the TOTP step or a
 * recovery code was the miss (`services/auth/twoFactorService.ts`). To the
 * app-wide policy that 401 is indistinguishable from an expired session, so a
 * mistyped digit used to log the owner out and drop them on `/login` instead of
 * erroring in the form that asked. It is an in-form error, exactly as on
 * `/auth/change-password`.
 *
 * Its siblings deliberately do NOT opt out. `confirm`/`email/confirm` also carry
 * a code, but answer a wrong one with `400 TWO_FACTOR_INVALID_CODE`, which the
 * policy never reads; every other call here carries no credential at all, so a
 * 401 from one of them proves the session really is gone and MUST bounce — see
 * the precision case in `user/control/panels/twoFactorAuthRedirect.test.tsx`.
 *
 * Accepted trade-off (the same one #2000 took): a session that genuinely expired
 * while this form was open now shows the form's error instead of bouncing, and
 * the endpoint's wrong-code throttle (429) shows there too rather than raising
 * the app-wide "too fast" toast. Nothing is lost — the code is refused either
 * way, the dialog prints the server's own message, and the next non-suppressed
 * request (the 2FA status read behind this panel) still bounces to login.
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
export async function enrollEmailTwoFactor(): Promise<void> {
  const data = await apiRequest<unknown>('/auth/2fa/email/enroll', { method: 'POST' });
  okResponseSchema.parse(data);
}

/**
 * `POST /auth/2fa/email/confirm` — enables the email method with the emailed code.
 * `recoveryCodes` is the fresh set when this is the first method enabled, else `null`.
 */
export async function confirmEmailTwoFactor(
  body: TwoFactorEmailConfirmRequest,
): Promise<TwoFactorMethodEnabledResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/email/confirm', { method: 'POST', body });
  return twoFactorMethodEnabledResponseSchema.parse(data);
}

/** `POST /auth/2fa/email/disable` — turn the email method off (authenticated session). */
export async function disableEmailTwoFactor(): Promise<void> {
  const data = await apiRequest<unknown>('/auth/2fa/email/disable', { method: 'POST' });
  okResponseSchema.parse(data);
}

/** `POST /auth/2fa/recovery-codes` — regenerate; invalidates any prior unused codes. */
export async function regenerateRecoveryCodes(): Promise<TwoFactorRecoveryCodesResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/recovery-codes', { method: 'POST' });
  return twoFactorRecoveryCodesResponseSchema.parse(data);
}
