import { describe, expect, it } from 'vitest';

import type { ConglomerateDetailRow } from '../../../data/repositories/conglomerateRepository';
import {
  createFlattenCache,
  createsCycle,
  FLATTEN_LOAD_CONCURRENCY,
  flattenConglomerate,
  longestChainLength,
  mapFlattened,
  MAX_FLATTENED_POSITIONS,
} from '../nesting';

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

  it('applies local root weights while preserving a nested child’s internal allocation', async () => {
    const load = loaderOf([
      row('parent', [assetPos('x', 50), childPos('child', 50)]),
      row('child', [assetPos('y', 40), assetPos('z', 60)]),
    ]);
    const flat = await flattenConglomerate(load, 'parent', {
      rootWeights: new Map([
        ['x', 20],
        ['child', 80],
      ]),
    });
    const byId = new Map(flat!.positions.map((position) => [position.assetId, position.weightPct]));
    expect(byId.get('x')).toBeCloseTo(20, 12);
    expect(byId.get('y')).toBeCloseTo(32, 12);
    expect(byId.get('z')).toBeCloseTo(48, 12);
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

  it('drops an EMPTY child branch, renormalizes the remainder and REPORTS the dropped slice', async () => {
    const load = loaderOf([
      row('parent', [assetPos('x', 30), assetPos('y', 20), childPos('empty', 50)]),
      row('empty', []),
    ]);
    const flat = await flattenConglomerate(load, 'parent');
    const byId = new Map(flat!.positions.map((p) => [p.assetId, p.weightPct]));
    expect(byId.get('x')).toBeCloseTo(60, 12);
    expect(byId.get('y')).toBeCloseTo(40, 12);
    // The renormalization above is what money callers must NOT spend: half the
    // basket resolved to nothing and says so.
    expect(flat!.unresolvedPct).toBeCloseTo(50, 12);
  });

  it('reports a child that is empty only through ITS own empty child', async () => {
    const load = loaderOf([
      row('parent', [assetPos('x', 60), childPos('mid', 40)]),
      row('mid', [childPos('empty', 100)]),
      row('empty', []),
    ]);
    const flat = await flattenConglomerate(load, 'parent');
    expect(flat!.positions).toHaveLength(1);
    expect(flat!.unresolvedPct).toBeCloseTo(40, 12);
  });

  it('reports nothing unresolved for a fully resolved tree (float noise is not a gap)', async () => {
    const load = loaderOf([
      row('root', [assetPos('a', 33.333), childPos('mid', 66.667)]),
      row('mid', [assetPos('b', 0.001), assetPos('c', 99.999)]),
    ]);
    const flat = await flattenConglomerate(load, 'root');
    expect(flat!.unresolvedPct).toBe(0);
  });

  it('flattens an entirely empty basket to no positions', async () => {
    const flat = await flattenConglomerate(loaderOf([row('parent', [])]), 'parent');
    expect(flat).toEqual({ positions: [], nested: false, unresolvedPct: 100 });
  });

  it('refuses an over-deep tree with a MAPPED 422 instead of a bare Error (never a 500)', async () => {
    // Four conglomerates in a chain — one past MAX_NESTING_DEPTH. Only a write
    // that raced the graph check can persist this; reading it must still answer
    // with a code, not an unexpected-error 500.
    const load = loaderOf([
      row('l1', [childPos('l2', 100)]),
      row('l2', [childPos('l3', 100)]),
      row('l3', [childPos('l4', 100)]),
      row('l4', [assetPos('x', 100)]),
    ]);
    await expect(flattenConglomerate(load, 'l1')).rejects.toMatchObject({
      statusCode: 422,
      code: 'NESTING_UNRESOLVABLE',
    });
  });

  it('refuses a PERSISTED cycle with the same mapped 422 rather than recursing', async () => {
    const load = loaderOf([row('a', [childPos('b', 100)]), row('b', [childPos('a', 100)])]);
    await expect(flattenConglomerate(load, 'a')).rejects.toMatchObject({
      statusCode: 422,
      code: 'NESTING_UNRESOLVABLE',
    });
  });

  it(`bounds the flattened asset count at ${MAX_FLATTENED_POSITIONS} with a clear error`, async () => {
    // Two children of 130 distinct assets each: 260 unique assets past the
    // flatten, over the cap — refused before any per-asset I/O is fanned out.
    const wide = (prefix: string) =>
      Array.from({ length: 130 }, (_, i) => assetPos(`${prefix}${i}`, 1));
    const load = loaderOf([
      row('root', [childPos('c1', 50), childPos('c2', 50)]),
      row('c1', wide('p')),
      row('c2', wide('q')),
    ]);
    await expect(flattenConglomerate(load, 'root')).rejects.toMatchObject({
      statusCode: 422,
      code: 'NESTING_TOO_MANY_ASSETS',
    });

    // Exactly at the cap still resolves — the bound is a ceiling, not a fence
    // around ordinary baskets.
    const atCap = loaderOf([
      row('root', [childPos('c1', 100)]),
      row(
        'c1',
        Array.from({ length: MAX_FLATTENED_POSITIONS }, (_, i) => assetPos(`p${i}`, 1)),
      ),
    ]);
    const flat = await flattenConglomerate(atCap, 'root');
    expect(flat!.positions).toHaveLength(MAX_FLATTENED_POSITIONS);
  });

  it('loads a basket’s nested children through the bounded pool, not one at a time', async () => {
    // The walk used to `await` each child load before starting the next, so a
    // basket of twelve children cost twelve serial round trips (#1776).
    const rows = [
      row(
        'root',
        Array.from({ length: 12 }, (_, i) => childPos(`c${i}`, 1)),
      ),
      ...Array.from({ length: 12 }, (_, i) => row(`c${i}`, [assetPos(`x${i}`, 100)])),
    ];
    const byId = new Map(rows.map((r) => [r.id, r]));
    let inFlight = 0;
    let peak = 0;
    const load = async (id: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return byId.get(id) ?? null;
    };

    const flat = await flattenConglomerate(load, 'root');
    expect(peak).toBeGreaterThan(1); // genuinely concurrent…
    expect(peak).toBeLessThanOrEqual(FLATTEN_LOAD_CONCURRENCY); // …but still bounded.
    // Only the loads moved: first-encounter order and the weights are exactly
    // what the sequential walk produced.
    expect(flat!.positions.map((p) => p.assetId)).toEqual(
      Array.from({ length: 12 }, (_, i) => `x${i}`),
    );
    for (const position of flat!.positions) expect(position.weightPct).toBeCloseTo(100 / 12, 12);
  });

  it('loads a shared basket once across flattens that share a cache', async () => {
    const rows = [
      row('p1', [childPos('shared', 100)]),
      row('p2', [childPos('shared', 100)]),
      row('shared', [assetPos('x', 100)]),
    ];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const loads: string[] = [];
    const load = (id: string) => {
      loads.push(id);
      return Promise.resolve(byId.get(id) ?? null);
    };

    const cache = createFlattenCache();
    const first = await flattenConglomerate(load, 'p1', { cache });
    const second = await flattenConglomerate(load, 'p2', { cache });

    expect(first!.positions[0]!.weightPct).toBeCloseTo(100, 12);
    expect(second!.positions[0]!.weightPct).toBeCloseTo(100, 12);
    // The revalidation sweep flattens once per child and once per ancestor; with
    // a per-call cache the shared basket was re-read every time (#1776).
    expect(loads).toEqual(['p1', 'shared', 'p2']);
  });

  it('does not serve a REJECTED read to a later caller of the same cache', async () => {
    // A shared cache memoised the rejected promise, so one transient repository
    // failure on a shared grandchild became the answer every later flatten got —
    // with no second attempt (#1831). The cache de-duplicates concurrent
    // readers; it is not a failure log.
    const rows = [
      row('p1', [childPos('shared', 100)]),
      row('p2', [childPos('shared', 100)]),
      row('shared', [assetPos('x', 100)]),
    ];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const loads: string[] = [];
    const boom = new Error('transient read failure');
    const load = (id: string) => {
      loads.push(id);
      if (id === 'shared' && loads.filter((l) => l === 'shared').length === 1) {
        return Promise.reject(boom);
      }
      return Promise.resolve(byId.get(id) ?? null);
    };

    const cache = createFlattenCache();
    await expect(flattenConglomerate(load, 'p1', { cache })).rejects.toBe(boom);
    // The failure is not retained…
    expect(cache.has('shared')).toBe(false);
    // …so the next flatten genuinely re-reads and resolves.
    const second = await flattenConglomerate(load, 'p2', { cache });
    expect(second!.positions.map((p) => p.assetId)).toEqual(['x']);
    expect(loads).toEqual(['p1', 'shared', 'p2', 'shared']);
    // The rows that DID resolve are still cached — the eviction is surgical.
    expect(cache.has('p1')).toBe(true);
  });

  it('shares one in-flight read between concurrent callers, failure included', async () => {
    // Eviction must not break the de-duplication it lives inside: two branches
    // that reach the same basket before it settles still take ONE read.
    const loads: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = async (id: string) => {
      loads.push(id);
      await gate;
      throw new Error(`no ${id}`);
    };

    const cache = createFlattenCache();
    const first = flattenConglomerate(load, 'root', { cache });
    const second = flattenConglomerate(load, 'root', { cache });
    release!();

    await expect(first).rejects.toThrow('no root');
    await expect(second).rejects.toThrow('no root');
    expect(loads).toEqual(['root']);
    expect(cache.has('root')).toBe(false);
  });
});

describe('mapFlattened', () => {
  it('preserves input order while running through a bounded pool', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const out = await mapFlattened(items, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return item * 2;
    });
    expect(out).toEqual(items.map((i) => i * 2));
    expect(peak).toBeGreaterThan(1); // genuinely concurrent…
    expect(peak).toBeLessThanOrEqual(FLATTEN_LOAD_CONCURRENCY); // …but bounded.
  });

  it('surfaces the LOWEST-INDEX failure, as the sequential loop it replaces did', async () => {
    await expect(
      mapFlattened([0, 1, 2, 3], async (item) => {
        if (item === 1 || item === 3) throw new Error(`fail-${item}`);
        return item;
      }),
    ).rejects.toThrow('fail-1');
  });

  it('returns null for an unknown root and flags a flat basket as not nested', async () => {
    expect(await flattenConglomerate(loaderOf([]), 'nope')).toBeNull();
    const flat = await flattenConglomerate(loaderOf([row('flat', [assetPos('x', 100)])]), 'flat');
    expect(flat!.nested).toBe(false);
  });
});
