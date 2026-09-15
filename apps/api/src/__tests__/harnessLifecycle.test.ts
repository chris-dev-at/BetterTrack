import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { createTestApp } from '../testing/createTestApp';

/**
 * Harness lifecycle (#1914).
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
 */

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
