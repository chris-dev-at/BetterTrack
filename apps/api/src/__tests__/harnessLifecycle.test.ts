import type { Redis } from 'ioredis';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DomainEvent } from '../events/types';
import { createTestApp, type TestHarness } from '../testing/createTestApp';
import {
  createHarnessRegistry,
  liveHarnesses,
  type HarnessDisposer,
  type SuiteScope,
  type TestScope,
} from '../testing/harnessRegistry';

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
 *
 * #1940 adds the suite level. The file reaper left a floor — the largest single
 * file's own live set — so a `describe` now drains as soon as the runner leaves
 * it, while anything owned by a suite that is still open (or by the file) is
 * untouched. The last third of this file proves both halves of that: the inner
 * suite's `beforeEach` harnesses are gone in the next sibling describe, and the
 * `beforeAll` harness of the describe around them is still serving requests
 * there.
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

// Ordering guard (#1936 review M1): the reaper lives in a file-level `afterAll`
// registered by the shared setup file, and the whole design rests on vitest's
// `sequence.hooks: 'stack'` default running that hook LAST. This file-level
// `afterAll` therefore runs BEFORE the reaper, while the harnesses this file
// deliberately never disposes are still registered. If a vitest default ever
// flips to 'list' (or a config sets it), the reaper drains the registry first
// and this assertion goes red — instead of the reaper silently closing harnesses
// that other files' own teardown still uses.
afterAll(() => {
  expect(liveHarnesses.isReaperInstalled()).toBe(true);
  expect(liveHarnesses.liveCount()).toBeGreaterThan(0);
});

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
    // The file-level harness is always still live here. The two leaked above
    // are not: they belong to the describe that just ended, and the #1940 suite
    // reaper released them on the way out of it (proved below). This test is
    // about register/forget accounting, so it counts from whatever is carried.
    const carried = liveHarnesses.liveCount();
    expect(carried).toBeGreaterThanOrEqual(1);
    expect(leaked).toHaveLength(2);

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

/* ------------------------------------------------------------------------- *
 * #1940 — suite teardown                                                      *
 * ------------------------------------------------------------------------- */

/** A vitest `File` task, as far as the registry's chain walk is concerned. */
function fakeFile(name = 'fake.test.ts'): SuiteScope {
  return { name, filepath: `/fake/${name}` };
}

/** A top-level describe: vitest gives it a `file` but no parent `suite`. */
function fakeSuite(name: string, file: SuiteScope): SuiteScope {
  return { name, file };
}

/** A nested describe: parent through `suite`, root still through `file`. */
function fakeNested(name: string, parent: SuiteScope, file: SuiteScope): SuiteScope {
  return { name, suite: parent, file };
}

/**
 * A registry wired exactly as the setup file wires the real one, but driven by
 * hand: `running` stands in for vitest's `getCurrentTest()`, `startTest()` calls
 * the installed `beforeEach` with the task shape vitest passes, and `endFile()`
 * calls the installed `afterAll`. No PGlite, no Redis — just the attribution and
 * transition rules.
 */
function drivenRegistry() {
  const registry = createHarnessRegistry();
  const released: string[] = [];
  const hooks: {
    beforeEach?: (context: TestScope) => Promise<void>;
    afterAll?: () => Promise<void>;
  } = {};
  let running = false;

  registry.installReaper((fn) => {
    hooks.afterAll = fn;
  });
  registry.installSuiteReaper(
    (fn) => {
      hooks.beforeEach = fn;
    },
    () => running,
  );

  return {
    registry,
    released,
    /** Register a harness. `failWith` makes its release throw, after recording. */
    add(label: string, failWith?: Error): HarnessDisposer {
      const dispose: HarnessDisposer = async () => {
        released.push(label);
        registry.forget(dispose);
        if (failWith) throw failWith;
      };
      registry.register(dispose);
      return dispose;
    },
    /** Outside a test: a `beforeAll`/`afterAll` body. */
    betweenTests(): void {
      running = false;
    },
    /** Start a test in `suite`, the way vitest starts one. */
    async startTest(suite: SuiteScope, file: SuiteScope, concurrent = false): Promise<void> {
      running = true;
      await hooks.beforeEach!({
        task: { suite: suite === file ? undefined : suite, file, concurrent },
      });
    },
    /** Run the file-teardown hook. */
    async endFile(): Promise<void> {
      await hooks.afterAll!();
    },
  };
}

describe('suite-teardown attribution and transitions (#1940)', () => {
  it('gives a beforeAll harness the outermost suite that opened, and a test its own suite', async () => {
    const file = fakeFile();
    const a = fakeSuite('A', file);
    const b = fakeSuite('B', file);
    const driven = drivenRegistry();

    // The file's own beforeAll, before anything has opened.
    driven.betweenTests();
    driven.add('file-beforeAll');

    await driven.startTest(a, file);
    driven.add('a1');
    await driven.startTest(a, file);
    driven.add('a2');

    // Nothing has closed yet, so nothing has been released.
    expect(driven.released).toEqual([]);
    expect(driven.registry.liveCount()).toBe(3);

    // A ends, B opens and builds its own beforeAll harness.
    driven.betweenTests();
    driven.add('b-beforeAll');
    await driven.startTest(b, file);

    // A's two are gone, newest first. The file-level harness is NOT: at the
    // start of a file the outermost suite that opened is the file itself.
    expect(driven.released).toEqual(['a2', 'a1']);
    expect(driven.registry.liveCount()).toBe(2);

    // …and B's own beforeAll harness survives its own tests.
    driven.add('b1');
    await driven.startTest(b, file);
    expect(driven.released).toEqual(['a2', 'a1']);

    await driven.endFile();
    expect(driven.released).toEqual(['a2', 'a1', 'b1', 'b-beforeAll', 'file-beforeAll']);
  });

  it('keeps an outer suite alive while its inner suites come and go', async () => {
    const file = fakeFile();
    const outer = fakeSuite('outer', file);
    const inner = fakeNested('inner', outer, file);
    const sibling = fakeNested('sibling', outer, file);
    const later = fakeSuite('later', file);
    const driven = drivenRegistry();

    // Open the file on a throwaway suite so `outer` is not the first thing that
    // opens — otherwise its beforeAll harness is attributed to the file.
    const first = fakeSuite('first', file);
    await driven.startTest(first, file);

    driven.betweenTests();
    driven.add('outer-beforeAll');
    await driven.startTest(inner, file);
    driven.add('inner1');
    await driven.startTest(inner, file);
    driven.add('inner2');

    // Into a sibling of `inner`, still inside `outer`.
    await driven.startTest(sibling, file);
    expect(driven.released).toEqual(['inner2', 'inner1']);

    // Back up to the outer level itself: `sibling` closes, `outer` does not.
    await driven.startTest(outer, file);
    expect(driven.registry.liveCount()).toBe(1);

    // Only leaving `outer` releases its beforeAll harness.
    await driven.startTest(later, file);
    expect(driven.released).toEqual(['inner2', 'inner1', 'outer-beforeAll']);
    expect(driven.registry.liveCount()).toBe(0);
  });

  it('reads the suite off the running task, not the hook argument vitest drops', async () => {
    // Vitest wraps every `beforeEach` callback in `withFixtures`, which
    // re-invokes it as `fn(context)` — the suite passed as the second argument
    // never arrives. Driving the installed hook with a context whose `task`
    // carries the chain is the only thing that must work.
    const file = fakeFile();
    const a = fakeSuite('A', file);
    const b = fakeSuite('B', file);
    const driven = drivenRegistry();

    await driven.startTest(a, file);
    driven.add('a1');
    await driven.startTest(b, file);

    expect(driven.released).toEqual(['a1']);
  });

  it('switches itself off for a file with concurrent tests', async () => {
    const file = fakeFile();
    const a = fakeSuite('A', file);
    const b = fakeSuite('B', file);
    const driven = drivenRegistry();

    await driven.startTest(a, file, true);
    driven.add('a1');
    await driven.startTest(b, file);

    // Chains of concurrent tests interleave, so a transition proves nothing.
    // Nothing is released until the file backstop runs.
    expect(driven.released).toEqual([]);
    await driven.endFile();
    expect(driven.released).toEqual(['a1']);
  });

  it('carries a failed transition release to file teardown instead of the innocent test', async () => {
    const file = fakeFile();
    const a = fakeSuite('A', file);
    const b = fakeSuite('B', file);
    const boom = new Error('release failed');
    const driven = drivenRegistry();

    await driven.startTest(a, file);
    driven.add('a1', boom);
    driven.add('a2');

    // The transition drains the whole suite and does not throw at the test
    // whose beforeEach happened to trigger it…
    await expect(driven.startTest(b, file)).resolves.toBeUndefined();
    expect(driven.released).toEqual(['a2', 'a1']);

    // …the file's teardown reports it instead, and it is never retried.
    await expect(driven.endFile()).rejects.toThrow(/1 of 2 undisposed harness/);
    await expect(driven.endFile()).resolves.toBeUndefined();
  });

  it('is installed for this file by the shared vitest setup file', () => {
    // RED without `installSuiteReaper` in `setupHarnessReaper.ts`: the flag is
    // set by the very call that registers the hook.
    expect(liveHarnesses.isSuiteReaperInstalled()).toBe(true);
  });
});

describe('a describe that leaks harnesses, and the one around it (#1940)', () => {
  /**
   * Built in THIS describe's `beforeAll` and never disposed. It must survive
   * every inner suite below — a suite reaper that released it would take the
   * readiness probe in the sibling describe down with it.
   */
  let groupHarness: TestHarness;
  let groupClose: MockInstance<() => Promise<void>>;
  /** Connections on the harness DB with only `groupHarness` live (real Redis). */
  let groupBaseline = 0;

  /** One per test of the inner describe, never disposed — the leaking pattern. */
  const innerHarnesses: TestHarness[] = [];
  const innerCloses: MockInstance<() => Promise<void>>[] = [];

  beforeAll(async () => {
    groupHarness = await createTestApp();
    groupClose = vi.spyOn(groupHarness.ctx.events, 'close');
    if (integrationMode) groupBaseline = await stableClientCount(groupHarness.ctx.redis);
  });

  describe('the inner describe', () => {
    beforeEach(async () => {
      const harness = await createTestApp();
      innerHarnesses.push(harness);
      innerCloses.push(vi.spyOn(harness.ctx.events, 'close'));
    });

    it('has its own live harness', async () => {
      await expect(
        innerHarnesses.at(-1)!.ctx.events.publish(sampleEvent()),
      ).resolves.toBeUndefined();
      expect(groupClose).not.toHaveBeenCalled();
    });

    it("still has the previous test's harness — the reaper is never per test", async () => {
      expect(innerHarnesses).toHaveLength(2);
      expect(innerCloses[0]!).not.toHaveBeenCalled();
      await expect(innerHarnesses[0]!.ctx.events.publish(sampleEvent())).resolves.toBeUndefined();
      await expect(innerHarnesses[1]!.ctx.events.publish(sampleEvent())).resolves.toBeUndefined();
    });

    it('and the third, so the suite is holding three at its peak', async () => {
      expect(innerHarnesses).toHaveLength(3);
      for (const close of innerCloses) expect(close).not.toHaveBeenCalled();
      if (integrationMode) {
        // Instrument check: unless the three live harnesses visibly move the
        // number, "back to baseline afterwards" would pass on a broken counter.
        const during = await settledClientCount(
          groupHarness.ctx.redis,
          groupBaseline + 3 * CONNECTIONS_PER_HARNESS,
        );
        expect(during).toBe(groupBaseline + 3 * CONNECTIONS_PER_HARNESS);
      }
    });
  });

  describe('a later sibling describe', () => {
    it("finds the inner describe drained and this describe's own harness untouched", async () => {
      // RED without the suite reaper: all three are still live here, and only
      // the file's teardown would ever release them.
      expect(innerHarnesses).toHaveLength(3);
      for (const close of innerCloses) expect(close).toHaveBeenCalledTimes(1);

      if (integrationMode) {
        expect(await settledClientCount(groupHarness.ctx.redis, groupBaseline)).toBe(groupBaseline);
      }

      // The harness of the describe AROUND the drained one is untouched and
      // still fully usable: DB and Redis through its own express app, plus the
      // event-bus pair that a release quits.
      expect(groupClose).not.toHaveBeenCalled();
      const res = await request(groupHarness.app).get('/api/v1/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.checks.database.status).toBe('ok');
      expect(res.body.checks.redis.status).toBe('ok');
      await expect(groupHarness.ctx.events.publish(sampleEvent())).resolves.toBeUndefined();
    }, 30_000);
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
