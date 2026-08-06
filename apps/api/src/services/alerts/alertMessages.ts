import type {
  AlertKind,
  NotificationMessage,
  NotificationMessageKey,
} from '@bettertrack/contracts';

import { notificationMessage } from '../notifications/notificationI18n';

/**
 * Localizable price-alert message descriptors (#1138).
 *
 * Alert rules branch by kind, so each branch gets a stable message key instead
 * of passing an already-English rule sentence through as a parameter. The
 * dispatcher renders the descriptor for server channels and stores it for the
 * inbox client's live locale.
 */

export interface AlertMessageInput {
  kind: AlertKind;
  symbol: string;
  threshold: number;
  currency: string;
}

const TRIGGERED_KEYS: Record<AlertKind, NotificationMessageKey> = {
  price_above: 'alertTriggeredPriceAbove',
  price_below: 'alertTriggeredPriceBelow',
  pct_up_from_ref: 'alertTriggeredPercentUpReference',
  pct_down_from_ref: 'alertTriggeredPercentDownReference',
  pct_day_up: 'alertTriggeredPercentDayUp',
  pct_day_down: 'alertTriggeredPercentDayDown',
};

const FOLLOW_CREATED_KEYS: Record<AlertKind, NotificationMessageKey> = {
  price_above: 'followAlertCreatedPriceAbove',
  price_below: 'followAlertCreatedPriceBelow',
  pct_up_from_ref: 'followAlertCreatedPercentUpReference',
  pct_down_from_ref: 'followAlertCreatedPercentDownReference',
  pct_day_up: 'followAlertCreatedPercentDayUp',
  pct_day_down: 'followAlertCreatedPercentDayDown',
};

const FOLLOW_FIRED_KEYS: Record<AlertKind, NotificationMessageKey> = {
  price_above: 'followAlertFiredPriceAbove',
  price_below: 'followAlertFiredPriceBelow',
  pct_up_from_ref: 'followAlertFiredPercentUpReference',
  pct_down_from_ref: 'followAlertFiredPercentDownReference',
  pct_day_up: 'followAlertFiredPercentDayUp',
  pct_day_down: 'followAlertFiredPercentDayDown',
};

function alertParams(input: AlertMessageInput) {
  return {
    symbol: input.symbol,
    threshold: input.threshold,
    currency: input.currency,
  };
}

/** The owner-facing fired-alert message. */
export function alertNotificationMessage(input: AlertMessageInput): NotificationMessage {
  return notificationMessage(TRIGGERED_KEYS[input.kind], alertParams(input));
}

/** A created/fired alert message shown to one of the owner's followers. */
export function followAlertNotificationMessage(
  variant: 'created' | 'fired',
  actor: string,
  input: AlertMessageInput,
): NotificationMessage {
  const keys = variant === 'created' ? FOLLOW_CREATED_KEYS : FOLLOW_FIRED_KEYS;
  return notificationMessage(keys[input.kind], { actor, ...alertParams(input) });
}
