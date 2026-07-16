import type { Response } from 'express';

import type { AppConfig } from '../config/env';

/**
 * Session cookie (PROJECTPLAN.md §6.1, §10): httpOnly, SameSite=Lax, Secure in
 * production, signed with SESSION_SECRET. The value is the opaque Redis session id.
 *
 * `persistent` (V4-P2b, owner spec #399 §A) selects the cookie lifetime:
 * - `true`  → a persisted cookie with `Max-Age` = the 30-day window (today's
 *   behavior for a "stay signed in" login).
 * - `false` → a **browser-session cookie**: no `Max-Age`/`Expires`, so it dies
 *   when the browser session ends. The server session behind it is separately
 *   bounded (sliding idle window + hard cap), so neither is immortal (§16).
 */
export function setSessionCookie(
  res: Response,
  config: AppConfig,
  sessionId: string,
  persistent: boolean,
): void {
  res.cookie(config.cookie.name, sessionId, {
    httpOnly: true,
    sameSite: config.cookie.sameSite,
    secure: config.cookie.secure,
    signed: true,
    // Omit maxAge entirely for an ephemeral session → a browser-session cookie.
    ...(persistent ? { maxAge: config.cookie.maxAgeMs } : {}),
    path: '/',
  });
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  res.clearCookie(config.cookie.name, {
    httpOnly: true,
    sameSite: config.cookie.sameSite,
    secure: config.cookie.secure,
    signed: true,
    path: '/',
  });
}

/**
 * Remembered-device cookie (PROJECTPLAN.md §16; owner spec #399 §B, V4-P2b): the
 * server-side binding for OAuth PIN quick re-auth. httpOnly + signed like the
 * session cookie — the browser never reads it (the client's own remember-me
 * record, username + avatar + user id, lives in localStorage). The value is an
 * opaque device id mapped to a user in Redis. Long-lived (no automatic expiry per
 * the owner — "until cleared"); the browser caps persistent cookies near 400
 * days, so it is re-set on every quick re-auth to keep it fresh.
 */
export const REMEMBERED_DEVICE_COOKIE = 'bt_rdid';
/** ~400 days (the browser cap for a persisted cookie) — the closest to "no expiry". */
export const REMEMBERED_DEVICE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

export function setRememberedDeviceCookie(
  res: Response,
  config: AppConfig,
  deviceId: string,
): void {
  res.cookie(REMEMBERED_DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    sameSite: config.cookie.sameSite,
    secure: config.cookie.secure,
    signed: true,
    maxAge: REMEMBERED_DEVICE_MAX_AGE_MS,
    path: '/',
  });
}

export function clearRememberedDeviceCookie(res: Response, config: AppConfig): void {
  res.clearCookie(REMEMBERED_DEVICE_COOKIE, {
    httpOnly: true,
    sameSite: config.cookie.sameSite,
    secure: config.cookie.secure,
    signed: true,
    path: '/',
  });
}

/**
 * Google OAuth `state` binding cookie (§13.4 V4-P4b). The authorization-code flow
 * already stores each single-use `state` server-side (Redis); this signed httpOnly
 * cookie double-submits the same value so the callback can require the returning
 * browser to be the one that started the flow — closing the OAuth login-CSRF hole
 * (a planted `state` from an attacker-initiated flow is rejected because the
 * victim's browser never holds its cookie). SameSite=Lax (like the session cookie)
 * so it survives the top-level GET redirect back from Google. Short-lived — it is
 * cleared the instant the callback consumes it, and expires with the state anyway.
 */
export const GOOGLE_OAUTH_STATE_COOKIE = 'bt_goog_state';
/** Matches the Redis `state` TTL (10 min) — long enough to sign in, tight otherwise. */
export const GOOGLE_OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

export function setGoogleOAuthStateCookie(res: Response, config: AppConfig, state: string): void {
  res.cookie(GOOGLE_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: config.cookie.sameSite,
    secure: config.cookie.secure,
    signed: true,
    maxAge: GOOGLE_OAUTH_STATE_MAX_AGE_MS,
    path: '/',
  });
}

export function clearGoogleOAuthStateCookie(res: Response, config: AppConfig): void {
  res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, {
    httpOnly: true,
    sameSite: config.cookie.sameSite,
    secure: config.cookie.secure,
    signed: true,
    path: '/',
  });
}
