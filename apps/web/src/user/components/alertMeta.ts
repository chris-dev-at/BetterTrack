import type { Alert, AlertKind, AlertStatus } from '@bettertrack/contracts';

import type { TranslateFn } from '../../i18n';
import { formatMoney, formatPercent } from '../../lib/format';

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

const KINDS = 'workboard.alerts.kinds';
const GROUPS = 'workboard.alerts.groups';

export const ALERT_KIND_META: Record<AlertKind, AlertKindMeta> = {
  price_above: {
    labelKey: `${KINDS}.priceAbove`,
    groupKey: `${GROUPS}.priceLevel`,
    unit: 'price',
    ref: false,
  },
  price_below: {
    labelKey: `${KINDS}.priceBelow`,
    groupKey: `${GROUPS}.priceLevel`,
    unit: 'price',
    ref: false,
  },
  pct_up_from_ref: {
    labelKey: `${KINDS}.pctUpFromRef`,
    groupKey: `${GROUPS}.fromReference`,
    unit: 'percent',
    ref: true,
  },
  pct_down_from_ref: {
    labelKey: `${KINDS}.pctDownFromRef`,
    groupKey: `${GROUPS}.fromReference`,
    unit: 'percent',
    ref: true,
  },
  pct_day_up: {
    labelKey: `${KINDS}.pctDayUp`,
    groupKey: `${GROUPS}.onTheDay`,
    unit: 'percent',
    ref: false,
  },
  pct_day_down: {
    labelKey: `${KINDS}.pctDayDown`,
    groupKey: `${GROUPS}.onTheDay`,
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
  const amount =
    meta.unit === 'price' ? formatMoney(alert.threshold, currency) : formatPercent(alert.threshold);
  const RULE = 'workboard.alerts.rule';
  switch (alert.kind) {
    case 'price_above':
      return t(`${RULE}.priceAbove`, { amount });
    case 'price_below':
      return t(`${RULE}.priceBelow`, { amount });
    case 'pct_up_from_ref':
      return alert.refPrice != null
        ? t(`${RULE}.pctUpFromRefPrice`, { amount, ref: formatMoney(alert.refPrice, currency) })
        : t(`${RULE}.pctUpFromRef`, { amount });
    case 'pct_down_from_ref':
      return alert.refPrice != null
        ? t(`${RULE}.pctDownFromRefPrice`, { amount, ref: formatMoney(alert.refPrice, currency) })
        : t(`${RULE}.pctDownFromRef`, { amount });
    case 'pct_day_up':
      return t(`${RULE}.pctDayUp`, { amount });
    case 'pct_day_down':
      return t(`${RULE}.pctDayDown`, { amount });
  }
}

export interface AlertStatusMeta {
  labelKey: string;
  className: string;
}

const STATUS = 'workboard.alerts.status';

export const ALERT_STATUS_META: Record<AlertStatus, AlertStatusMeta> = {
  active: {
    labelKey: `${STATUS}.active`,
    className: 'bg-emerald-950/60 text-emerald-400 ring-emerald-800',
  },
  triggered: {
    labelKey: `${STATUS}.triggered`,
    className: 'bg-amber-950/60 text-amber-400 ring-amber-800',
  },
  disabled: {
    labelKey: `${STATUS}.disabled`,
    className: 'bg-neutral-800 text-neutral-400 ring-neutral-700',
  },
};
