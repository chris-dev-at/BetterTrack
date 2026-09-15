import type { Redis } from 'ioredis';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DomainEvent } from '../events/types';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { createHarnessRegistry, liveHarnesses } from '../testing/harnessRegistry';

/**
 * Harness lifecycle (#1914 — the release itself; #1936 — who calls it).
 *
 * `buildContext` hands the domain event bus its own publisher/subscriber pair
 * (`redis.duplicate()` twice, `http/context.ts`). Nothing closed them, so in
 * integration mode — `vitest.config.integration.ts` runs every file in ONE fork
 * so the harness singletons survive — each `createTestApp()` left two real
 * sockets open until the fork died, and a file like `vaultsE1.test.ts` builds
 * ~8 harnesses.
 *
 * The accounting test below is the regression guard for the whole class: it
 * counts server-side connections, so ANY future per-harness connection
 * `buildContext` forgets to hand back fails it, not just the bus pair.
 *
 * #1936 then made `dispose()` actually get called: 49 `createTestApp(` sites in
 * the slice, one of which disposed. The second half of this file proves the
 * reaper that closes that gap — and, just as importantly, proves it does NOT
 * run per test.
 */

/** A minimal well-formed domain event; publishing it needs a live bus. */
function sampleEvent(): DomainEvent {
  return {
    type: 'quote.updated',
    assetId: '00000000-0000-0000-0000-000000000000',
    occurredAt: new Date().toISOString(),
  };
}

/**
 * The #1936 constraint made concrete: one harness, built in a file-level
 * `beforeAll`, reused across every describe below, and deliberately NEVER
 * disposed. The last test in this file asserts it is still fully usable — so a
 * reaper that ran per test (or per describe) fails here, and the file-teardown
 * reaper releases it at the end without any test's help.
 */
let fileHarness: TestHarness;

beforeAll(async () => {
  fileHarness = await createTestApp();
});

const realRedisUrl = process.env.TEST_REDIS_URL;
const integrationMode = Boolean(realRedisUrl);

/** The event bus's publisher + subscriber duplicates — all a harness opens. */
const CONNECTIONS_PER_HARNESS = 2;

/** The logical DB the integration harness selects (`redis://host:port/<n>`). */
function testRedisDb(): number {
  const index = new URL(realRedisUrl!).pathname.replace(/^\//, '');
  return index === '' ? 0 : Number.parseInt(index, 10);
}

/**
 * Connections against the harness's logical DB, counted server-side. `CLIENT
 * LIST` reports every client on the whole server, so narrowing to our own DB
 * index keeps an unrelated connection to the same container (a dev API, a
 * `redis-cli`) from moving the number under us.
 */
async function countHarnessClients(redis: Redis): Promise<number> {
  const raw = (await redis.call('CLIENT', 'LIST')) as string;
  const marker = ` db=${testRedisDb()} `;
  return raw.split('\n').filter((line) => line.includes(marker)).length;
}

/** Sample until two consecutive reads agree — connects land asynchronously. */
async function stableClientCount(redis: Redis): Promise<number> {
  const deadline = Date.now() + 2_000;
  let previous = await countHarnessClients(redis);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = await countHarnessClients(redis);
    if (next === previous || Date.now() > deadline) return next;
    previous = next;
  }
}

/**
 * Poll briefly for `expected`: QUIT's reply can beat the server's reap of the
 * socket. This cannot hide the leak it guards — a connection that was never
 * handed back does not settle, the window runs out, and the caller still sees
 * the real number.
 */
async function settledClientCount(redis: Redis, expected: number): Promise<number> {
  const deadline = Date.now() + 2_000;
  let count = await countHarnessClients(redis);
  while (count !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    count = await countHarnessClients(redis);
  }
  return count;
}

describe.runIf(integrationMode)('harness lifecycle on real Redis (#1914)', () => {
  it('hands back every connection createTestApp() opened, and keeps the shared client', async () => {
    // The probe harness owns the counting client: in integration mode
    // `ctx.redis` IS the worker-shared singleton, never a per-harness client.
    const probe = await createTestApp();
    try {
      const baseline = await stableClientCount(probe.ctx.redis);

      // Instrument check first: unless a live harness visibly MOVES the
      // number, "no growth after dispose" would pass on a broken counter.
      const live = await createTestApp();
      const during = await settledClientCount(probe.ctx.redis, baseline + CONNECTIONS_PER_HARNESS);
      expect(during).toBe(baseline + CONNECTIONS_PER_HARNESS);

      await live.dispose();
      expect(await settledClientCount(probe.ctx.redis, baseline)).toBe(baseline);

      // …and it must not drift across repeated lifecycles.
      for (let i = 0; i < 3; i += 1) {
        const harness = await createTestApp();
        await harness.dispose();
      }
      expect(await settledClientCount(probe.ctx.redis, baseline)).toBe(baseline);

      // Only harness-owned connections were closed: the shared singleton the
      // next test file depends on is untouched (#1485).
      await expect(probe.ctx.redis.ping()).resolves.toBe('PONG');
    } finally {
      await probe.dispose();
    }
  }, 30_000);

  it('closes the event bus exactly once, however often dispose() is called', async () => {
    const probe = await createTestApp();
    try {
      const baseline = await stableClientCount(probe.ctx.redis);
      const harness = await createTestApp();
      const closeBus = vi.spyOn(harness.ctx.events, 'close');

      await harness.dispose();
      await harness.dispose();

      expect(closeBus).toHaveBeenCalledTimes(1);
      expect(await settledClientCount(probe.ctx.redis, baseline)).toBe(baseline);
      await expect(probe.ctx.redis.ping()).resolves.toBe('PONG');
    } finally {
      await probe.dispose();
    }
  }, 30_000);
});

describe.runIf(!integrationMode)('harness lifecycle on the PGlite path (#1914)', () => {
  it('disposes a RedisMock harness and is idempotent', async () => {
    const harness = await createTestApp();
    const closeBus = vi.spyOn(harness.ctx.events, 'close');

    await expect(harness.dispose()).resolves.toBeUndefined();
    expect(closeBus).toHaveBeenCalledTimes(1);

    // Second dispose is a no-op: it neither throws nor re-closes anything.
    await expect(harness.dispose()).resolves.toBeUndefined();
    expect(closeBus).toHaveBeenCalledTimes(1);
  });

  it('leaves a concurrently-live harness fully usable', async () => {
    const first = await createTestApp();
    const second = await createTestApp();

    try {
      await first.dispose();

      // RedisMock instances share one store per worker; closing the first
      // harness's bus duplicates must not reach the second harness's.
      await expect(second.ctx.redis.ping()).resolves.toBe('PONG');
      await expect(
        second.ctx.events.publish({
          type: 'quote.updated',
          assetId: '00000000-0000-0000-0000-000000000000',
          occurredAt: new Date().toISOString(),
        }),
      ).resolves.toBeUndefined();
    } finally {
      await second.dispose();
    }
  });
});

describe('file-teardown reaper (#1936)', () => {
  /** Harnesses built per test and never disposed — the pattern that leaked. */
  const leaked: TestHarness[] = [];

  describe('a harness built in beforeEach and never disposed', () => {
    beforeEach(async () => {
      leaked.push(await createTestApp());
    });

    it('is live inside its own test', async () => {
      const harness = leaked.at(-1)!;
      await expect(harness.ctx.events.publish(sampleEvent())).resolves.toBeUndefined();
    });

    it('and is STILL live during the next test — the reaper never runs per test', async () => {
      expect(leaked).toHaveLength(2);
      // The previous test's harness would already be closed by an `afterEach`
      // reaper; publishing goes through the bus pair that reaping quits.
      await expect(leaked[0]!.ctx.events.publish(sampleEvent())).resolves.toBeUndefined();
      await expect(leaked[1]!.ctx.events.publish(sampleEvent())).resolves.toBeUndefined();
    });
  });

  it('holds every undisposed harness, and drops the ones that dispose themselves', async () => {
    // The two leaked above plus the file-level harness are all still live.
    const carried = liveHarnesses.liveCount();
    expect(carried).toBeGreaterThanOrEqual(leaked.length + 1);

    const explicit = await createTestApp();
    expect(liveHarnesses.liveCount()).toBe(carried + 1);

    // Explicit dispose() stays the preferred path and leaves the reaper nothing
    // to do; a second call is still a no-op and must not double-count.
    await explicit.dispose();
    expect(liveHarnesses.liveCount()).toBe(carried);
    await explicit.dispose();
    expect(liveHarnesses.liveCount()).toBe(carried);
  });

  it('is installed for this file by the shared vitest setup file', () => {
    // RED without `setupFiles: ['src/testing/setupHarnessReaper.ts']`: the flag
    // is set by the very call that registers the teardown hook, so it cannot be
    // true while the hook is missing.
    expect(liveHarnesses.isReaperInstalled()).toBe(true);
  });

  it('releases every harness registered with it, and hands the connections back', async () => {
    // Drained on a registry of its own so the file-level harness — and the two
    // leaked ones — survive to the end of the file, exactly as the constraint
    // requires. It is the same `reap()` the installed hook calls.
    const registry = createHarnessRegistry();
    expect(registry.isReaperInstalled()).toBe(false);

    const baseline = integrationMode ? await stableClientCount(fileHarness.ctx.redis) : 0;

    const undisposed: TestHarness[] = [];
    for (let i = 0; i < 3; i += 1) {
      const harness = await createTestApp();
      undisposed.push(harness);
      registry.register(harness.dispose);
    }
    expect(registry.liveCount()).toBe(3);

    if (integrationMode) {
      // Instrument check: unless three live harnesses visibly move the number,
      // "back to baseline afterwards" would pass on a broken counter.
      const during = await settledClientCount(
        fileHarness.ctx.redis,
        baseline + 3 * CONNECTIONS_PER_HARNESS,
      );
      expect(during).toBe(baseline + 3 * CONNECTIONS_PER_HARNESS);
    }

    const report = await registry.reap();
    expect(report).toEqual({ reaped: 3, failures: [] });
    expect(registry.liveCount()).toBe(0);

    if (integrationMode) {
      expect(await settledClientCount(fileHarness.ctx.redis, baseline)).toBe(baseline);
      await expect(fileHarness.ctx.redis.ping()).resolves.toBe('PONG');
    }

    // Reaping is what disposed them, so the shared registry lost them too.
    for (const harness of undisposed) {
      await expect(harness.dispose()).resolves.toBeUndefined();
    }
  }, 30_000);

  it('drains the whole set newest-first even when one release throws', async () => {
    const registry = createHarnessRegistry();
    const released: string[] = [];
    const boom = new Error('release failed');

    registry.register(async () => {
      released.push('first');
    });
    registry.register(async () => {
      throw boom;
    });
    registry.register(async () => {
      released.push('third');
    });

    const report = await registry.reap();

    // Newest first, and the thrower did not strand the one registered before it.
    expect(released).toEqual(['third', 'first']);
    expect(report.reaped).toBe(2);
    expect(report.failures).toEqual([boom]);
    expect(registry.liveCount()).toBe(0);

    // The set is emptied before anything is released, so a failed release is
    // never retried by a later reap.
    expect(await registry.reap()).toEqual({ reaped: 0, failures: [] });
  });
});

describe('the beforeAll harness this file never disposes (#1936)', () => {
  it('is still fully usable in the last test of its file', async () => {
    // Everything above built, leaked and reaped harnesses around this one. If
    // any of that reached it, the readiness probe below is the first casualty:
    // it exercises the harness's DB and Redis through its own express app.
    const res = await request(fileHarness.app).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.database.status).toBe('ok');
    expect(res.body.checks.redis.status).toBe('ok');

    // …and the event-bus pair, which is precisely what a release quits.
    await expect(fileHarness.ctx.events.publish(sampleEvent())).resolves.toBeUndefined();

    // Nothing disposed it, so it is still the reaper's to release at teardown.
    expect(liveHarnesses.liveCount()).toBeGreaterThan(0);
  });
});
