export interface IntradayBucketPriceCandle {
  atMs: number;
  price: number;
}

/**
 * Build a bucket-to-price lookup by sweeping ascending, same-day candles and
 * ascending buckets once.
 *
 * Each bucket uses the last candle whose instant is strictly before the
 * bucket's end. Buckets before the first candle carry that first price
 * backward, matching the portfolio curve's later-opening asset behavior.
 */
export function buildIntradayBucketPrices(
  candles: readonly IntradayBucketPriceCandle[],
  buckets: readonly number[],
  stepMs: number,
): ReadonlyMap<number, number> {
  const prices = new Map<number, number>();
  if (candles.length === 0) return prices;

  let candleIndex = 0;
  let nextCandle: IntradayBucketPriceCandle | undefined = candles[0]!;
  let chosenPrice = nextCandle.price;

  for (const bucket of buckets) {
    const cutoff = bucket + stepMs;
    while (nextCandle !== undefined && nextCandle.atMs < cutoff) {
      chosenPrice = nextCandle.price;
      candleIndex += 1;
      nextCandle = candleIndex < candles.length ? candles[candleIndex] : undefined;
    }
    prices.set(bucket, chosenPrice);
  }

  return prices;
}
