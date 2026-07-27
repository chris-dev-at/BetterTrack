import type { HistoryRange, PricePoint, Quote, SearchResultItem } from '@bettertrack/contracts';

import { getAssetDailyCloses, getAssetQuote } from './assetApi';
import { searchAssets } from './searchApi';

const DAY_MS = 86_400_000;
const FX_NEAREST_PRIOR_MAX_DAYS = 7;
const FX_HISTORY_MEMO_MS = 60_000;
const FX_HISTORY_DAY_INDEX = new WeakMap<readonly PricePoint[], ReadonlyMap<string, number>>();

export const MARKET_DATA_SOURCE_ERROR_CODES = [
  'MARKET_DATA_INVALID',
  'MARKET_DATA_UNAVAILABLE',
  'MARKET_DATA_UNSUPPORTED',
] as const;

export type MarketDataSourceErrorCode = (typeof MARKET_DATA_SOURCE_ERROR_CODES)[number];

/** A typed failure at the public market-data boundary. */
export class MarketDataSourceError extends Error {
  constructor(
    public readonly code: MarketDataSourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MarketDataSourceError';
  }
}

export interface MarketDataValue<T> {
  value: T;
  stale: boolean;
  /** Upstream observation time, or null when no provider value exists. */
  asOf: string | null;
  /** Changes whenever the money-relevant payload changes. */
  watermark: string;
}

export interface MarketFxValue extends MarketDataValue<number> {
  from: string;
  to: string;
  /** Historical day, or null for a spot rate. */
  date: string | null;
}

/**
 * The autonomy seam required by the paranoid design. V5 has one implementation:
 * BetterTrack's public asset/search API. None of these methods identifies or
 * reads a portfolio.
 */
export interface MarketDataSource {
  quote(assetId: string, signal?: AbortSignal): Promise<MarketDataValue<Quote>>;
  history(
    assetId: string,
    range: HistoryRange,
    signal?: AbortSignal,
  ): Promise<MarketDataValue<PricePoint[]>>;
  search(query: string, signal?: AbortSignal): Promise<MarketDataValue<SearchResultItem[]>>;
  fx(from: string, to: string, date?: string, signal?: AbortSignal): Promise<MarketFxValue>;
}

export interface BetterTrackMarketDataSourceOptions {
  now?: () => number;
}

/**
 * BetterTrack API implementation of {@link MarketDataSource}. History uses the
 * dedicated daily-close endpoint so portfolio valuation never receives weekly
 * or monthly candles. FX mirrors the server's audited provider convention:
 * Yahoo `EUR{CCY}=X` legs crossed through EUR.
 */
export function createBetterTrackMarketDataSource(
  options: BetterTrackMarketDataSourceOptions = {},
): MarketDataSource {
  const now = options.now ?? Date.now;
  const fxAssetIds = new Map<string, Promise<string>>();
  const fxHistories = new Map<
    string,
    { pending: Promise<MarketDataValue<PricePoint[]>>; expiresAt: number }
  >();

  const source: MarketDataSource = {
    async quote(assetId, signal) {
      signal?.throwIfAborted();
      try {
        const result = await getAssetQuote(assetId, signal);
        assertPositive(result.quote.price, `quote for asset ${assetId}`);
        return {
          value: result.quote,
          stale: result.stale,
          asOf: result.asOf,
          watermark: await payloadWatermark({
            quote: result.quote,
            stale: result.stale,
            asOf: result.asOf,
          }),
        };
      } catch (cause) {
        rethrowAbort(cause, signal);
        if (cause instanceof MarketDataSourceError) throw cause;
        if (isSchemaFailure(cause)) {
          throw marketFailure(
            'MARKET_DATA_INVALID',
            `Quote payload for asset ${assetId} is invalid.`,
            cause,
          );
        }
        throw marketFailure(
          'MARKET_DATA_UNAVAILABLE',
          `Quote unavailable for asset ${assetId}.`,
          cause,
        );
      }
    },

    async history(assetId, range, signal) {
      signal?.throwIfAborted();
      try {
        const result = await getAssetDailyCloses(assetId, signal);
        const points = filterRange(result.points, range, now());
        for (const point of points) {
          assertPositive(point.close, `daily close for asset ${assetId} at ${point.time}`);
        }
        return {
          value: points,
          stale: result.stale,
          asOf: result.asOf,
          watermark: await payloadWatermark({
            points,
            stale: result.stale,
            asOf: result.asOf,
          }),
        };
      } catch (cause) {
        rethrowAbort(cause, signal);
        if (cause instanceof MarketDataSourceError) throw cause;
        if (isSchemaFailure(cause)) {
          throw marketFailure(
            'MARKET_DATA_INVALID',
            `Daily history payload for asset ${assetId} is invalid.`,
            cause,
          );
        }
        throw marketFailure(
          'MARKET_DATA_UNAVAILABLE',
          `Daily history unavailable for asset ${assetId}.`,
          cause,
        );
      }
    },

    async search(query, signal) {
      signal?.throwIfAborted();
      try {
        const result = await searchAssets(query, signal);
        return {
          value: result.results,
          stale: result.enriching === true,
          asOf: null,
          watermark: await payloadWatermark({
            results: result.results,
            enriching: result.enriching === true,
          }),
        };
      } catch (cause) {
        rethrowAbort(cause, signal);
        if (cause instanceof MarketDataSourceError) throw cause;
        if (isSchemaFailure(cause)) {
          throw marketFailure('MARKET_DATA_INVALID', 'Asset search payload is invalid.', cause);
        }
        throw marketFailure('MARKET_DATA_UNAVAILABLE', 'Asset search is unavailable.', cause);
      }
    },

    async fx(from, to, date, signal) {
      signal?.throwIfAborted();
      const fromCode = currencyCode(from);
      const toCode = currencyCode(to);
      if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new MarketDataSourceError(
          'MARKET_DATA_INVALID',
          `Historical FX date must be ISO YYYY-MM-DD, got ${date}.`,
        );
      }
      if (fromCode === toCode) {
        return {
          value: 1,
          stale: false,
          asOf: date === undefined ? new Date(now()).toISOString() : `${date}T00:00:00.000Z`,
          watermark: `${fromCode}:${toCode}:${date ?? 'spot'}:1`,
          from: fromCode,
          to: toCode,
          date: date ?? null,
        };
      }

      const [fromLeg, toLeg] = await Promise.all([
        eurLeg(fromCode, date, signal),
        eurLeg(toCode, date, signal),
      ]);
      signal?.throwIfAborted();
      const rate = toLeg.value / fromLeg.value;
      assertPositive(rate, `${fromCode}->${toCode} FX rate`);
      return {
        value: rate,
        stale: fromLeg.stale || toLeg.stale,
        asOf: latestIso(fromLeg.asOf, toLeg.asOf),
        watermark: `${fromLeg.watermark}|${toLeg.watermark}`,
        from: fromCode,
        to: toCode,
        date: date ?? null,
      };
    },
  };

  return source;

  async function eurLeg(
    currency: string,
    date: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<MarketDataValue<number>> {
    if (currency === 'EUR') {
      return {
        value: 1,
        stale: false,
        asOf: date === undefined ? new Date(now()).toISOString() : `${date}T00:00:00.000Z`,
        watermark: `EUR:${date ?? 'spot'}:1`,
      };
    }
    const assetId = await resolveFxAsset(currency, signal);
    if (date === undefined) {
      const quoted = await source.quote(assetId, signal);
      return { ...quoted, value: quoted.value.price };
    }
    const history = await resolveFxHistory(currency, assetId, signal);
    const close = nearestPriorClose(history.value, date);
    if (close === null) {
      throw new MarketDataSourceError(
        'MARKET_DATA_UNAVAILABLE',
        `No EUR${currency}=X close on or within ${FX_NEAREST_PRIOR_MAX_DAYS} days before ${date}.`,
      );
    }
    return {
      ...history,
      value: close,
      watermark: `${history.watermark}:${date}:${close}`,
    };
  }

  function resolveFxAsset(currency: string, signal?: AbortSignal): Promise<string> {
    let pending = fxAssetIds.get(currency);
    if (pending === undefined) {
      const providerRef = `EUR${currency}=X`;
      pending = source.search(providerRef, signal).then((result) => {
        const match = result.value.find(
          (item) => item.providerId === 'yahoo' && item.providerRef === providerRef,
        );
        if (match === undefined) {
          throw new MarketDataSourceError(
            'MARKET_DATA_UNAVAILABLE',
            `The BetterTrack asset catalog has no ${providerRef} FX pair.`,
          );
        }
        return match.id;
      });
      fxAssetIds.set(currency, pending);
      pending.catch(() => {
        if (fxAssetIds.get(currency) === pending) fxAssetIds.delete(currency);
      });
    }
    return pending;
  }

  function resolveFxHistory(
    currency: string,
    assetId: string,
    signal?: AbortSignal,
  ): Promise<MarketDataValue<PricePoint[]>> {
    let entry = fxHistories.get(currency);
    if (entry === undefined || entry.expiresAt <= now()) {
      const pending = source.history(assetId, 'MAX', signal);
      entry = { pending, expiresAt: now() + FX_HISTORY_MEMO_MS };
      fxHistories.set(currency, entry);
      pending.catch(() => {
        if (fxHistories.get(currency)?.pending === pending) fxHistories.delete(currency);
      });
    }
    return entry.pending;
  }
}

function filterRange(
  points: readonly PricePoint[],
  range: HistoryRange,
  nowMs: number,
): PricePoint[] {
  if (range === 'MAX')
    return [...points].sort((left, right) => left.time.localeCompare(right.time));
  const startMs = rangeStartMs(nowMs, range);
  return points
    .filter((point) => Date.parse(point.time) >= startMs)
    .sort((left, right) => left.time.localeCompare(right.time));
}

function rangeStartMs(nowMs: number, range: Exclude<HistoryRange, 'MAX'>): number {
  const date = new Date(nowMs);
  switch (range) {
    case '1D':
      return nowMs - DAY_MS;
    case '1W':
      return nowMs - 7 * DAY_MS;
    case '1M':
      date.setUTCMonth(date.getUTCMonth() - 1);
      return date.getTime();
    case '3M':
      date.setUTCMonth(date.getUTCMonth() - 3);
      return date.getTime();
    case '6M':
      date.setUTCMonth(date.getUTCMonth() - 6);
      return date.getTime();
    case '1Y':
      date.setUTCFullYear(date.getUTCFullYear() - 1);
      return date.getTime();
    case '5Y':
      date.setUTCFullYear(date.getUTCFullYear() - 5);
      return date.getTime();
  }
}

function nearestPriorClose(points: readonly PricePoint[], date: string): number | null {
  const targetMs = Date.parse(`${date}T00:00:00.000Z`);
  let byDay = FX_HISTORY_DAY_INDEX.get(points);
  if (byDay === undefined) {
    byDay = new Map(points.map((point) => [point.time.slice(0, 10), point.close]));
    FX_HISTORY_DAY_INDEX.set(points, byDay);
  }
  for (let back = 0; back <= FX_NEAREST_PRIOR_MAX_DAYS; back += 1) {
    const day = new Date(targetMs - back * DAY_MS).toISOString().slice(0, 10);
    const close = byDay.get(day);
    if (close !== undefined) return close;
  }
  return null;
}

function currencyCode(raw: string): string {
  const normalized = raw.toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new MarketDataSourceError(
      'MARKET_DATA_UNSUPPORTED',
      `Unsupported currency code ${JSON.stringify(raw)}.`,
    );
  }
  return normalized;
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MarketDataSourceError(
      'MARKET_DATA_INVALID',
      `${label} must be a finite positive number, got ${value}.`,
    );
  }
}

function latestIso(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

function marketFailure(
  code: MarketDataSourceErrorCode,
  message: string,
  cause: unknown,
): MarketDataSourceError {
  return cause instanceof MarketDataSourceError
    ? cause
    : new MarketDataSourceError(code, message, { cause });
}

async function payloadWatermark(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoded));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rethrowAbort(cause: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
}

function isSchemaFailure(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'ZodError';
}
