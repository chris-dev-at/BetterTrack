import { describe, expect, it } from 'vitest';

import type { ConglomerateDetailRow } from '../../../data/repositories/conglomerateRepository';
import { createsCycle, flattenConglomerate, longestChainLength } from '../nesting';

/**
 * Pure V5-P6 nesting rules (issue #592): cycle detection, the depth-cap
 * measure, and the shared recursive weight resolution — including the plan's
 * hand-computed fixture (50 % child holding a 40/60 split ⇒ 20/30 effective).
 */

function assetPos(assetId: string, weightPct: number) {
  return {
    kind: 'asset' as const,
    assetId,
    weightPct,
    sortOrder: 0,
    asset: {
      symbol: assetId.toUpperCase(),
      name: assetId,
      currency: 'EUR',
      type: 'stock' as const,
    },
  };
}

function childPos(childId: string, weightPct: number) {
  return {
    kind: 'conglomerate' as const,
    childId,
    weightPct,
    sortOrder: 0,
    child: { id: childId, name: childId, status: 'draft' as const, positionCount: 0 },
  };
}

function row(id: string, positions: ConglomerateDetailRow['positions']): ConglomerateDetailRow {
  return {
    id,
    name: id,
    description: null,
    status: 'draft',
    visibility: 'private',
    positionCount: positions.length,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    positions,
  };
}

/** A loader over an in-memory closure, as the repo would serve it. */
function loaderOf(rows: ConglomerateDetailRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => Promise.resolve(byId.get(id) ?? null);
}

describe('createsCycle', () => {
  it('detects a direct self-reference', () => {
    expect(createsCycle([{ parentId: 'a', childId: 'a' }], 'a')).toBe(true);
  });

  it('detects a transitive cycle through several hops', () => {
    const edges = [
      { parentId: 'a', childId: 'b' },
      { parentId: 'b', childId: 'c' },
      { parentId: 'c', childId: 'a' },
    ];
    expect(createsCycle(edges, 'a')).toBe(true);
    expect(createsCycle(edges, 'b')).toBe(true);
  });

  it('accepts a DAG — shared children are not cycles', () => {
    const edges = [
      { parentId: 'a', childId: 'b' },
      { parentId: 'a', childId: 'c' },
      { parentId: 'b', childId: 'd' },
      { parentId: 'c', childId: 'd' }, // diamond: d reached twice, no cycle
    ];
    for (const node of ['a', 'b', 'c', 'd']) expect(createsCycle(edges, node)).toBe(false);
  });
});

describe('longestChainLength', () => {
  it('measures a linear chain in conglomerates, not edges', () => {
    expect(longestChainLength([])).toBe(0);
    expect(longestChainLength([{ parentId: 'a', childId: 'b' }])).toBe(2);
    expect(
      longestChainLength([
        { parentId: 'a', childId: 'b' },
        { parentId: 'b', childId: 'c' },
      ]),
    ).toBe(3);
  });

  it('takes the longest path through a diamond', () => {
    expect(
      longestChainLength([
        { parentId: 'a', childId: 'b' },
        { parentId: 'b', childId: 'c' },
        { parentId: 'a', childId: 'c' }, // short-cut edge does not shorten the max
      ]),
    ).toBe(3);
  });
});

describe('flattenConglomerate', () => {
  it('resolves the canonical fixture: 50% child with a 40/60 split ⇒ 20/30 effective', async () => {
    const load = loaderOf([
      row('parent', [assetPos('x', 50), childPos('child', 50)]),
      row('child', [assetPos('y', 40), assetPos('z', 60)]),
    ]);
    const flat = await flattenConglomerate(load, 'parent');
    expect(flat).not.toBeNull();
    expect(flat!.nested).toBe(true);
    const byId = new Map(flat!.positions.map((p) => [p.assetId, p.weightPct]));
    expect(byId.get('x')).toBeCloseTo(50, 12);
    expect(byId.get('y')).toBeCloseTo(20, 12);
    expect(byId.get('z')).toBeCloseTo(30, 12);
    // The vector is normalized: Σ = 100.
    const sum = flat!.positions.reduce((acc, p) => acc + p.weightPct, 0);
    expect(sum).toBeCloseTo(100, 12);
  });

  it('normalizes each level by its own weight sum — a draft child distributes proportionally', async () => {
    // Child is a draft whose weights sum to 50 (20/30): a 40% slice of it
    // must still split 40/60 within the slice, exactly like the invest
    // calculator treats a draft basket.
    const load = loaderOf([
      row('parent', [assetPos('x', 60), childPos('draftChild', 40)]),
      row('draftChild', [assetPos('y', 20), assetPos('z', 30)]),
    ]);
    const flat = await flattenConglomerate(load, 'parent');
    const byId = new Map(flat!.positions.map((p) => [p.assetId, p.weightPct]));
    expect(byId.get('x')).toBeCloseTo(60, 12);
    expect(byId.get('y')).toBeCloseTo(16, 12);
    expect(byId.get('z')).toBeCloseTo(24, 12);
  });

  it('merges an asset reachable both directly and through a child', async () => {
    const load = loaderOf([
      row('parent', [assetPos('x', 50), childPos('child', 50)]),
      row('child', [assetPos('x', 50), assetPos('y', 50)]),
    ]);
    const flat = await flattenConglomerate(load, 'parent');
    expect(flat!.positions).toHaveLength(2);
    const byId = new Map(flat!.positions.map((p) => [p.assetId, p.weightPct]));
    expect(byId.get('x')).toBeCloseTo(75, 12);
    expect(byId.get('y')).toBeCloseTo(25, 12);
  });

  it('resolves three levels with multiplied fractions', async () => {
    // root → 50% mid → 50% leaf(100% x) ⇒ x carries 25 via the leaf.
    const load = loaderOf([
      row('root', [assetPos('a', 50), childPos('mid', 50)]),
      row('mid', [assetPos('b', 50), childPos('leaf', 50)]),
      row('leaf', [assetPos('x', 100)]),
    ]);
    const flat = await flattenConglomerate(load, 'root');
    const byId = new Map(flat!.positions.map((p) => [p.assetId, p.weightPct]));
    expect(byId.get('a')).toBeCloseTo(50, 12);
    expect(byId.get('b')).toBeCloseTo(25, 12);
    expect(byId.get('x')).toBeCloseTo(25, 12);
  });

  it('drops an EMPTY child branch and renormalizes the remainder to 100', async () => {
    const load = loaderOf([
      row('parent', [assetPos('x', 30), assetPos('y', 20), childPos('empty', 50)]),
      row('empty', []),
    ]);
    const flat = await flattenConglomerate(load, 'parent');
    const byId = new Map(flat!.positions.map((p) => [p.assetId, p.weightPct]));
    expect(byId.get('x')).toBeCloseTo(60, 12);
    expect(byId.get('y')).toBeCloseTo(40, 12);
  });

  it('flattens an entirely empty basket to no positions', async () => {
    const flat = await flattenConglomerate(loaderOf([row('parent', [])]), 'parent');
    expect(flat).toEqual({ positions: [], nested: false });
  });

  it('returns null for an unknown root and flags a flat basket as not nested', async () => {
    expect(await flattenConglomerate(loaderOf([]), 'nope')).toBeNull();
    const flat = await flattenConglomerate(loaderOf([row('flat', [assetPos('x', 100)])]), 'flat');
    expect(flat!.nested).toBe(false);
  });
});
