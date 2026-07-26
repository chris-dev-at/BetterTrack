import { describe, expect, it } from 'vitest';

import { buildIntradayBucketPrices, type IntradayBucketPriceCandle } from '../intradayBucketPrices';

describe('buildIntradayBucketPrices', () => {
  it('returns no prices for an empty candle list', () => {
    const prices = buildIntradayBucketPrices([], [0, 10, 20], 10);

    expect(prices.size).toBe(0);
    expect(prices.get(0)).toBeUndefined();
  });

  it('preserves strict bucket ends, duplicate timestamps, gaps, and the reference-close bucket', () => {
    const candles: IntradayBucketPriceCandle[] = [
      { atMs: 5, price: 50 },
      { atMs: 10, price: 100 },
      { atMs: 10, price: 101 },
      { atMs: 29, price: 290 },
      { atMs: 30, price: 300 },
    ];

    const prices = buildIntradayBucketPrices(candles, [0, 10, 20, 30, 40], 10);

    expect([...prices]).toEqual([
      [0, 50], // atMs 10 is excluded by the strict atMs < bucket + step rule
      [10, 101], // the last duplicate timestamp wins
      [20, 290],
      [30, 300], // the bucket containing the reference close includes it
      [40, 300], // gaps carry the last observed price forward
    ]);
  });

  it('carries the first candle backward for a later-opening asset', () => {
    const candles: IntradayBucketPriceCandle[] = [
      { atMs: 25, price: 250 },
      { atMs: 35, price: 350 },
    ];

    expect([...buildIntradayBucketPrices(candles, [0, 10, 20, 30], 10)]).toEqual([
      [0, 250],
      [10, 250],
      [20, 250],
      [30, 350],
    ]);
  });

  it('visits candles only a constant multiple of candles plus buckets', () => {
    const candleCount = 256;
    const bucketCount = 256;
    const candles: IntradayBucketPriceCandle[] = Array.from(
      { length: candleCount },
      (_, index) => ({ atMs: index * 10, price: 100 + index }),
    );
    let candleVisits = 0;
    const observedCandles = new Proxy(candles, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
          candleVisits += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const buckets = Array.from({ length: bucketCount }, (_, index) => index * 10);

    const prices = buildIntradayBucketPrices(observedCandles, buckets, 10);

    expect(prices.size).toBe(bucketCount);
    expect(prices.get(buckets[buckets.length - 1]!)).toBe(100 + candleCount - 1);
    expect(candleVisits).toBeLessThanOrEqual(4 * (candleCount + bucketCount));
  });
});
