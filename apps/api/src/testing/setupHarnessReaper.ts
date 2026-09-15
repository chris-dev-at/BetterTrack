import { afterAll } from 'vitest';

import { liveHarnesses } from './harnessRegistry';

/**
 * Shared vitest setup file (#1936) — listed in `setupFiles` of both
 * `vitest.config.ts` and `vitest.config.integration.ts`.
 *
 * Setup files are evaluated once per test file, in that file's module graph and
 * before its own code, so this single call installs one `afterAll` on each test
 * file's root suite: at FILE teardown every harness `createTestApp()` built and
 * nothing disposed is released. Explicit `dispose()` stays preferred — a
 * harness that released itself is already out of the registry, and the reaper
 * finds nothing to do.
 *
 * Registering from here (rather than from the test file) is what makes the
 * reaper run last: with Vitest's default `sequence.hooks: "stack"`, `afterAll`
 * hooks run in reverse registration order, and this one is registered first.
 *
 * Everything else lives in `harnessRegistry.ts`, including the hook body — the
 * flag `liveHarnesses.isReaperInstalled()` is set by the same call that
 * registers the hook, so `harnessLifecycle.test.ts` can prove the wiring
 * without this file being able to lie about it.
 */
liveHarnesses.installReaper(afterAll);
