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
  lastLoginAt: Date | string | null;
  createdAt: Date | string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- standard Express request augmentation
  namespace Express {
    interface Request {
      sessionId?: string;
      authUser?: AuthUser;
      /** Parsed, schema-validated inputs (Express 5 `req.query` is read-only). */
      valid?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}
