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
});

describe('progressive limiter — escalation & decay (§10)', () => {
  it('the first over-limit trips the first (short) rung', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    const d = await overflow(limiter, 'ip');
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBe(SCHEDULE.cooldownsSec[0]);
    expect(d.level).toBe(1);
  });

  it('requests while cooling down are rejected without escalating further', async () => {
    const limiter = createProgressiveLimiter(redis, 't', SCHEDULE);
    await overflow(limiter, 'ip'); // level → 1, cooldown armed
    const again = await limiter.consume('ip');
    expect(again.allowed).toBe(false);
    expect(again.retryAfterSec).toBeGreaterThan(0);
    expect(again.level).toBe(1); // still 1 — a blocked retry does not climb
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
    expect(cfg.general.limit).toBeGreaterThanOrEqual(4500);
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
    // A tight short window a reload flood trips fast...
    expect(cfg.generalBurst.windowSec).toBeLessThanOrEqual(15);
    expect(cfg.generalBurst.limit).toBeLessThan(cfg.general.limit);
    // ...yet generous enough to clear a multi-tab refetch burst (3 tabs × ~6
    // endpoints = ~18), and it escalates/decays exactly like the steady state.
    expect(cfg.generalBurst.limit).toBeGreaterThanOrEqual(60);
    expect(cfg.generalBurst.cooldownsSec).toEqual(cfg.general.cooldownsSec);
    expect(cfg.generalBurst.decaySec).toBe(cfg.general.decaySec);
  });
});
