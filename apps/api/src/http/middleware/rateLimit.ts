import type { Request } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore, type SendCommandFn } from 'rate-limit-redis';

import { tooManyRequests } from '../../errors';
import type { AppContext } from '../context';

const keyByIp = (req: Request): string => req.ip ?? 'unknown';
const keyByUserOrIp = (req: Request): string => req.authUser?.id ?? req.ip ?? 'unknown';

export interface RateLimiters {
  login: RateLimitRequestHandler;
  general: RateLimitRequestHandler;
  admin: RateLimitRequestHandler;
  search: RateLimitRequestHandler;
}

/**
 * Redis-backed rate limits (PROJECTPLAN.md §10). Disabled under test (skip) so
 * the limiter — and its Redis store — never runs against the in-memory mock.
 */
export function createRateLimiters(ctx: AppContext): RateLimiters {
  const enabled = ctx.config.rateLimits.enabled;

  const sendCommand: SendCommandFn = (...args: string[]) =>
    ctx.redis.call(...(args as [string, ...string[]])) as unknown as ReturnType<SendCommandFn>;

  const make = (windowMs: number, limit: number, keyGenerator: (req: Request) => string) =>
    rateLimit({
      windowMs,
      limit,
      keyGenerator,
      standardHeaders: true,
      legacyHeaders: false,
      validate: false,
      skip: () => !enabled,
      handler: (_req, _res, next) => next(tooManyRequests()),
      // RedisStore loads its Lua scripts eagerly on construction, so only build
      // it when limiting is on. Disabled (tests) falls back to the unused
      // in-memory store. A fresh store per limiter keeps their counters separate.
      store: enabled ? new RedisStore({ sendCommand }) : undefined,
    });

  const { loginPerMinutePerIp, generalPer15MinPerUser, adminPer15Min, searchPerMinutePerUser } =
    ctx.config.rateLimits;
  return {
    login: make(60_000, loginPerMinutePerIp, keyByIp),
    general: make(15 * 60_000, generalPer15MinPerUser, keyByUserOrIp),
    admin: make(15 * 60_000, adminPer15Min, keyByUserOrIp),
    search: make(60_000, searchPerMinutePerUser, keyByUserOrIp),
  };
}
