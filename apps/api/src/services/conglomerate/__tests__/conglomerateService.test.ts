import { describe, expect, it } from 'vitest';

import type {
  ConglomerateConstituentRow,
  ConglomerateDetailRow,
  ConglomerateRepository,
  NestingEdgeRow,
  PositionInput,
} from '../../../data/repositories/conglomerateRepository';
import type { AssetRepository } from '../../../data/repositories/assetRepository';
import type { Logger } from '../../../logger';
import type { MarketDataService } from '../../../providers';
import type { CurrencyService } from '../../currency/currencyService';
import type { AudienceService } from '../../social/audienceService';
import { createConglomerateService } from '../conglomerateService';

/**
 * Service-seam tests for the V5-P6 write race (issue #1615). The concurrency the
 * fix defends against cannot be produced against the single-connection test
 * database, so the race is driven where it actually matters: the repository
 * seam. The stub answers the service's up-front graph read with the PRE-race
 * snapshot and then hands the write's `verifyNesting` callback the edge set as
 * it stands after the racing writer committed — exactly what the real
 * transaction observes once it holds the owner's row locks.
 */

const OWNER = 'u1';
const A = '018f0000-0000-7000-8000-00000000aaaa';
const B = '018f0000-0000-7000-8000-00000000bbbb';

interface StubWrite {
  positions: readonly PositionInput[];
  verifyNesting?: (edges: NestingEdgeRow[]) => void;
}

/**
 * @param staleEdges what the service's pre-write check sees.
 * @param committedEdges what the write transaction sees (the racer's result).
 */
function createStubService(staleEdges: NestingEdgeRow[], committedEdges: NestingEdgeRow[]) {
  const writes: StubWrite[] = [];
  const applied: StubWrite[] = [];

  const repo = {
    findByIdForOwner: async (ownerId: string, id: string) =>
      ownerId === OWNER
        ? {
            id,
            name: id,
            description: null,
            status: 'draft',
            visibility: 'private',
            positionCount: 0,
            createdAt: new Date(0),
            updatedAt: new Date(0),
            positions: [],
          }
        : null,
    ownedConglomerateIds: async (ownerId: string, ids: readonly string[]) =>
      new Set(ownerId === OWNER ? ids : []),
    visibleAssetIds: async (_ownerId: string, ids: readonly string[]) => new Set(ids),
    nestingEdges: async () => staleEdges,
    // The post-write ancestor revalidation (#1755) asks who embeds the edited
    // basket; in this fixture nothing does, so the walk stops immediately.
    parentsOf: async () => [],
    replacePositions: async (
      _ownerId: string,
      _id: string,
      positions: readonly PositionInput[],
      options?: { verifyNesting?: (edges: NestingEdgeRow[]) => void },
    ) => {
      const write: StubWrite = { positions, verifyNesting: options?.verifyNesting };
      writes.push(write);
      // The real repository runs the callback inside the transaction; throwing
      // there rolls the write back, so nothing lands in `applied`.
      options?.verifyNesting?.(committedEdges);
      applied.push(write);
      return true;
    },
  } as unknown as ConglomerateRepository;

  const service = createConglomerateService({
    repo,
    assetRepo: {} as unknown as AssetRepository,
    marketData: {} as unknown as MarketDataService,
    currencyService: {} as unknown as CurrencyService,
    audience: {} as unknown as AudienceService,
  });

  return { service, writes, applied };
}

describe('conglomerateService.replacePositions — concurrent nesting writes', () => {
  it('rejects the losing write when the graph moved between the check and the write', async () => {
    // A → B committed after this caller's own check ran against an empty graph.
    const { service, writes, applied } = createStubService([], [{ parentId: A, childId: B }]);

    await expect(
      service.replacePositions(OWNER, B, [{ childId: A, weightPct: 100 }]),
    ).rejects.toMatchObject({ statusCode: 400, code: 'NESTING_CYCLE' });

    // The write was attempted (so the check really is the in-transaction one)
    // and then rolled back — B → A never became durable.
    expect(writes).toHaveLength(1);
    expect(applied).toHaveLength(0);
  });

  it('takes no re-check (and no lock) for a write that cannot touch the graph', async () => {
    const { service, writes } = createStubService([], []);
    await service.replacePositions(OWNER, B, [
      { assetId: '018f0000-0000-7000-8000-00000000cccc', weightPct: 100 },
    ]);
    expect(writes[0]!.verifyNesting).toBeUndefined();
  });
});

/**
 * The post-commit ancestor revalidation (#1755) seen from the seam it must not
 * break (#1776): it runs AFTER `replacePositions` has already committed, so it
 * may neither turn a durable save into a 4xx nor re-read the same basket once
 * per branch and again per ancestor. Driven over a stub graph because both
 * defects are about how many times — and after what — the repository is asked.
 */

interface StubBasket {
  status: ConglomerateDetailRow['status'];
  /** `weightPct` defaults to an even split, so a fixture only states it when it matters. */
  positions: Array<
    | { kind: 'asset'; assetId: string; weightPct?: number }
    | { kind: 'conglomerate'; childId: string; weightPct?: number }
  >;
}

function createGraphService(baskets: Record<string, StubBasket>) {
  const loads: string[] = [];
  const statusWrites: Array<{ id: string; status: string }> = [];
  const logged: Array<{ level: 'warn' | 'error'; fields: Record<string, unknown> }> = [];

  const detailOf = (id: string): ConglomerateDetailRow | null => {
    const basket = baskets[id];
    if (!basket) return null;
    const evenSplit = basket.positions.length > 0 ? 100 / basket.positions.length : 0;
    const positions: ConglomerateConstituentRow[] = basket.positions.map((p, sortOrder) =>
      p.kind === 'asset'
        ? {
            kind: 'asset',
            assetId: p.assetId,
            weightPct: p.weightPct ?? evenSplit,
            sortOrder,
            asset: { symbol: p.assetId, name: p.assetId, currency: 'EUR', type: 'stock' as const },
          }
        : {
            kind: 'conglomerate',
            childId: p.childId,
            weightPct: p.weightPct ?? evenSplit,
            sortOrder,
            child: {
              id: p.childId,
              name: p.childId,
              status: baskets[p.childId]?.status ?? 'draft',
              positionCount: baskets[p.childId]?.positions.length ?? 0,
            },
          },
    );
    return {
      id,
      name: id,
      description: null,
      status: basket.status,
      visibility: 'private',
      positionCount: positions.length,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      positions,
    };
  };

  const repo = {
    findByIdForOwner: async (ownerId: string, id: string) => {
      loads.push(id);
      return ownerId === OWNER ? detailOf(id) : null;
    },
    parentsOf: async (ownerId: string, id: string) =>
      ownerId === OWNER
        ? Object.entries(baskets)
            .filter(([, b]) =>
              b.positions.some((p) => p.kind === 'conglomerate' && p.childId === id),
            )
            .map(([parentId]) => ({ id: parentId, name: parentId }))
        : [],
    ownedConglomerateIds: async (ownerId: string, ids: readonly string[]) =>
      new Set(ownerId === OWNER ? ids : []),
    visibleAssetIds: async (_ownerId: string, ids: readonly string[]) => new Set(ids),
    nestingEdges: async () =>
      Object.entries(baskets).flatMap(([parentId, b]) =>
        b.positions.flatMap((p) =>
          p.kind === 'conglomerate' ? [{ parentId, childId: p.childId }] : [],
        ),
      ),
    replacePositions: async (_ownerId: string, id: string, positions: readonly PositionInput[]) => {
      const basket = baskets[id];
      if (!basket) return false;
      // The real repository stores the weights the caller sent and never touches
      // `status` — the reason the post-write gate has to run at all (#1831).
      basket.positions = positions.map((p) =>
        p.kind === 'asset'
          ? { kind: 'asset' as const, assetId: p.assetId, weightPct: p.weightPct }
          : { kind: 'conglomerate' as const, childId: p.childId, weightPct: p.weightPct },
      );
      return true;
    },
    setStatus: async (_ownerId: string, id: string, status: string) => {
      statusWrites.push({ id, status });
      const basket = baskets[id];
      if (basket) basket.status = status as ConglomerateDetailRow['status'];
      return true;
    },
    conglomerateIdsHoldingAsset: async (ownerId: string, assetId: string) =>
      ownerId === OWNER
        ? Object.entries(baskets)
            .filter(([, b]) => b.positions.some((p) => p.kind === 'asset' && p.assetId === assetId))
            .map(([id]) => id)
        : [],
  } as unknown as ConglomerateRepository;

  const logger = {
    warn: (fields: Record<string, unknown>) => logged.push({ level: 'warn', fields }),
    error: (fields: Record<string, unknown>) => logged.push({ level: 'error', fields }),
  } as unknown as Logger;

  const service = createConglomerateService({
    repo,
    assetRepo: {} as unknown as AssetRepository,
    marketData: {} as unknown as MarketDataService,
    currencyService: {} as unknown as CurrencyService,
    audience: {} as unknown as AudienceService,
    logger,
  });

  return { service, repo, baskets, loads, statusWrites, logged };
}

const asset = (assetId: string, weightPct?: number) => ({
  kind: 'asset' as const,
  assetId,
  ...(weightPct === undefined ? {} : { weightPct }),
});
const child = (childId: string, weightPct?: number) => ({
  kind: 'conglomerate' as const,
  childId,
  ...(weightPct === undefined ? {} : { weightPct }),
});

describe('conglomerateService.replacePositions — post-commit ancestor revalidation', () => {
  it('still succeeds when an ancestor cannot be flattened, and demotes it instead', async () => {
    // The issue's repro: A nests B, B nests six children of 50 assets each, so
    // flattening B resolves 300 assets — past MAX_FLATTENED_POSITIONS. Editing a
    // grandchild committed, then A's revalidation threw the mapped 422 back at
    // the caller, and the Builder re-PUT the identical payload on every keystroke.
    const baskets: Record<string, StubBasket> = {
      A: { status: 'active', positions: [child('B')] },
      B: { status: 'active', positions: Array.from({ length: 6 }, (_, i) => child(`C${i}`)) },
    };
    for (let i = 0; i < 6; i += 1) {
      baskets[`C${i}`] = {
        status: 'draft',
        positions: Array.from({ length: 50 }, (_, j) => asset(`a${i}-${j}`)),
      };
    }
    const { service, statusWrites, logged } = createGraphService(baskets);

    const detail = await service.replacePositions(OWNER, 'C0', [
      { assetId: 'a0-0', weightPct: 100 },
    ]);

    // 2xx, and the positions the caller sent are what is stored.
    expect(detail.id).toBe('C0');
    expect(baskets.C0!.positions).toEqual([asset('a0-0', 100)]);
    // The ancestor that cannot be resolved is recorded as needing attention —
    // a basket whose own resolved view is a 422 does not earn `active`.
    expect(statusWrites).toEqual([{ id: 'A', status: 'draft' }]);
    // B still flattens (six 50-asset children, one at a time), so it is left be.
    expect(baskets.B!.status).toBe('active');
    // And the failure is reported rather than silently swallowed.
    expect(logged).toHaveLength(1);
    expect(logged[0]!.level).toBe('warn');
    expect(logged[0]!.fields).toMatchObject({
      conglomerateId: 'A',
      err: { code: 'NESTING_TOO_MANY_ASSETS' },
    });
  });

  it('still succeeds when the revalidation sweep itself fails, and reports it', async () => {
    const { service, repo, logged } = createGraphService({
      P: { status: 'active', positions: [child('C')] },
      C: { status: 'draft', positions: [asset('x')] },
    });
    const boom = new Error('parentsOf exploded');
    const brokenRepo = repo as unknown as { parentsOf: () => Promise<never> };
    brokenRepo.parentsOf = () => Promise.reject(boom);

    await expect(
      service.replacePositions(OWNER, 'C', [{ assetId: 'x', weightPct: 100 }]),
    ).resolves.toMatchObject({ id: 'C' });
    expect(logged).toEqual([
      { level: 'error', fields: expect.objectContaining({ err: boom, seedIds: ['C'] }) },
    ]);
  });

  it('loads each basket of a diamond once per request, not once per branch or ancestor', async () => {
    // A → {B1, B2}, and both branches nest the edited basket E *and* the shared
    // basket G. G used to be re-read for B1, for B2, and again for each of them
    // while A was checked — four reads of three round trips each, per keystroke.
    const { service, loads } = createGraphService({
      A: { status: 'active', positions: [child('B1'), child('B2')] },
      B1: { status: 'active', positions: [child('E'), child('G')] },
      B2: { status: 'active', positions: [child('E'), child('G')] },
      E: { status: 'draft', positions: [asset('e1')] },
      G: { status: 'draft', positions: [asset('g1')] },
    });

    await service.replacePositions(OWNER, 'E', [{ assetId: 'e1', weightPct: 100 }]);

    const times = (id: string) => loads.filter((loaded) => loaded === id).length;
    expect(times('G')).toBe(1);
    expect(times('B1')).toBe(1);
    expect(times('B2')).toBe(1);
    expect(times('A')).toBe(1);
    // The edited basket is read once by the sweep and once more to build the
    // response — the two reads the request genuinely needs.
    expect(times('E')).toBe(2);
  });
});

/**
 * The gate on the basket the write itself edited (#1831). `replacePositions`
 * never touches `status`, and the sweep used to check ANCESTORS only — so an
 * autosave could point an `active` basket at an empty child and leave it
 * `active` while its own resolved view reported the slice unresolved.
 */
describe('conglomerateService.replacePositions — the edited basket is gated too', () => {
  it('demotes the edited basket when the edit points it at an empty nested child', async () => {
    const { service, baskets, statusWrites } = createGraphService({
      P: { status: 'active', positions: [asset('a1', 60), child('C', 40)] },
      C: { status: 'draft', positions: [asset('x1')] },
      E: { status: 'draft', positions: [] },
    });

    const detail = await service.replacePositions(OWNER, 'P', [
      { assetId: 'a1', weightPct: 60 },
      { childId: 'E', weightPct: 40 },
    ]);

    // The write itself stands — the swap is what the owner asked for…
    expect(baskets.P!.positions).toEqual([asset('a1', 60), child('E', 40)]);
    // …but P no longer earns `active`: 40 % of it now resolves to nothing, the
    // state `POST /:id/activate` refuses outright.
    expect(statusWrites).toEqual([{ id: 'P', status: 'draft' }]);
    expect(detail.status).toBe('draft');
  });

  it('leaves a still-resolvable edit — and its ancestors — alone', async () => {
    const { service, baskets, statusWrites } = createGraphService({
      A: { status: 'active', positions: [child('P')] },
      P: { status: 'active', positions: [asset('a1', 60), child('C', 40)] },
      C: { status: 'active', positions: [asset('x1')] },
    });

    await service.replacePositions(OWNER, 'P', [
      { assetId: 'a1', weightPct: 70 },
      { childId: 'C', weightPct: 30 },
    ]);

    expect(statusWrites).toEqual([]);
    expect(baskets.P!.status).toBe('active');
    expect(baskets.A!.status).toBe('active');
  });

  it('does not take over the sum-to-100 rule: off-sum weights are not demoted', async () => {
    // The gate re-run here is the NESTED half only (emptiness + nesting). Σ = 100
    // is checked when a basket is activated, over its own weights, and an edit
    // that leaves the sum short is a draft-in-progress, not a broken structure.
    const { service, baskets, statusWrites } = createGraphService({
      P: { status: 'active', positions: [asset('a1', 30), asset('a2', 20)] },
    });

    await service.replacePositions(OWNER, 'P', [
      { assetId: 'a1', weightPct: 30 },
      { assetId: 'a2', weightPct: 25 },
    ]);

    expect(statusWrites).toEqual([]);
    expect(baskets.P!.status).toBe('active');
  });
});

/**
 * One transient read must not decide a status (#1831). The sweep shares ONE
 * cache across the whole closure, so a rejected read that stayed in it was
 * re-thrown — with no second attempt — for every ancestor above the failed
 * basket, and each of them was demoted on a network blip.
 */
describe('conglomerateService.replacePositions — a poisoned read in the sweep', () => {
  const diamond = () => ({
    A: { status: 'active' as const, positions: [child('B'), child('C')] },
    B: { status: 'active' as const, positions: [child('X')] },
    C: { status: 'active' as const, positions: [child('X')] },
    X: { status: 'active' as const, positions: [asset('x1')] },
  });

  /** Make `id`'s first `failures` reads reject; later ones serve the real row. */
  function poisonReads(repo: ConglomerateRepository, id: string, failures: number) {
    const seam = repo as unknown as {
      findByIdForOwner: (
        ownerId: string,
        rowId: string,
        opts?: unknown,
      ) => Promise<ConglomerateDetailRow | null>;
    };
    const real = seam.findByIdForOwner.bind(repo);
    const attempts = { count: 0 };
    seam.findByIdForOwner = async (ownerId, rowId, opts) => {
      if (rowId === id) {
        attempts.count += 1;
        if (attempts.count <= failures) throw new Error(`transient read failure on ${rowId}`);
      }
      return real(ownerId, rowId, opts);
    };
    return attempts;
  }

  it('demotes nobody when a single read of a shared grandchild fails once', async () => {
    const { service, repo, baskets, statusWrites } = createGraphService(diamond());
    const attempts = poisonReads(repo, 'X', 1);

    await service.replacePositions(OWNER, 'X', [{ assetId: 'x1', weightPct: 100 }]);

    // The failed read is retried rather than memoised, so nothing in the
    // closure is judged on it. Every basket keeps the status it earned.
    expect(statusWrites).toEqual([]);
    expect(baskets.A!.status).toBe('active');
    expect(baskets.B!.status).toBe('active');
    expect(baskets.C!.status).toBe('active');
    expect(attempts.count).toBeGreaterThan(1);
  });

  it('still demotes what genuinely cannot resolve when the read keeps failing', async () => {
    const { service, repo, baskets, statusWrites, logged } = createGraphService(diamond());
    poisonReads(repo, 'X', Number.MAX_SAFE_INTEGER);

    // The edit itself survives the failing sweep, exactly as before.
    await expect(
      service.replacePositions(OWNER, 'C', [{ childId: 'X', weightPct: 100 }]),
    ).resolves.toMatchObject({ id: 'C' });

    // C nests X and A reaches it through B; neither can be shown to resolve, so
    // neither keeps `active` — and both refusals are reported.
    expect(statusWrites).toEqual([
      { id: 'C', status: 'draft' },
      { id: 'A', status: 'draft' },
    ]);
    expect(baskets.B!.status).toBe('active');
    expect(logged.some((l) => l.level === 'warn')).toBe(true);
  });
});

describe('conglomerateService.revalidateAfterAssetRemoval', () => {
  it('demotes the emptied basket AND the ancestors activated for it', async () => {
    // C = [X 100%], P = [A 60%, C 40%], both active; deleting the custom asset X
    // cascades C's only position away (#1776).
    const { service, baskets, statusWrites } = createGraphService({
      P: { status: 'active', positions: [asset('a1'), child('C')] },
      C: { status: 'active', positions: [asset('X')] },
    });

    const held = await service.basketsHoldingAsset(OWNER, 'X');
    expect(held).toEqual(['C']);

    // The delete itself: the position row goes with the asset identity.
    baskets.C!.positions = [];
    await service.revalidateAfterAssetRemoval(OWNER, held);

    expect(statusWrites).toEqual([
      { id: 'C', status: 'draft' },
      { id: 'P', status: 'draft' },
    ]);
  });

  it('leaves a basket that still resolves alone', async () => {
    const { service, baskets, statusWrites } = createGraphService({
      P: { status: 'active', positions: [asset('a1'), child('C')] },
      C: { status: 'active', positions: [asset('X'), asset('a2')] },
    });
    const held = await service.basketsHoldingAsset(OWNER, 'X');
    baskets.C!.positions = [asset('a2')];
    await service.revalidateAfterAssetRemoval(OWNER, held);
    expect(statusWrites).toEqual([]);
  });
});
