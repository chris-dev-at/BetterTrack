import type { Response } from 'express';

import type { AppConfig } from '../config/env';

/**
 * Session cookie (PROJECTPLAN.md §6.1, §10): httpOnly, SameSite=Lax, Secure in
 * production, signed with SESSION_SECRET. The value is the opaque Redis session id.
 */
export function setSessionCookie(res: Response, config: AppConfig, sessionId: string): void {
  res.cookie(config.cookie.name, sessionId, {
    httpOnly: true,
    sameSite: config.cookie.sameSite,
    secure: config.cookie.secure,
    signed: true,
    maxAge: config.cookie.maxAgeMs,
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
