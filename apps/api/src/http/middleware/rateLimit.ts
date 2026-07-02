import type { Request, RequestHandler } from 'express';

import { tooManyRequests } from '../../errors';
import {
  createProgressiveLimiter,
  type ProgressiveLimiter,
} from '../../services/security/progressiveLimiter';
import type { AppContext } from '../context';

const keyByIp = (req: Request): string => req.ip ?? 'unknown';
const keyByUserOrIp = (req: Request): string => req.authUser?.id ?? req.ip ?? 'unknown';

export interface RateLimiters {
  login: RequestHandler;
  general: RequestHandler;
  admin: RequestHandler;
  search: RequestHandler;
}

/**
 * Redis-backed progressive rate limiting (PROJECTPLAN.md §10). Each request
 * counts against a generous steady-state allowance; an over-limit trips a short
 * cooldown that escalates only on repeat violations and decays after ~15 min of
 * good behavior. A 429 carries the wait both as a `Retry-After` header (which the
 * SPA reads) and in the body's `details.retryAfter`.
 *
 * Disabled under test (`rateLimits.enabled`) so the HTTP limiter stays out of the
 * way of deterministic API tests; the limiter primitive itself is unit-tested.
 */
export function createRateLimiters(ctx: AppContext): RateLimiters {
  const { enabled, general, search, loginIp } = ctx.config.rateLimits;

  const guard = (
    limiter: ProgressiveLimiter,
    keyGenerator: (req: Request) => string,
  ): RequestHandler => {
    return (req, res, next) => {
      if (!enabled) {
        next();
        return;
      }
      limiter
        .consume(keyGenerator(req))
        .then((decision) => {
          if (decision.allowed) {
            next();
            return;
          }
          // The SPA's fetch chokepoint reads Retry-After to drive its toast.
          res.setHeader('Retry-After', String(decision.retryAfterSec));
          next(tooManyRequests(decision.retryAfterSec));
        })
        .catch(next);
    };
  };

  const loginLimiter = createProgressiveLimiter(ctx.redis, 'login_ip', loginIp);
  const generalLimiter = createProgressiveLimiter(ctx.redis, 'general', general);
  const searchLimiter = createProgressiveLimiter(ctx.redis, 'search', search);

  return {
    login: guard(loginLimiter, keyByIp),
    general: guard(generalLimiter, keyByUserOrIp),
    // Admin endpoints share the general schedule (§10); a distinct namespace
    // keeps their counter independent of a co-located user's general traffic.
    admin: guard(createProgressiveLimiter(ctx.redis, 'admin', general), keyByUserOrIp),
    search: guard(searchLimiter, keyByUserOrIp),
  };
}
