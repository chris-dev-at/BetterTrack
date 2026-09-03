/**
 * V5-P14 REQUIRED-SCENARIO MANIFEST — and the pure logic that grades a merged
 * Playwright blob report against it.
 *
 * The phase's acceptance line is "Nightly e2e green incl. all new flows", and
 * it names ten flows. Before this manifest existed, "green" only meant "nothing
 * that ran, failed": an unconditionally-skipped spec, a `test.fixme` with an
 * empty body, or a spec file that silently stopped being collected all reported
 * exactly the same green as a scenario that ran end to end. Two of the ten were
 * in that state (#1683), and nothing in CI noticed.
 *
 * So the ten scenarios are enumerated HERE, each mapped to the test that proves
 * it, and `.github/workflows/e2e-nightly.yml` fails the run when a mapped test
 * did not produce a passing result. A scenario that is genuinely blocked on
 * product work is `waived` — it does not fail the build, but it is reported as
 * an explicit, countable gap in the job summary, and it must name a reason, a
 * blocking issue and the date the waiver was taken.
 *
 * Written as `.mjs` on purpose: `node` in the workflow imports it directly, and
 * `e2e/v5-gate.spec.ts` imports the same module (e2e/tsconfig.json has
 * `allowJs`/`checkJs` and includes `./support/**\/*.mjs`, so it is typechecked
 * like the rest of the suite). One manifest, one grader, two readers.
 *
 * The same waiver rule governs `V5_STEP_PROOFS` below: a step proof whose host
 * test is quarantined is a reported gap, not a build failure — and, like a
 * waived scenario, it goes red the moment it starts running again.
 *
 * MAINTENANCE: `e2e/v5-gate.spec.ts` re-reads every spec named below and fails
 * if a mapped title has disappeared, has become unconditionally dead, or if a
 * waived entry (scenario OR step proof) has quietly come back to life. The
 * manifest cannot drift away from the suite without a red test.
 */

/**
 * A test title in a spec file, repo-relative.
 *
 * @typedef {{ spec: string, title: string }} SpecTest
 */

/**
 * Proven by a Playwright test that must run and pass in the nightly suite.
 *
 * @typedef {object} PlaywrightCoverage
 * @property {'playwright'} kind
 * @property {SpecTest[]} tests every one of these must produce a passing result
 */

/**
 * Proven outside the browser suite. Counted as covered, but the nightly report
 * cannot see it, so the summary says where the real gate lives.
 *
 * The nightly's assertion for this kind is the EXISTENCE of `spec` and nothing
 * more (`e2e/v5-gate.spec.ts` reads the file; deleting it turns the gate red,
 * emptying or `describe.skip`ping it does not). The suite's own content is
 * gated per-PR by the package's vitest run, which is what `note` must say.
 *
 * @typedef {object} VitestCoverage
 * @property {'vitest'} kind
 * @property {string} spec
 * @property {string} note
 */

/**
 * Knowingly not covered. Does not fail the build; is reported as a gap.
 *
 * @typedef {object} WaivedCoverage
 * @property {'waived'} kind
 * @property {SpecTest[]} deadTests the dead declarations this waiver accounts for
 * @property {string} reason why no browser coverage exists today
 * @property {number} blockedBy the issue that has to land first
 * @property {string} waivedOn ISO date the waiver was taken
 */

/**
 * @typedef {PlaywrightCoverage | VitestCoverage | WaivedCoverage} ScenarioCoverage
 */

/**
 * @typedef {object} RequiredScenario
 * @property {string} id stable slug, used in annotations
 * @property {string} scenario the phase line's own wording
 * @property {ScenarioCoverage} coverage
 */

/**
 * The ten scenarios V5-P14 owes, in the order the phase line names them.
 *
 * @type {readonly RequiredScenario[]}
 */
export const V5_REQUIRED_SCENARIOS = [
  {
    id: 'digest-delivery',
    scenario: 'digest delivery',
    coverage: {
      kind: 'playwright',
      tests: [
        {
          spec: 'e2e/notification-digest.spec.ts',
          title:
            'digest: a daily-digest user gets exactly one matrix-honoring summary for the period',
        },
      ],
    },
  },
  {
    id: 'de-tax-fixture',
    scenario: 'DE tax fixture flow',
    coverage: {
      kind: 'playwright',
      tests: [
        {
          spec: 'e2e/tax-de.spec.ts',
          title:
            'DE tax mode: FIFO, Sparer-Pauschbetrag exhaustion, both loss pots, and report exports',
        },
      ],
    },
  },
  {
    id: 'mirrorchain-flows',
    scenario: 'mirrorchain join / write-propagation / kick-fork / transfer',
    coverage: {
      kind: 'playwright',
      // Four arcs, four separate assertions: the lifecycle test carries join and
      // transfer through the UI, and the three below own propagation, the fork
      // severance and the ownership handover on their own.
      tests: [
        {
          spec: 'e2e/mirrorchain.spec.ts',
          title: 'mirrorchain: invite, join, fork severance, and transfer work through the UI',
        },
        {
          spec: 'e2e/mirrorchain.spec.ts',
          title: 'mirrorchain: a member buy propagates to every copy, attributed',
        },
        {
          spec: 'e2e/mirrorchain.spec.ts',
          title: 'mirrorchain: a kick leaves a fully working, un-synced fork',
        },
        {
          spec: 'e2e/mirrorchain.spec.ts',
          title: 'mirrorchain: transfer makes the target owner and demotes the old owner',
        },
      ],
    },
  },
  {
    id: 'comments-and-groups',
    scenario: 'comments / groups',
    coverage: {
      kind: 'playwright',
      tests: [
        {
          spec: 'e2e/social-comments.spec.ts',
          title: 'comments: audience-scoped thread, reactions, delete-own and owner moderation',
        },
        {
          spec: 'e2e/friend-groups.spec.ts',
          title: 'friend groups: a portfolio shared to a group is visible to members only',
        },
      ],
    },
  },
  {
    id: 'expense-import-budget-alert',
    scenario: 'expense import → budget alert',
    coverage: {
      kind: 'waived',
      deadTests: [
        {
          spec: 'e2e/expenses-budget.spec.ts',
          title:
            'expenses: bank import → categorize → dashboard → single budget alert, portfolio untouched',
        },
      ],
      reason:
        'The V5 cash fusion retired the expense_* island: /portfolio/cash/import is a parked ' +
        'placeholder with no upload form to drive, the starter categories this spec selected by ' +
        'label no longer exist, and the rule/budget dialogs changed shape. No browser path exists ' +
        'until statement import re-lands against the fused portfolio cash ledger. The server-side ' +
        'guarantee (one budget.exceeded alert per period however often it is evaluated) is proven ' +
        'meanwhile by apps/api/src/__tests__/cashTagging.test.ts.',
      blockedBy: 1660,
      waivedOn: '2026-09-03',
    },
  },
  {
    id: 'webhook-delivery',
    scenario: 'webhook delivery',
    coverage: {
      kind: 'playwright',
      tests: [
        {
          spec: 'e2e/webhooks.spec.ts',
          title: 'webhooks: a Settings-created webhook delivers a verifiable signed payload',
        },
        {
          spec: 'e2e/webhooks.spec.ts',
          title: 'webhooks: a dead receiver retries, auto-disables, and re-enables from Settings',
        },
      ],
    },
  },
  {
    id: 'standing-order-forecast',
    scenario: 'standing-order + forecast flow',
    coverage: {
      kind: 'playwright',
      tests: [
        {
          spec: 'e2e/forecast.spec.ts',
          title: 'forecast: a scheduled cash-add lifts the enabled one-year projection',
        },
      ],
    },
  },
  {
    id: 'paranoid-drive-only-round-trip',
    scenario: 'paranoid Drive-only round trip',
    coverage: {
      kind: 'waived',
      // Dead in BOTH implementations — the account-level v1 arc and the
      // per-vault E10 arc. Listing both keeps either resurrection visible.
      deadTests: [
        {
          spec: 'e2e/paranoid.spec.ts',
          title:
            'Drive-only enable → lock/reload → tamper fail-closed → verified media switch → disable',
        },
        {
          spec: 'e2e/paranoid-e10.spec.ts',
          title:
            '[E10-A9] Drive-only vault round trip (blocked: PER_VAULT_DRIVE_PROVISIONING_AVAILABLE === false)',
        },
      ],
      reason:
        'PER_VAULT_DRIVE_PROVISIONING_AVAILABLE is false (apps/web/src/user/vault/capabilities.ts) ' +
        'and provisionVault.ts refuses any media containing drive, so no per-vault Drive document ' +
        'can be written to round-trip; the account-level v1 arc that used to carry this coverage is ' +
        'itself quarantined since the §16 2026-08-30 entry-point retirement. The product has NO ' +
        'Drive-medium e2e at all. What the flag DOES ship — an honest, disabled option naming the ' +
        'missing epic — is asserted by [E10-A5], which fails the moment the flag flips.',
      blockedBy: 1638,
      waivedOn: '2026-09-03',
    },
  },
  {
    id: 'nl-builder-draft',
    scenario: 'NL builder draft',
    coverage: {
      kind: 'playwright',
      tests: [
        {
          spec: 'e2e/nl-builder.spec.ts',
          title: 'nl builder: a local-provider draft is reviewed and confirmed before it commits',
        },
      ],
    },
  },
  {
    id: 'empty-error-loading-sweep',
    scenario: 'empty / error / loading sweep',
    coverage: {
      kind: 'vitest',
      spec: 'apps/web/src/i18n/v5SurfaceInventory.test.ts',
      note:
        'Covered mechanically by an AST inventory over every v5 surface rather than by a browser ' +
        'walk, and gated per-PR by the web vitest suite — not by this nightly run. This manifest ' +
        'asserts only that the named suite still EXISTS; whether it still asserts anything is the ' +
        "web package's own vitest gate.",
    },
  },
];

/**
 * A named STEP proof, as opposed to a whole-test proof.
 *
 * `host` is the test the step lives inside, so `e2e/v5-gate.spec.ts` can hold a
 * step proof to the same liveness rule as a mapped scenario: a proof whose host
 * is dead MUST carry `waived`, and a waived proof whose host has come back to
 * life MUST lose it.
 *
 * @typedef {object} StepProof
 * @property {string} id
 * @property {string} step the exact `test.step(...)` title
 * @property {number} expected how many successful occurrences a live run owes
 * @property {string} why
 * @property {SpecTest} host the test declaration the step runs inside
 * @property {{ reason: string, blockedBy: number, waivedOn: string } | undefined} [waived]
 *   set only while the host is quarantined; reported as a gap, not a failure
 */

/**
 * Named STEP proofs, as opposed to whole-test proofs.
 *
 * The PD9 cleartext probe is not one of the ten scenarios; it is a
 * proof-of-absence asserted by a single step INSIDE a paranoid test, and it has
 * to be counted exactly once (two copies would mean the probe ran against a
 * second, unaudited database). It predates this manifest as a hand-rolled check
 * in the merge job. Rather than leave a second bespoke report parser alongside
 * this one, it is subsumed here: same records, same run, same summary.
 *
 * It is subsumed WITH its own waiver, because the step is in exactly the state
 * this manifest exists to make visible: its host test is the very declaration
 * the `paranoid-drive-only-round-trip` scenario waives, so the probe cannot run
 * and the old hand-rolled `!== 1` check was an unreachable green. A waived step
 * proof is a `::warning::` gap like a waived scenario — and, like a waived
 * scenario, it turns the gate RED the moment the step starts occurring again.
 *
 * @type {readonly StepProof[]}
 */
export const V5_STEP_PROOFS = [
  {
    id: 'pd9-cleartext-probe',
    step: '[PD9-A2] complete DB cleartext probe',
    expected: 1,
    why: 'Exactly one successful sweep of the whole database for paranoid cleartext.',
    host: {
      spec: 'e2e/paranoid.spec.ts',
      title:
        'Drive-only enable → lock/reload → tamper fail-closed → verified media switch → disable',
    },
    waived: {
      reason:
        'The probe is a step inside the account-level Drive-only arc, which opts out ' +
        'unconditionally since the §16 2026-08-30 entry-point retirement — the same declaration the ' +
        '`paranoid-drive-only-round-trip` scenario waives. A skipped test emits no step records, so ' +
        'requiring the probe would keep the nightly red forever while proving nothing. The ' +
        'server-side half of the guarantee still runs: PARANOID_PROBE_HANDLER_NAMES and the ' +
        'purge/probe repositories are covered by the API suite. Retire this waiver together with ' +
        'the sibling scenario waiver when a live Drive-medium arc returns.',
      blockedBy: 1638,
      waivedOn: '2026-09-03',
    },
  },
];

/**
 * One blob-report record. Deliberately loose: the shape is Playwright's
 * internal tele-reporter protocol, and this module only reaches for the four
 * fields it needs.
 *
 * @typedef {{ method?: string, params?: any }} ReportRecord
 */

/**
 * @param {string} text concatenated `report.jsonl` payloads from every shard
 * @returns {ReportRecord[]}
 */
export function parseReportRecords(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => /** @type {ReportRecord} */ (JSON.parse(line)));
}

/**
 * Last path segment, so a repo-relative manifest path (`e2e/forecast.spec.ts`)
 * and whatever the report calls the same file (Playwright titles file suites
 * relative to `testDir`) reduce to the same key.
 *
 * @param {unknown} path
 * @returns {string}
 */
function fileKey(path) {
  const cleaned = String(path ?? '').replaceAll('\\', '/');
  return cleaned.slice(cleaned.lastIndexOf('/') + 1);
}

/**
 * `spec::title` — the key grading is done on, so two specs may share a title
 * without grading each other's results.
 *
 * @param {string} spec
 * @param {string} title
 * @returns {string}
 */
function qualifiedKey(spec, title) {
  return `${fileKey(spec)}::${title}`;
}

/**
 * @param {any} suite
 * @param {string} file the enclosing file suite's title
 * @param {Map<string, { title: string, file: string }>} testsById
 * @returns {void}
 */
function collectSuiteTests(suite, file, testsById) {
  for (const entry of suite?.entries ?? []) {
    if (typeof entry?.testId === 'string') {
      testsById.set(entry.testId, { title: String(entry.title), file });
    } else {
      collectSuiteTests(entry, file, testsById);
    }
  }
}

/**
 * @typedef {object} ReportIndex
 * @property {Map<string, string[]>} statusesByKey every result status seen per `spec::title`
 * @property {Set<string>} collectedKeys every `spec::title` the run collected, run or not
 * @property {Map<string, string[]>} statusesByTitle the same, keyed on title alone
 * @property {Set<string>} collectedTitles every title the run collected, run or not
 */

/**
 * Fold a merged blob report into "which titles were collected, and what did
 * each of their results end up as".
 *
 * Titles rather than ids on purpose. A spec runs once per Playwright project,
 * so one title yields several results, and the LEGITIMATE conditional skips
 * (`testInfo.project.name !== 'chromium'`, `skipOnPhone`) show up as a
 * `skipped` result in one project beside a `passed` one in the other. Grading
 * on "at least one passing result" therefore lets conditional skips through
 * untouched while an unconditional skip — which yields `skipped` in every
 * project and nothing else — falls straight through to failed.
 *
 * @param {ReportRecord[]} records
 * @returns {ReportIndex}
 */
export function indexReport(records) {
  /** @type {Map<string, { title: string, file: string }>} */
  const testsById = new Map();
  for (const record of records) {
    if (record.method !== 'onProject') continue;
    for (const suite of record.params?.project?.suites ?? []) {
      collectSuiteTests(suite, fileKey(suite?.title), testsById);
    }
  }

  /** @type {Map<string, string[]>} */
  const statusesByKey = new Map();
  /** @type {Map<string, string[]>} */
  const statusesByTitle = new Map();
  /** @type {(map: Map<string, string[]>, key: string, status: string) => void} */
  const record_ = (map, key, status) => {
    const seen = map.get(key);
    if (seen) seen.push(status);
    else map.set(key, [status]);
  };
  for (const record of records) {
    if (record.method !== 'onTestEnd') continue;
    const testId = record.params?.test?.testId;
    const status = record.params?.result?.status;
    if (typeof testId !== 'string' || typeof status !== 'string') continue;
    const test = testsById.get(testId);
    if (test === undefined) continue;
    record_(statusesByKey, `${test.file}::${test.title}`, status);
    record_(statusesByTitle, test.title, status);
  }

  const collected = [...testsById.values()];
  return {
    statusesByKey,
    collectedKeys: new Set(collected.map((test) => `${test.file}::${test.title}`)),
    statusesByTitle,
    collectedTitles: new Set(collected.map((test) => test.title)),
  };
}

/**
 * Look one manifest entry up in the index.
 *
 * Qualified (`spec::title`) first, so two specs cannot grade each other's
 * results. The title-only fallback exists for one case only: a report that
 * carried no recognisable file title for the test (a tele-reporter shape
 * change). Falling back there degrades to the pre-#1683 behaviour instead of
 * reporting a false "never collected" for a whole green run.
 *
 * @param {ReportIndex} index
 * @param {SpecTest} test
 * @returns {{ collected: boolean, statuses: string[] }}
 */
function lookup(index, test) {
  const key = qualifiedKey(test.spec, test.title);
  if (index.collectedKeys.has(key)) {
    return { collected: true, statuses: index.statusesByKey.get(key) ?? [] };
  }
  if (index.collectedTitles.has(test.title)) {
    return { collected: true, statuses: index.statusesByTitle.get(test.title) ?? [] };
  }
  return { collected: false, statuses: [] };
}

/**
 * @typedef {object} ScenarioEvaluation
 * @property {string} id
 * @property {string} scenario
 * @property {'covered' | 'waived' | 'failed'} status
 * @property {string} proof one-line, human-readable provenance
 * @property {string[]} problems empty unless `status === 'failed'`
 */

/**
 * @param {ReportIndex} index
 * @param {SpecTest} test
 * @returns {string | null} a problem description, or null when the test passed
 */
function passProblem(index, test) {
  const { collected, statuses } = lookup(index, test);
  if (statuses.includes('passed')) return null;
  if (!collected) {
    return `${test.spec} — "${test.title}" was never collected by the run (spec renamed, moved or not discovered).`;
  }
  if (statuses.length === 0) {
    return `${test.spec} — "${test.title}" was collected but produced no result.`;
  }
  return `${test.spec} — "${test.title}" never passed; results were: ${statuses.join(', ')}.`;
}

/**
 * Grade every required scenario against a merged report.
 *
 * @param {ReportIndex} index
 * @param {readonly RequiredScenario[]} [scenarios]
 * @returns {ScenarioEvaluation[]}
 */
export function evaluateRequiredScenarios(index, scenarios = V5_REQUIRED_SCENARIOS) {
  return scenarios.map((scenario) => {
    const { coverage } = scenario;

    if (coverage.kind === 'vitest') {
      return {
        id: scenario.id,
        scenario: scenario.scenario,
        /** @type {'covered'} */ status: 'covered',
        proof: `vitest ${coverage.spec}`,
        problems: [],
      };
    }

    if (coverage.kind === 'waived') {
      // A waiver that has outlived its blocker is as misleading as a silent
      // skip: it keeps reporting a gap the suite has actually closed. Fail on
      // it so the manifest is forced back into agreement with reality.
      const revived = coverage.deadTests.filter((test) =>
        lookup(index, test).statuses.includes('passed'),
      );
      return {
        id: scenario.id,
        scenario: scenario.scenario,
        status: revived.length > 0 ? 'failed' : 'waived',
        proof: `waived — blocked by #${coverage.blockedBy} since ${coverage.waivedOn}`,
        problems: revived.map(
          (test) =>
            `"${test.title}" passed, so the #${coverage.blockedBy} waiver is stale — retire it in e2e/support/v5Gate.mjs.`,
        ),
      };
    }

    const problems = coverage.tests
      .map((test) => passProblem(index, test))
      .filter(/** @returns {problem is string} */ (problem) => problem !== null);
    return {
      id: scenario.id,
      scenario: scenario.scenario,
      status: problems.length > 0 ? 'failed' : 'covered',
      proof: `${coverage.tests.length} Playwright test(s)`,
      problems,
    };
  });
}

/**
 * @typedef {object} StepProofEvaluation
 * @property {string} id
 * @property {string} step
 * @property {number} expected how many occurrences a LIVE proof owes
 * @property {number} found
 * @property {'proven' | 'waived' | 'failed'} status
 * @property {string} proof one-line, human-readable provenance
 * @property {string[]} problems empty unless `status === 'failed'`
 */

/**
 * Count the successful occurrences of each named step proof, and grade them.
 *
 * A step counts only when its own `onStepEnd` carried no error AND the result
 * it belongs to ended `passed` — a step that "completed" inside a test that
 * later blew up proves nothing.
 *
 * A `waived` proof inverts the rule: its host test is quarantined, so the step
 * MUST NOT occur. Zero occurrences is the reported gap; any occurrence means
 * the host is alive again and the waiver is stale, which fails exactly like a
 * revived scenario waiver does.
 *
 * @param {ReportRecord[]} records
 * @param {readonly StepProof[]} [proofs]
 * @returns {StepProofEvaluation[]}
 */
export function evaluateStepProofs(records, proofs = V5_STEP_PROOFS) {
  const passedResultIds = new Set(
    records
      .filter(
        (record) => record.method === 'onTestEnd' && record.params?.result?.status === 'passed',
      )
      .map((record) => String(record.params.result.id)),
  );
  const completedSteps = new Set(
    records
      .filter((record) => record.method === 'onStepEnd' && !record.params?.step?.error)
      .map(
        (record) => `${record.params.testId}:${record.params.resultId}:${record.params.step.id}`,
      ),
  );

  return proofs.map((proof) => {
    const found = records.filter((record) => {
      if (
        record.method !== 'onStepBegin' ||
        record.params?.step?.title !== proof.step ||
        !passedResultIds.has(String(record.params?.resultId))
      ) {
        return false;
      }
      return completedSteps.has(
        `${record.params.testId}:${record.params.resultId}:${record.params.step.id}`,
      );
    }).length;

    if (proof.waived) {
      const stale = found > 0;
      return {
        id: proof.id,
        step: proof.step,
        expected: proof.expected,
        found,
        /** @type {'waived' | 'failed'} */ status: stale ? 'failed' : 'waived',
        proof: `waived — blocked by #${proof.waived.blockedBy} since ${proof.waived.waivedOn}`,
        problems: stale
          ? [
              `"${proof.step}" ran ${found} time(s), so the #${proof.waived.blockedBy} waiver is stale — ` +
                'restore it as a required step proof in e2e/support/v5Gate.mjs.',
            ]
          : [],
      };
    }

    const ok = found === proof.expected;
    return {
      id: proof.id,
      step: proof.step,
      expected: proof.expected,
      found,
      /** @type {'proven' | 'failed'} */ status: ok ? 'proven' : 'failed',
      proof: `${found}/${proof.expected} successful`,
      problems: ok
        ? []
        : [`Expected ${proof.expected} successful "${proof.step}" step(s); found ${found}.`],
    };
  });
}

/**
 * @typedef {object} GateReport
 * @property {boolean} ok
 * @property {number} covered
 * @property {number} waived
 * @property {number} failed
 * @property {string[]} summary GitHub-flavoured markdown for the job summary
 * @property {string[]} annotations `::error::` / `::warning::` workflow commands
 */

/**
 * @param {ScenarioEvaluation[]} evaluations
 * @param {StepProofEvaluation[]} stepProofs
 * @returns {GateReport}
 */
export function formatGateReport(evaluations, stepProofs) {
  const covered = evaluations.filter((entry) => entry.status === 'covered').length;
  const waived = evaluations.filter((entry) => entry.status === 'waived').length;
  const failed = evaluations.filter((entry) => entry.status === 'failed').length;
  const badge = { covered: '✅ covered', waived: '⚠️ waived', failed: '❌ failed' };

  /** @type {string[]} */
  const summary = [
    '### V5-P14 required scenarios',
    '',
    // The headline the phase gate is read against: "green" can no longer be
    // mistaken for "all ten ran".
    `**${covered} covered · ${waived} waived · ${failed} failed** of ${evaluations.length} required scenarios.`,
    '',
    '| Scenario | Status | Proof |',
    '| --- | --- | --- |',
    ...evaluations.map(
      (entry) => `| ${entry.scenario} | ${badge[entry.status]} | ${entry.proof} |`,
    ),
    '',
  ];

  /** @type {string[]} */
  const annotations = [];
  for (const entry of evaluations) {
    if (entry.status === 'waived') {
      annotations.push(
        `::warning::V5-P14 scenario "${entry.scenario}" is WAIVED — ${entry.proof}. It is a known gap, not coverage.`,
      );
    }
    for (const problem of entry.problems) {
      annotations.push(`::error::V5-P14 scenario "${entry.scenario}": ${problem}`);
    }
  }

  const stepBadge = { proven: '✅', waived: '⚠️', failed: '❌' };
  for (const proof of stepProofs) {
    summary.push(`- ${stepBadge[proof.status]} step proof \`${proof.step}\`: ${proof.proof}.`);
    if (proof.status === 'waived') {
      annotations.push(
        `::warning::V5-P14 step proof "${proof.step}" is WAIVED — ${proof.proof}. Its host test is quarantined, so the probe does not run. It is a known gap, not coverage.`,
      );
    }
    for (const problem of proof.problems) {
      annotations.push(`::error::V5-P14 step proof: ${problem}`);
    }
  }

  return {
    ok: failed === 0 && stepProofs.every((proof) => proof.status !== 'failed'),
    covered,
    waived,
    failed,
    summary,
    annotations,
  };
}
