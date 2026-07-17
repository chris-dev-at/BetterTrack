import type {
  AssetMeta,
  AssetRef,
  AssetSearchResult,
  HistoryInterval,
  HistoryRange,
  PricePoint,
  Quote,
} from '@bettertrack/contracts';

import type { AssetProvider } from './AssetProvider';
import { AssetNotFoundError } from './errors';
import { rangeStartMs } from './historyWindow';
import { createRequestQueue, type RequestQueue, type RequestQueueOptions } from './requestQueue';
import type { StooqClient } from './stooqClient';
import { mapToStooq, stooqCanServe, type StooqRef } from './stooqMapping';

/**
 * The Stooq provider (PROJECTPLAN.md §13.5 V5-P1c): the keyless secondary quote
 * source behind the §5.1 `AssetProvider` interface, used by the failover chain
 * when Yahoo is unhealthy. It answers `getQuote`/`getHistory`/`getMeta` for the
 * SAME instrument the user picked on Yahoo, mapping the yahoo ref to Stooq's own
 * symbol + currency via `stooqMapping.ts` (money-critical — see that file).
 *
 * It reuses the §5.2 outbound queue (concurrency + spacing + backoff); freshness
 * caching, timeout, retry-once, circuit breaking and stale-while-revalidate are
 * added on top by the market-data service, so this file never touches Redis.
 * Stooq has no search endpoint and no reference metadata, so `search` returns
 * nothing (the catalog is Yahoo-fed) and `getMeta` is derived from the symbol.
 *
 * Stooq serves EOD data: a quote has no meaningful intraday reference, so
 * `prevClose`/`dayChangePct` are null (an honest "no day move" rather than a
 * fabricated one), and history is daily closes regardless of the requested
 * interval — good enough to keep charts/backtests flowing during a Yahoo outage.
 */

const PROVIDER_ID = 'stooq';

export interface CreateStooqProviderDeps {
  /** The (real or stubbed) Stooq client. Stubbed in tests — no live network. */
  client: StooqClient;
  /** Outbound queue policy; defaults to the §5.2/§5.3 concurrency + spacing + backoff queue. */
  queue?: RequestQueue;
  /** Tuning for the default queue; ignored when `queue` is given. */
  queueOptions?: RequestQueueOptions;
  /** Injectable clock (tests) used to derive history windows. */
  now?: () => number;
}

/** Resolve a yahoo ref to its Stooq symbol, or throw a not-found when unsupported. */
function requireStooq(ref: AssetRef): StooqRef {
  const mapped = mapToStooq(ref.providerRef);
  if (!mapped) {
    throw new AssetNotFoundError(`Stooq cannot serve "${ref.providerRef}"`);
  }
  return mapped;
}

export function createStooqProvider(deps: CreateStooqProviderDeps): AssetProvider {
  const { client } = deps;
  const queue = deps.queue ?? createRequestQueue(deps.queueOptions);
  const now = deps.now ?? Date.now;

  async function search(_query: string): Promise<AssetSearchResult[]> {
    // Stooq has no search API; the catalog/search fan-out is Yahoo-fed (§6.2).
    return [];
  }

  async function getQuote(ref: AssetRef): Promise<Quote> {
    const mapped = requireStooq(ref);
    const row = await queue.run(() => client.quote(mapped.symbol));
    if (!row || row.close === null) {
      // No price ⇒ Stooq does not know this symbol — a definitive not-found.
      throw new AssetNotFoundError(`Stooq returned no price for "${mapped.symbol}"`);
    }
    // Stooq gives a UTC-ish `date`/`time`; fall back to now for the asOf stamp.
    const asOfMs =
      row.date && row.time
        ? Date.parse(`${row.date}T${row.time}Z`)
        : row.date
          ? Date.parse(`${row.date}T00:00:00Z`)
          : NaN;
    return {
      price: row.close,
      currency: mapped.currency,
      prevClose: null,
      dayChangePct: null,
      asOf: new Date(Number.isNaN(asOfMs) ? now() : asOfMs).toISOString(),
    };
  }

  async function getHistory(
    ref: AssetRef,
    range: HistoryRange,
    _interval: HistoryInterval,
  ): Promise<PricePoint[]> {
    const mapped = requireStooq(ref);
    const end = now();
    const start = rangeStartMs(end, range);
    const rows = await queue.run(() =>
      client.history(mapped.symbol, { period1: new Date(start), period2: new Date(end) }),
    );
    const points: PricePoint[] = [];
    for (const row of rows) {
      const ms = Date.parse(`${row.date}T00:00:00Z`);
      if (Number.isNaN(ms)) continue;
      points.push({ time: new Date(ms).toISOString(), close: row.close });
    }
    return points;
  }

  async function getMeta(ref: AssetRef): Promise<AssetMeta> {
    const mapped = requireStooq(ref);
    // Stooq carries no name/exchange; derive an honest, symbol-based meta so the
    // shape is valid. The authoritative meta stays Yahoo's when it is reachable.
    const symbol = ref.providerRef;
    return {
      providerId: PROVIDER_ID,
      providerRef: ref.providerRef,
      symbol,
      name: symbol,
      exchange: null,
      currency: mapped.currency,
      type: mapped.type,
    };
  }

  return {
    id: PROVIDER_ID,
    canServe: (ref) => stooqCanServe(ref.providerRef),
    search,
    getQuote,
    getHistory,
    getMeta,
  };
}
