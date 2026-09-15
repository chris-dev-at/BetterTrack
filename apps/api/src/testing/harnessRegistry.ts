/**
 * Live-harness registry and the file-teardown reaper (#1936).
 *
 * `createTestApp()`'s `dispose()` became correct in #1914 — it hands back the
 * two Redis connections `buildContext` opens for the domain event bus — but
 * across the integration slice there are 49 `createTestApp(` sites and exactly
 * one ordinary test that calls `dispose()`. Most calls sit in a `beforeEach`,
 * so a 65-test file builds 65 harnesses and releases none, and the slice peaked
 * at ~670 connections on the harness's Redis DB.
 *
 * So the harness registers itself here instead, and a shared vitest setup file
 * (`setupHarnessReaper.ts`, wired into both configs' `setupFiles`) installs the
 * reaper below as an `afterAll` on the test file's root suite.
 *
 * ## Why FILE teardown, never per test
 *
 * A harness built in `beforeAll` and reused by every test in its file is a
 * legitimate, common pattern here. An `afterEach` reaper would close its event
 * bus after the first test and every later test in that file would fail. The
 * reaper therefore runs exactly once per file, after everything else.
 *
 * It really is last: Vitest 3 defaults `sequence.hooks` to `"stack"`, so
 * `afterAll` hooks run in reverse registration order — and setup files are
 * evaluated before the test file, which makes the reaper's hook the first
 * registered and therefore the last to run. A file's own `afterAll` that still
 * uses its harness is untouched.
 *
 * ## Why a strong Set, and why disposers rather than harnesses
 *
 * A `WeakRef` would be collectable exactly in the case this exists for — a
 * harness the test file dropped without disposing — and a collected ref cannot
 * be reaped, so the registry holds strong references.
 *
 * What it holds is the disposer, not the harness. A closure created inside
 * `createTestApp` shares that function's scope, so retaining one would pin the
 * whole harness — express app, router tree, every service — until file
 * teardown; a 65-harness file would hold 65 of them at once, on top of the
 * PGlite instance each worker already carries. `createTestApp` therefore builds
 * its disposer from a module-level factory that captures only the event bus and
 * the harness-owned Redis, leaving the rest collectable while the file runs.
 *
 * ## Scope
 *
 * Vitest re-evaluates the module graph per test file (that is why the PGlite
 * instance in `createTestApp.ts` lives on `globalThis`), so this set holds the
 * harnesses of the file being torn down. Even where a module graph is shared,
 * the accounting holds: everything an earlier file created was already reaped
 * at that file's teardown.
 */

/** A harness's terminal, idempotent release (`TestHarness.dispose`). */
export type HarnessDisposer = () => Promise<void>;

/** Vitest's `afterAll`, narrowed to what {@link HarnessRegistry.installReaper} uses. */
export type RegisterAfterAll = (fn: () => Promise<void>, timeoutMs?: number) => void;

export interface HarnessReapReport {
  /** Harnesses the reaper had to release because nothing disposed them. */
  reaped: number;
  /**
   * Errors thrown by a disposer. The reaper always drains the whole set, so one
   * broken harness cannot strand the others' connections; the setup file turns
   * a non-empty list into a failed teardown rather than swallowing it.
   */
  failures: unknown[];
}

export interface HarnessRegistry {
  /** Record a live harness. Called by `createTestApp` for every harness it builds. */
  register(dispose: HarnessDisposer): void;
  /** Drop a harness that released itself. Called by the disposer, so an explicit
   * `dispose()` leaves nothing for the reaper to do. */
  forget(dispose: HarnessDisposer): void;
  /** Harnesses created and not yet disposed. */
  liveCount(): number;
  /**
   * Release every live harness, newest first, and empty the registry. Safe to
   * call on an empty registry, and idempotent by construction: the set is
   * snapshotted and cleared before the first disposer runs, and each disposer
   * is itself terminal.
   */
  reap(): Promise<HarnessReapReport>;
  /** Install {@link reap} as a file-teardown hook. The setup file's only job. */
  installReaper(registerAfterAll: RegisterAfterAll): void;
  /**
   * Whether {@link installReaper} ran — i.e. whether this file loaded the shared
   * setup file. Set by the same call that registers the hook, so it cannot
   * report a reaper that was never wired up.
   */
  isReaperInstalled(): boolean;
}

/**
 * Generous bound for the teardown hook: a file that leaked 60+ harnesses does
 * 120 sequential QUITs on its way out, and the integration config inherits
 * Vitest's 10 s hook default.
 */
const REAP_TIMEOUT_MS = 30_000;

export function createHarnessRegistry(): HarnessRegistry {
  const live = new Set<HarnessDisposer>();
  let reaperInstalled = false;

  async function reap(): Promise<HarnessReapReport> {
    // Snapshot and clear before disposing anything: each disposer calls
    // `forget()` on its way out, and a disposer that throws must not be left
    // behind for a later reap to retry.
    const pending = [...live].reverse();
    live.clear();

    const failures: unknown[] = [];
    let reaped = 0;
    for (const dispose of pending) {
      try {
        await dispose();
        reaped += 1;
      } catch (err) {
        failures.push(err);
      }
    }
    return { reaped, failures };
  }

  return {
    register(dispose: HarnessDisposer): void {
      live.add(dispose);
    },
    forget(dispose: HarnessDisposer): void {
      live.delete(dispose);
    },
    liveCount(): number {
      return live.size;
    },
    reap,
    installReaper(registerAfterAll: RegisterAfterAll): void {
      reaperInstalled = true;
      registerAfterAll(async () => {
        const report = await reap();
        if (report.failures.length > 0) {
          throw new AggregateError(
            report.failures,
            `harness reaper: ${report.failures.length} of ${
              report.failures.length + report.reaped
            } undisposed harness(es) failed to release`,
          );
        }
      }, REAP_TIMEOUT_MS);
    },
    isReaperInstalled(): boolean {
      return reaperInstalled;
    },
  };
}

/**
 * The registry `createTestApp` writes to and the setup file reaps. One per
 * module graph, i.e. per test file.
 */
export const liveHarnesses: HarnessRegistry = createHarnessRegistry();
