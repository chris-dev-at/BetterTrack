import { describe, expect, it } from 'vitest';

import {
  backtestBenchmarkInputSchema,
  backtestComparisonRequestSchema,
  backtestComparisonResponseSchema,
  backtestPreviewRequestSchema,
  backtestResponseSchema,
  COMPARISON_MAX_SERIES,
} from './backtest';

const UUID_A = '018f0000-0000-7000-8000-00000000000a';
const UUID_B = '018f0000-0000-7000-8000-00000000000b';

/** N distinct valid UUIDs for the comparison-size tests. */
function uuids(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `018f0000-0000-7000-8000-0000000000${(i + 16).toString(16)}`,
  );
}

const BASE_REQUEST = {
  positions: [{ assetId: UUID_A, weight: 60 }],
  range: '5Y',
};

describe('backtestBenchmarkInputSchema — exactly one benchmark at a time (V4-P7)', () => {
  it('accepts each single source: preset, catalog asset, own conglomerate', () => {
    expect(backtestBenchmarkInputSchema.safeParse({ preset: '^GSPC' }).success).toBe(true);
    expect(backtestBenchmarkInputSchema.safeParse({ assetId: UUID_A }).success).toBe(true);
    expect(backtestBenchmarkInputSchema.safeParse({ conglomerateId: UUID_B }).success).toBe(true);
  });

  it('rejects two sources at once — a wire invariant, not a service check', () => {
    expect(
      backtestBenchmarkInputSchema.safeParse({ preset: '^GSPC', assetId: UUID_A }).success,
    ).toBe(false);
    expect(
      backtestBenchmarkInputSchema.safeParse({ assetId: UUID_A, conglomerateId: UUID_B }).success,
    ).toBe(false);
    expect(
      backtestBenchmarkInputSchema.safeParse({ preset: '^GSPC', conglomerateId: UUID_B }).success,
    ).toBe(false);
  });

  it('rejects an unknown preset and a non-uuid id', () => {
    expect(backtestBenchmarkInputSchema.safeParse({ preset: '^FTSE' }).success).toBe(false);
    expect(backtestBenchmarkInputSchema.safeParse({ assetId: 'not-a-uuid' }).success).toBe(false);
    expect(backtestBenchmarkInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('backtestPreviewRequestSchema — benchmark field (V4-P7)', () => {
  it('accepts a request without a benchmark, with null, and with each single source', () => {
    expect(backtestPreviewRequestSchema.safeParse(BASE_REQUEST).success).toBe(true);
    expect(
      backtestPreviewRequestSchema.safeParse({ ...BASE_REQUEST, benchmark: null }).success,
    ).toBe(true);
    for (const benchmark of [
      { preset: '^GDAXI' },
      { assetId: UUID_A },
      { conglomerateId: UUID_B },
    ]) {
      expect(backtestPreviewRequestSchema.safeParse({ ...BASE_REQUEST, benchmark }).success).toBe(
        true,
      );
    }
  });

  it('rejects a request naming two benchmark sources at once', () => {
    expect(
      backtestPreviewRequestSchema.safeParse({
        ...BASE_REQUEST,
        benchmark: { preset: '^GSPC', conglomerateId: UUID_B },
      }).success,
    ).toBe(false);
  });

  it('rejects the pre-V4-P7 bare-string benchmark shape', () => {
    expect(
      backtestPreviewRequestSchema.safeParse({ ...BASE_REQUEST, benchmark: '^GSPC' }).success,
    ).toBe(false);
  });
});

describe('backtestResponseSchema — benchmark result block (V4-P7)', () => {
  it('accepts a full benchmark block with kind, refId, label, series and stats', () => {
    const response = {
      startDate: '2021-01-04',
      endDate: '2026-01-05',
      series: [{ date: '2021-01-04', value: 100 }],
      stats: {
        totalReturnPct: 12.5,
        cagrPct: 2.4,
        maxDrawdownPct: -8,
        volatilityPct: 14,
        bestDay: { date: '2022-03-01', returnPct: 3 },
        worstDay: { date: '2022-03-02', returnPct: -3 },
      },
      contributions: [],
      notice: null,
      benchmark: {
        kind: 'conglomerate',
        refId: UUID_B,
        label: 'My Mix',
        series: [{ date: '2021-01-04', value: 100 }],
        stats: {
          totalReturnPct: 10,
          cagrPct: 1.9,
          maxDrawdownPct: -6,
          volatilityPct: 11,
          bestDay: null,
          worstDay: null,
        },
      },
      mode: 'clip',
      rebalance: 'quarterly',
      entryEvents: [],
      rebalanceEvents: [{ date: '2021-04-01' }],
      idleCashAvgPct: null,
    };
    expect(backtestResponseSchema.safeParse(response).success).toBe(true);
  });
});

describe('backtestComparisonRequestSchema — N-way comparison (V5-P6)', () => {
  it('accepts 2…6 conglomerate ids and applies the mode/rebalance defaults', () => {
    for (let n = 2; n <= COMPARISON_MAX_SERIES; n += 1) {
      const parsed = backtestComparisonRequestSchema.safeParse({
        conglomerateIds: uuids(n),
        range: '5Y',
      });
      expect(parsed.success, `n=${n}`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.mode).toBe('clip');
        expect(parsed.data.rebalance).toBe('none');
      }
    }
  });

  it('rejects N=7 (over the cap) and N=1 (under the floor) at the contract', () => {
    expect(
      backtestComparisonRequestSchema.safeParse({ conglomerateIds: uuids(7), range: '5Y' }).success,
    ).toBe(false);
    expect(
      backtestComparisonRequestSchema.safeParse({ conglomerateIds: uuids(1), range: '5Y' }).success,
    ).toBe(false);
  });

  it('rejects duplicate ids', () => {
    expect(
      backtestComparisonRequestSchema.safeParse({ conglomerateIds: [UUID_A, UUID_A], range: '5Y' })
        .success,
    ).toBe(false);
  });

  it('accepts a baselineId that is one of the ids, rejects one that is not', () => {
    expect(
      backtestComparisonRequestSchema.safeParse({
        conglomerateIds: [UUID_A, UUID_B],
        range: '5Y',
        baselineId: UUID_B,
      }).success,
    ).toBe(true);
    expect(
      backtestComparisonRequestSchema.safeParse({
        conglomerateIds: [UUID_A, UUID_B],
        range: '5Y',
        baselineId: '018f0000-0000-7000-8000-0000000000ff',
      }).success,
    ).toBe(false);
  });
});

describe('backtestComparisonResponseSchema — series + deltas (V5-P6)', () => {
  it('accepts a two-series comparison with full stats and per-metric deltas', () => {
    const response = {
      startDate: '2021-01-04',
      endDate: '2026-01-05',
      baselineId: UUID_A,
      mode: 'clip',
      rebalance: 'none',
      series: [
        {
          conglomerateId: UUID_A,
          name: 'A/B Mix',
          series: [{ date: '2021-01-04', value: 100 }],
          stats: {
            totalReturnPct: 12.5,
            cagrPct: 2.4,
            maxDrawdownPct: -8,
            volatilityPct: 14,
            bestDay: { date: '2022-03-01', returnPct: 3 },
            worstDay: { date: '2022-03-02', returnPct: -3 },
          },
          deltas: {
            totalReturnPct: 0,
            cagrPct: 0,
            maxDrawdownPct: 0,
            volatilityPct: 0,
            bestDayPct: 0,
            worstDayPct: 0,
          },
        },
        {
          conglomerateId: UUID_B,
          name: 'All B',
          series: [{ date: '2021-01-04', value: 100 }],
          stats: {
            totalReturnPct: 10,
            cagrPct: null,
            maxDrawdownPct: -6,
            volatilityPct: null,
            bestDay: null,
            worstDay: null,
          },
          deltas: {
            totalReturnPct: -2.5,
            cagrPct: null,
            maxDrawdownPct: 2,
            volatilityPct: null,
            bestDayPct: null,
            worstDayPct: null,
          },
        },
      ],
    };
    expect(backtestComparisonResponseSchema.safeParse(response).success).toBe(true);
  });
});
