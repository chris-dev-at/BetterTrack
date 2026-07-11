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
