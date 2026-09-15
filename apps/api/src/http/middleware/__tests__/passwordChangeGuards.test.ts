import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { AUTH_ERROR_CODES } from '@bettertrack/contracts';

import { ApiError } from '../../../errors';
import { enforcePasswordChange, requirePasswordChangeCompleted } from '../session';

/**
 * The two forced-password-change guards differ in exactly one way, and that
 * difference is a security boundary: {@link enforcePasswordChange} reads a
 * MOUNT-relative `req.path` against an `/api/v1`-relative allowlist, so it is
 * only correct on the `/api/v1` mount, while
 * {@link requirePasswordChangeCompleted} refuses regardless of path and is what
 * deeper mounts (the Grafana proxy) must use.
 */
function runGuard(
  guard: typeof enforcePasswordChange,
  path: string,
  mustChangePassword = true,
): unknown {
  const next = vi.fn() as unknown as NextFunction;
  guard({ path, authUser: { mustChangePassword } } as unknown as Request, {} as Response, next);
  const calls = (next as unknown as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]?.[0];
}

/** Every mount-relative shape the Grafana proxy can receive. */
const GRAFANA_MOUNT_RELATIVE_PATHS = [
  '/',
  '/d/abc',
  '/api/datasources',
  // The `/api/v1`-relative exemptions, which under a deeper mount are Grafana's
  // OWN sub-paths and must not exempt anything.
  '/auth/login',
  '/auth/logout',
  '/auth/change-password',
  '/auth/accept-invite',
  '/auth/invite/abc',
  // The traversal form: `req.path` keeps the dot segments, but the proxy's
  // `new URL(req.originalUrl, upstream)` collapses them back onto a real
  // dashboard — so an allowlist match here is a full bypass.
  '/auth/invite/../../d/abc',
];

describe('requirePasswordChangeCompleted', () => {
  it('refuses every path shape while the password change is pending', () => {
    for (const path of GRAFANA_MOUNT_RELATIVE_PATHS) {
      const err = runGuard(requirePasswordChangeCompleted, path);
      expect(err, path).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode, path).toBe(403);
      expect((err as ApiError).code, path).toBe(AUTH_ERROR_CODES.passwordChangeRequired);
    }
  });

  it('passes the request through once no change is pending', () => {
    for (const path of GRAFANA_MOUNT_RELATIVE_PATHS) {
      expect(runGuard(requirePasswordChangeCompleted, path, false), path).toBeUndefined();
    }
  });
});

describe('enforcePasswordChange', () => {
  it('is the /api/v1-relative variant — its exemptions make it unsafe on a deeper mount', () => {
    // Documents WHY the Grafana mount cannot reuse it: these Grafana sub-paths
    // collide with the `/api/v1` auth allowlist and would skip the guard.
    for (const path of [
      '/auth/login',
      '/auth/logout',
      '/auth/change-password',
      '/auth/accept-invite',
      '/auth/invite/abc',
      '/auth/invite/../../d/abc',
    ]) {
      expect(runGuard(enforcePasswordChange, path), path).toBeUndefined();
    }
  });

  it('refuses ordinary /api/v1 paths while the password change is pending', () => {
    for (const path of ['/auth/me', '/admin/users', '/admin/monitoring/status']) {
      const err = runGuard(enforcePasswordChange, path);
      expect((err as ApiError).code, path).toBe(AUTH_ERROR_CODES.passwordChangeRequired);
    }
  });
});
