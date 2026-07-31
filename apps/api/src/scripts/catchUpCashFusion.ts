import { pathToFileURL } from 'node:url';

import { loadConfig } from '../config/env';
import { createDatabase } from '../data/db';
import {
  CASH_FUSION_TAG,
  createCashFusionCatchUpRepository,
  type CashFusionCatchUpRepository,
} from '../data/repositories/cashFusionCatchUpRepository';
import {
  centsToNumericText,
  parseCents,
  planIsEmpty,
  planOwnerCatchUp,
  spendingPortfolioId,
  spendingSourceId,
  type OwnerPlan,
} from './cashFusionCatchUpCore';

/**
 * CATCH-UP SYNC for the V5 cash fusion (`0076_cash_fusion`).
 *
 * 0076 moved every `expense_*` row onto the portfolio cash ledger but left the
 * old tables in place and `/api/v1/expenses` writable, so every row written
 * through those routes since the deploy is missing from the fused tables. This
 * script closes that gap with the SAME id-borrowing, name-collapsing, sign and
 * merge rules the migration used, and must be run BEFORE the fused surfaces
 * become the only ones — otherwise the flip silently drops the divergence.
 *
 * All decisions live in `cashFusionCatchUpCore.ts` (pure, database-free); all SQL
 * in `data/repositories/cashFusionCatchUpRepository.ts`. This file is the CLI.
 *
 * SAFE TO RE-RUN. Every inserted row's primary key is borrowed from its source
 * row or derived deterministically from the owner, so a second run plans nothing.
 * Each owner is applied in one transaction that re-derives the reconciliation and
 * rolls itself back on any mismatch — an owner either lands whole and balances to
 * the cent, or is untouched and reported as failed. One owner's failure never
 * abandons the rest.
 *
 * Run inside the api container, which already has the env:
 *   pnpm catchup:cash-fusion --dry-run   # report only, writes nothing
 *   pnpm catchup:cash-fusion --apply
 */

export interface CatchUpCashFusionOptions {
  dryRun: boolean;
  repository: CashFusionCatchUpRepository;
  /** Per-owner progress sink; defaults to silence (tests). */
  onOwner?: (entry: OwnerReport) => void;
}

export interface OwnerReport {
  userId: string;
  portfolioId: string;
  createdPortfolio: boolean;
  tags: number;
  movements: number;
  movementTags: number;
  budgets: number;
  fires: number;
  rules: number;
  ruleTags: number;
  /** Signed cents this owner's plan adds to the fused ledger. */
  netCents: number;
  /** Pre-fusion expense rows with no fused counterpart — reported, never migrated. */
  orphanedPreFusion: number;
  /** Fused movements whose tag set disagrees with the old category — left alone. */
  divergedTagLinks: number;
  applied: boolean;
  /** Set when the owner could not be planned or the apply rolled back. */
  error: string | null;
}

export interface CatchUpTotals {
  tags: number;
  movements: number;
  movementTags: number;
  budgets: number;
  fires: number;
  rules: number;
  ruleTags: number;
  netCents: number;
  orphanedPreFusion: number;
  divergedTagLinks: number;
}

export interface CatchUpReport {
  mode: 'dry-run' | 'apply';
  /** The instant 0076 ran, as the database reports it. */
  fusionAppliedAt: string;
  owners: number;
  ownersWithWork: number;
  applied: number;
  failed: number;
  blocked: number;
  totals: CatchUpTotals;
  /** Net cents the fused ledger gains, as a decimal for the human reading it. */
  netEur: string;
  ownerReports: OwnerReport[];
}

function emptyTotals(): CatchUpTotals {
  return {
    tags: 0,
    movements: 0,
    movementTags: 0,
    budgets: 0,
    fires: 0,
    rules: 0,
    ruleTags: 0,
    netCents: 0,
    orphanedPreFusion: 0,
    divergedTagLinks: 0,
  };
}

/**
 * How many cents this plan's new movements add to the ledger. Summed off the
 * signed `numeric(20,2)` text that will actually be stored, in integer cents, so
 * the reported figure is exactly the money being written.
 */
function planNetCents(plan: OwnerPlan): number {
  return plan.movements.reduce((net, movement) => net + parseCents(movement.amountEur), 0);
}

function reportFor(plan: OwnerPlan, applied: boolean, error: string | null): OwnerReport {
  return {
    userId: plan.userId,
    portfolioId: plan.portfolioId,
    createdPortfolio: plan.createPortfolio !== null,
    tags: plan.tags.length,
    movements: plan.movements.length,
    movementTags: plan.movementTags.length,
    budgets: plan.budgets.length,
    fires: plan.fires.length,
    rules: plan.rules.length,
    ruleTags: plan.ruleTags.length,
    netCents: planNetCents(plan),
    orphanedPreFusion: plan.orphanedPreFusion,
    divergedTagLinks: plan.divergedTagLinks,
    applied,
    error,
  };
}

/**
 * Migrate every not-yet-fused expense row. Reports what it would do under
 * `--dry-run` without opening a write transaction.
 *
 * Throws only when the precondition fails (0076 not applied) — a per-owner
 * failure is recorded in that owner's report and the run continues.
 */
export async function catchUpCashFusion(options: CatchUpCashFusionOptions): Promise<CatchUpReport> {
  const { dryRun, repository } = options;

  const fusionAppliedAt = await repository.fusionAppliedAt();
  if (fusionAppliedAt === null) {
    throw new Error(
      `Migration ${CASH_FUSION_TAG} has not been applied to this database. ` +
        'There is nothing to catch up to — run the migrations first.',
    );
  }

  const owners = await repository.listOwners();
  const ownerReports: OwnerReport[] = [];
  const totals = emptyTotals();
  let ownersWithWork = 0;
  let applied = 0;
  let failed = 0;
  let blocked = 0;

  for (const userId of owners) {
    let entry: OwnerReport;
    try {
      const snapshot = await repository.loadOwner(
        userId,
        spendingPortfolioId(userId),
        spendingSourceId(userId),
      );
      const plan = planOwnerCatchUp(snapshot, fusionAppliedAt);

      if (plan.blocked !== null) {
        blocked += 1;
        entry = reportFor(plan, false, plan.blocked);
      } else if (planIsEmpty(plan)) {
        // Nothing to write, but the orphan/divergence counts still matter.
        entry = reportFor(plan, false, null);
      } else {
        ownersWithWork += 1;
        if (dryRun) {
          entry = reportFor(plan, false, null);
        } else {
          await repository.applyOwnerPlan(plan, fusionAppliedAt);
          applied += 1;
          entry = reportFor(plan, true, null);
        }
      }
    } catch (err) {
      // One owner's failure must not abandon the rest; the operator re-runs and
      // an already-caught-up owner simply plans nothing.
      failed += 1;
      entry = {
        userId,
        portfolioId: spendingPortfolioId(userId),
        createdPortfolio: false,
        tags: 0,
        movements: 0,
        movementTags: 0,
        budgets: 0,
        fires: 0,
        rules: 0,
        ruleTags: 0,
        netCents: 0,
        orphanedPreFusion: 0,
        divergedTagLinks: 0,
        applied: false,
        error: err instanceof Error ? err.message : 'unknown error',
      };
    }

    totals.tags += entry.tags;
    totals.movements += entry.movements;
    totals.movementTags += entry.movementTags;
    totals.budgets += entry.budgets;
    totals.fires += entry.fires;
    totals.rules += entry.rules;
    totals.ruleTags += entry.ruleTags;
    totals.netCents += entry.netCents;
    totals.orphanedPreFusion += entry.orphanedPreFusion;
    totals.divergedTagLinks += entry.divergedTagLinks;

    ownerReports.push(entry);
    options.onOwner?.(entry);
  }

  return {
    mode: dryRun ? 'dry-run' : 'apply',
    fusionAppliedAt: fusionAppliedAt.toISOString(),
    owners: owners.length,
    ownersWithWork,
    applied,
    failed,
    blocked,
    totals,
    netEur: centsToNumericText(totals.netCents),
    ownerReports,
  };
}

export interface CatchUpCliOptions {
  dryRun: boolean;
}

export function parseCatchUpArgs(argv: readonly string[]): CatchUpCliOptions {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  if (dryRun === apply) {
    throw new Error('Choose exactly one of --dry-run or --apply.');
  }
  const known = new Set(['--dry-run', '--apply']);
  for (const arg of args) {
    if (!known.has(arg)) throw new Error('Unknown argument.');
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const cli = parseCatchUpArgs(process.argv);
  const config = loadConfig();
  const { db, client } = createDatabase(config.databaseUrl);

  try {
    const report = await catchUpCashFusion({
      dryRun: cli.dryRun,
      repository: createCashFusionCatchUpRepository(db),
      // One line per owner that has work or something to flag, so a long
      // production run shows progress and leaves a record of what was touched.
      onOwner: (entry) => {
        const notable =
          entry.movements > 0 ||
          entry.tags > 0 ||
          entry.budgets > 0 ||
          entry.rules > 0 ||
          entry.orphanedPreFusion > 0 ||
          entry.divergedTagLinks > 0 ||
          entry.error !== null;
        if (notable) console.log(JSON.stringify(entry));
      },
    });
    console.log(JSON.stringify({ ...report, ownerReports: undefined }));
    if (report.failed > 0 || report.blocked > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    console.error(
      `Cash-fusion catch-up failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}
