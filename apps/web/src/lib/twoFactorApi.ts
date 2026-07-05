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

import { apiRequest } from './apiClient';

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

/** `POST /auth/2fa/disable` — a valid TOTP code or recovery code authorizes turning it off. */
export async function disableTwoFactor(body: TwoFactorDisableRequest): Promise<void> {
  const data = await apiRequest<unknown>('/auth/2fa/disable', { method: 'POST', body });
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
