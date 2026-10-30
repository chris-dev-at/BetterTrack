import type {
  FxHoleScanTarget,
  PortfolioSnapshotRepository,
  SnapshotRowRecord,
} from '../../data/repositories/portfolioSnapshotRepository';
import type {
  TransactionRecord,
  TransactionRepository,
} from '../../data/repositories/transactionRepository';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';
import {
  findVanishedHoldings,
  SNAPSHOT_PERSIST_GUARD_VERSION,
  type PortfolioSnapshotService,
  type VanishedHolding,
} from './portfolioSnapshots';

/**
 * One-off repair of the FX-probe history holes (issue #1729).
 *
 * Before #1729's fix, ONE failed `EUR{ccy}=X` convertibility probe dropped every
 * asset of that currency from a whole snapshot run, and the run was persisted
 * as clean. The nightly roll only rewrites its heal window `[run−35, run−1]`,
 * so the oldest day of each degraded night froze without those assets for
 * good — the owner's 2026-08-08/09 hole. The fix stops new holes; this repairs
 * the frozen ones, and it ships as code because nobody can run SQL against
 * production.
 *
 * **Algorithm.**
 *  1. Gate ({@link checkFxHoleRepairGate}): refuse to run unless this build's
 *     snapshot writer carries both persist-time refusals.
 *  2. Enumerate, read-only: for every non-vaulted portfolio with stored rows,
 *     the earliest stored day on which an asset that an EARLIER row carries,
 *     and that the CURRENT transactions still hold, is missing
 *     ({@link earliestFxHole} — the writer's own {@link findVanishedHoldings}
 *     walk, anchored at each asset's first keyed row). The counts are recorded
 *     as `snapshots.fx_hole_repair_enumerated` BEFORE anything is touched.
 *  3. Repair, per hit: the service's own `invalidate(portfolioId, earliestHole)`
 *     — the dirty marker (never later than an existing one: `least()`), then
 *     the delete of the rows from that day, under the portfolio's paranoid
 *     transition lock — then the service's own `recompute`, i.e. the guarded
 *     persist path. A recompute the guards refuse writes nothing and leaves the
 *     marker for the nightly roll; it is counted `refused`, never `repaired`.
 *  4. Verify and record: `repaired` only when the state is clean AND a re-scan
 *     of the stored rows finds no hole; the outcome is recorded as
 *     `snapshots.fx_hole_repair_completed`.
 *
 * **Idempotent.** A repaired portfolio has no hole left, so a second run finds
 * nothing and records zeros. A crash mid-run leaves every portfolio either
 * untouched (not yet reached: re-found by the next run) or dirty (marker
 * written: the nightly roll and every read heal it) — never half-deleted
 * without a marker, because the marker lands before the delete. Overlapping
 * runs are prevented by the deterministic BullMQ job id
 * ({@link FX_HOLE_REPAIR_RUN_ID}); if one ever overlapped anyway, every write
 * is still safe — the marker is a `least()` upsert and every persist is fenced
 * by the state row's compare-and-set.
 *
 * **Never touches vault data.** Vaulted portfolios are excluded by the scan
 * query and only COUNTED; a paranoid owner's portfolio is skipped before its
 * rows are read; the writes go through the service, which re-checks both under
 * the account's transition lock.
 */

/**
 * The repair's run identity — and its BullMQ job id. Re-enqueueing the same id
 * is a no-op while the finished job is retained, so a worker restart does not
 * re-run it; a deliberate re-run ships as a bumped id. No `:` (BullMQ refuses
 * custom ids containing one).
 */
export const FX_HOLE_REPAIR_RUN_ID = 'fx-hole-repair-v1';

/** The lowest {@link SNAPSHOT_PERSIST_GUARD_VERSION} the repair accepts. */
export const FX_HOLE_REPAIR_MIN_GUARD_VERSION = 1;

/** Portfolios per scan page — bounds memory and spaces the progress log. */
export const FX_HOLE_REPAIR_PAGE_SIZE = 100;

/** Portfolios scanned / repaired at once — the recompute reaches providers. */
export const FX_HOLE_REPAIR_CONCURRENCY = 2;

/** `audit_log.target_type` of the repair's system rows (no target id). */
const AUDIT_TARGET_TYPE = 'snapshot_repair';

/** A portfolio's earliest frozen hole and the holdings missing on it. */
export interface FxHole {
  /** The earliest stored day missing a held, previously keyed asset. */
  day: string;
  /** One entry per vanished asset (its first such day), as the guard reports them. */
  vanished: VanishedHolding[];
}

const byDate = (a: { date: string }, b: { date: string }) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

/**
 * The earliest FX hole in a portfolio's stored rows, or null.
 *
 * A hole is a stored row on which an asset is missing although (a) an EARLIER
 * row carries it and (b) the current transactions hold it on that day. That is
 * exactly the persist-time guard's question, so the walk IS the guard: each
 * asset is checked by {@link findVanishedHoldings} with the first row that
 * carries it as the anchor and every later row as the "written" rows. Using the
 * guard's own holding walk (not a re-derivation) keeps the two agreeing: a
 * position fully sold before the missing day, or one whose transactions were
 * deleted, is no hole — its value is 0 with or without the key — and the
 * recompute the repair triggers will not be refused for it either.
 */
export function earliestFxHole(
  rows: readonly Pick<SnapshotRowRecord, 'date' | 'assetValues'>[],
  txns: readonly Pick<TransactionRecord, 'assetId' | 'side' | 'quantity' | 'executedAt'>[],
): FxHole | null {
  const sorted = [...rows].sort(byDate);
  // Group assets by the first row that keys them, so one guard call covers
  // every asset sharing an anchor.
  const anchors = new Map<number, Record<string, number>>();
  const seen = new Set<string>();
  sorted.forEach((row, index) => {
    for (const [assetId, value] of Object.entries(row.assetValues)) {
      if (seen.has(assetId)) continue;
      seen.add(assetId);
      const bucket = anchors.get(index) ?? {};
      bucket[assetId] = value;
      anchors.set(index, bucket);
    }
  });

  const vanished: VanishedHolding[] = [];
  for (const [index, assetValues] of anchors) {
    const anchor = sorted[index];
    if (anchor === undefined) continue;
    vanished.push(...findVanishedHoldings({ date: anchor.date, assetValues }, sorted, txns));
  }
  if (vanished.length === 0) return null;
  vanished.sort((a, b) => byDate({ date: a.day }, { date: b.day }));
  return { day: vanished[0]!.day, vanished };
}

export type FxHoleRepairGate =
  | { ok: true }
  | { ok: false; reason: 'fix_absent'; detail: 'guard_version' | 'guard_self_check' };

/**
 * Is the #1729 fix present in THIS running build? The repair deletes stored
 * rows and recomputes them; on a writer without the two persist-time refusals,
 * a recompute during an FX blip would rewrite the whole invalidated range
 * without the currency and turn a two-day hole into weeks. So it runs only
 * when all three hold:
 *
 *  1. **Compile-time:** this module imports `findVanishedHoldings` and
 *     `SNAPSHOT_PERSIST_GUARD_VERSION` by name; a build without #1729's
 *     `portfolioSnapshots.ts` does not typecheck, so it cannot ship.
 *  2. **Declared contract:** `SNAPSHOT_PERSIST_GUARD_VERSION` is at least
 *     {@link FX_HOLE_REPAIR_MIN_GUARD_VERSION}. The writer's owner lowers it in
 *     the same change that weakens either refusal.
 *  3. **Behaviour:** the guard this build actually links flags a held asset
 *     that vanished and spares one that was sold — so a stubbed-out or inverted
 *     guard fails closed too.
 *
 * Injectable for tests; production calls it with no argument.
 */
export function checkFxHoleRepairGate(
  probe: { guardVersion: unknown; findVanished: unknown } = {
    guardVersion: SNAPSHOT_PERSIST_GUARD_VERSION,
    findVanished: findVanishedHoldings,
  },
): FxHoleRepairGate {
  if (
    typeof probe.guardVersion !== 'number' ||
    !(probe.guardVersion >= FX_HOLE_REPAIR_MIN_GUARD_VERSION)
  ) {
    return { ok: false, reason: 'fix_absent', detail: 'guard_version' };
  }
  if (typeof probe.findVanished !== 'function') {
    return { ok: false, reason: 'fix_absent', detail: 'guard_self_check' };
  }
  const guard = probe.findVanished as typeof findVanishedHoldings;
  try {
    const anchor = { date: '2000-01-02', assetValues: { probe: 1 } };
    const rows = [{ date: '2000-01-03', assetValues: {} }];
    const buy = {
      assetId: 'probe',
      side: 'buy' as const,
      quantity: 1,
      executedAt: new Date('2000-01-01T00:00:00.000Z'),
    };
    const sell = { ...buy, side: 'sell' as const, executedAt: new Date('2000-01-03T00:00:00.000Z') };
    const held = guard(anchor, rows, [buy]);
    const sold = guard(anchor, rows, [buy, sell]);
    const flagsHeld =
      Array.isArray(held) &&
      held.length === 1 &&
      held[0]?.assetId === 'probe' &&
      held[0]?.day === '2000-01-03';
    const sparesSold = Array.isArray(sold) && sold.length === 0;
    if (!flagsHeld || !sparesSold) {
      return { ok: false, reason: 'fix_absent', detail: 'guard_self_check' };
    }
  } catch {
    return { ok: false, reason: 'fix_absent', detail: 'guard_self_check' };
  }
  return { ok: true };
}

export interface FxHoleRepairDeps {
  snapshotRepo: Pick<
    PortfolioSnapshotRepository,
    'listFxHoleScanTargets' | 'countVaultedPortfolios' | 'listForPortfolio' | 'getState'
  >;
  transactionRepo: Pick<TransactionRepository, 'listForPortfolio'>;
  /** The worker's snapshot service — its `invalidate`/`recompute` carry the guards and locks. */
  snapshots: Pick<PortfolioSnapshotService, 'invalidate' | 'recompute'>;
  /** Server-invisible portfolio (vaulted, or a paranoid owner's): skipped unread. */
  isParanoidPortfolio?: (portfolioId: string) => Promise<boolean>;
  audit: Pick<AuditService, 'record'>;
  logger: Logger;
  /** The BullMQ attempt this run is (1-based), recorded beside the counts. */
  attempt?: number;
  /** Injectable gate (tests); defaults to {@link checkFxHoleRepairGate}. */
  gate?: () => FxHoleRepairGate;
  pageSize?: number;
  concurrency?: number;
  /** Injectable clock (tests); defaults to the wall clock. */
  now?: () => number;
}

/** What the read-only pass found — recorded before any write. */
export interface FxHoleEnumeration {
  /** Non-vaulted portfolios with stored rows whose rows were read. */
  portfoliosScanned: number;
  portfoliosWithHoles: number;
  /** Distinct owners of the portfolios with holes. */
  usersAffected: number;
  /** The earliest hole day across every portfolio, or null when none. */
  earliestHoleDay: string | null;
  /** Vaulted portfolios — invisible to the server, so never read. */
  skippedVaulted: number;
  /** Portfolios of a paranoid owner (or vaulted mid-run) — never read. */
  skippedParanoid: number;
  /** Portfolios whose rows could not be read (they were not repaired). */
  scanFailed: number;
}

export interface FxHoleRepairReport extends FxHoleEnumeration {
  status: 'completed' | 'skipped';
  /** Set when `status` is `skipped`. */
  reason?: 'fix_absent';
  /** Hole gone from the stored rows and the state clean. */
  repaired: number;
  /** The guarded recompute persisted nothing; the marker stays for the nightly roll. */
  refused: number;
  /** The invalidation or the recompute threw, or a hole survived a clean persist. */
  failed: number;
  /** Holes that could not even be MARKED dirty — the only ones the nightly cannot heal. */
  unmarked: number;
  durationMs: number;
}

type RepairOutcome = 'repaired' | 'refused' | 'failed' | 'unmarked' | 'skipped';

/** Run `work` over `items` with at most `limit` in flight. `work` must not throw. */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * Run the repair once: gate, enumerate (read-only), record, repair, verify,
 * record. Never throws for one portfolio; the caller decides from `scanFailed`
 * and `unmarked` whether the run is worth a retry.
 */
export async function runFxHoleRepair(deps: FxHoleRepairDeps): Promise<FxHoleRepairReport> {
  const { snapshotRepo, transactionRepo, snapshots, audit, logger } = deps;
  const now = deps.now ?? Date.now;
  const pageSize = deps.pageSize ?? FX_HOLE_REPAIR_PAGE_SIZE;
  const concurrency = deps.concurrency ?? FX_HOLE_REPAIR_CONCURRENCY;
  const attempt = deps.attempt ?? 1;
  const startedAt = now();
  const runId = FX_HOLE_REPAIR_RUN_ID;

  const gate = (deps.gate ?? checkFxHoleRepairGate)();
  if (!gate.ok) {
    logger.warn(
      { event: 'repair.skipped', runId, reason: gate.reason, detail: gate.detail, attempt },
      'repair.skipped reason=fix_absent',
    );
    await audit.record({
      action: AuditAction.SnapshotFxHoleRepairSkipped,
      targetType: AUDIT_TARGET_TYPE,
      meta: { runId, attempt, reason: gate.reason, detail: gate.detail },
    });
    return {
      status: 'skipped',
      reason: gate.reason,
      portfoliosScanned: 0,
      portfoliosWithHoles: 0,
      usersAffected: 0,
      earliestHoleDay: null,
      skippedVaulted: 0,
      skippedParanoid: 0,
      scanFailed: 0,
      repaired: 0,
      refused: 0,
      failed: 0,
      unmarked: 0,
      durationMs: now() - startedAt,
    };
  }

  /** The current earliest hole of one portfolio, read from durable state. */
  async function scan(portfolioId: string): Promise<FxHole | null> {
    const [rows, txns] = await Promise.all([
      snapshotRepo.listForPortfolio(portfolioId),
      transactionRepo.listForPortfolio(portfolioId),
    ]);
    return earliestFxHole(rows, txns);
  }

  // ── Pass 1: enumerate, read-only ────────────────────────────────────────────
  const skippedVaulted = await snapshotRepo.countVaultedPortfolios();
  const hits: Array<FxHoleScanTarget & { hole: FxHole }> = [];
  let scanned = 0;
  let skippedParanoid = 0;
  let scanFailed = 0;
  let after: string | null = null;
  for (;;) {
    const page = await snapshotRepo.listFxHoleScanTargets({
      afterPortfolioId: after,
      limit: pageSize,
    });
    if (page.length === 0) break;
    await forEachBounded(page, concurrency, async (target) => {
      try {
        if (await deps.isParanoidPortfolio?.(target.portfolioId)) {
          skippedParanoid += 1;
          return;
        }
        const hole = await scan(target.portfolioId);
        scanned += 1;
        if (hole !== null) hits.push({ ...target, hole });
      } catch (err) {
        scanFailed += 1;
        logger.warn(
          { err, event: 'repair.scan_failed', runId, portfolioId: target.portfolioId },
          'fx hole repair: could not read a portfolio',
        );
      }
    });
    after = page[page.length - 1]!.portfolioId;
    logger.info(
      { event: 'repair.progress', runId, phase: 'enumerate', scanned, withHoles: hits.length },
      'fx hole repair: enumeration progress',
    );
    if (page.length < pageSize) break;
  }
  hits.sort((a, b) => (a.portfolioId < b.portfolioId ? -1 : 1));

  const enumeration: FxHoleEnumeration = {
    portfoliosScanned: scanned,
    portfoliosWithHoles: hits.length,
    usersAffected: new Set(hits.map((h) => h.userId)).size,
    earliestHoleDay: hits.reduce<string | null>(
      (min, h) => (min === null || h.hole.day < min ? h.hole.day : min),
      null,
    ),
    skippedVaulted,
    skippedParanoid,
    scanFailed,
  };
  // The PRE-repair truth, durable before the first write: if the run dies in
  // pass 2, the owner still learns how many portfolios carried the hole.
  logger.info(
    { event: 'repair.enumerated', runId, attempt, ...enumeration, durationMs: now() - startedAt },
    'repair.enumerated',
  );
  await audit.record({
    action: AuditAction.SnapshotFxHoleRepairEnumerated,
    targetType: AUDIT_TARGET_TYPE,
    meta: { runId, attempt, ...enumeration, durationMs: now() - startedAt },
  });

  // ── Pass 2: invalidate from the earliest hole, recompute through the guards ──
  async function repairOne(hit: FxHoleScanTarget & { hole: FxHole }): Promise<RepairOutcome> {
    const { portfolioId } = hit;
    const from = hit.hole.day;
    if (await deps.isParanoidPortfolio?.(portfolioId)) return 'skipped';
    try {
      // Marker first, then the delete — the service's own invalidation, under
      // the account's transition lock. Never later than an existing marker.
      await snapshots.invalidate(portfolioId, from);
    } catch (err) {
      logger.warn(
        { err, event: 'repair.invalidate_failed', runId, portfolioId, from },
        'fx hole repair: could not mark a portfolio dirty; its hole is untouched',
      );
      return 'unmarked';
    }
    try {
      await snapshots.recompute(portfolioId);
    } catch (err) {
      logger.warn(
        { err, event: 'repair.recompute_failed', runId, portfolioId, from },
        'fx hole repair: recompute failed; the dirty marker stays for the nightly roll',
      );
      return 'failed';
    }
    // Verify from durable state, not from what the recompute claims.
    if (await deps.isParanoidPortfolio?.(portfolioId)) return 'skipped';
    const state = await snapshotRepo.getState(portfolioId);
    if (state !== null && state.dirtyFrom !== null) return 'refused';
    const remaining = await scan(portfolioId);
    if (remaining === null) return 'repaired';
    logger.warn(
      { event: 'repair.hole_survived', runId, portfolioId, from, remaining: remaining.day },
      'fx hole repair: a hole survived a clean persist',
    );
    return 'failed';
  }

  let repaired = 0;
  let refused = 0;
  let failed = 0;
  let unmarked = 0;
  let done = 0;
  await forEachBounded(hits, concurrency, async (hit) => {
    let outcome: RepairOutcome;
    try {
      outcome = await repairOne(hit);
    } catch (err) {
      logger.warn(
        { err, event: 'repair.verify_failed', runId, portfolioId: hit.portfolioId },
        'fx hole repair: could not verify a portfolio',
      );
      outcome = 'failed';
    }
    if (outcome === 'repaired') repaired += 1;
    else if (outcome === 'refused') refused += 1;
    else if (outcome === 'failed') failed += 1;
    else if (outcome === 'unmarked') unmarked += 1;
    else skippedParanoid += 1;
    done += 1;
    logger.info(
      {
        event: 'repair.portfolio',
        runId,
        portfolioId: hit.portfolioId,
        from: hit.hole.day,
        vanished: hit.hole.vanished.slice(0, 5),
        outcome,
        progress: `${done}/${hits.length}`,
      },
      'fx hole repair: portfolio processed',
    );
  });

  const counts = {
    ...enumeration,
    skippedParanoid,
    repaired,
    refused,
    failed,
    unmarked,
    durationMs: now() - startedAt,
  };
  logger.info({ event: 'repair.completed', runId, attempt, ...counts }, 'repair.completed');
  await audit.record({
    action: AuditAction.SnapshotFxHoleRepairCompleted,
    targetType: AUDIT_TARGET_TYPE,
    meta: { runId, attempt, ...counts },
  });
  return { status: 'completed', ...counts };
}
