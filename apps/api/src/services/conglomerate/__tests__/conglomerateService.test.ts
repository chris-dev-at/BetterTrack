import { describe, expect, it } from 'vitest';

import type {
  ConglomerateRepository,
  NestingEdgeRow,
  PositionInput,
} from '../../../data/repositories/conglomerateRepository';
import type { AssetRepository } from '../../../data/repositories/assetRepository';
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
