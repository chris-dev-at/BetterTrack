/**
 * CLI half of the V5-P14 scenario gate: reads the merged Playwright blob
 * report, grades it against `e2e/support/v5Gate.mjs`, writes the job summary
 * and exits non-zero when a required scenario did not run and pass.
 *
 *     node e2e/support/v5GateReport.mjs <combined-report.jsonl>
 *
 * The argument is the concatenation of every shard's `report.jsonl` (see
 * `.github/workflows/e2e-nightly.yml`). All grading logic lives in `v5Gate.mjs`
 * so `e2e/v5-gate.spec.ts` can drive it against synthetic reports; this file is
 * deliberately nothing but IO.
 */
import { appendFileSync, readFileSync } from 'node:fs';

import {
  evaluateRequiredScenarios,
  evaluateStepProofs,
  formatGateReport,
  indexReport,
  parseReportRecords,
} from './v5Gate.mjs';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('usage: node e2e/support/v5GateReport.mjs <combined-report.jsonl>');
  process.exit(2);
}

const records = parseReportRecords(readFileSync(reportPath, 'utf8'));
const report = formatGateReport(
  evaluateRequiredScenarios(indexReport(records)),
  evaluateStepProofs(records),
);

for (const line of report.summary) console.log(line);
for (const annotation of report.annotations) console.log(annotation);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.summary.join('\n')}\n`);
}

if (!report.ok) {
  // Name BOTH halves: the run can be red because a required scenario never
  // passed, because a step proof did not occur exactly as many times as it must,
  // or both. Reporting only the scenario count sent a reader looking in the
  // wrong place when it was the step proof that tripped.
  console.error(
    `V5-P14 gate FAILED: ${report.failed} required scenario(s) did not run and pass; ` +
      'see the ::error:: annotations above for the step proofs.',
  );
  process.exit(1);
}
