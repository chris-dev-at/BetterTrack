import { pathToFileURL } from 'node:url';

import { loadConfig } from '../config/env';
import { createDatabase } from '../data/db';
import {
  createPortfolioSnapshotRepository,
  type PortfolioSnapshotRepository,
} from '../data/repositories/portfolioSnapshotRepository';

/**
 * One-off repair for the taxed-sell flow bug (#125 follow-up to 985e795).
 *
 * The engine predicate is fixed, but stored snapshot rows are served verbatim
 * while the state is clean, so every portfolio that recorded a taxed sell whose
 * proceeds left the portfolio still serves the wrong curve. The nightly roll
 * only overwrites a trailing 35 days (`SNAPSHOT_HEAL_WINDOW_DAYS`, sized for
 * provider close revisions), and the performance index is chain-linked — one
 * wrong flow day corrupts every later point — so an old taxed sell stays wrong
 * forever without this.
 *
 * The repair is deliberately just an INVALIDATION from each affected
 * portfolio's first event day, which is the codebase's existing "this
 * portfolio's history changed at day X" primitive: mark the state dirty, then
 * delete the derived rows from that day. Nothing else is touched — no
 * transaction, cash movement or user row is read for anything but selection,
 * and no user data is deleted.
 *
 * Rebuild then happens through the paths that already exist:
 *  - the very next read sees a dirty state, serves the live engine (correct,
 *    post-fix) and opportunistically refills the rows, so correctness is
 *    immediate rather than job-dependent;
 *  - the nightly `snapshots.backfill` re-persists the full history durably.
 *
 * Doing it this way keeps the script free of the provider/currency graph: it
 * opens one database connection and issues two writes per portfolio, so it
 * cannot stall on a provider or spend a rate-limit budget.
 *
 * **Idempotent in outcome, not a literal no-op.** A second run re-invalidates
 * the same portfolios and the rebuild reproduces byte-identical rows; it costs
 * one more rebuild rather than corrupting anything. Re-running after a partial
 * failure is the intended recovery.
 */

export interface RepairTaxedSellSnapshotsOptions {
  dryRun: boolean;
  snapshotRepo: Pick<
    PortfolioSnapshotRepository,
    'listTaxedSellFlowRepairTargets' | 'markDirty' | 'deleteFrom'
  >;
  /** Per-portfolio progress sink; defaults to silence (tests). */
  onPortfolio?: (entry: RepairedPortfolio) => void;
}

export interface RepairedPortfolio {
  portfolioId: string;
  /** The day the rebuild starts from (the portfolio's first event). */
  firstEventDay: string;
  /** False when the portfolio was selected but the write failed. */
  invalidated: boolean;
}

export interface RepairReport {
  mode: 'dry-run' | 'apply';
  /** Portfolios matching the corruption signature. */
  affected: number;
  /** Portfolios whose snapshots were invalidated (0 in dry-run). */
  invalidated: number;
  failed: number;
  portfolios: RepairedPortfolio[];
}

/**
 * Select every portfolio corrupted by the taxed-sell flow bug and invalidate
 * its snapshots from inception. Safe to re-run.
 */
export async function repairTaxedSellSnapshots(
  options: RepairTaxedSellSnapshotsOptions,
): Promise<RepairReport> {
  const { dryRun, snapshotRepo } = options;
  const targets = await snapshotRepo.listTaxedSellFlowRepairTargets();

  const portfolios: RepairedPortfolio[] = [];
  let invalidated = 0;
  let failed = 0;

  for (const target of targets) {
    const entry: RepairedPortfolio = {
      portfolioId: target.portfolioId,
      firstEventDay: target.firstEventDay,
      invalidated: false,
    };

    if (!dryRun) {
      try {
        // Same order as PortfolioSnapshotService.invalidate: the dirty marker
        // lands BEFORE the row delete, so a reader interleaving with the repair
        // falls back to the engine instead of serving a gapped series.
        await snapshotRepo.markDirty(target.portfolioId, target.firstEventDay);
        await snapshotRepo.deleteFrom(target.portfolioId, target.firstEventDay);
        entry.invalidated = true;
        invalidated += 1;
      } catch {
        // One portfolio's failure must not abandon the rest; the operator
        // re-runs, and an already-repaired portfolio simply repairs again.
        failed += 1;
      }
    }

    portfolios.push(entry);
    options.onPortfolio?.(entry);
  }

  return {
    mode: dryRun ? 'dry-run' : 'apply',
    affected: targets.length,
    invalidated,
    failed,
    portfolios,
  };
}

export interface RepairCliOptions {
  dryRun: boolean;
}

export function parseRepairArgs(argv: readonly string[]): RepairCliOptions {
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
  const cli = parseRepairArgs(process.argv);
  const config = loadConfig();
  const { db, client } = createDatabase(config.databaseUrl);

  try {
    const report = await repairTaxedSellSnapshots({
      dryRun: cli.dryRun,
      snapshotRepo: createPortfolioSnapshotRepository(db),
      // Per-portfolio line so a long production run shows progress, and so the
      // operator has a record of exactly which portfolios were touched.
      onPortfolio: (entry) => {
        console.log(
          JSON.stringify({
            portfolioId: entry.portfolioId,
            from: entry.firstEventDay,
            invalidated: entry.invalidated,
          }),
        );
      },
    });
    console.log(JSON.stringify({ ...report, portfolios: undefined }));
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    console.error(
      `Snapshot repair failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}
