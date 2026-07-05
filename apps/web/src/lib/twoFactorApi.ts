import {
  okResponseSchema,
  twoFactorEnrollResponseSchema,
  twoFactorRecoveryCodesResponseSchema,
  twoFactorStatusResponseSchema,
  type TwoFactorConfirmRequest,
  type TwoFactorDisableRequest,
  type TwoFactorEnrollResponse,
  type TwoFactorRecoveryCodesResponse,
  type TwoFactorStatusResponse,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the two-factor auth surface (PROJECTPLAN.md §6.1, §13.2
 * V2-P5), mirroring `settingsApi.ts`. Kept separate from `userApi.ts`, which
 * the login-challenge issue owns.
 */

/** `GET /auth/2fa/status` — the caller's current 2FA state. */
export async function getTwoFactorStatus(signal?: AbortSignal): Promise<TwoFactorStatusResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/status', { signal });
  return twoFactorStatusResponseSchema.parse(data);
}

/** `POST /auth/2fa/enroll` — provisional secret + `otpauth://` URI (2FA not yet on). */
export async function enrollTwoFactor(): Promise<TwoFactorEnrollResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/enroll', { method: 'POST' });
  return twoFactorEnrollResponseSchema.parse(data);
}

/** `POST /auth/2fa/confirm` — enables 2FA; returns the one-time recovery codes. */
export async function confirmTwoFactor(
  body: TwoFactorConfirmRequest,
): Promise<TwoFactorRecoveryCodesResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/confirm', { method: 'POST', body });
  return twoFactorRecoveryCodesResponseSchema.parse(data);
}

/** `POST /auth/2fa/disable` — a valid TOTP code or recovery code authorizes turning it off. */
export async function disableTwoFactor(body: TwoFactorDisableRequest): Promise<void> {
  const data = await apiRequest<unknown>('/auth/2fa/disable', { method: 'POST', body });
  okResponseSchema.parse(data);
}

/** `POST /auth/2fa/recovery-codes` — regenerate; invalidates any prior unused codes. */
export async function regenerateRecoveryCodes(): Promise<TwoFactorRecoveryCodesResponse> {
  const data = await apiRequest<unknown>('/auth/2fa/recovery-codes', { method: 'POST' });
  return twoFactorRecoveryCodesResponseSchema.parse(data);
}
