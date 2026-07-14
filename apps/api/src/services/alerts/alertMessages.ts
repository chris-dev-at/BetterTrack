import type { AlertKind } from '@bettertrack/contracts';

/**
 * Human-readable phrasing for a fired price alert (PROJECTPLAN.md §14). Shared
 * by the in-app notification (via the dispatcher) and the email template so the
 * two channels never drift.
 */

export interface AlertMessageInput {
  kind: AlertKind;
  symbol: string;
  threshold: number;
  currency: string;
}

/** The notification title — the asset the alert is about. */
export function alertTitle(symbol: string): string {
  return `Price alert: ${symbol}`;
}

/**
 * A short, pronoun-free description of an alert's RULE ("AAPL above 200 USD"),
 * used by the follower-facing `follow.alert.*` notifications (#455) where the
 * owner-facing phrasing of {@link alertBody} ("… from your reference price")
 * would misaddress the reader. No trailing period — callers compose it.
 */
export function alertRuleSummary(input: AlertMessageInput): string {
  const { kind, symbol, threshold, currency } = input;
  switch (kind) {
    case 'price_above':
      return `${symbol} above ${threshold} ${currency}`;
    case 'price_below':
      return `${symbol} below ${threshold} ${currency}`;
    case 'pct_up_from_ref':
      return `${symbol} up ${threshold}% from the reference price`;
    case 'pct_down_from_ref':
      return `${symbol} down ${threshold}% from the reference price`;
    case 'pct_day_up':
      return `${symbol} up ${threshold}% on the day`;
    case 'pct_day_down':
      return `${symbol} down ${threshold}% on the day`;
  }
}

/** A one-sentence description of why the alert fired. */
export function alertBody(input: AlertMessageInput): string {
  const { kind, symbol, threshold, currency } = input;
  switch (kind) {
    case 'price_above':
      return `${symbol} rose above ${threshold} ${currency}.`;
    case 'price_below':
      return `${symbol} dropped below ${threshold} ${currency}.`;
    case 'pct_up_from_ref':
      return `${symbol} is up ${threshold}% from your reference price.`;
    case 'pct_down_from_ref':
      return `${symbol} is down ${threshold}% from your reference price.`;
    case 'pct_day_up':
      return `${symbol} is up ${threshold}% on the day.`;
    case 'pct_day_down':
      return `${symbol} is down ${threshold}% on the day.`;
  }
}
