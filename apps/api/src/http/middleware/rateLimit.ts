import type { Request, RequestHandler } from 'express';

import type { RequestCostKey } from '../../config/env';
import { tooManyRequests } from '../../errors';
import {
  createProgressiveLimiter,
  type ProgressiveLimiter,
  type ProgressiveSchedule,
} from '../../services/security/progressiveLimiter';
import type { AppContext } from '../context';

/**
 * The two limiter key spaces, derived in ONE place so nothing reconstructs them
 * by hand. Anything that needs to read or clear a limiter's Redis state for a
 * principal composes `progressiveKeys(namespace, limiterKeyForUser(id))` rather
 * than pasting the prefix.
 */
export const limiterKeyForUser = (userId: string): string => `u:${userId}`;
export const limiterKeyForIp = (ip: string): string => `ip:${ip}`;

const keyByIp = (req: Request): string => limiterKeyForIp(req.ip ?? 'unknown');

/**
 * Authenticated traffic is metered PER USER; only an anonymous caller falls back
 * to its address (§10). Both cookie sessions and bearer principals resolve
 * `req.authUser` before the limiters mount (see `app.ts` — bearer → session →
 * general), so every signed-in request lands in its own bucket:
 *
 *   * two accounts behind one address (a household, an office, CGNAT) never
 *     share a counter or a cooldown — one of them cannot lock the other out;
 *   * one account across two addresses (phone on cellular + laptop on wifi)
 *     DOES share its counter, which is the point: the budget belongs to the
 *     user, not to the network path.
 *
 * The `u:` / `ip:` prefixes keep the two key spaces disjoint by construction, so
 * no user id can ever be confused with an address inside a Redis namespace.
 */
const keyByUserOrIp = (req: Request): string =>
  req.authUser ? limiterKeyForUser(req.authUser.id) : keyByIp(req);

export interface RateLimiters {
  login: RequestHandler;
  /** Public native Google LINK callbacks, isolated from the shared login-IP budget. */
  googleLinkCallback: RequestHandler;
  general: RequestHandler;
  /**
   * Cost-metered guard for one expensive endpoint (§10 COST TABLE, #1643).
   * Mounted per route with the endpoint's declared weight KEY — the units
   * themselves live in `config/env.ts` and are never inlined at a call site.
   */
  cost: (endpoint: RequestCostKey) => RequestHandler;
  /** Per-API-key limiter (bearer requests only; a no-op for cookie sessions). */
  apiKey: RequestHandler;
  admin: RequestHandler;
  search: RequestHandler;
  social: RequestHandler;
  /** Authenticated feedback capture, per author. */
  feedback: RequestHandler;
  /** Support-thread replies, per author — independent of the capture budget. */
  feedbackThread: RequestHandler;
  /** Paranoid vault writes, per user (§13.5 V5-P13). */
  vault: RequestHandler;
  /** Paranoid vault reads, per user, isolated from the write counter/cooldown. */
  vaultRead: RequestHandler;
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
  const {
    enabled,
    general,
    generalBurst,
    expensive,
    requestCosts,
    search,
    social,
    feedback,
    feedbackThread,
    vault,
    vaultRead,
    loginIp,
    apiKey,
  } = ctx.config.rateLimits;

  /**
   * Guard a request against one or more limiters sharing a key. Each is consumed
   * in order and the first denial wins — so the general guard can layer a tight
   * burst window in front of the generous steady-state window and either one
   * trips the same 429. A denial short-circuits, so the caller's later windows
   * aren't counted while it's already being turned away.
   *
   * `cost` is the number of allowance UNITS one request spends (§10 COST
   * TABLE); it defaults to 1, which is the plain request-count behaviour every
   * limiter but `expensive` uses.
   */
  const guard = (
    limiters: readonly ProgressiveLimiter[],
    keyGenerator: (req: Request) => string,
    cost = 1,
  ): RequestHandler => {
    return (req, res, next) => {
      if (!enabled) {
        next();
        return;
      }
      const key = keyGenerator(req);
      void (async () => {
        for (const limiter of limiters) {
          const decision = await limiter.consume(key, cost);
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

  /**
   * Per-key guard for bearer requests: keyed by `req.apiKey.id` and skipped
   * entirely for cookie sessions, so a personal token gets its own automation
   * budget (§6.13) independent of the per-user `general` counter.
   *
   * The (limit, window) come from the key's resolved rate tier (§13.5 V5-P10),
   * carried on `req.apiKey.rateLimit`; the escalation ladder + decay stay the
   * shared `apiKey` config so tiers only tune the steady-state allowance. A key
   * with no resolved tier (OAuth grants, or a key whose tier could not resolve)
   * falls back to the base schedule verbatim. Keyed by key/grant id, so a key
   * over its own limit is turned away without touching any other key's counter.
   */
  const apiKeyGuard = (baseSchedule: ProgressiveSchedule): RequestHandler => {
    return (req, res, next) => {
      if (!enabled || !req.apiKey) {
        next();
        return;
      }
      const tier = req.apiKey.rateLimit;
      const schedule: ProgressiveSchedule = tier
        ? { ...baseSchedule, windowSec: tier.windowSec, limit: tier.limit }
        : baseSchedule;
      const limiter = createProgressiveLimiter(ctx.redis, 'api_key', schedule);
      void (async () => {
        const decision = await limiter.consume(req.apiKey!.id);
        if (!decision.allowed) {
          res.setHeader('Retry-After', String(decision.retryAfterSec));
          next(tooManyRequests(decision.retryAfterSec));
          return;
        }
        next();
      })().catch(next);
    };
  };

  const loginLimiter = createProgressiveLimiter(ctx.redis, 'login_ip', loginIp);
  const googleLinkCallbackLimiter = createProgressiveLimiter(
    ctx.redis,
    'google_link_callback_ip',
    loginIp,
  );
  const generalLimiter = createProgressiveLimiter(ctx.redis, 'general', general);
  // Short-window burst dimension (owner report #202): a page-reload flood fires
  // far more requests in a few seconds than the 15-min steady-state allowance can
  // notice, so this tighter window trips it. It feeds the SAME escalation ladder
  // (its own namespace, the general ladder + decay) and fronts every /api/v1
  // route, since `general` is mounted app-wide before any per-router limiter.
  const generalBurstLimiter = createProgressiveLimiter(ctx.redis, 'general_burst', generalBurst);
  // Cost dimension (#1643): its own namespace, so an endpoint's WORK budget is
  // never spent by — and never spends — the request-count windows above.
  const expensiveLimiter = createProgressiveLimiter(ctx.redis, 'expensive', expensive);
  const searchLimiter = createProgressiveLimiter(ctx.redis, 'search', search);
  const socialLimiter = createProgressiveLimiter(ctx.redis, 'social', social);
  const feedbackLimiter = createProgressiveLimiter(ctx.redis, 'feedback', feedback);
  const feedbackThreadLimiter = createProgressiveLimiter(
    ctx.redis,
    'feedback_thread',
    feedbackThread,
  );
  const vaultLimiter = createProgressiveLimiter(ctx.redis, 'vault', vault);
  const vaultReadLimiter = createProgressiveLimiter(ctx.redis, 'vault_read', vaultRead);

  return {
    login: guard([loginLimiter], keyByIp),
    googleLinkCallback: guard([googleLinkCallbackLimiter], keyByIp),
    general: guard([generalBurstLimiter, generalLimiter], keyByUserOrIp),
    // Cost-metered endpoints (§10 COST TABLE): keyed exactly like `general` —
    // per user, falling back to the address only for anonymous callers — so one
    // account's expensive traffic can never close another's. A route mounts
    // this IN ADDITION to the app-wide `general` guard; whichever dimension
    // runs out first produces the same 429 envelope.
    cost: (endpoint) => guard([expensiveLimiter], keyByUserOrIp, requestCosts[endpoint]),
    apiKey: apiKeyGuard(apiKey),
    // Admin endpoints share the general schedule (§10); a distinct namespace
    // keeps their counter independent of a co-located user's general traffic.
    admin: guard([createProgressiveLimiter(ctx.redis, 'admin', general)], keyByUserOrIp),
    search: guard([searchLimiter], keyByUserOrIp),
    // Friend-request creation, per user — blunts bulk email→username probing (§6.9).
    social: guard([socialLimiter], keyByUserOrIp),
    // Text-only feedback creation is deliberately small-volume: five accepted
    // POST attempts per author/hour before the progressive 429.
    feedback: guard([feedbackLimiter], keyByUserOrIp),
    // Support-thread replies and submitter tombstones, per author — its own
    // namespace and counter, so a spent capture allowance never closes a live
    // conversation (and an owner working through the inbox is never throttled by
    // the anti-spam budget). DELETE rides here rather than on `feedback` so a
    // delete cannot spend the allowance the open-cap 409 asks the submitter to
    // reclaim; see `feedbackRoutes.ts` for the trade-off that buys.
    feedbackThread: guard([feedbackThreadLimiter], keyByUserOrIp),
    // Paranoid vault writes, per user — a modest dedicated write budget (§13.5
    // V5-P13, design §4).
    vault: guard([vaultLimiter], keyByUserOrIp),
    // Vault reads have an independent, larger sync budget. Their counter and
    // cooldown never consume or inherit state from the write namespace.
    vaultRead: guard([vaultReadLimiter], keyByUserOrIp),
  };
}
