import type { VaultDocumentV1 } from '@bettertrack/contracts';
import { interpolateDailyMarks } from '@bettertrack/domain/manualAsset';
import type { HoldingAssetInput, PricePoint } from '@bettertrack/domain/holdings';

import { storedPrices, type ClientAssetRecord } from './model';

export interface LocalManualAssetMarket {
  prices: PricePoint[];
  quote: HoldingAssetInput['quote'];
  watermark: string;
}

/**
 * Resolve a vault-only custom asset with the same rules as the server manual
 * provider: smoothing interpolates history, while the latest sparse mark is
 * the quote and intentionally has no fabricated previous close.
 */
export function localManualAssetMarket(
  document: VaultDocumentV1,
  asset: ClientAssetRecord,
): LocalManualAssetMarket {
  const stored = storedPrices(document, asset.id);
  const smoothing = asset.dto.smoothing === true;
  const prices = smoothing
    ? interpolateDailyMarks(stored.map((point) => ({ date: point.date, value: point.close }))).map(
        (point) => ({ date: point.date, close: point.value }),
      )
    : stored;
  const latest = stored.at(-1);

  return {
    prices,
    quote: latest === undefined ? null : { price: latest.close, prevClose: null },
    watermark: `manual:${smoothing ? 'smooth' : 'step'}:${stored
      .map((point) => `${point.date}:${point.close}`)
      .join(',')}`,
  };
}
