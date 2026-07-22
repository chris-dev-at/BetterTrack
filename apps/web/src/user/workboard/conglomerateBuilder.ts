import type {
  AiConglomerateDraftLine,
  AssetType,
  ConglomerateSummary,
  CurrencyCode,
  SearchResultItem,
} from '@bettertrack/contracts';

/**
 * Pure state helpers for the Conglomerate Builder (PROJECTPLAN.md §6.5).
 *
 * The Builder's weight maths lives here — free of React and I/O — so the
 * §6.5 model rules (1–50 positions, `0 < w ≤ 100` at ≤ 3 decimals, Σ = 100 ±
 * 0.01 to activate) and the auto-balance / normalize behaviours are unit-tested
 * in isolation and reused by the page unchanged.
 */

/** §6.5: at most 50 positions per Conglomerate. */
export const MAX_POSITIONS = 50;
/** The weight Σ an `active` Conglomerate must hit. */
export const ACTIVE_SUM = 100;
/** …within this tolerance (§6.5). */
export const SUM_TOLERANCE = 0.01;
/** Slider granularity (§6.5): 0–100 in steps of 0.5. */
export const WEIGHT_SLIDER_STEP = 0.5;
/** Number-input granularity (§6.5): 0.001 precision, matching `numeric(6,3)`. */
export const WEIGHT_INPUT_STEP = 0.001;

/**
 * One editable row in the Builder — an asset or, since V5-P6, one of the
 * user's own conglomerates nested as a constituent. `locked` and the embedded
 * identity are client-only; only the ref id + `weightPct` are persisted
 * (§6.5). A freshly added position starts at weight 0 until the user gives it
 * a share.
 */
export interface BuilderPosition {
  kind: 'asset' | 'conglomerate';
  /** The constituent's id: an asset id, or the nested conglomerate's id (V5-P6). */
  refId: string;
  /** Display lead: the asset symbol, or the nested conglomerate's name. */
  symbol: string;
  name: string;
  currency?: CurrencyCode;
  type?: AssetType;
  weightPct: number;
  locked: boolean;
}

/** Round to the 3-decimal (`numeric(6,3)`) precision weights are stored at (§2.6). */
export function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Clamp a raw weight into the 0–100 range at 3-decimal precision (non-finite → 0). */
export function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return roundWeight(Math.min(100, Math.max(0, value)));
}

/** Σ of every row's weight, at 3-decimal precision. */
export function sumWeights(positions: readonly BuilderPosition[]): number {
  return roundWeight(positions.reduce((acc, p) => acc + p.weightPct, 0));
}

/** True when Σ weights = 100 ± 0.01 (the §6.5 activation threshold). */
export function isSumValid(positions: readonly BuilderPosition[]): boolean {
  return Math.abs(sumWeights(positions) - ACTIVE_SUM) <= SUM_TOLERANCE;
}

/** The rows that actually persist (`0 < w`): weight-0 rows are dropped on save (§6.5). */
export function persistablePositions(positions: readonly BuilderPosition[]): BuilderPosition[] {
  return positions.filter((p) => p.weightPct > 0);
}

/**
 * Client-side activation gate mirroring the server rule (§6.5): after dropping
 * weight-0 rows there must be 1–50 positions, each `0 < w ≤ 100` at ≤ 3 dp, and
 * Σ = 100 ± 0.01. Weight-0 rows are ignored (they never reach the API).
 */
export function canActivate(positions: readonly BuilderPosition[]): boolean {
  const live = persistablePositions(positions);
  if (live.length < 1 || live.length > MAX_POSITIONS) return false;
  const everyWeightOk = live.every(
    (p) => p.weightPct > 0 && p.weightPct <= 100 && roundWeight(p.weightPct) === p.weightPct,
  );
  return everyWeightOk && isSumValid(live);
}

/** A rejection reason as an i18n key + params — the page translates it (EN+DE). */
export interface AddPositionRejection {
  key: string;
  params?: Record<string, string | number>;
}

/**
 * Would adding this constituent be rejected? (the 1–50 cap, a duplicate
 * constituent, or — for a nested conglomerate — nesting the basket into
 * itself, V5-P6). Transitive cycles and the depth cap are server-enforced;
 * the Builder surfaces those errors on save.
 */
export function canAddPosition(
  positions: readonly BuilderPosition[],
  candidate: { kind: BuilderPosition['kind']; refId: string },
  selfId?: string | null,
): { ok: true } | { ok: false; reason: AddPositionRejection } {
  if (positions.length >= MAX_POSITIONS) {
    return {
      ok: false,
      reason: { key: 'workboard.builder.errors.maxPositions', params: { max: MAX_POSITIONS } },
    };
  }
  if (candidate.kind === 'conglomerate' && selfId != null && candidate.refId === selfId) {
    return { ok: false, reason: { key: 'workboard.builder.errors.selfNest' } };
  }
  if (positions.some((p) => p.kind === candidate.kind && p.refId === candidate.refId)) {
    return {
      ok: false,
      reason: {
        key:
          candidate.kind === 'asset'
            ? 'workboard.builder.errors.duplicateAsset'
            : 'workboard.builder.errors.duplicateConglomerate',
      },
    };
  }
  return { ok: true };
}

/** Build a new weight-0 position from a search result (§6.5 "click adds at weight 0"). */
export function positionFromSearchResult(item: SearchResultItem): BuilderPosition {
  return {
    kind: 'asset',
    refId: item.id,
    symbol: item.symbol,
    name: item.name,
    currency: item.currency,
    type: item.type,
    weightPct: 0,
    locked: false,
  };
}

/**
 * Build weighted Builder positions from an AI draft's RESOLVED lines (V5-P12).
 * Unresolved lines (`asset: null`) are dropped here — the NL panel flags them
 * separately so they are never silently lost — and duplicate assets are merged
 * (weights summed) since the Builder keys positions by ref. Every weight is
 * clamped to the stored 0–100 / 3-dp precision. The result is a plain draft the
 * user reviews, edits and explicitly saves (nothing here persists on its own).
 */
export function positionsFromDraftLines(
  lines: readonly AiConglomerateDraftLine[],
): BuilderPosition[] {
  const byRef = new Map<string, BuilderPosition>();
  for (const line of lines) {
    if (!line.asset) continue;
    const existing = byRef.get(line.asset.id);
    if (existing) {
      existing.weightPct = clampWeight(existing.weightPct + line.weightPct);
      continue;
    }
    byRef.set(line.asset.id, {
      kind: 'asset',
      refId: line.asset.id,
      symbol: line.asset.symbol,
      name: line.asset.name,
      currency: line.asset.currency,
      type: line.asset.type,
      weightPct: clampWeight(line.weightPct),
      locked: false,
    });
  }
  return [...byRef.values()];
}

/** Build a weight-0 nested-conglomerate constituent from one of the user's own baskets (V5-P6). */
export function positionFromConglomerate(summary: ConglomerateSummary): BuilderPosition {
  return {
    kind: 'conglomerate',
    refId: summary.id,
    symbol: summary.name,
    name: summary.name,
    weightPct: 0,
    locked: false,
  };
}

/**
 * Assign each unlocked index a weight via `assign`, then let the *last* unlocked
 * position absorb the rounding remainder so the unlocked total lands exactly on
 * `target` (at 3 dp). Locked rows are returned untouched.
 */
function distributeUnlocked(
  positions: readonly BuilderPosition[],
  target: number,
  assign: (position: BuilderPosition) => number,
): BuilderPosition[] {
  const unlockedIdx = positions.reduce<number[]>((acc, p, i) => {
    if (!p.locked) acc.push(i);
    return acc;
  }, []);
  const next = positions.slice();
  let running = 0;
  unlockedIdx.forEach((idx, k) => {
    const base = next[idx];
    if (!base) return;
    const isLast = k === unlockedIdx.length - 1;
    const weightPct = isLast ? roundWeight(target - running) : roundWeight(assign(base));
    if (!isLast) running = roundWeight(running + weightPct);
    next[idx] = { ...base, weightPct };
  });
  return next;
}

/**
 * **Auto-balance** (§6.5): distribute `100 − Σ(locked)` equally across the
 * unlocked positions. No-op when everything is locked. The last unlocked row
 * absorbs the rounding remainder so Σ hits exactly 100 (locked untouched).
 */
export function autoBalance(positions: readonly BuilderPosition[]): BuilderPosition[] {
  const unlockedCount = positions.filter((p) => !p.locked).length;
  if (unlockedCount === 0) return positions.slice();
  const lockedSum = roundWeight(
    positions.filter((p) => p.locked).reduce((acc, p) => acc + p.weightPct, 0),
  );
  const remaining = roundWeight(ACTIVE_SUM - lockedSum);
  const per = roundWeight(remaining / unlockedCount);
  return distributeUnlocked(positions, remaining, () => per);
}

export type NormalizeResult =
  | { ok: true; positions: BuilderPosition[] }
  | { ok: false; error: string };

/**
 * **Normalize** (§6.5): scale the unlocked positions proportionally so Σ hits
 * exactly 100, leaving locked positions untouched. Errors when the locked
 * positions alone already total ≥ 100 (nothing left to distribute), or when
 * there are no unlocked positions to scale. Unlocked positions that are all 0
 * are spread equally rather than divided by zero.
 */
export function normalize(positions: readonly BuilderPosition[]): NormalizeResult {
  const lockedSum = roundWeight(
    positions.filter((p) => p.locked).reduce((acc, p) => acc + p.weightPct, 0),
  );
  if (lockedSum >= ACTIVE_SUM) {
    return {
      ok: false,
      error: 'Locked weights already total 100% or more — unlock a position to normalize.',
    };
  }
  const unlocked = positions.filter((p) => !p.locked);
  if (unlocked.length === 0) {
    return { ok: false, error: 'There are no unlocked positions to normalize.' };
  }
  const target = roundWeight(ACTIVE_SUM - lockedSum);
  const unlockedSum = unlocked.reduce((acc, p) => acc + p.weightPct, 0);
  const positions2 = distributeUnlocked(positions, target, (p) =>
    unlockedSum > 0 ? (p.weightPct / unlockedSum) * target : target / unlocked.length,
  );
  return { ok: true, positions: positions2 };
}
