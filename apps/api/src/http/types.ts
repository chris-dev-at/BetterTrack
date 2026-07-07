import type { Role, UserStatus } from '@bettertrack/contracts';

/** The session user attached to a request (never carries the password hash). */
export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: Role;
  status: UserStatus;
  mustChangePassword: boolean;
  pinEnabled: boolean;
  pinLockIdleMinutes: number | null;
  baseCurrency: string;
  locale: string;
  lastLoginAt: Date | string | null;
  createdAt: Date | string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- standard Express request augmentation
  namespace Express {
    interface Request {
      sessionId?: string;
      authUser?: AuthUser;
      /**
       * Set when the request authenticated via an `Authorization: Bearer` token
       * instead of the session cookie (§6.13, V2-P12) — either a personal API
       * key (`btk_…`, `kind: 'personal'`) or a delegated OAuth access token
       * (`bto_…`, `kind: 'oauth'`, `id` is the grant id). Its presence means:
       * skip CSRF (no cookies), enforce the token's scopes, and rate-limit per
       * token/grant id. Mutually exclusive with cookie-session auth. Both kinds
       * ride the exact same scope-enforcement rail.
       */
      apiKey?: { id: string; scopes: string[]; kind: 'personal' | 'oauth' };
      /** Parsed, schema-validated inputs (Express 5 `req.query` is read-only). */
      valid?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}
