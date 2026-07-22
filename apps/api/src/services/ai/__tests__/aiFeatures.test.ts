import { describe, expect, it, vi } from 'vitest';

import type {
  AnalyticsSeriesResponse,
  PortfolioResponse,
  SearchResponse,
} from '@bettertrack/contracts';

import { ApiError } from '../../../errors';
import type { Logger } from '../../../logger';
import { createAiFeaturesService } from '../aiFeaturesService';
import { AiCapExceededError, AiUnavailableError } from '../errors';
import { computeInsights } from '../insightFacts';
import { extractJsonObject, parseNlIntents } from '../nlIntent';

/**
 * Unit tests for the user-facing AI features (§13.5 V5-P12 2/2), with every I/O
 * dep mocked so the design mandate is asserted deterministically: the model ONLY
 * phrases / extracts intent, and every number + asset id is service-computed. The
 * feature service has NO write dependency at all — structurally it cannot mutate
 * data, which is exactly the "informational only, never auto-acts" guarantee.
 */

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function holding(symbol: string, marketValueEur: number) {
  return {
    asset: { symbol, name: symbol },
    marketValueEur,
  } as unknown as PortfolioResponse['holdings'][number];
}

function portfolioWith(...holdings: PortfolioResponse['holdings']): PortfolioResponse {
  return { baseCurrency: 'EUR', holdings, totals: {} } as unknown as PortfolioResponse;
}

function seriesWithDrawdown(maxDrawdownPct: number): AnalyticsSeriesResponse {
  return { primary: { stats: { maxDrawdownPct } } } as unknown as AnalyticsSeriesResponse;
}

function searchHit(id: string, symbol: string): SearchResponse {
  return {
    results: [
      {
        id,
        providerId: 'yahoo',
        providerRef: symbol,
        symbol,
        name: symbol,
        exchange: null,
        type: 'stock',
        currency: 'USD',
        isCustom: false,
      },
    ],
  } as unknown as SearchResponse;
}

const UUID_A = '00000000-0000-7000-8000-000000000001';
const UUID_B = '00000000-0000-7000-8000-000000000002';

describe('computeInsights (pure — authoritative numbers)', () => {
  it('derives concentration facts from holdings and omits drawdown when flat', () => {
    const { observations, promptFacts } = computeInsights({
      holdings: [
        holding('AAPL', 4200),
        holding('MSFT', 3000),
        holding('GOLD', 2000),
        holding('TSLA', 800),
      ],
      maxDrawdownPct: 0,
    });
    const concentration = observations.find((o) => o.kind === 'concentration');
    expect(concentration).toBeDefined();
    const facts = Object.fromEntries(concentration!.facts.map((f) => [f.key, f.value]));
    expect(facts.topWeightPct).toBe(42); // 4200 / 10000
    expect(facts.top3WeightPct).toBe(92); // (4200+3000+2000) / 10000
    expect(facts.positionCount).toBe(4);
    expect(observations.some((o) => o.kind === 'drawdown')).toBe(false); // flat ⇒ no drawdown obs
    expect(promptFacts.length).toBeGreaterThan(0);
  });

  it('emits a drawdown observation only for a real (negative) drawdown', () => {
    const withDrawdown = computeInsights({
      holdings: [holding('AAA', 100)],
      maxDrawdownPct: -15.25,
    });
    const dd = withDrawdown.observations.find((o) => o.kind === 'drawdown');
    expect(dd?.facts[0]).toEqual({ key: 'maxDrawdownPct', value: 15.3 }); // magnitude, 1 dp
  });

  it('excludes unpriced/flat holdings and returns nothing for an empty portfolio', () => {
    expect(computeInsights({ holdings: [], maxDrawdownPct: -5 }).observations).toEqual([]);
    const onlyUnpriced = computeInsights({
      holdings: [
        {
          asset: { symbol: 'X', name: 'X' },
          marketValueEur: null,
        } as unknown as PortfolioResponse['holdings'][number],
      ],
      maxDrawdownPct: null,
    });
    expect(onlyUnpriced.observations).toEqual([]);
  });
});

describe('parseNlIntents (pure — tolerant JSON extraction)', () => {
  it('parses plain, fenced and prose-wrapped JSON identically', () => {
    const expected = [
      { query: 'US tech', weightPct: 60 },
      { query: 'gold', weightPct: 40 },
    ];
    const body = '{"lines":[{"query":"US tech","weightPct":60},{"query":"gold","weightPct":40}]}';
    expect(parseNlIntents(body)).toEqual(expected);
    expect(parseNlIntents('```json\n' + body + '\n```')).toEqual(expected);
    expect(parseNlIntents('Sure! Here you go:\n' + body + '\nHope that helps.')).toEqual(expected);
  });

  it('clamps weights, truncates queries, caps at 50 and fails soft on garbage', () => {
    const clamped = parseNlIntents(
      '{"lines":[{"query":"a","weightPct":999},{"query":"b","weightPct":-5}]}',
    );
    expect(clamped).toEqual([
      { query: 'a', weightPct: 100 },
      { query: 'b', weightPct: 0 },
    ]);
    const many = `{"lines":[${Array.from({ length: 80 }, (_, i) => `{"query":"q${i}","weightPct":1}`).join(',')}]}`;
    expect(parseNlIntents(many)).toHaveLength(50);
    expect(parseNlIntents('not json at all')).toEqual([]);
    expect(parseNlIntents('{"lines": "oops"}')).toEqual([]);
  });

  it('keeps a brace inside a quoted value from closing the object early', () => {
    expect(extractJsonObject('prefix {"a":"has } brace","b":1} suffix')).toBe(
      '{"a":"has } brace","b":1}',
    );
  });
});

describe('aiFeaturesService.insights', () => {
  function make(
    overrides: {
      complete?: ReturnType<typeof vi.fn>;
      getPortfolio?: ReturnType<typeof vi.fn>;
      getSeries?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const complete =
      overrides.complete ??
      vi.fn().mockResolvedValue({
        text: 'A neutral summary.',
        model: 'llama3.1:8b',
        provider: 'ollama',
      });
    const getPortfolio =
      overrides.getPortfolio ??
      vi
        .fn()
        .mockResolvedValue(
          portfolioWith(holding('AAPL', 4200), holding('MSFT', 3000), holding('GOLD', 2800)),
        );
    const getSeries = overrides.getSeries ?? vi.fn().mockResolvedValue(seriesWithDrawdown(-12.5));
    const search = vi.fn();
    const service = createAiFeaturesService({
      ai: { complete } as never,
      portfolio: { getPortfolio } as never,
      analytics: { getSeries } as never,
      search: { search } as never,
      logger: noopLogger,
    });
    return { service, complete, getPortfolio, getSeries };
  }

  it('renders service-computed observations phrased by the model (one cap unit)', async () => {
    const { service, complete } = make();
    const res = await service.insights('u1', { portfolioId: UUID_A });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(res.summary).toBe('A neutral summary.');
    expect(res.model).toBe('llama3.1:8b');
    const concentration = res.observations.find((o) => o.kind === 'concentration')!;
    expect(Object.fromEntries(concentration.facts.map((f) => [f.key, f.value]))).toMatchObject({
      topWeightPct: 42,
      positionCount: 3,
    });
    expect(res.observations.some((o) => o.kind === 'drawdown')).toBe(true);
    // The response carries no action/mutation field — informational only.
    expect(Object.keys(res).sort()).toEqual(['model', 'observations', 'summary']);
  });

  it('never lets a figure in the model text override the service-computed numbers', async () => {
    const lying = vi.fn().mockResolvedValue({
      text: 'Your top holding is 999% and you have 42 positions.',
      model: 'm',
      provider: 'ollama',
    });
    const { service } = make({ complete: lying });
    const res = await service.insights('u1', { portfolioId: UUID_A });
    const facts = Object.fromEntries(
      res.observations.find((o) => o.kind === 'concentration')!.facts.map((f) => [f.key, f.value]),
    );
    expect(facts.topWeightPct).toBe(42); // NOT 999
    expect(facts.positionCount).toBe(3); // NOT 42
  });

  it('omits drawdown (but still succeeds) when the analytics series cannot be built', async () => {
    const { service } = make({ getSeries: vi.fn().mockRejectedValue(new Error('no series')) });
    const res = await service.insights('u1', { portfolioId: UUID_A });
    expect(res.observations.some((o) => o.kind === 'concentration')).toBe(true);
    expect(res.observations.some((o) => o.kind === 'drawdown')).toBe(false);
  });

  it('rejects (400) an empty portfolio without spending a completion', async () => {
    const { service, complete } = make({
      getPortfolio: vi.fn().mockResolvedValue(portfolioWith()),
    });
    await expect(service.insights('u1', { portfolioId: UUID_A })).rejects.toBeInstanceOf(ApiError);
    expect(complete).not.toHaveBeenCalled(); // no cap burned on nothing
  });

  it('propagates the typed unavailable / cap errors from the guarded path', async () => {
    const unavailable = make({ complete: vi.fn().mockRejectedValue(new AiUnavailableError()) });
    await expect(
      unavailable.service.insights('u1', { portfolioId: UUID_A }),
    ).rejects.toBeInstanceOf(AiUnavailableError);
    const capped = make({ complete: vi.fn().mockRejectedValue(new AiCapExceededError(3600)) });
    await expect(capped.service.insights('u1', { portfolioId: UUID_A })).rejects.toBeInstanceOf(
      AiCapExceededError,
    );
  });
});

describe('aiFeaturesService.conglomerateDraft', () => {
  function make(complete: ReturnType<typeof vi.fn>, search: ReturnType<typeof vi.fn>) {
    return createAiFeaturesService({
      ai: { complete } as never,
      portfolio: { getPortfolio: vi.fn() } as never,
      analytics: { getSeries: vi.fn() } as never,
      search: { search } as never,
      logger: noopLogger,
    });
  }

  it('resolves intents through the local catalog and flags — never drops — unresolvable ones', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: '{"lines":[{"query":"nasdaq","weightPct":60},{"query":"unicorn dust","weightPct":40}]}',
      model: 'm',
      provider: 'ollama',
    });
    const search = vi
      .fn()
      .mockResolvedValueOnce(searchHit(UUID_B, 'QQQ'))
      .mockResolvedValueOnce({ results: [] } as unknown as SearchResponse);
    const service = make(complete, search);

    const res = await service.conglomerateDraft('u1', { prompt: '60% nasdaq, 40% unicorn dust' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(2);
    expect(res.lines).toHaveLength(2); // nothing dropped
    // Weight comes from the model; the asset id comes ONLY from the catalog.
    expect(res.lines[0]).toEqual({
      query: 'nasdaq',
      weightPct: 60,
      asset: expect.objectContaining({ id: UUID_B, symbol: 'QQQ' }),
    });
    expect(res.lines[1]).toEqual({ query: 'unicorn dust', weightPct: 40, asset: null });
  });

  it('raises a provider error when the model returns no usable intent', async () => {
    const complete = vi
      .fn()
      .mockResolvedValue({ text: 'I cannot help with that.', model: 'm', provider: 'ollama' });
    const search = vi.fn();
    await expect(
      make(complete, search).conglomerateDraft('u1', { prompt: 'hi' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(search).not.toHaveBeenCalled();
  });

  it('propagates the typed cap error from the guarded path', async () => {
    const complete = vi.fn().mockRejectedValue(new AiCapExceededError(3600));
    await expect(
      make(complete, vi.fn()).conglomerateDraft('u1', { prompt: 'x' }),
    ).rejects.toBeInstanceOf(AiCapExceededError);
  });
});
