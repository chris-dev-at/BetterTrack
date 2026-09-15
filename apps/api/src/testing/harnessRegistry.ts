/**
 * Live-harness registry, the file-teardown reaper (#1936) and the suite-teardown
 * reaper (#1940).
 *
 * `createTestApp()`'s `dispose()` became correct in #1914 — it hands back the
 * two Redis connections `buildContext` opens for the domain event bus — but
 * across the integration slice there are 49 `createTestApp(` sites and exactly
 * one ordinary test that calls `dispose()`. Most calls sit in a `beforeEach`,
 * so a 65-test file builds 65 harnesses and releases none, and the slice peaked
 * at ~670 connections on the harness's Redis DB.
 *
 * So the harness registers itself here instead, and a shared vitest setup file
 * (`setupHarnessReaper.ts`, wired into both configs' `setupFiles`) installs two
 * reapers: the file-teardown backstop below, and the suite-teardown reaper that
 * drains a `describe` as soon as the runner is done with it.
 *
 * ## Never per test
 *
 * A harness built in `beforeAll` and reused by every test in its file — or in
 * its describe — is a legitimate, common pattern here. An `afterEach` reaper
 * would close its event bus after the first test and every later test would
 * fail. Neither reaper below ever runs per test: the unit of release is a suite
 * the runner has finished with, or the file.
 *
 * ## The file backstop (#1936)
 *
 * One `afterAll` on the test file's root suite. It really is last: Vitest 3
 * defaults `sequence.hooks` to `"stack"`, so `afterAll` hooks run in reverse
 * registration order — and setup files are evaluated before the test file,
 * which makes the reaper's hook the first registered and therefore the last to
 * run. A file's own `afterAll` that still uses its harness is untouched.
 *
 * ## The suite reaper (#1940) — transition detection
 *
 * The backstop leaves a floor: the largest single file's own live set. The
 * integration slice's remaining ~130 connections were one file,
 * `portfolioVaultTransitionService.test.ts`, whose 65 `beforeEach` harnesses all
 * survive to its last line. Releasing them needs a per-describe teardown, and
 * Vitest has no global "afterEachSuite" hook: `afterAll()` called from inside a
 * running hook attaches to whatever collector was current at collection time,
 * not to the suite being run, and a custom `test.runner` (which does get an
 * `onAfterRunSuite`) is instantiated outside the per-file module graph, so its
 * import of this module would not be the instance `createTestApp` writes to.
 *
 * What a setup file can register is one `beforeEach` on the root suite, and
 * under `sequence.hooks: "stack"` that hook runs **first** of all — `beforeEach`
 * recurses to the parent suite before running its own hooks, and this one is the
 * first registered on the file. It receives the running test's own suite, so it
 * can compare the current suite chain with the previous test's:
 *
 * - Suites on the previous chain that are no longer on this one are **over**.
 *   Vitest runs a suite's own `afterAll` before returning to its parent
 *   (`runSuite`), so by the time this hook sees the transition, every closed
 *   suite's teardown has already run and cannot be reading its harness any more.
 *   Harnesses stamped with those suites are released here, newest first.
 * - Suites on this chain that were not on the previous one have just **opened**.
 *
 * That ordering is the same guarantee the file backstop gives, one level down,
 * and it is strictly stronger in one way: a suite whose own `afterAll` throws
 * aborts the remaining `afterAll` hooks of that suite, but it cannot stop the
 * next test's `beforeEach`. The suite reaper still drains it.
 *
 * ## Stamping: which suite owns a harness
 *
 * Registration happens inside `createTestApp()`, wherever the test file calls
 * it, so the registry has to work out the owner itself. There are two cases,
 * and Vitest's own `getCurrentTest()` separates them exactly — the runner sets
 * it before a test's `beforeEach` and clears it in `runTest`'s tail, after the
 * `afterEach` try/catch, where no failing hook can skip it:
 *
 * - **A test is running** (its `beforeEach`, its body, its `afterEach`): the
 *   harness belongs to the innermost suite of the running chain. Exact.
 * - **No test is running**: the call came from a `beforeAll` of a suite that is
 *   opening, from an `afterAll` of one that just closed, or from the file's own
 *   `beforeAll`. Those are indistinguishable from here, so the harness is left
 *   unattributed and stamped at the next test's `beforeEach` with the
 *   **outermost** suite that opened — the only choice that is never *too early*,
 *   since every deeper suite ends before it. At the start of a file the
 *   outermost opening suite is the file itself, so a file-level `beforeAll`
 *   harness is owned by the file and survives to file teardown, exactly as
 *   #1936 requires.
 *
 * ## Known limitations, all in the safe direction
 *
 * 1. The last suite of a file never transitions out of the chain; its harnesses
 *    are released by the file backstop, not on transition.
 * 2. The first describe of a file opens together with the file, so a harness
 *    built in *its* `beforeAll` is attributed to the file. Every later describe
 *    is attributed exactly.
 * 3. Concurrent tests (`it.concurrent`, `describe.concurrent`, or
 *    `sequence.concurrent`) interleave chains, which makes a transition
 *    meaningless. The first concurrent test switches the suite reaper off for
 *    that file for good; the file backstop still runs.
 * 4. A harness deliberately built inside one describe and reused by a *later*
 *    sibling describe is released before that second describe runs. Sharing
 *    across siblings means building it in the parent's `beforeAll` (or in the
 *    file's), which is what the ownership rules above are for.
 *
 * A release that throws during a transition is not raised from the innocent test
 * whose `beforeEach` happened to trigger it; it is carried to the file-teardown
 * hook, which fails the file with every failure it collected.
 *
 * ## Why a strong Map, and why disposers rather than harnesses
 *
 * A `WeakRef` would be collectable exactly in the case this exists for — a
 * harness the test file dropped without disposing — and a collected ref cannot
 * be reaped, so the registry holds strong references. Insertion order is what
 * makes "newest first" cheap, and a `Map` keyed by the disposer keeps `forget()`
 * O(1) while carrying each harness's owning suite.
 *
 * What it holds is the disposer, not the harness. A closure created inside
 * `createTestApp` shares that function's scope, so retaining one would pin the
 * whole harness — express app, router tree, every service — until teardown; a
 * 65-harness file would hold 65 of them at once, on top of the PGlite instance
 * each worker already carries. `createTestApp` therefore builds its disposer
 * from a module-level factory that captures only the event bus and the
 * harness-owned Redis, leaving the rest collectable while the file runs.
 *
 * ## Scope
 *
 * Vitest re-evaluates the module graph per test file (that is why the PGlite
 * instance in `createTestApp.ts` lives on `globalThis`), so this registry holds
 * the harnesses of the file being torn down. Even where a module graph is
 * shared, the accounting holds: everything an earlier file created was already
 * reaped at that file's teardown.
 */

/** A harness's terminal, idempotent release (`TestHarness.dispose`). */
export type HarnessDisposer = () => Promise<void>;

/** Vitest's `afterAll`, narrowed to what {@link HarnessRegistry.installReaper} uses. */
export type RegisterAfterAll = (fn: () => Promise<void>, timeoutMs?: number) => void;

/**
 * Vitest's `Suite`/`File` task, narrowed to the chain walk. A `File` is the one
 * node carrying `filepath`; every other suite reaches its parent through
 * `suite` (a nested describe) or `file` (a top-level one) — the same shape
 * `callSuiteHook` uses to stop at file level.
 */
export interface SuiteScope {
  readonly name: string;
  readonly suite?: SuiteScope | undefined;
  readonly file?: SuiteScope | undefined;
  readonly filepath?: string | undefined;
}

/**
 * Vitest's `TestContext`, narrowed to what the hook reads off the running test.
 *
 * `beforeEach` is handed `[context, suite]`, but Vitest wraps every `beforeEach`
 * callback in `withFixtures`, which re-invokes it as `fn(context)` — the suite
 * argument never arrives. The running test carries the same pointers
 * (`runTest` itself resolves its suite as `test.suite || test.file`), so the
 * chain is read from `task` instead.
 */
export interface TestScope {
  readonly task?:
    | {
        readonly concurrent?: boolean | undefined;
        readonly suite?: SuiteScope | undefined;
        readonly file?: SuiteScope | undefined;
      }
    | undefined;
}

/** Vitest's `beforeEach`, narrowed to what {@link HarnessRegistry.installSuiteReaper} uses. */
export type RegisterBeforeEach = (
  fn: (context: TestScope) => Promise<void>,
  timeoutMs?: number,
) => void;

/**
 * Whether a test — including its `beforeEach`/`afterEach` — is running right
 * now. The setup file supplies Vitest's own `getCurrentTest()`; keeping it a
 * parameter is what lets this module stay free of Vitest imports and lets a
 * test drive the whole mechanism with a fake.
 */
export type TestRunningProbe = () => boolean;

export interface HarnessReapReport {
  /** Harnesses the reaper had to release because nothing disposed them. */
  reaped: number;
  /**
   * Errors thrown by a disposer. A reap always drains its whole selection, so
   * one broken harness cannot strand the others' connections; the file-teardown
   * hook turns a non-empty list — its own and every transition's — into a failed
   * teardown rather than swallowing it.
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
  /** Install {@link reap} as a file-teardown hook (#1936). */
  installReaper(registerAfterAll: RegisterAfterAll): void;
  /**
   * Whether {@link installReaper} ran — i.e. whether this file loaded the shared
   * setup file. Set by the same call that registers the hook, so it cannot
   * report a reaper that was never wired up.
   */
  isReaperInstalled(): boolean;
  /**
   * Install the suite-teardown reaper (#1940): one root-suite `beforeEach` that
   * detects suite transitions, plus the probe that tells registration whether a
   * test is running.
   */
  installSuiteReaper(registerBeforeEach: RegisterBeforeEach, isTestRunning: TestRunningProbe): void;
  /** Whether {@link installSuiteReaper} ran, on the same terms as {@link isReaperInstalled}. */
  isSuiteReaperInstalled(): boolean;
  /**
   * The suite reaper's hook body: stamp everything registered between tests,
   * then release the harnesses of every suite the runner has just left. Exposed
   * so the transition logic can be driven directly, without vitest hooks.
   *
   * Returns what this transition released; failures are also carried to the
   * file-teardown hook.
   */
  noteTestStart(suite: SuiteScope, concurrent?: boolean): Promise<HarnessReapReport>;
}

/**
 * Generous bound for the teardown hooks: a file that leaked 60+ harnesses does
 * 120 sequential QUITs on its way out, and the integration config inherits
 * Vitest's 10 s hook default.
 */
const REAP_TIMEOUT_MS = 30_000;

/** The registry's view of one live harness. `owner === null` is "not attributed yet". */
interface LiveEntry {
  owner: SuiteScope | null;
}

/**
 * The chain from the file down to `suite`, outermost first. The guard set makes
 * a malformed (cyclic) task graph terminate rather than hang a hook.
 */
function suiteChain(suite: SuiteScope): SuiteScope[] {
  const chain: SuiteScope[] = [];
  const seen = new Set<SuiteScope>();
  let node: SuiteScope | undefined = suite;
  while (node && !seen.has(node)) {
    seen.add(node);
    chain.unshift(node);
    if (typeof node.filepath === 'string') break;
    node = node.suite ?? node.file;
  }
  return chain;
}

/** How many leading suites two chains share, by identity. */
function commonPrefixLength(a: readonly SuiteScope[], b: readonly SuiteScope[]): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}

export function createHarnessRegistry(): HarnessRegistry {
  const live = new Map<HarnessDisposer, LiveEntry>();
  let reaperInstalled = false;
  let suiteReaperInstalled = false;

  /** Vitest's `getCurrentTest()`, once the suite reaper is installed. */
  let isTestRunning: TestRunningProbe = () => false;
  /** The suite chain of the test that started most recently, outermost first. */
  let openChain: SuiteScope[] = [];
  /** Set for good by the first concurrent test: transitions stop meaning anything. */
  let concurrentSeen = false;

  /** Failures from transition reaps, raised by the file-teardown hook instead. */
  const carriedFailures: unknown[] = [];
  /** Harnesses released by transitions, for the file hook's error message. */
  let carriedReaped = 0;

  /** Release the given disposers in order, draining the whole list regardless. */
  async function release(pending: readonly HarnessDisposer[]): Promise<HarnessReapReport> {
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

  async function reap(): Promise<HarnessReapReport> {
    // Snapshot and clear before disposing anything: each disposer calls
    // `forget()` on its way out, and a disposer that throws must not be left
    // behind for a later reap to retry.
    const pending = [...live.keys()].reverse();
    live.clear();
    return release(pending);
  }

  /** Release every harness owned by a suite that is over, newest first. */
  async function reapSuites(closed: readonly SuiteScope[]): Promise<HarnessReapReport> {
    if (closed.length === 0) return { reaped: 0, failures: [] };

    const doomed: HarnessDisposer[] = [];
    for (const [dispose, entry] of live) {
      if (entry.owner !== null && closed.includes(entry.owner)) doomed.push(dispose);
    }
    for (const dispose of doomed) live.delete(dispose);

    return release(doomed.reverse());
  }

  async function noteTestStart(suite: SuiteScope, concurrent = false): Promise<HarnessReapReport> {
    if (concurrent) concurrentSeen = true;
    // Chains of concurrently running tests interleave, so "the previous test's
    // suite" stops implying that suite is over. Fall back to the file backstop
    // for the rest of this file rather than guess.
    if (concurrentSeen) return { reaped: 0, failures: [] };

    const chain = suiteChain(suite);
    const shared = commonPrefixLength(chain, openChain);

    // Everything registered while no test was running belongs to the outermost
    // suite that has just opened — or, when nothing opened, to the suite this
    // test sits in. Both are on the chain below, so neither can be in `closed`.
    const gapOwner = chain[shared] ?? chain.at(-1) ?? null;
    if (gapOwner !== null) {
      for (const entry of live.values()) {
        if (entry.owner === null) entry.owner = gapOwner;
      }
    }

    const closed = openChain.slice(shared);
    openChain = chain;

    const report = await reapSuites(closed);
    carriedFailures.push(...report.failures);
    carriedReaped += report.reaped;
    return report;
  }

  return {
    register(dispose: HarnessDisposer): void {
      // Inside a test (its `beforeEach`, body or `afterEach`) the owner is known
      // exactly: the innermost suite of the running chain. Outside one it is not
      // — `noteTestStart` stamps it at the next test.
      const owner = !concurrentSeen && isTestRunning() ? (openChain.at(-1) ?? null) : null;
      live.set(dispose, { owner });
    },
    forget(dispose: HarnessDisposer): void {
      live.delete(dispose);
    },
    liveCount(): number {
      return live.size;
    },
    reap,
    noteTestStart,
    installReaper(registerAfterAll: RegisterAfterAll): void {
      reaperInstalled = true;
      registerAfterAll(async () => {
        const report = await reap();
        const failures = [...carriedFailures, ...report.failures];
        carriedFailures.length = 0;
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            `harness reaper: ${failures.length} of ${
              failures.length + report.reaped + carriedReaped
            } undisposed harness(es) failed to release`,
          );
        }
      }, REAP_TIMEOUT_MS);
    },
    isReaperInstalled(): boolean {
      return reaperInstalled;
    },
    installSuiteReaper(
      registerBeforeEach: RegisterBeforeEach,
      testRunningProbe: TestRunningProbe,
    ): void {
      suiteReaperInstalled = true;
      isTestRunning = testRunningProbe;
      registerBeforeEach(async (context) => {
        const task = context?.task;
        const suite = task?.suite ?? task?.file;
        // No task means no chain to compare — leave the file backstop to it.
        if (!suite) return;
        await noteTestStart(suite, task?.concurrent === true);
      }, REAP_TIMEOUT_MS);
    },
    isSuiteReaperInstalled(): boolean {
      return suiteReaperInstalled;
    },
  };
}

/**
 * The registry `createTestApp` writes to and the setup file reaps. One per
 * module graph, i.e. per test file.
 */
export const liveHarnesses: HarnessRegistry = createHarnessRegistry();
