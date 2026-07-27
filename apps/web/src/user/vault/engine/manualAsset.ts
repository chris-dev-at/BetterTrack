import type { VaultDocumentV1 } from '@bettertrack/contracts';
import type { HoldingAssetInput, PricePoint } from '@bettertrack/domain/holdings';

import { storedPrices, type ClientAssetRecord } from './model';

export interface LocalManualAssetMarket {
  prices: PricePoint[];
  quote: HoldingAssetInput['quote'];
  watermark: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * Resolve a vault-only custom asset according to the audited manual-provider
 * vector: smoothing interpolates each interior UTC day, while the latest sparse
 * mark is the quote and intentionally has no fabricated previous close.
 */
export function localManualAssetMarket(
  document: VaultDocumentV1,
  asset: ClientAssetRecord,
): LocalManualAssetMarket {
  const stored = storedPrices(document, asset.id);
  const smoothing = asset.dto.smoothing === true;
  const prices = smoothing ? interpolateDailyPrices(stored) : stored;
  const latest = stored.at(-1);

  return {
    prices,
    quote: latest === undefined ? null : { price: latest.close, prevClose: null },
    watermark: `manual:${smoothing ? 'smooth' : 'step'}:${stored
      .map((point) => `${point.date}:${point.close}`)
      .join(',')}`,
  };
}

function interpolateDailyPrices(points: readonly PricePoint[]): PricePoint[] {
  if (points.length <= 1) return points.map((point) => ({ ...point }));

  const result: PricePoint[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index]!;
    const right = points[index + 1]!;
    const leftMs = Date.parse(`${left.date}T00:00:00.000Z`);
    const rightMs = Date.parse(`${right.date}T00:00:00.000Z`);
    const spanDays = Math.round((rightMs - leftMs) / MS_PER_DAY);

    result.push({ ...left });
    for (let offset = 1; offset < spanDays; offset += 1) {
      result.push({
        date: new Date(leftMs + offset * MS_PER_DAY).toISOString().slice(0, 10),
        close: left.close + ((right.close - left.close) * offset) / spanDays,
      });
    }
  }
  result.push({ ...points[points.length - 1]! });
  return result;
}
