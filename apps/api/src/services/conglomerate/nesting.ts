import { MAX_FLATTENED_POSITIONS, MAX_NESTING_DEPTH } from '@bettertrack/contracts';

import type {
  ConglomerateDetailRow,
  ConglomerateConstituentRow,
} from '../../data/repositories/conglomerateRepository';
import { unprocessable } from '../../errors';

/**
 * Nested-conglomerate rules (PROJECTPLAN.md §13.5 V5-P6, issue #592).
 *
 * A conglomerate may embed the owner's OTHER conglomerates as constituents.
 * This module holds the two write-time graph rules — cycle rejection (direct
 * and transitive) and the planner-set depth cap of {@link MAX_NESTING_DEPTH} —
 * as pure functions over the owner-local nesting graph, plus the ONE shared
 * resolution function that flattens a nested conglomerate to effective asset
 * weights. Backtest, valuation and the invest-calculator/allocation path all
 * flatten through {@link flattenConglomerate}; nothing else re-implements the
 * recursion.
 *
 * Semantics of the flatten (the §13.5 "weights resolve recursively" rule): a
 * constituent's share of its basket is its weight divided by the basket's own
 * weight sum — so a draft whose weights don't total 100 still distributes
 * proportionally, exactly as the invest calculator has always treated a draft
 * basket. An asset's effective weight is the product of those fractions along
 * each path from the root to it, summed over all paths (the same asset may be
 * reachable both directly and through a child), scaled to sum to 100. For the
 * canonical fixture — a 50 % child holding a 40/60 split — that yields 20/30.
 */

export { MAX_FLATTENED_POSITIONS, MAX_NESTING_DEPTH };

/**
 * The read-time refusals of the flatten. Both are MAPPED (422) rather than bare
 * `Error`s: a persisted structure the write-time rules should have prevented —
 * a cycle that slipped through a race, or a tree past the depth cap — used to
 * surface as a plain throw, which `http/errorHandler` reports as an unexpected
 * **500**. `GET /:id/resolved`, `POST /:id/allocate` and `POST /backtest/compare`
 * now answer with a clear 4xx code instead. Both messages are identity-free so
 * the shared-sandbox path (which must never name a descendant) can let them
 * through unchanged.
 */
const nestingUnresolvable = () =>
  unprocessable(
    `This blueprint's nesting cannot be resolved — it is nested deeper than the cap of ${MAX_NESTING_DEPTH} levels, or one of its constituents forms a cycle. Edit its constituents to fix it.`,
    'NESTING_UNRESOLVABLE',
  );

const tooManyFlattenedAssets = () =>
  unprocessable(
    `This blueprint resolves to more than ${MAX_FLATTENED_POSITIONS} assets — simplify its nesting before valuing or backtesting it.`,
    'NESTING_TOO_MANY_ASSETS',
  );

/**
 * Bounded fan-out over a flattened basket. The flatten resolves up to
 * {@link MAX_FLATTENED_POSITIONS} assets and each consumer does per-asset I/O
 * (an owner-scoped row read plus a quote or a history window), so the loads run
 * through a small pool instead of one sequential round trip each — or all at
 * once, which would hand the provider layer a 250-deep burst.
 *
 * Output order is the input order, and the LOWEST-INDEX failure is the one that
 * throws — exactly the error the sequential `for` loop this replaces would have
 * surfaced, so a basket's failure message stays deterministic instead of being
 * decided by whichever provider call happened to reject first.
 */
export const FLATTEN_LOAD_CONCURRENCY = 8;

export async function mapFlattened<T, R>(
  items: readonly T[],
  load: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  const failures: Array<{ index: number; error: unknown }> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    // `next++` is claimed synchronously, so two workers never take one item.
    for (let index = next++; index < items.length; index = next++) {
      try {
        out[index] = await load(items[index]!, index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FLATTEN_LOAD_CONCURRENCY, items.length) }, () => worker()),
  );
  if (failures.length > 0) {
    throw failures.reduce((first, f) => (f.index < first.index ? f : first)).error;
  }
  return out;
}

/** One parent → child nesting edge of the owner-local graph. */
export interface NestingEdge {
  parentId: string;
  childId: string;
}

/** Adjacency map (parent → children) of a nesting edge list. */
function adjacency(edges: readonly NestingEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.parentId);
    if (list) list.push(e.childId);
    else out.set(e.parentId, [e.childId]);
  }
  return out;
}

/**
 * True when `startId` can reach itself over `edges` — i.e. the graph contains
 * a cycle through `startId`. Called with the owner's edges *after* substituting
 * the basket's proposed constituent set, so both a direct self-reference and a
 * transitive loop (A→B, B→A) are caught before anything is written.
 */
export function createsCycle(edges: readonly NestingEdge[], startId: string): boolean {
  const adj = adjacency(edges);
  const stack = [...(adj.get(startId) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === startId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adj.get(node) ?? []) stack.push(next);
  }
  return false;
}

/**
 * The length, in conglomerates, of the longest chain in the (acyclic) nesting
 * graph — e.g. A→B→C is 3. Compared against {@link MAX_NESTING_DEPTH} at write
 * time; the graph must already be cycle-free ({@link createsCycle} runs first),
 * but a visiting guard keeps this loop-safe regardless.
 */
export function longestChainLength(edges: readonly NestingEdge[]): number {
  const adj = adjacency(edges);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  function depthFrom(node: string): number {
    const known = memo.get(node);
    if (known !== undefined) return known;
    if (visiting.has(node)) return 0; // cycle guard — unreachable after createsCycle
    visiting.add(node);
    let best = 1;
    for (const next of adj.get(node) ?? []) {
      const d = 1 + depthFrom(next);
      if (d > best) best = d;
    }
    visiting.delete(node);
    memo.set(node, best);
    return best;
  }

  let max = 0;
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.parentId);
    nodes.add(e.childId);
  }
  for (const node of nodes) {
    const d = depthFrom(node);
    if (d > max) max = d;
  }
  return max;
}

/** The asset identity carried through the flatten for display consumers. */
export interface FlattenedAsset {
  assetId: string;
  /** Effective weight in percent; the full vector sums to 100 (full precision). */
  weightPct: number;
  asset: Extract<ConglomerateConstituentRow, { kind: 'asset' }>['asset'];
}

export interface FlattenedConglomerate {
  /** Effective asset weights in first-encounter (depth-first) order. */
  positions: FlattenedAsset[];
  /** True when the ROOT basket has at least one nested-conglomerate constituent. */
  nested: boolean;
  /**
   * The share of the root's weight, in percent, that resolved to NO asset —
   * a nested constituent that is empty (directly or through its own empty
   * children). `positions` is normalized to 100 over what *did* resolve, so
   * this is the part of the basket the normalization would otherwise hand to
   * the survivors. Money consumers must withhold it rather than spend it; the
   * activation gate rejects it outright.
   */
  unresolvedPct: number;
}

export interface FlattenConglomerateOptions {
  /**
   * Optional local overrides for the ROOT basket only, keyed by an asset
   * constituent's `assetId` or a nested constituent's `childId`. Child baskets
   * keep their stored internal weights and are resolved through the same
   * recursive walk. Callers that accept untrusted ids must pin the map to the
   * root's exact constituent set before flattening.
   */
  rootWeights?: ReadonlyMap<string, number>;
}

function constituentId(position: ConglomerateConstituentRow): string {
  return position.kind === 'asset' ? position.assetId : position.childId;
}

/**
 * Float-noise floor for {@link FlattenedConglomerate.unresolvedPct}: summing
 * products of fractions lands a fully-resolved tree a few ULPs off 1, which is
 * not an empty child. One part in 10⁹ of the basket is far below any weight the
 * three-decimal contract can express.
 */
const UNRESOLVED_EPSILON = 1e-9;

/**
 * Flatten a conglomerate to effective asset weights (the shared resolution
 * function — see the module doc for the math). `load` is the owner-scoped
 * detail loader; each basket in the closure is loaded once. Returns null when
 * the root does not exist (or is not the caller's). An empty child resolves to
 * nothing: the surviving assets are normalized to 100 among themselves and the
 * dropped slice is reported as {@link FlattenedConglomerate.unresolvedPct} —
 * money consumers withhold it instead of silently redistributing it. The
 * recursion is bounded by {@link MAX_NESTING_DEPTH} and the result by
 * {@link MAX_FLATTENED_POSITIONS}; either breach is a mapped 422, never a bare
 * throw that would surface as a 500.
 * {@link FlattenConglomerateOptions.rootWeights} lets read-only what-if callers
 * change only the root allocation while retaining the stored recursive
 * structure and internal child weights.
 */
export async function flattenConglomerate(
  load: (id: string) => Promise<ConglomerateDetailRow | null>,
  rootId: string,
  options?: FlattenConglomerateOptions,
): Promise<FlattenedConglomerate | null> {
  const cache = new Map<string, ConglomerateDetailRow | null>();
  async function loadOnce(id: string): Promise<ConglomerateDetailRow | null> {
    if (cache.has(id)) return cache.get(id) ?? null;
    const row = await load(id);
    cache.set(id, row);
    return row;
  }

  const root = await loadOnce(rootId);
  if (!root) return null;

  const shareByAsset = new Map<string, { share: number; asset: FlattenedAsset['asset'] }>();

  async function walk(row: ConglomerateDetailRow, fraction: number, depth: number): Promise<void> {
    // Deeper than the write-time invariant allows — an over-deep tree, or a
    // cycle that a concurrent write slipped past the graph check (the recursion
    // hits the cap rather than looping). Refuse with a mapped code.
    if (depth > MAX_NESTING_DEPTH) throw nestingUnresolvable();
    const weightOf = (position: ConglomerateConstituentRow): number =>
      depth === 1
        ? (options?.rootWeights?.get(constituentId(position)) ?? position.weightPct)
        : position.weightPct;
    const sum = row.positions.reduce((acc, position) => acc + weightOf(position), 0);
    if (sum <= 0) return;
    for (const pos of row.positions) {
      const share = fraction * (weightOf(pos) / sum);
      if (pos.kind === 'asset') {
        const existing = shareByAsset.get(pos.assetId);
        if (existing) existing.share += share;
        else {
          if (shareByAsset.size >= MAX_FLATTENED_POSITIONS) throw tooManyFlattenedAssets();
          shareByAsset.set(pos.assetId, { share, asset: pos.asset });
        }
      } else {
        const child = await loadOnce(pos.childId);
        if (child) await walk(child, share, depth + 1);
      }
    }
  }

  await walk(root, 1, 1);

  const total = [...shareByAsset.values()].reduce((acc, e) => acc + e.share, 0);
  const positions: FlattenedAsset[] =
    total > 0
      ? [...shareByAsset.entries()].map(([assetId, e]) => ({
          assetId,
          weightPct: (e.share / total) * 100,
          asset: e.asset,
        }))
      : [];

  // Every fully-resolved path contributes its fraction, so a tree that resolves
  // completely totals exactly 1 (modulo float noise). Whatever is missing is the
  // slice of empty children the normalization above just handed to the
  // survivors — report it so money consumers can withhold it instead.
  const unresolved = 1 - total;
  return {
    positions,
    nested: root.positions.some((p) => p.kind === 'conglomerate'),
    unresolvedPct: unresolved > UNRESOLVED_EPSILON ? unresolved * 100 : 0,
  };
}
