import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';

import type { MeResponse, Passkey } from '@bettertrack/contracts';

import {
  finishPasskeyLogin,
  finishPasskeyRegistration,
  startPasskeyLogin,
  startPasskeyRegistration,
} from './userApi';

/**
 * Passkey / WebAuthn ceremony orchestration (PROJECTPLAN.md §13.4 V4-P4). This is
 * the ONLY module that touches `@simplewebauthn/browser` (the native authenticator
 * prompt), so the rest of the SPA stays framework-agnostic and testable. Each
 * helper runs the two-round ceremony end to end: fetch server-minted options →
 * drive the authenticator → post the response back for verification.
 */

/** Whether the browser can run WebAuthn at all — gates rendering the passkey UI. */
export { browserSupportsWebAuthn };

/**
 * True when a thrown ceremony error is the user dismissing/cancelling the native
 * prompt (or it timing out) — a `NotAllowedError`/`AbortError` — as opposed to a
 * real failure. Lets the UI stay quiet on an intentional cancel.
 */
export function isPasskeyCancellation(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');
}

/** The re-auth credential accompanying a passkey add (password or a 2FA factor). */
export interface PasskeyReauth {
  password?: string;
  code?: string;
  recoveryCode?: string;
}

/**
 * Register a new passkey end to end: request creation options, drive the
 * authenticator prompt, then verify + persist (with the re-auth credential).
 * Throws on cancellation/failure — the caller renders the outcome.
 */
export async function registerPasskey(name: string, reauth: PasskeyReauth): Promise<Passkey> {
  const { options } = await startPasskeyRegistration();
  const response = await startRegistration({
    optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'],
  });
  return finishPasskeyRegistration({
    name,
    response: response as unknown as Record<string, unknown>,
    ...reauth,
  });
}

/**
 * Sign in with a passkey end to end: request usernameless request options, drive
 * the authenticator prompt, then verify (the server sets the session cookie).
 */
export async function signInWithPasskey(staySignedIn?: boolean): Promise<MeResponse> {
  const { challengeId, options } = await startPasskeyLogin();
  const response = await startAuthentication({
    optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
  });
  return finishPasskeyLogin({
    challengeId,
    response: response as unknown as Record<string, unknown>,
    staySignedIn,
  });
}
