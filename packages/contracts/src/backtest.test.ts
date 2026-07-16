import { describe, expect, it } from 'vitest';

import {
  backtestBenchmarkInputSchema,
  backtestPreviewRequestSchema,
  backtestResponseSchema,
} from './backtest';

const UUID_A = '018f0000-0000-7000-8000-00000000000a';
const UUID_B = '018f0000-0000-7000-8000-00000000000b';

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
