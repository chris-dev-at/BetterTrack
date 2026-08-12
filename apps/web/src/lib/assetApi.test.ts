import { ASSET_BATCH_MAX_IDS } from '@bettertrack/contracts';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./apiClient', () => ({ apiRequest: vi.fn() }));

import { apiRequest } from './apiClient';
import { getAssetQuotes, getAssetSparklines } from './assetApi';

const assetId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const quote = {
  price: 150,
  currency: 'USD' as const,
  prevClose: 148,
  dayChangePct: 1.35,
  asOf: '2026-06-20T09:59:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('aggregate asset reads', () => {
  test('sends one canonical request for a list inside the server cap', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      quotes: [{ assetId: assetId(1), quote, stale: false, asOf: quote.asOf }],
      failed: [],
    });

    const result = await getAssetQuotes([assetId(2), assetId(1), assetId(2)]);

    expect(apiRequest).toHaveBeenCalledTimes(1);
    // De-duplicated and sorted so a drag-only reorder reuses the same URL.
    expect(vi.mocked(apiRequest).mock.calls[0]?.[1]?.query).toEqual({
      ids: `${assetId(1)},${assetId(2)}`,
    });
    expect(result.quotes).toHaveLength(1);
  });

  test('chunks past the server cap instead of sending a request that 400s', async () => {
    const ids = Array.from({ length: ASSET_BATCH_MAX_IDS + 5 }, (_, index) => assetId(index));
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => ({
      quotes: (options?.query?.ids as string)
        .split(',')
        .map((id) => ({ assetId: id, quote, stale: false, asOf: quote.asOf })),
      failed: [],
    }));

    const result = await getAssetQuotes(ids);

    expect(apiRequest).toHaveBeenCalledTimes(2);
    const pages = vi
      .mocked(apiRequest)
      .mock.calls.map((call) => (call[1]?.query?.ids as string).split(','));
    expect(pages[0]).toHaveLength(ASSET_BATCH_MAX_IDS);
    expect(pages[1]).toHaveLength(5);
    // Every id still resolves — the caller sees one merged response.
    expect(result.quotes.map((entry) => entry.assetId)).toEqual([...ids].sort());
  });

  test('chunks sparklines on the same cap and merges the pages', async () => {
    const ids = Array.from({ length: ASSET_BATCH_MAX_IDS * 2 }, (_, index) => assetId(index));
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => ({
      sparklines: (options?.query?.ids as string).split(',').map((id) => ({
        assetId: id,
        points: [{ time: '2026-06-20T00:00:00.000Z', close: 150 }],
        stale: false,
        asOf: quote.asOf,
      })),
      failed: [],
    }));

    const result = await getAssetSparklines(ids);

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(result.sparklines).toHaveLength(ids.length);
    expect(result.failed).toEqual([]);
  });

  test('merges the failed ids of every page, not just the first', async () => {
    const ids = Array.from({ length: ASSET_BATCH_MAX_IDS + 2 }, (_, index) => assetId(index));
    // One unpriceable row per page: chunking must not swallow the second page's
    // failure, or the client silently under-reports the outage.
    vi.mocked(apiRequest).mockImplementation(async (_path, options) => {
      const page = (options?.query?.ids as string).split(',');
      return {
        quotes: page.slice(1).map((id) => ({ assetId: id, quote, stale: false, asOf: quote.asOf })),
        failed: [page[0]],
      };
    });

    const result = await getAssetQuotes(ids);

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(result.failed).toEqual([assetId(0), assetId(ASSET_BATCH_MAX_IDS)]);
    expect(result.quotes).toHaveLength(ids.length - 2);
  });
});
