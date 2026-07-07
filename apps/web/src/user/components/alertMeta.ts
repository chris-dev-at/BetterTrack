import type { Alert, AlertKind, AlertStatus } from '@bettertrack/contracts';

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
  /** Full label for the kind selector. */
  label: string;
  /** Grouping caption in the selector (price level vs. % move). */
  group: string;
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
  price_above: { label: 'Price rises above', group: 'Price level', unit: 'price', ref: false },
  price_below: { label: 'Price falls below', group: 'Price level', unit: 'price', ref: false },
  pct_up_from_ref: {
    label: 'Rises % from reference',
    group: 'Move from reference',
    unit: 'percent',
    ref: true,
  },
  pct_down_from_ref: {
    label: 'Falls % from reference',
    group: 'Move from reference',
    unit: 'percent',
    ref: true,
  },
  pct_day_up: { label: 'Up % on the day', group: 'Move on the day', unit: 'percent', ref: false },
  pct_day_down: {
    label: 'Down % on the day',
    group: 'Move on the day',
    unit: 'percent',
    ref: false,
  },
};

/** Human sentence for an alert's rule (asset omitted — the row already names it). */
export function describeAlertRule(
  alert: Pick<Alert, 'kind' | 'threshold' | 'refPrice'>,
  currency = 'EUR',
): string {
  const meta = ALERT_KIND_META[alert.kind];
  const amount =
    meta.unit === 'price' ? formatMoney(alert.threshold, currency) : formatPercent(alert.threshold);
  const money = (value: number) => formatMoney(value, currency);
  switch (alert.kind) {
    case 'price_above':
      return `Price rises above ${amount}`;
    case 'price_below':
      return `Price falls below ${amount}`;
    case 'pct_up_from_ref':
      return alert.refPrice != null
        ? `Rises ${amount} from ${money(alert.refPrice)}`
        : `Rises ${amount} from reference`;
    case 'pct_down_from_ref':
      return alert.refPrice != null
        ? `Falls ${amount} from ${money(alert.refPrice)}`
        : `Falls ${amount} from reference`;
    case 'pct_day_up':
      return `Up ${amount} on the day`;
    case 'pct_day_down':
      return `Down ${amount} on the day`;
  }
}

export interface AlertStatusMeta {
  label: string;
  className: string;
}

export const ALERT_STATUS_META: Record<AlertStatus, AlertStatusMeta> = {
  active: { label: 'Active', className: 'bg-emerald-950/60 text-emerald-400 ring-emerald-800' },
  triggered: { label: 'Triggered', className: 'bg-amber-950/60 text-amber-400 ring-amber-800' },
  disabled: { label: 'Disabled', className: 'bg-neutral-800 text-neutral-400 ring-neutral-700' },
};
