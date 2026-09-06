import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { createProblemDropTally } from '../problemDropTally';

/**
 * The cross-process drop tally (§13.5 V5-P2 arc (d), #1847).
 *
 * `inWindow` is published to the admin as "captures the rate cap refused in the
 * CURRENT window" and is summed with the capture service's genuinely per-window
 * counter. It used to be one key whose TTL was refreshed on every drop, so
 * under a SUSTAINED storm — the only situation it exists for — the key never
 * expired and a six-hour cumulative total was rendered as a one-minute figure.
 */
describe('problem drop tally', () => {
  const WINDOW_MS = 60_000;
  let redis: Redis;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
  });

  const tallyAt = (clock: () => number) =>
    createProblemDropTally(redis, 'worker', { windowMs: WINDOW_MS, now: clock });

  it('reports only the current window, while the total keeps accumulating', async () => {
    let clock = 0;
    const tally = tallyAt(() => clock);

    // One drop per second for three windows straight — sustained pressure.
    for (let second = 0; second < 180; second += 1) {
      clock = second * 1000;
      tally.record('job', 'kind-budget');
    }
    await tally.settled();

    // Mid-storm the operator sees THIS window's rate (60 refusals/minute), not
    // the 180 it has refused since the storm began.
    const during = await tally.read();
    expect(during.inWindow).toBe(60);
    expect(during.total).toBe(180);

    // The storm stops: the next window reports zero refusals of its own, and
    // the retained total still says how big the incident was.
    clock = 180_000;
    const after = await tally.read();
    expect(after.inWindow).toBe(0);
    expect(after.total).toBe(180);
  });

  it('never lets one window count another window’s refusals', async () => {
    let clock = 0;
    const tally = tallyAt(() => clock);

    tally.record('job', 'kind-budget');
    tally.record('job', 'kind-budget');
    // A drop in the very last millisecond of the window belongs to that window.
    clock = WINDOW_MS - 1;
    tally.record('provider', 'kind-budget');
    await tally.settled();
    expect((await tally.read()).inWindow).toBe(3);

    // One millisecond later a new window has started, and it is empty.
    clock = WINDOW_MS;
    expect((await tally.read()).inWindow).toBe(0);
    tally.record('job', 'tracking-capacity');
    await tally.settled();
    expect(await tally.read()).toEqual({ inWindow: 1, total: 4 });
  });

  it('keeps a window bucket on a TTL that its own drops cannot extend', async () => {
    let clock = 0;
    const tally = tallyAt(() => clock);

    tally.record('job', 'kind-budget');
    await tally.settled();
    const [key] = await redis.keys('problems:drops:worker:window:*');
    expect(key).toBeDefined();
    const fresh = await redis.ttl(key!);

    // Late drops into the same bucket re-state the SAME deadline rather than
    // pushing it out: this is what turned the counter immortal under load.
    clock = WINDOW_MS - 10_000;
    tally.record('job', 'kind-budget');
    await tally.settled();
    const late = await redis.ttl(key!);
    expect(late).toBeLessThan(fresh);
    expect(late).toBeLessThanOrEqual(15);
  });

  it('degrades to zeroes when the tally is unreadable', async () => {
    const broken = {
      mget: async () => {
        throw new Error('redis down');
      },
    } as unknown as Redis;
    const logger = { warn: () => {} };
    const tally = createProblemDropTally(broken, 'worker', { logger: logger as never });

    expect(await tally.read()).toEqual({ inWindow: 0, total: 0 });
  });
});
