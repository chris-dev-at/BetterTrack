import type { Alert, AlertKind, AlertStatus } from '@bettertrack/contracts';

import type { TranslateFn } from '../../i18n';
import { formatPercent, formatUnitPrice } from '../../lib/format';

/**
 * Shared presentation metadata for price alerts (PROJECTPLAN.md §14). Both the
 * Workboard alerts panel and the asset-page inline widget render rules and
 * create the six §14 kinds from this single source, so labels + threshold
 * semantics never drift between the two surfaces.
 */

/** How a kind's threshold is entered/measured: an absolute price, or a percent. */
export type ThresholdUnit = 'price' | 'percent';

export interface AlertKindMeta {
  /** i18n key of the full label for the kind selector. */
  labelKey: string;
  /** i18n key of the grouping caption in the selector (price level vs. % move). */
  groupKey: string;
  /** Whether the threshold is a price or a percentage. */
  unit: ThresholdUnit;
  /** Whether a reference price is captured at creation (the `*_from_ref` kinds). */
  ref: boolean;
}

/** The six §14 kinds, in the order they appear in the create dialog. */
export const ALERT_KIND_ORDER: readonly AlertKind[] = [
  'price_above',
  'price_below',
  'pct_up_from_ref',
  'pct_down_from_ref',
  'pct_day_up',
  'pct_day_down',
];

export const ALERT_KIND_META: Record<AlertKind, AlertKindMeta> = {
  price_above: {
    labelKey: 'workboard.alerts.kinds.priceAbove',
    groupKey: 'workboard.alerts.groups.priceLevel',
    unit: 'price',
    ref: false,
  },
  price_below: {
    labelKey: 'workboard.alerts.kinds.priceBelow',
    groupKey: 'workboard.alerts.groups.priceLevel',
    unit: 'price',
    ref: false,
  },
  pct_up_from_ref: {
    labelKey: 'workboard.alerts.kinds.pctUpFromRef',
    groupKey: 'workboard.alerts.groups.fromReference',
    unit: 'percent',
    ref: true,
  },
  pct_down_from_ref: {
    labelKey: 'workboard.alerts.kinds.pctDownFromRef',
    groupKey: 'workboard.alerts.groups.fromReference',
    unit: 'percent',
    ref: true,
  },
  pct_day_up: {
    labelKey: 'workboard.alerts.kinds.pctDayUp',
    groupKey: 'workboard.alerts.groups.onTheDay',
    unit: 'percent',
    ref: false,
  },
  pct_day_down: {
    labelKey: 'workboard.alerts.kinds.pctDayDown',
    groupKey: 'workboard.alerts.groups.onTheDay',
    unit: 'percent',
    ref: false,
  },
};

/** Human sentence for an alert's rule (asset omitted — the row already names it). */
export function describeAlertRule(
  t: TranslateFn,
  alert: Pick<Alert, 'kind' | 'threshold' | 'refPrice'>,
  currency = 'EUR',
): string {
  const meta = ALERT_KIND_META[alert.kind];
  // Thresholds and references are per-unit PRICES (§7.1 rule 4) — a sub-cent
  // alert on a micro-priced token must not describe itself as "above 0,00 €".
  const amount =
    meta.unit === 'price'
      ? formatUnitPrice(alert.threshold, currency)
      : formatPercent(alert.threshold);
  switch (alert.kind) {
    case 'price_above':
      return t('workboard.alerts.rule.priceAbove', { amount });
    case 'price_below':
      return t('workboard.alerts.rule.priceBelow', { amount });
    case 'pct_up_from_ref':
      return alert.refPrice != null
        ? t('workboard.alerts.rule.pctUpFromRefPrice', {
            amount,
            ref: formatUnitPrice(alert.refPrice, currency),
          })
        : t('workboard.alerts.rule.pctUpFromRef', { amount });
    case 'pct_down_from_ref':
      return alert.refPrice != null
        ? t('workboard.alerts.rule.pctDownFromRefPrice', {
            amount,
            ref: formatUnitPrice(alert.refPrice, currency),
          })
        : t('workboard.alerts.rule.pctDownFromRef', { amount });
    case 'pct_day_up':
      return t('workboard.alerts.rule.pctDayUp', { amount });
    case 'pct_day_down':
      return t('workboard.alerts.rule.pctDayDown', { amount });
  }
}

export interface AlertStatusMeta {
  labelKey: string;
  className: string;
}

export const ALERT_STATUS_META: Record<AlertStatus, AlertStatusMeta> = {
  active: {
    labelKey: 'workboard.alerts.status.active',
    className: 'bg-emerald-950/60 text-emerald-400 ring-emerald-800',
  },
  triggered: {
    labelKey: 'workboard.alerts.status.triggered',
    className: 'bg-amber-950/60 text-amber-400 ring-amber-800',
  },
  disabled: {
    labelKey: 'workboard.alerts.status.disabled',
    className: 'bg-neutral-800 text-neutral-400 ring-neutral-700',
  },
};
