import { afterAll, beforeEach } from 'vitest';
import { getCurrentTest } from 'vitest/suite';

import { liveHarnesses } from './harnessRegistry';
import { installLoopbackOnlyListen } from './loopbackOnlyListen';

/**
 * Shared vitest setup file (#1936, #1940, #1998) — listed in `setupFiles` of
 * both `vitest.config.ts` and `vitest.config.integration.ts`.
 *
 * Setup files are evaluated once per test file, in that file's module graph and
 * before its own code, so these two calls install hooks on each test file's root
 * suite:
 *
 * - `installReaper(afterAll)` — the FILE backstop. At file teardown every
 *   harness `createTestApp()` built and nothing disposed is released.
 *   Registering from here is what makes it run last: with Vitest's default
 *   `sequence.hooks: "stack"`, `afterAll` hooks run in reverse registration
 *   order, and this one is registered first.
 *
 * - `installSuiteReaper(beforeEach, …)` — SUITE teardown. The same ordering
 *   works the other way round for `beforeEach`, which runs parent-first: this
 *   hook is the first to run for every test, and by comparing the running test's
 *   suite chain with the previous test's it releases the harnesses of every
 *   describe the runner has just left. The chain comes off the running task,
 *   not the hook's second argument: Vitest wraps every `beforeEach` callback in
 *   `withFixtures`, which re-invokes it with the context alone, so the suite
 *   argument never arrives. `getCurrentTest` is Vitest's own accounting of
 *   whether a test (or one of its per-test hooks) is running; the registry uses
 *   it to tell a `beforeEach` harness, which belongs to the suite around it,
 *   from a `beforeAll` harness, which does not.
 *
 * Explicit `dispose()` stays preferred — a harness that released itself is
 * already out of the registry, and neither reaper finds anything to do.
 *
 * Everything else lives in `harnessRegistry.ts`, including both hook bodies —
 * the flags `liveHarnesses.isReaperInstalled()` / `isSuiteReaperInstalled()`
 * are set by the same calls that register the hooks, so
 * `harnessLifecycle.test.ts` can prove the wiring without this file being able
 * to lie about it.
 *
 * The third call is not a hook at all but a process-wide transport guarantee
 * (#1998): every host-less `listen()` — supertest opens one per request — binds
 * `127.0.0.1` instead of the IPv6 wildcard, so a resident process squatting an
 * ephemeral port on the IPv4 loopback can no longer be handed requests meant for
 * the app under test. `loopbackOnlyListen.ts` carries the full mechanism; doing
 * it from here means both vitest configs get it, before any test module loads.
 */
liveHarnesses.installReaper(afterAll);
liveHarnesses.installSuiteReaper(beforeEach, () => getCurrentTest() !== undefined);
installLoopbackOnlyListen();
