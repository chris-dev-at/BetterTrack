import type { ProfileIconId, Role, UserStatus } from '@bettertrack/contracts';

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
  /** Curated profile icon id (§13.5 V5-P0c) or `null` when never picked. */
  profileIcon: ProfileIconId | null;
  lastLoginAt: Date | string | null;
  createdAt: Date | string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- standard Express request augmentation
  namespace Express {
    interface Request {
      sessionId?: string;
      /**
       * Whether the resolved cookie session is persistent ("stay signed in") vs
       * ephemeral (V4-P2b, §399 §A). Set alongside `sessionId` by `loadSession`
       * so handlers that re-issue the cookie (PIN verify) keep its flavour.
       */
      sessionPersistent?: boolean;
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
      apiKey?: {
        id: string;
        scopes: string[];
        kind: 'personal' | 'oauth';
        /**
         * Resolved per-key rate tier (§13.5 V5-P10) for a personal key — the
         * limiter reads (limit, windowSec) from here. Absent for OAuth grants and
         * for keys with no resolvable tier, which fall back to the config default.
         */
        rateLimit?: { limit: number; windowSec: number };
      };
      /** Parsed, schema-validated inputs (Express 5 `req.query` is read-only). */
      valid?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}
