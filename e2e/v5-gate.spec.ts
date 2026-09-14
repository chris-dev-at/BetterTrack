import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  V5_GRADED_SCENARIOS,
  V5_PHASE_SCENARIOS,
  V5_REQUIRED_SCENARIOS,
  V5_STEP_PROOFS,
  evaluateRequiredScenarios,
  evaluateStepProofs,
  formatGateReport,
  indexReport,
} from './support/v5Gate.mjs';

/**
 * The V5-P14 scenario gate, guarding ITSELF.
 *
 * `e2e/support/v5Gate.mjs` is the manifest the nightly grades a run against; if
 * it were only exercised by the nightly merge job, the two ways it can rot
 * would both be invisible until a release review:
 *
 *  1. **The manifest drifts from the suite.** A renamed test, a deleted spec, a
 *     scenario that quietly became `test.skip` — the grader would report the
 *     gap, but only once a night and only after a full sharded run.
 *  2. **The grader stops grading.** A refactor that broke the report parsing
 *     would make every scenario look covered, which is exactly the failure mode
 *     this whole mechanism exists to end.
 *
 * So the manifest is re-derived from the spec sources here, and the grader is
 * dry-run against synthetic reports that plant each failure it must catch. No
 * browser and no fixtures: it runs in both projects for the price of a few file
 * reads, and it is one of the specs PR CI runs (see `.github/workflows/ci.yml`).
 */

/** A `test(...)` declaration found in a spec source. */
type Declaration = {
  /** `''` for a plain `test(`, otherwise `skip` / `fixme` / `only`. */
  modifier: string;
  title: string;
  index: number;
};

/**
 * Declaration sites only: `test(`, `test.skip(`, `test.fixme(` whose FIRST
 * argument is a string literal. A body-level `test.skip(cond, 'reason')` never
 * matches, because its first argument is an expression.
 */
const DECLARATION = /^[ \t]*test(?:\.(skip|fixme|only))?\(\s*'((?:[^'\\]|\\.)*)'/gmu;

/** Unconditional in-body opt-out: `test.skip(true, …)` / `test.fixme(true, …)`. */
const UNCONDITIONAL_IN_BODY = /\btest\.(?:skip|fixme)\(\s*true\b/u;

function declarationsIn(source: string): Declaration[] {
  return [...source.matchAll(DECLARATION)].map((match) => ({
    modifier: match[1] ?? '',
    title: match[2] ?? '',
    index: match.index ?? 0,
  }));
}

/** A whole-file/whole-describe opt-out, hoisted above the first test. */
const HOISTED_OPT_OUT = /\btest\.describe\.(?:skip|fixme)\(|\btest\.(?:skip|fixme)\(\s*true\b/u;

type Liveness = { dead: boolean; why: string; body: string };

/**
 * Decide whether a named test can actually produce a result.
 *
 * The distinction the gate has to respect (issue #1683): a CONDITIONAL skip —
 * `test.skip(testInfo.project.name !== 'chromium', …)` — is legitimate and must
 * stay untouched, because the test still runs in the other project. Only an
 * UNCONDITIONAL opt-out is a dead scenario, and it comes in three spellings: at
 * the declaration (`test.skip('title', …)`), in the body (`test.skip(true)`),
 * and hoisted above every test in the file (`test.describe.skip(`, or a
 * `beforeEach` that opts out unconditionally).
 *
 * LIMIT, stated rather than hidden: the hoisted scan covers the region before
 * the FIRST declaration, because everything after it is indistinguishable —
 * without a parser — from the preceding test's body. A `beforeEach` wedged
 * between two tests would still read as alive here. The runtime grader is the
 * backstop for that spelling: such a test reports `skipped` in every project and
 * never passes, so `evaluateRequiredScenarios` fails it anyway.
 */
function livenessOf(source: string, title: string): Liveness {
  const declarations = declarationsIn(source);
  const position = declarations.findIndex((declaration) => declaration.title === title);
  expect(position, `no test titled "${title}" exists in this spec`).toBeGreaterThanOrEqual(0);
  const declaration = declarations[position]!;
  const nextDeclaration = declarations[position + 1];
  const body = source.slice(declaration.index, nextDeclaration?.index ?? source.length);

  if (declaration.modifier === 'skip' || declaration.modifier === 'fixme') {
    return { dead: true, why: `declared with test.${declaration.modifier}(`, body };
  }

  if (HOISTED_OPT_OUT.test(source.slice(0, declarations[0]!.index))) {
    return { dead: true, why: 'a hoisted opt-out disables every test in the file', body };
  }

  if (UNCONDITIONAL_IN_BODY.test(body)) {
    return { dead: true, why: 'body opts out with test.skip(true, …)', body };
  }
  return { dead: false, why: 'runs', body };
}

function repoRoot(specFile: string): string {
  // `e2e/v5-gate.spec.ts` → `e2e/` → repo root.
  return join(dirname(specFile), '..');
}

/** Reads repo-relative spec sources, once each. */
function sourceReader(root: string): (spec: string) => Promise<string> {
  const sources = new Map<string, string>();
  return async (spec: string): Promise<string> => {
    const cached = sources.get(spec);
    if (cached !== undefined) return cached;
    const source = await readFile(join(root, spec), 'utf8');
    sources.set(spec, source);
    return source;
  };
}

// ---------------------------------------------------------------------------
// Synthetic blob reports, for dry-running the grader.
// ---------------------------------------------------------------------------

type ReportRecord = { method: string; params: unknown };

type PlannedResult = {
  /** Repo-relative, exactly as the manifest spells it. */
  spec: string;
  title: string;
  project: string;
  /** `null` models a test that was collected but never produced a result. */
  status: string | null;
};

/**
 * Build the records `indexReport` reads: one `onProject` per project, carrying
 * one file suite per spec with the titles it collected, plus an `onTestEnd` per
 * planned result. Mirrors Playwright 1.61's tele-reporter shape
 * (`params.project.suites[].entries[]` for collection, `params.test.testId` +
 * `params.result.status` for outcomes), including the file suite's title —
 * which the grader keys on so two specs cannot grade each other's results.
 *
 * `fileTitles: false` drops those suite titles, modelling a report shape the
 * grader does not recognise, so the title-only fallback can be exercised.
 */
function syntheticReport(planned: PlannedResult[], fileTitles = true): ReportRecord[] {
  const projects = [...new Set(planned.map((entry) => entry.project))];
  const testId = (entry: PlannedResult): string =>
    `${entry.project}::${entry.spec}::${entry.title}`;

  const records: ReportRecord[] = projects.map((project) => {
    const inProject = planned.filter((entry) => entry.project === project);
    const specs = [...new Set(inProject.map((entry) => entry.spec))];
    return {
      method: 'onProject',
      params: {
        project: {
          name: project,
          suites: specs.map((spec) => ({
            title: fileTitles ? spec.replace(/^e2e\//u, '') : '',
            entries: inProject
              .filter((entry) => entry.spec === spec)
              .map((entry) => ({ testId: testId(entry), title: entry.title })),
          })),
        },
      },
    };
  });

  for (const entry of planned) {
    if (entry.status === null) continue;
    records.push({
      method: 'onTestEnd',
      params: {
        test: { testId: testId(entry) },
        result: { id: `${testId(entry)}#0`, status: entry.status },
      },
    });
  }
  return records;
}

/** Every graded scenario passing once, in the desktop project. */
function plannedForFullyCoveredRun(): PlannedResult[] {
  const planned: PlannedResult[] = [];
  for (const scenario of V5_GRADED_SCENARIOS) {
    if (scenario.coverage.kind === 'playwright') {
      for (const mapped of scenario.coverage.tests) {
        planned.push({
          spec: mapped.spec,
          title: mapped.title,
          project: 'chromium',
          status: 'passed',
        });
      }
    }
    if (scenario.coverage.kind === 'waived') {
      for (const dead of scenario.coverage.deadTests) {
        planned.push({
          spec: dead.spec,
          title: dead.title,
          project: 'chromium',
          status: 'skipped',
        });
      }
    }
  }
  return planned;
}

/** A step proof occurring `count` times, each inside a passed test. */
function stepProofRecords(step: string, count: number): ReportRecord[] {
  const records: ReportRecord[] = [];
  for (let occurrence = 0; occurrence < count; occurrence += 1) {
    const testId = `step-host-${occurrence}`;
    const resultId = `${testId}#0`;
    records.push(
      {
        method: 'onTestEnd',
        params: { test: { testId }, result: { id: resultId, status: 'passed' } },
      },
      {
        method: 'onStepBegin',
        params: { testId, resultId, step: { id: 'step-1', title: step } },
      },
      { method: 'onStepEnd', params: { testId, resultId, step: { id: 'step-1' } } },
    );
  }
  return records;
}

/** The real `[PD9-A2]` proof, minus its waiver — the shape a live proof has. */
const REQUIRED_STEP_PROOF = [{ ...V5_STEP_PROOFS[0]!, waived: undefined }];

function grade(records: ReportRecord[], proofs = V5_STEP_PROOFS) {
  return formatGateReport(
    evaluateRequiredScenarios(indexReport(records)),
    evaluateStepProofs(records, proofs),
  );
}

test.describe('V5-P14 required-scenario gate', () => {
  // Playwright requires the first argument to be an object destructuring
  // pattern; these tests genuinely need no fixture, hence the empty one.
  /* eslint-disable no-empty-pattern */

  test('v5 gate: the manifest names all ten V5-P14 scenarios, and every waiver is accountable', async ({}) => {
    // The phase line names ten flows. A dropped one is the whole point.
    expect(V5_REQUIRED_SCENARIOS).toHaveLength(10);
    expect(new Set(V5_REQUIRED_SCENARIOS.map((scenario) => scenario.id)).size).toBe(10);

    // Scenarios later issues registered live in their own array, so the ten
    // above stay a literal transcription of the phase line. They are graded
    // identically — and listed here so one cannot appear unremarked.
    expect(V5_PHASE_SCENARIOS.map((scenario) => scenario.id)).toEqual(['pwa-install-flow']);
    expect(new Set(V5_GRADED_SCENARIOS.map((scenario) => scenario.id)).size).toBe(
      V5_GRADED_SCENARIOS.length,
    );

    for (const scenario of V5_GRADED_SCENARIOS) {
      const { coverage } = scenario;
      if (coverage.kind !== 'waived') continue;
      expect(coverage.deadTests.length, `${scenario.id} waives nothing`).toBeGreaterThan(0);
      expect(coverage.reason.length, `${scenario.id} has no reason`).toBeGreaterThan(40);
      expect(coverage.blockedBy, `${scenario.id} names no blocking issue`).toBeGreaterThan(0);
      expect(coverage.waivedOn, `${scenario.id} has no waiver date`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/u,
      );
    }

    // Exactly the two the issue registered; a third appearing silently would
    // mean the phase quietly gave up on another flow.
    expect(
      V5_GRADED_SCENARIOS.filter((scenario) => scenario.coverage.kind === 'waived').map(
        (scenario) => scenario.id,
      ),
    ).toEqual(['expense-import-budget-alert', 'paranoid-drive-only-round-trip']);
  });

  test('v5 gate: every mapped test is live, and every waived test is genuinely dead', async ({}, testInfo) => {
    const sourceOf = sourceReader(repoRoot(testInfo.file));
    const root = repoRoot(testInfo.file);

    for (const scenario of V5_GRADED_SCENARIOS) {
      const { coverage } = scenario;
      if (coverage.kind === 'playwright') {
        for (const mapped of coverage.tests) {
          const liveness = livenessOf(await sourceOf(mapped.spec), mapped.title);
          expect(
            liveness.dead,
            `${scenario.id} maps to a dead test (${liveness.why}): ${mapped.spec} — "${mapped.title}". ` +
              'Either restore it or move the scenario to a waiver with a blocking issue.',
          ).toBe(false);
        }
      }
      if (coverage.kind === 'waived') {
        for (const dead of coverage.deadTests) {
          const liveness = livenessOf(await sourceOf(dead.spec), dead.title);
          expect(
            liveness.dead,
            `${scenario.id} is waived, but ${dead.spec} — "${dead.title}" runs again. Retire the waiver.`,
          ).toBe(true);
        }
      }
      if (coverage.kind === 'vitest') {
        // Proven outside this suite; assert only that the named gate still
        // exists. That existence check IS the whole nightly assertion for this
        // kind — the suite's content is gated by the web package's vitest run.
        await expect(readFile(join(root, coverage.spec), 'utf8')).resolves.toBeTruthy();
      }
    }
  });

  test('v5 gate: every step proof is either live and required, or dead and waived', async ({}, testInfo) => {
    // The gap this closes (review of PR #1691): the step proof was the ONE
    // manifest entry with no liveness check, and it was the one that was dead —
    // `[PD9-A2]` lives inside the same quarantined declaration the
    // `paranoid-drive-only-round-trip` scenario waives, so requiring it made the
    // gate's green state unreachable. Held to the same rule as a scenario now:
    // host alive ⇒ required, host dead ⇒ waived, and never both or neither.
    const sourceOf = sourceReader(repoRoot(testInfo.file));

    expect(V5_STEP_PROOFS.length).toBeGreaterThan(0);
    for (const proof of V5_STEP_PROOFS) {
      const source = await sourceOf(proof.host.spec);
      const liveness = livenessOf(source, proof.host.title);

      // The step must still exist where the manifest says it does; a renamed
      // step would otherwise count zero occurrences forever.
      expect(
        liveness.body.includes(proof.step),
        `${proof.id}: no step titled "${proof.step}" inside ${proof.host.spec} — "${proof.host.title}".`,
      ).toBe(true);

      if (liveness.dead) {
        expect(
          proof.waived,
          `${proof.id}: its host test is dead (${liveness.why}), so requiring the step would keep ` +
            'the nightly permanently red. Waive it with a reason, a blocking issue and a date, or ' +
            'restore the host.',
        ).toBeTruthy();
        expect(proof.waived!.reason.length).toBeGreaterThan(40);
        expect(proof.waived!.blockedBy).toBeGreaterThan(0);
        expect(proof.waived!.waivedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      } else {
        expect(
          proof.waived,
          `${proof.id}: its host test runs again, so the waiver is stale — restore the step proof ` +
            'as required in e2e/support/v5Gate.mjs.',
        ).toBeUndefined();
        expect(proof.expected).toBeGreaterThan(0);
      }
    }
  });

  test('v5 gate: a conditional skip is not a dead test', async ({}, testInfo) => {
    const root = repoRoot(testInfo.file);
    // The legitimate conditional skips the issue enumerates: a project guard, a
    // capability guard, and the shared `skipOnPhone` helper. None may be
    // flagged, or the gate would start demanding that every spec run in every
    // project.
    const conditional: { spec: string; title: string }[] = [
      {
        spec: 'e2e/light-mode.spec.ts',
        title: 'boots light from a stored pin, without a flash of the dark canvas',
      },
      {
        spec: 'e2e/light-mode.spec.ts',
        title: 'System follows the OS, and an explicit pin overrides it',
      },
      { spec: 'e2e/light-mode.spec.ts', title: 'the Appearance panel switches the theme live' },
      {
        spec: 'e2e/light-mode.spec.ts',
        title: 'light mode resolves the bright gold and its geometry on real pages',
      },
      {
        spec: 'e2e/vault-session-sharing.spec.ts',
        title: 'survives a reload, unlocks in one step, is shared across tabs, and dies on lock',
      },
      {
        spec: 'e2e/paranoid-e10.spec.ts',
        title: '[E10-A1] vault ceremony, endpoint lock and unlock',
      },
    ];
    for (const entry of conditional) {
      const source = await readFile(join(root, entry.spec), 'utf8');
      expect(
        livenessOf(source, entry.title).dead,
        `${entry.spec} — "${entry.title}" skips conditionally and must not be flagged dead`,
      ).toBe(false);
    }

    // The discriminator: this one carries BOTH a conditional project skip and an
    // unconditional `test.skip(true, V1_ENABLE_ENTRY_RETIRED)`. The presence of a
    // conditional skip must not launder it into looking alive.
    const paranoid = await readFile(join(root, 'e2e/paranoid.spec.ts'), 'utf8');
    expect(
      livenessOf(
        paranoid,
        'Drive-only enable → lock/reload → tamper fail-closed → verified media switch → disable',
      ),
    ).toMatchObject({ dead: true, why: 'body opts out with test.skip(true, …)' });

    // A skip hoisted above every test — `test.describe.skip(`, or a `beforeEach`
    // that opts out — kills tests that look alive at their own declaration.
    const hoisted = [
      "test.describe.skip('suite', () => {",
      "test('live-looking title', async () => {});",
      '});',
    ].join('\n');
    expect(livenessOf(hoisted, 'live-looking title')).toMatchObject({
      dead: true,
      why: 'a hoisted opt-out disables every test in the file',
    });
  });

  test('v5 gate: a run that covers everything is green and counts nine covered, two waived', async ({}) => {
    const report = grade(syntheticReport(plannedForFullyCoveredRun()));
    expect(report.ok).toBe(true);
    expect({ covered: report.covered, waived: report.waived, failed: report.failed }).toEqual({
      covered: 9,
      waived: 2,
      failed: 0,
    });
    // The waived pair — plus the waived step proof — is surfaced as an
    // unmissable annotation, not swallowed.
    const warnings = report.annotations.filter((line) => line.startsWith('::warning::'));
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain(
      'step proof "[PD9-A2] complete DB cleartext probe" is WAIVED',
    );
    expect(report.summary.join('\n')).toContain('**9 covered · 2 waived · 0 failed**');
  });

  test('v5 gate: grading is per spec, so two files may share a title', async ({}) => {
    // The waived paranoid title, alive and passing in a DIFFERENT spec, must not
    // read as a revived waiver — nor may a live scenario be graded green by a
    // namesake somewhere else.
    const impostor = {
      spec: 'e2e/some-other.spec.ts',
      title:
        'Drive-only enable → lock/reload → tamper fail-closed → verified media switch → disable',
      project: 'chromium',
      status: 'passed',
    };
    const report = grade(syntheticReport([...plannedForFullyCoveredRun(), impostor]));
    expect(report.ok).toBe(true);
    expect(report.waived).toBe(2);

    // And with no file titles at all (an unrecognised report shape) the grader
    // degrades to title-only matching rather than failing a green run.
    const untitled = grade(syntheticReport(plannedForFullyCoveredRun(), false));
    expect(untitled.ok).toBe(true);
    expect(untitled.covered).toBe(9);
  });

  test('v5 gate: removing, skipping or failing a mapped test turns the gate red', async ({}) => {
    const forecast = 'forecast: a scheduled cash-add lifts the enabled one-year projection';

    // (a) the spec stopped being collected at all — a rename, a move, a
    //     `testIgnore` that grew too wide.
    const removed = grade(
      syntheticReport(plannedForFullyCoveredRun().filter((entry) => entry.title !== forecast)),
    );
    expect(removed.ok).toBe(false);
    expect(removed.failed).toBe(1);
    expect(removed.annotations.join('\n')).toContain('was never collected by the run');

    // (b) the test is still collected, but unconditionally skipped in every
    //     project — the exact state the two waived scenarios were in.
    const skipped = grade(
      syntheticReport(
        plannedForFullyCoveredRun().map((entry) =>
          entry.title === forecast ? { ...entry, status: 'skipped' } : entry,
        ),
      ),
    );
    expect(skipped.ok).toBe(false);
    expect(skipped.annotations.join('\n')).toContain('never passed; results were: skipped');

    // (c) it ran and failed.
    const failed = grade(
      syntheticReport(
        plannedForFullyCoveredRun().map((entry) =>
          entry.title === forecast ? { ...entry, status: 'failed' } : entry,
        ),
      ),
    );
    expect(failed.ok).toBe(false);
    expect(failed.covered).toBe(8);

    // (d) collected, but the shard died before producing a result.
    const noResult = grade(
      syntheticReport(
        plannedForFullyCoveredRun().map((entry) =>
          entry.title === forecast ? { ...entry, status: null } : entry,
        ),
      ),
    );
    expect(noResult.ok).toBe(false);
    expect(noResult.annotations.join('\n')).toContain('produced no result');
  });

  test('v5 gate: a project-conditional skip beside a passing project stays green', async ({}) => {
    // The same title, skipped on the phone and passed on the desktop — what
    // `skipOnPhone` and the light-mode project guards actually produce.
    const planned = plannedForFullyCoveredRun().flatMap((entry) =>
      entry.status === 'passed'
        ? [entry, { ...entry, project: 'mobile-chromium', status: 'skipped' }]
        : [entry],
    );
    const report = grade(syntheticReport(planned));
    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
  });

  test('v5 gate: a waived scenario that came back to life turns the gate red', async ({}) => {
    const revived = plannedForFullyCoveredRun().map((entry) =>
      entry.status === 'skipped' ? { ...entry, status: 'passed' } : entry,
    );
    const report = grade(syntheticReport(revived));
    expect(report.ok).toBe(false);
    expect(report.waived).toBe(0);
    expect(report.annotations.join('\n')).toContain('waiver is stale');
  });

  test('v5 gate: a REQUIRED step proof must occur exactly as often as it claims', async ({}) => {
    // The rule a live step proof is graded by, dry-run against the real proof
    // with its waiver stripped — so the semantics stay tested while the actual
    // `[PD9-A2]` host is quarantined, and come back for free when it returns.
    const covered = plannedForFullyCoveredRun();
    const step = V5_STEP_PROOFS[0]!.step;
    const required = (records: ReportRecord[]) => grade(records, REQUIRED_STEP_PROOF);

    expect(required([...syntheticReport(covered), ...stepProofRecords(step, 1)]).ok).toBe(true);

    const missing = required([...syntheticReport(covered), ...stepProofRecords(step, 0)]);
    expect(missing.ok).toBe(false);
    expect(missing.annotations.join('\n')).toContain(`Expected 1 successful "${step}" step(s)`);

    expect(required([...syntheticReport(covered), ...stepProofRecords(step, 2)]).ok).toBe(false);

    // A step that completed inside a test that did NOT pass proves nothing.
    const insideAFailedTest: ReportRecord[] = [
      {
        method: 'onTestEnd',
        params: { test: { testId: 'pd9' }, result: { id: 'pd9#0', status: 'failed' } },
      },
      {
        method: 'onStepBegin',
        params: { testId: 'pd9', resultId: 'pd9#0', step: { id: 's', title: step } },
      },
      { method: 'onStepEnd', params: { testId: 'pd9', resultId: 'pd9#0', step: { id: 's' } } },
    ];
    expect(required([...syntheticReport(covered), ...insideAFailedTest]).ok).toBe(false);
  });

  test('v5 gate: a WAIVED step proof is a reported gap, and turns red the moment it runs again', async ({}) => {
    // The blocking review finding on PR #1691: `[PD9-A2]` lives inside a test
    // that opts out unconditionally, so demanding it made a perfect run fail —
    // permanently, and before the merged HTML report was ever produced. As a
    // waiver it is loud but not fatal…
    const covered = plannedForFullyCoveredRun();
    const waived = grade(syntheticReport(covered));
    expect(waived.ok).toBe(true);
    expect(waived.summary.join('\n')).toContain(
      `⚠️ step proof \`${V5_STEP_PROOFS[0]!.step}\`: waived — blocked by #`,
    );

    // …and it cannot outlive its blocker: one successful occurrence means the
    // host runs again, which must force the manifest back into agreement.
    const revived = grade([
      ...syntheticReport(covered),
      ...stepProofRecords(V5_STEP_PROOFS[0]!.step, 1),
    ]);
    expect(revived.ok).toBe(false);
    expect(revived.annotations.join('\n')).toContain('waiver is stale');
  });

  test('v5 gate: the nightly still auto-discovers specs, and grades the run it just made', async ({}, testInfo) => {
    const workflow = await readFile(
      join(repoRoot(testInfo.file), '.github/workflows/e2e-nightly.yml'),
      'utf8',
    );

    // REGRESSION (#1683): a brand-new spec file must keep running nightly with
    // no workflow edit. The shard command therefore passes ONLY `--shard=`; the
    // moment someone adds a path argument, the suite silently narrows to a
    // hand-maintained list and every spec outside it stops being a gate.
    const invocation = workflow
      .split('\n')
      .find((line) => line.includes('playwright test --shard='));
    expect(invocation, 'the nightly no longer invokes a sharded playwright run').toBeTruthy();
    expect(invocation!).toContain('pnpm exec playwright test --shard=');
    expect(
      /e2e\/|\.spec\.ts/u.test(invocation!),
      `the nightly shard command grew a path argument, so new specs stopped running automatically: ${invocation!.trim()}`,
    ).toBe(false);

    // And the merge job must actually grade that run against this manifest —
    // the gate is worthless if the step that runs it is dropped.
    expect(workflow).toContain('node e2e/support/v5GateReport.mjs');
  });

  /* eslint-enable no-empty-pattern */
});
