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
  social: RequestHandler;
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
  const { enabled, general, generalBurst, search, social, loginIp } = ctx.config.rateLimits;

  /**
   * Guard a request against one or more limiters sharing a key. Each is consumed
   * in order and the first denial wins — so the general guard can layer a tight
   * burst window in front of the generous steady-state window and either one
   * trips the same 429. A denial short-circuits, so the caller's later windows
   * aren't counted while it's already being turned away.
   */
  const guard = (
    limiters: readonly ProgressiveLimiter[],
    keyGenerator: (req: Request) => string,
  ): RequestHandler => {
    return (req, res, next) => {
      if (!enabled) {
        next();
        return;
      }
      const key = keyGenerator(req);
      void (async () => {
        for (const limiter of limiters) {
          const decision = await limiter.consume(key);
          if (!decision.allowed) {
            // The SPA's fetch chokepoint reads Retry-After to drive its toast.
            res.setHeader('Retry-After', String(decision.retryAfterSec));
            next(tooManyRequests(decision.retryAfterSec));
            return;
          }
        }
        next();
      })().catch(next);
    };
  };

  const loginLimiter = createProgressiveLimiter(ctx.redis, 'login_ip', loginIp);
  const generalLimiter = createProgressiveLimiter(ctx.redis, 'general', general);
  // Short-window burst dimension (owner report #202): a page-reload flood fires
  // far more requests in a few seconds than the 15-min steady-state allowance can
  // notice, so this tighter window trips it. It feeds the SAME escalation ladder
  // (its own namespace, the general ladder + decay) and fronts every /api/v1
  // route, since `general` is mounted app-wide before any per-router limiter.
  const generalBurstLimiter = createProgressiveLimiter(ctx.redis, 'general_burst', generalBurst);
  const searchLimiter = createProgressiveLimiter(ctx.redis, 'search', search);
  const socialLimiter = createProgressiveLimiter(ctx.redis, 'social', social);

  return {
    login: guard([loginLimiter], keyByIp),
    general: guard([generalBurstLimiter, generalLimiter], keyByUserOrIp),
    // Admin endpoints share the general schedule (§10); a distinct namespace
    // keeps their counter independent of a co-located user's general traffic.
    admin: guard([createProgressiveLimiter(ctx.redis, 'admin', general)], keyByUserOrIp),
    search: guard([searchLimiter], keyByUserOrIp),
    // Friend-request creation, per user — blunts bulk email→username probing (§6.9).
    social: guard([socialLimiter], keyByUserOrIp),
  };
}
