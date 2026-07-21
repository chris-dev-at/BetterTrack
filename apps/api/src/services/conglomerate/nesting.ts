import { MAX_NESTING_DEPTH } from '@bettertrack/contracts';

import type {
  ConglomerateDetailRow,
  ConglomerateConstituentRow,
} from '../../data/repositories/conglomerateRepository';

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

export { MAX_NESTING_DEPTH };

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
}

/**
 * Flatten a conglomerate to effective asset weights (the shared resolution
 * function — see the module doc for the math). `load` is the owner-scoped
 * detail loader; each basket in the closure is loaded once. Returns null when
 * the root does not exist (or is not the caller's). An empty child contributes
 * nothing — its slice is redistributed by the final normalization. The
 * recursion is bounded by {@link MAX_NESTING_DEPTH}; deeper data would violate
 * the write-time invariant and throws rather than resolving silently wrong.
 */
export async function flattenConglomerate(
  load: (id: string) => Promise<ConglomerateDetailRow | null>,
  rootId: string,
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
    if (depth > MAX_NESTING_DEPTH) {
      throw new Error(
        `Conglomerate nesting exceeds the depth cap of ${MAX_NESTING_DEPTH} — write-time invariant violated.`,
      );
    }
    const sum = row.positions.reduce((acc, p) => acc + p.weightPct, 0);
    if (sum <= 0) return;
    for (const pos of row.positions) {
      const share = fraction * (pos.weightPct / sum);
      if (pos.kind === 'asset') {
        const existing = shareByAsset.get(pos.assetId);
        if (existing) existing.share += share;
        else shareByAsset.set(pos.assetId, { share, asset: pos.asset });
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

  return {
    positions,
    nested: root.positions.some((p) => p.kind === 'conglomerate'),
  };
}
