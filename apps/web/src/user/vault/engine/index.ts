import type { MarketDataSource } from '../../../lib/marketDataSource';
import {
  createStandingOrderMaterializationLifecycle,
  type StandingOrderMaterializationLifecycle,
} from '../standingOrders/lifecycle';
import { STANDING_ORDER_SCHEDULE_TZ, calendarDayInTimezone } from '../standingOrders/schedule';
import type { VaultSyncEngine } from '../sync';
import { createPortfolioDerivationEngine } from './portfolioEngine';
import { createClientTaxEngine } from './taxEngine';
import type { VaultMoneyEngine } from './types';

export * from './cache';
export * from './clientSeries';
export * from './errorCopy';
export * from './errors';
export * from './portfolioEngine';
export * from './session';
export * from './taxEngine';
export * from './types';

export interface CreateVaultMoneyEngineOptions {
  now?: () => number;
  standingOrders?: StandingOrderMaterializationLifecycle;
}

/** The complete PD7 client money engine over one authenticated vault session. */
export function createVaultMoneyEngine(
  sync: VaultSyncEngine,
  market: MarketDataSource,
  options: CreateVaultMoneyEngineOptions = {},
): VaultMoneyEngine {
  const portfolio = createPortfolioDerivationEngine(sync, market, options);
  const tax = createClientTaxEngine(sync, market, options);
  const now = options.now;
  const standingOrders =
    options.standingOrders ??
    createStandingOrderMaterializationLifecycle(sync, market, {
      ...(now === undefined ? {} : { now: () => new Date(now()) }),
    });
  const clock = now ?? (() => Date.now());
  let requiredCatchUp: ReturnType<StandingOrderMaterializationLifecycle['onAppOpen']> | null = null;
  let catchUpDay: string | null = null;
  let unlockRequired = false;

  /**
   * The schedule's calendar day, which is what makes an occurrence due. The
   * server scan has a clock trigger (a daily cron); the vault twin has only the
   * boundaries this engine is called on, so the day is its trigger (#1793).
   */
  function scheduleDay(): string | null {
    try {
      return calendarDayInTimezone(new Date(clock()), STANDING_ORDER_SCHEDULE_TZ);
    } catch {
      return null;
    }
  }

  function onAppOpen() {
    const today = scheduleDay();
    /*
     * Memoized per calendar day, not per session. Memoizing for the life of the
     * engine meant a tab left open across midnight scanned exactly once: every
     * later day's occurrence was silently never booked, while the same order on
     * a non-vaulted portfolio booked one per day. A locked vault still waits for
     * its explicit unlock boundary — re-running would only re-report the lock.
     */
    if (requiredCatchUp !== null && (unlockRequired || today === catchUpDay)) {
      return requiredCatchUp;
    }
    catchUpDay = today;
    requiredCatchUp = trackCatchUp(standingOrders.onAppOpen());
    return requiredCatchUp;
  }

  function afterUnlock() {
    unlockRequired = false;
    catchUpDay = scheduleDay();
    requiredCatchUp = trackCatchUp(standingOrders.afterUnlock());
    return requiredCatchUp;
  }

  function trackCatchUp(catchUp: ReturnType<StandingOrderMaterializationLifecycle['onAppOpen']>) {
    void catchUp.then(
      (outcome) => {
        if (requiredCatchUp !== catchUp || outcome.ok) return;
        if (outcome.error.code === 'VAULT_LOCKED') {
          unlockRequired = true;
          return;
        }
        if (outcome.error.retryable && !unlockRequired) {
          requiredCatchUp = null;
        }
      },
      () => {
        if (requiredCatchUp === catchUp && !unlockRequired) {
          requiredCatchUp = null;
        }
      },
    );
    return catchUp;
  }

  async function catchUpFailure() {
    const outcome = await onAppOpen();
    return outcome.ok ? null : outcome.error;
  }

  return {
    onAppOpen,
    afterUnlock,
    getLastStandingOrderMaterialization: standingOrders.getLastStandingOrderMaterialization,
    subscribeStandingOrderMaterialization: standingOrders.subscribeStandingOrderMaterialization,
    async derivePortfolio(...args) {
      const error = await catchUpFailure();
      if (error !== null) return { ok: false, error };
      return portfolio.derivePortfolio(...args);
    },
    async deriveTaxReport(...args) {
      const error = await catchUpFailure();
      if (error !== null) return { ok: false, error };
      return tax.deriveTaxReport(...args);
    },
    clearCache() {
      portfolio.clearCache();
      tax.clearTaxCache();
    },
  };
}
