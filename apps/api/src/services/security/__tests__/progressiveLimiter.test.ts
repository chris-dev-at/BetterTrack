import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../config/env';
import {
  createProgressiveLimiter,
  progressiveKeys,
  resetProgressiveLimiter,
  type ProgressiveSchedule,
} from '../progressiveLimiter';

let redis: Redis;

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares one in-memory store across instances; isolate each test.
  await redis.flushall();
});

// Small, fast schedule: 3/window allowance, a 4-rung ladder. Escalation is
// level-driven (not wall-clock), so tiny cooldowns let us assert the ladder
// without waiting — between violations we drop the cooldown key to simulate it
// elapsing, since a caller mid-cooldown is rejected without re-escalating.
const SCHEDULE: ProgressiveSchedule = {
  windowSec: 100,
  limit: 3,
  cooldownsSec: [10, 30, 60, 120],
  decaySec: 900,
};

const overflow = async (limiter: ReturnType<typeof createProgressiveLimiter>, id: string) => {
  for (let i = 0; i < SCHEDULE.limit; i += 1) await limiter.consume(id);
  return limiter.consume(id); // the event that overflows the window
};

const consumeConcurrently = (
  limiter: ReturnType<typeof createProgressiveLimiter>,
  id: string,
  events: number,
) => {
  let release: () => void;
  const start = new Promise<void>((resolve) => {
    release = resolve;
  });
  const decisions = Array.from({ length: events }, async () => {
    await start;
    return limiter.consume(id);
  });
  release!();
  return Promise.all(decisions);
};

describe('progressive limiter — steady state (§10)', () => {
  it('allows every request up to the window limit', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    for (let i = 0; i < SCHEDULE.limit; i += 1) {
      const d = await limiter.consume('ip');
      expect(d.allowed).toBe(true);
      expect(d.retryAfterSec).toBe(0);
      expect(d.level).toBe(0);
    }
  });

  it('allows exactly the limit of synchronized fresh requests without arming state', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    const decisions = await consumeConcurrently(limiter, 'ip', SCHEDULE.limit);
    const keys = progressiveKeys('t', 'ip');

    expect(decisions).toEqual(
      Array.from({ length: SCHEDULE.limit }, () => ({
        allowed: true,
        retryAfterSec: 0,
        level: 0,
        cooldownStarted: false,
      })),
    );
    expect(await redis.get(keys.count)).toBe(String(SCHEDULE.limit));
    expect(await redis.ttl(keys.cooldown)).toBe(-2);
    expect(await redis.get(keys.level)).toBeNull();
  });
});

describe('progressive limiter — escalation & decay (§10)', () => {
  it('the first over-limit trips the first (short) rung', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    const d = await overflow(limiter, 'ip');
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBe(SCHEDULE.cooldownsSec[0]);
    expect(d.level).toBe(1);
    expect(d.cooldownStarted).toBe(true);
  });

  it('requests while cooling down are rejected without escalating further', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    await overflow(limiter, 'ip'); // level → 1, cooldown armed
    const again = await limiter.consume('ip');
    expect(again.allowed).toBe(false);
    expect(again.retryAfterSec).toBeGreaterThan(0);
    expect(again.level).toBe(1); // still 1 — a blocked retry does not climb
    expect(again.cooldownStarted).toBe(false);
  });

  it('keeps a live sub-second cooldown closed and rounds its retry-after up', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    const keys = progressiveKeys('t', 'ip');
    await redis.set(keys.cooldown, '1', 'PX', 900);
    await redis.set(keys.level, '2', 'EX', SCHEDULE.decaySec);

    const cooldownMs = await redis.pttl(keys.cooldown);
    expect(cooldownMs).toBeGreaterThan(0);
    expect(cooldownMs).toBeLessThan(1_000);
    expect(await limiter.peek('ip')).toBe(1);
    expect(await limiter.consume('ip')).toEqual({
      allowed: false,
      retryAfterSec: 1,
      level: 2,
      cooldownStarted: false,
    });
    expect(await redis.get(keys.count)).toBeNull();
    expect(await redis.get(keys.level)).toBe('2');
  });

  it('linearizes a synchronized overflow and keeps concurrent blocked retries out of the transition', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    const keys = progressiveKeys('t', 'ip');
    const firstWindow = await consumeConcurrently(limiter, 'ip', SCHEDULE.limit + 2);
    const transitions = firstWindow.filter((decision) => decision.cooldownStarted);
    const cooldownRetries = firstWindow.filter(
      (decision) => !decision.allowed && !decision.cooldownStarted,
    );

    expect(firstWindow.filter((decision) => decision.allowed)).toHaveLength(SCHEDULE.limit);
    // Exactly one request crosses the fresh-window boundary. The additional
    // over-limit request starts at the same barrier but must observe that live
    // cooldown and be rejected as a retry, rather than applying a second rung.
    expect(transitions).toEqual([
      {
        allowed: false,
        retryAfterSec: SCHEDULE.cooldownsSec[0],
        level: 1,
        cooldownStarted: true,
      },
    ]);
    expect(cooldownRetries).toEqual([
      {
        allowed: false,
        retryAfterSec: expect.any(Number),
        level: 1,
        cooldownStarted: false,
      },
    ]);
    expect(await redis.get(keys.count)).toBeNull();
    expect(await redis.ttl(keys.cooldown)).toBeGreaterThan(0);
    expect(await redis.get(keys.level)).toBe('1');

    const whileCooling = await consumeConcurrently(limiter, 'ip', SCHEDULE.limit + 1);
    expect(whileCooling).toEqual(
      Array.from({ length: SCHEDULE.limit + 1 }, () => ({
        allowed: false,
        retryAfterSec: expect.any(Number),
        level: 1,
        cooldownStarted: false,
      })),
    );
    expect(await redis.get(keys.count)).toBeNull();
    expect(await redis.get(keys.level)).toBe('1');
  });

  it('starts one fresh window after cooldown expiry and advances one rung on its next overflow', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    const keys = progressiveKeys('t', 'ip');
    await consumeConcurrently(limiter, 'ip', SCHEDULE.limit + 1); // level → 1
    await redis.del(keys.cooldown); // simulate the first cooldown expiring

    const nextWindow = await consumeConcurrently(limiter, 'ip', SCHEDULE.limit + 1);
    expect(nextWindow.filter((decision) => decision.allowed)).toHaveLength(SCHEDULE.limit);
    expect(nextWindow.filter((decision) => !decision.allowed)).toEqual([
      {
        allowed: false,
        retryAfterSec: SCHEDULE.cooldownsSec[1],
        level: 2,
        cooldownStarted: true,
      },
    ]);
    expect(await redis.get(keys.count)).toBeNull();
    expect(await redis.get(keys.level)).toBe('2');
  });

  it('can retain an exhausted hard-window counter through cooldown expiry', async () => {
    const hardWindowSchedule: ProgressiveSchedule = {
      ...SCHEDULE,
      retainCountOnViolation: true,
    };
    const limiter = createProgressiveLimiter(redis, 'hard', hardWindowSchedule);
    const keys = progressiveKeys('hard', 'user');

    for (let i = 0; i < hardWindowSchedule.limit; i += 1) {
      expect((await limiter.consume('user')).allowed).toBe(true);
    }
    expect((await limiter.consume('user')).allowed).toBe(false);
    expect(await redis.get(keys.count)).toBe(String(hardWindowSchedule.limit + 1));
    expect(await redis.ttl(keys.count)).toBeGreaterThan(0);

    // The first short cooldown elapsed, but the original counting window did
    // not: the next request must remain rejected rather than gaining a fresh
    // allowance.
    await redis.del(keys.cooldown);
    expect((await limiter.consume('user')).allowed).toBe(false);
    expect(await redis.get(keys.count)).toBe(String(hardWindowSchedule.limit + 2));
    expect(await redis.ttl(keys.count)).toBeGreaterThan(0);

    // Once the retained window and its bounded cooldown expire, a new window
    // starts normally.
    await redis.del(keys.count, keys.cooldown);
    expect((await limiter.consume('user')).allowed).toBe(true);
    expect(await redis.get(keys.count)).toBe('1');
  });

  it('sustained violations climb the ladder and cap at the last rung', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    const keys = progressiveKeys('t', 'ip');
    const seen: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      const d = await overflow(limiter, 'ip');
      seen.push(d.retryAfterSec);
      await redis.del(keys.cooldown); // simulate the cooldown elapsing
    }
    // 10 → 30 → 60 → 120 → 120 → 120 (capped at the last rung).
    expect(seen).toEqual([10, 30, 60, 120, 120, 120]);
  });

  it('arms the escalation level with the decay TTL', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    await overflow(limiter, 'ip');
    const ttl = await redis.ttl(progressiveKeys('t', 'ip').level);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SCHEDULE.decaySec);
  });

  it('resets to the first rung once the level has decayed away', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    const keys = progressiveKeys('t', 'ip');
    const first = await overflow(limiter, 'ip');
    expect(first.retryAfterSec).toBe(SCHEDULE.cooldownsSec[0]);
    expect(first.level).toBe(1);

    // Simulate ~15 min of good behavior: the decaying level key expires (and the
    // cooldown elapses). The next violation starts from the bottom rung again.
    await redis.del(keys.level, keys.cooldown);
    const after = await overflow(limiter, 'ip');
    expect(after.retryAfterSec).toBe(SCHEDULE.cooldownsSec[0]);
    expect(after.level).toBe(1);
  });
});

describe('progressive limiter — per-request cost (§10 COST TABLE, #1643)', () => {
  /** A roomier schedule, so a handful of weighted events fit inside the window. */
  const COST_SCHEDULE: ProgressiveSchedule = { ...SCHEDULE, limit: 30 };

  it('spends exactly `cost` units — a cost-N event equals N cost-1 events', async () => {
    const weighted = createProgressiveLimiter(redis, 'weighted', COST_SCHEDULE);
    const plain = createProgressiveLimiter(redis, 'plain', COST_SCHEDULE);

    await weighted.consume('ip', 7);
    for (let i = 0; i < 7; i += 1) await plain.consume('ip');

    const weightedCount = await redis.get(progressiveKeys('weighted', 'ip').count);
    const plainCount = await redis.get(progressiveKeys('plain', 'ip').count);
    expect(weightedCount).toBe('7');
    expect(plainCount).toBe(weightedCount);
  });

  it('gives the window opened by a weighted event the schedule TTL', async () => {
    const limiter = createProgressiveLimiter(redis, 't', COST_SCHEDULE);
    await limiter.consume('ip', 9);
    // The event that opens the window owns its expiry — a counter left without
    // a TTL would be a permanent budget, never a per-window one.
    const ttl = await redis.ttl(progressiveKeys('t', 'ip').count);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(COST_SCHEDULE.windowSec);
  });

  it('defaults to one unit, and clamps a nonsense cost up to one', async () => {
    const limiter = createProgressiveLimiter(redis, 't', COST_SCHEDULE);
    await limiter.consume('ip'); // default
    await limiter.consume('ip', 0);
    await limiter.consume('ip', -5);
    await limiter.consume('ip', Number.NaN);
    expect(await redis.get(progressiveKeys('t', 'ip').count)).toBe('4');
  });

  it('trips the SAME ladder, decay and Retry-After when the units run out', async () => {
    const limiter = createProgressiveLimiter(redis, 't', COST_SCHEDULE);
    const keys = progressiveKeys('t', 'ip');

    // Three 10-unit events: the third crosses the 30-unit allowance.
    expect((await limiter.consume('ip', 10)).allowed).toBe(true);
    expect((await limiter.consume('ip', 10)).allowed).toBe(true);
    const tripped = await limiter.consume('ip', 10);
    expect(tripped.allowed).toBe(true); // exactly AT the allowance still passes

    const over = await limiter.consume('ip', 10);
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBe(COST_SCHEDULE.cooldownsSec[0]);
    expect(over.level).toBe(1);
    expect(over.cooldownStarted).toBe(true);

    // …and the ladder climbs on the next violation exactly as for counted
    // requests: the cooldown elapsing leaves the escalation level armed.
    await redis.del(keys.cooldown);
    const again = await limiter.consume('ip', 31);
    expect(again.allowed).toBe(false);
    expect(again.retryAfterSec).toBe(COST_SCHEDULE.cooldownsSec[1]);
    expect(again.level).toBe(2);
  });

  it('turns a heavy caller away in fewer requests than a cheap one', async () => {
    const limiter = createProgressiveLimiter(redis, 't', COST_SCHEDULE);
    const requestsUntilDenied = async (id: string, cost: number) => {
      let n = 0;
      for (;;) {
        n += 1;
        const decision = await limiter.consume(id, cost);
        if (!decision.allowed) return n;
      }
    };
    // 30 units / 10 per request = the 4th request is refused; a cost-1 caller
    // gets 30 through. Same limiter, same ladder — bounded by work, not count.
    expect(await requestsUntilDenied('heavy', 10)).toBe(4);
    expect(await requestsUntilDenied('cheap', 1)).toBe(COST_SCHEDULE.limit + 1);
  });
});

describe('progressive limiter — independence (§10)', () => {
  it('tracks distinct callers under one limiter separately', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    await overflow(limiter, 'ip-a'); // a is now cooling down
    const b = await limiter.consume('ip-b');
    expect(b.allowed).toBe(true);
    expect(await limiter.peek('ip-a')).toBeGreaterThan(0);
    expect(await limiter.peek('ip-b')).toBe(0);
  });

  it('tracks per-IP and per-account counters independently (same id, two namespaces)', async () => {
    const perIp = createProgressiveLimiter(redis, 'login_ip', SCHEDULE);
    const perAccount = createProgressiveLimiter(redis, 'login_account', SCHEDULE);
    // Overflow the per-account counter for a user; the per-IP counter (same id
    // string) is untouched.
    await overflow(perAccount, 'user-1');
    expect(await perAccount.peek('user-1')).toBeGreaterThan(0);
    expect(await perIp.peek('user-1')).toBe(0);
    const stillOk = await perIp.consume('user-1');
    expect(stillOk.allowed).toBe(true);
  });

  it('keeps synchronized events for different callers and namespaces isolated', async () => {
    const first = createProgressiveLimiter(redis, 'first', SCHEDULE);
    const second = createProgressiveLimiter(redis, 'second', SCHEDULE);
    const [firstId, otherId, secondNamespace] = await Promise.all([
      consumeConcurrently(first, 'same-id', SCHEDULE.limit + 1),
      consumeConcurrently(first, 'other-id', SCHEDULE.limit),
      consumeConcurrently(second, 'same-id', SCHEDULE.limit + 1),
    ]);

    expect(firstId.filter((decision) => !decision.allowed)).toHaveLength(1);
    expect(otherId.every((decision) => decision.allowed)).toBe(true);
    expect(secondNamespace.filter((decision) => !decision.allowed)).toHaveLength(1);
    expect(await first.peek('same-id')).toBeGreaterThan(0);
    expect(await first.peek('other-id')).toBe(0);
    expect(await second.peek('same-id')).toBeGreaterThan(0);
  });
});

describe('progressive limiter — peek & reset (§10)', () => {
  it('peek reports remaining cooldown without counting the request', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    await limiter.consume('ip'); // count = 1 of 3
    for (let i = 0; i < 10; i += 1) expect(await limiter.peek('ip')).toBe(0);
    // Two more consumes are still within the allowance — peek never advanced it.
    expect((await limiter.consume('ip')).allowed).toBe(true);
    expect((await limiter.consume('ip')).allowed).toBe(true);
  });

  it('reset clears cooldown, count and level', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    await overflow(limiter, 'ip');
    expect(await limiter.peek('ip')).toBeGreaterThan(0);
    await limiter.reset('ip');
    expect(await limiter.peek('ip')).toBe(0);
    expect((await limiter.consume('ip')).allowed).toBe(true);
  });

  it('resetProgressiveLimiter clears state by namespace without a schedule', async () => {
    const limiter = createProgressiveLimiter(redis, 'login_account', SCHEDULE);
    await overflow(limiter, 'user-1');
    await resetProgressiveLimiter(redis, 'login_account', 'user-1');
    expect(await limiter.peek('user-1')).toBe(0);
  });
});

describe('progressive limiter — configured schedules meet §10', () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'test-secret-value-1234',
    APP_ORIGIN: 'http://localhost:5173',
  }).rateLimits;

  it('general: first over-limit is 10–30 s, escalating to a 10 min cap', () => {
    expect(cfg.general.cooldownsSec[0]).toBeGreaterThanOrEqual(10);
    expect(cfg.general.cooldownsSec[0]).toBeLessThanOrEqual(30);
    expect(cfg.general.cooldownsSec.at(-1)).toBe(600);
    // A FLOOR, not the value: the steady-state allowance must clear the
    // modelled worst realistic 15 minutes for one user with two tabs (1576
    // requests) by 3× (§16, 2026-09-02). The exact number is pinned in
    // `config/__tests__/rateLimitTable.test.ts`.
    expect(cfg.general.limit).toBeGreaterThanOrEqual(1576 * 3);
  });

  it('login is stricter: ~10 account failures → 30 s, escalating to 10 min+', () => {
    expect(cfg.loginAccount.limit).toBeLessThanOrEqual(10);
    expect(cfg.loginAccount.cooldownsSec[0]).toBe(30);
    expect(cfg.loginAccount.cooldownsSec.at(-1)).toBeGreaterThanOrEqual(600);
    expect(cfg.loginIp.cooldownsSec[0]).toBe(30);
  });

  it('escalation decays after ~15 min of good behavior', () => {
    expect(cfg.general.decaySec).toBe(15 * 60);
    expect(cfg.loginAccount.decaySec).toBe(15 * 60);
  });

  it('general burst window is short and tight but feeds the SAME ladder (#202)', () => {
    // A SHORT window, so a reload flood trips it long before the 15-minute
    // steady state notices. Widened from 10 s to 30 s on 2026-09-02 (§16): the
    // ceiling this bound used to protect — 60 requests — was smaller than the
    // app's own cold load, so the window was not catching floods, it was
    // catching page loads. A wider window at a higher rate raises SPIKE
    // tolerance without raising the sustained rate as far, which is the shape
    // of the real traffic; a minute or more would stop being a burst dimension
    // at all and start duplicating the steady-state window.
    expect(cfg.generalBurst.windowSec).toBeLessThanOrEqual(30);
    expect(cfg.generalBurst.limit).toBeLessThan(cfg.general.limit);
    // ...yet generous enough to clear the modelled normal-use bar — two tabs
    // cold-loading a widget board, a navigation and a search, 188 requests — by
    // 3×, and it escalates/decays exactly like the steady state.
    expect(cfg.generalBurst.limit).toBeGreaterThanOrEqual(188 * 3);
    expect(cfg.generalBurst.cooldownsSec).toEqual(cfg.general.cooldownsSec);
    expect(cfg.generalBurst.decaySec).toBe(cfg.general.decaySec);
  });
});
