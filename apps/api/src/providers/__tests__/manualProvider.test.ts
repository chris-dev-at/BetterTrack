import type { AssetRef } from '@bettertrack/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../data/schema';
import { createTestApp, type TestHarness } from '../../testing/createTestApp';
import { rangeStartMs } from '../historyWindow';
import {
  createManualAssetSource,
  createManualProvider,
  type ManualAssetRecord,
  type ManualAssetSource,
  type ManualValuePoint,
} from '../manualProvider';

const REF: AssetRef = { providerId: 'manual', providerRef: 'house-1' };
const FIXED_NOW = Date.parse('2026-06-22T12:00:00.000Z');

const HOUSE: ManualAssetRecord = {
  id: 'asset-house',
  symbol: 'HOUSE',
  name: 'Family Home',
  exchange: null,
  currency: 'EUR',
  type: 'custom',
};

function fakeSource(
  asset: ManualAssetRecord | null,
  points: ManualValuePoint[],
): ManualAssetSource {
  return {
    findAsset: () => Promise.resolve(asset),
    valuePoints: () => Promise.resolve(points),
  };
}

describe('manualProvider.getQuote (§5.1)', () => {
  it('returns the latest value point with null prev/day-change', async () => {
    const provider = createManualProvider({
      source: fakeSource(HOUSE, [
        { date: '2026-01-01', value: 250000 },
        { date: '2026-06-01', value: 260000 },
      ]),
      now: () => FIXED_NOW,
    });

    const quote = await provider.getQuote(REF);
    expect(quote).toEqual({
      price: 260000,
      currency: 'EUR',
      prevClose: null,
      dayChangePct: null,
      asOf: '2026-06-01T00:00:00.000Z',
    });
  });

  it('throws MANUAL_ASSET_NOT_FOUND when the asset is missing', async () => {
    const provider = createManualProvider({ source: fakeSource(null, []), now: () => FIXED_NOW });
    await expect(provider.getQuote(REF)).rejects.toMatchObject({ code: 'MANUAL_ASSET_NOT_FOUND' });
  });

  it('throws MANUAL_ASSET_EMPTY when there are no value points', async () => {
    const provider = createManualProvider({ source: fakeSource(HOUSE, []), now: () => FIXED_NOW });
    await expect(provider.getQuote(REF)).rejects.toMatchObject({ code: 'MANUAL_ASSET_EMPTY' });
  });
});

describe('manualProvider.getHistory carry-forward (§5.1)', () => {
  const startIso = new Date(rangeStartMs(FIXED_NOW, '1M')).toISOString();

  it('returns in-window value points as a step series', async () => {
    const provider = createManualProvider({
      source: fakeSource(HOUSE, [
        { date: '2026-06-01', value: 100 },
        { date: '2026-06-15', value: 110 },
      ]),
      now: () => FIXED_NOW,
    });
    const history = await provider.getHistory(REF, '1M', '30m');
    expect(history).toEqual([
      { time: '2026-06-01T00:00:00.000Z', close: 100 },
      { time: '2026-06-15T00:00:00.000Z', close: 110 },
    ]);
  });

  it('carries the last pre-window value forward to the window start', async () => {
    const provider = createManualProvider({
      source: fakeSource(HOUSE, [
        { date: '2026-01-10', value: 500 }, // before the 1M window
        { date: '2026-06-10', value: 520 },
      ]),
      now: () => FIXED_NOW,
    });
    const history = await provider.getHistory(REF, '1M', '30m');
    expect(history).toEqual([
      { time: startIso, close: 500 }, // synthetic carry-forward at window start
      { time: '2026-06-10T00:00:00.000Z', close: 520 },
    ]);
  });

  it('emits a single flat point when only a pre-window value exists', async () => {
    const provider = createManualProvider({
      source: fakeSource(HOUSE, [{ date: '2026-01-10', value: 500 }]),
      now: () => FIXED_NOW,
    });
    const history = await provider.getHistory(REF, '1M', '30m');
    expect(history).toEqual([{ time: startIso, close: 500 }]);
  });

  it('ignores future-dated points and returns everything for MAX', async () => {
    const provider = createManualProvider({
      source: fakeSource(HOUSE, [
        { date: '2020-01-01', value: 10 },
        { date: '2026-06-10', value: 20 },
        { date: '2030-01-01', value: 99 }, // future — excluded
      ]),
      now: () => FIXED_NOW,
    });
    const history = await provider.getHistory(REF, 'MAX', '1mo');
    expect(history).toEqual([
      { time: '2020-01-01T00:00:00.000Z', close: 10 },
      { time: '2026-06-10T00:00:00.000Z', close: 20 },
    ]);
  });

  it('returns an empty series when there are no value points', async () => {
    const provider = createManualProvider({ source: fakeSource(HOUSE, []), now: () => FIXED_NOW });
    expect(await provider.getHistory(REF, '1M', '30m')).toEqual([]);
  });
});

describe('manualProvider.getMeta (§5.1)', () => {
  it('maps the custom asset row', async () => {
    const provider = createManualProvider({ source: fakeSource(HOUSE, []), now: () => FIXED_NOW });
    const meta = await provider.getMeta(REF);
    expect(meta).toEqual({
      providerId: 'manual',
      providerRef: 'house-1',
      symbol: 'HOUSE',
      name: 'Family Home',
      exchange: null,
      currency: 'EUR',
      type: 'custom',
    });
  });

  it('search contributes nothing to the fan-out (custom assets are user-scoped)', async () => {
    const provider = createManualProvider({ source: fakeSource(HOUSE, []), now: () => FIXED_NOW });
    expect(await provider.search('anything')).toEqual([]);
  });
});

describe('createManualAssetSource over Postgres/price_history (§5.5)', () => {
  let h: TestHarness;
  let ownerId: string;

  beforeAll(async () => {
    h = await createTestApp();
    const user = await h.seedUser();
    ownerId = user.id;
  });

  afterAll(async () => {
    await h.ctx.redis.quit?.();
  });

  it('reads a custom asset and its carry-forward history end to end', async () => {
    const [asset] = await h.db
      .insert(schema.assets)
      .values({
        providerId: 'manual',
        providerRef: 'house-db-1',
        ownerId,
        type: 'custom',
        symbol: 'HOUSE',
        name: 'Lakeside House',
        currency: 'EUR',
      })
      .returning();
    if (!asset) throw new Error('expected an inserted asset');

    await h.db.insert(schema.priceHistory).values([
      { assetId: asset.id, date: '2026-05-01', close: '250000' },
      { assetId: asset.id, date: '2026-06-01', close: '260000.50' },
    ]);

    const source = createManualAssetSource(h.db);

    const found = await source.findAsset('house-db-1');
    expect(found).toMatchObject({ id: asset.id, symbol: 'HOUSE', currency: 'EUR', type: 'custom' });
    expect(await source.findAsset('does-not-exist')).toBeNull();

    const points = await source.valuePoints(asset.id);
    expect(points).toEqual([
      { date: '2026-05-01', value: 250000 },
      { date: '2026-06-01', value: 260000.5 },
    ]);

    const provider = createManualProvider({ source, now: () => FIXED_NOW });
    const quote = await provider.getQuote({ providerId: 'manual', providerRef: 'house-db-1' });
    expect(quote.price).toBe(260000.5);
    expect(quote.currency).toBe('EUR');

    const history = await provider.getHistory(
      { providerId: 'manual', providerRef: 'house-db-1' },
      '6M',
      '1d',
    );
    expect(history).toEqual([
      { time: '2026-05-01T00:00:00.000Z', close: 250000 },
      { time: '2026-06-01T00:00:00.000Z', close: 260000.5 },
    ]);
  });
});
