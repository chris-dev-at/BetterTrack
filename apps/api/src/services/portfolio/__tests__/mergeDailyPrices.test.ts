import type { PricePoint as ProviderPricePoint } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import { mergeDailyPrices, type StoredPricePoint } from '../portfolioSnapshots';

/**
 * The stored-vs-provider merge behind the value series (§16 2026-09-03, #1694).
 *
 * The value engine multiplies these closes by AS-TRANSACTED stored quantities,
 * so the whole series must sit on the raw traded basis. `prices.refreshDaily`
 * heals only a trailing 35-day window, so rows written before the basis rule
 * landed keep their adjusted closes for years — and the merge is the exact place
 * where one of those would otherwise be spliced into a raw provider window.
 */
describe('mergeDailyPrices basis discipline', () => {
  const providerPoint = (date: string, close: number): ProviderPricePoint => ({
    time: `${date}T00:00:00.000Z`,
    close,
  });
  const stored = (
    date: string,
    close: number,
    basis: StoredPricePoint['basis'],
  ): StoredPricePoint => ({ date, close, basis });

  it('drops a stored row on the adjusted basis instead of mixing it in', () => {
    // The provider window heals only the last two days; 2024-01-02 still holds
    // the pre-#1694 adjusted close of 80 for a day whose actual close was 100.
    // Merging it would report a +87.5 % rise where the holding rose 50 %.
    expect(
      mergeDailyPrices(
        [stored('2024-01-02', 80, 'adjusted'), stored('2026-01-01', 150, 'unadjusted')],
        [providerPoint('2026-01-02', 150)],
      ),
    ).toEqual([
      { date: '2026-01-01', close: 150 },
      { date: '2026-01-02', close: 150 },
    ]);
  });

  it('keeps stored rows that record the valuation basis', () => {
    expect(
      mergeDailyPrices(
        [stored('2026-01-01', 100, 'unadjusted'), stored('2026-01-02', 101, 'unadjusted')],
        [],
      ),
    ).toEqual([
      { date: '2026-01-01', close: 100 },
      { date: '2026-01-02', close: 101 },
    ]);
  });

  it('drops EVERY stored row when the provider call failed, rather than serving a mixed curve', () => {
    // The "carry the whole asset when the provider call failed" path: with no
    // provider points at all, an adjusted book contributes nothing. A curve that
    // starts where trustworthy data starts beats one that restates the money.
    expect(
      mergeDailyPrices(
        [stored('2024-01-02', 80, 'adjusted'), stored('2024-01-03', 81, 'adjusted')],
        [],
      ),
    ).toEqual([]);
  });

  it('lets a provider candle win over a stored row for the same day', () => {
    expect(
      mergeDailyPrices(
        [stored('2026-01-02', 100, 'unadjusted')],
        [providerPoint('2026-01-02', 103)],
      ),
    ).toEqual([{ date: '2026-01-02', close: 103 }]);
  });

  it('collapses a day to its last provider candle and skips non-finite closes', () => {
    expect(
      mergeDailyPrices(
        [],
        [
          { time: '2026-01-02T09:00:00.000Z', close: 100 },
          { time: '2026-01-02T17:30:00.000Z', close: 104 },
          { time: '2026-01-03T17:30:00.000Z', close: Number.NaN },
        ],
      ),
    ).toEqual([{ date: '2026-01-02', close: 104 }]);
  });
});
