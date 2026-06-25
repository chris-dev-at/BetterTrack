import type { MarketDataService } from '../../providers';
import type { FxRateSource } from './currencyService';

/**
 * {@link FxRateSource} backed by cached Yahoo quotes (PROJECTPLAN.md §5.4).
 *
 * Yahoo exposes FX as ordinary symbols of the form `EUR{CCY}=X`, whose price is
 * "CCY per 1 EUR". We always cross through EUR rather than relying on a direct
 * `{FROM}{TO}=X` pair existing:
 *
 *   - `eurFromRate` = price of `EUR{from}=X` = `from` per EUR (1.0 when from==EUR)
 *   - `eurToRate`   = price of `EUR{to}=X`   = `to`   per EUR (1.0 when to==EUR)
 *   - spot(from→to) = eurToRate / eurFromRate = `to` per 1 `from`
 *
 * The {@link CurrencyService} normalises codes and applies its own finite/>0
 * guard on the returned rate, so this source only needs to validate the raw
 * leg prices it fetches and let `getQuote` errors propagate.
 */
export function createMarketDataFxSource(marketData: MarketDataService): FxRateSource {
  /** Price of `EUR{ccy}=X` ("ccy per 1 EUR"), or 1.0 when ccy is EUR itself. */
  async function eurLegRate(ccy: string): Promise<number> {
    if (ccy === 'EUR') return 1;
    const cached = await marketData.getQuote({
      providerId: 'yahoo',
      providerRef: `EUR${ccy}=X`,
    });
    const rate = cached.value.price;
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`FX leg EUR${ccy}=X returned an invalid rate ${rate}`);
    }
    return rate;
  }

  return {
    async getSpotRate(from, to) {
      // Codes arrive already normalised (3-char uppercase ISO-4217) from the
      // currency service. Cross through EUR; result is "to per 1 from".
      const [eurFromRate, eurToRate] = await Promise.all([eurLegRate(from), eurLegRate(to)]);
      return eurToRate / eurFromRate;
    },

    getHistoricalRate() {
      // Historical FX belongs to the `price_history` FX pairs (§5.3), wired with
      // backtests (P2). Not reachable from the quote path; fail loud until then.
      throw new Error('Historical FX rates not yet supported — use price_history (future issue)');
    },
  };
}
