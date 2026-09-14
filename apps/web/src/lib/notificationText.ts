import {
  NOTIFICATION_MESSAGE_MONEY_PARAMS,
  notificationMessageSchema,
  type Notification,
  type NotificationMessage,
  type NotificationMessageKey,
  type NotificationMessageParams,
} from '@bettertrack/contracts';

import type { TranslateFn } from '../i18n';
import { DISCREET_MASK, isDiscreetMode } from './format';

/**
 * The web-catalog path for one localizable notification title/body.
 *
 * The strings under `notificationContent.*` in `i18n/messages/{en,de}.json` are
 * the same pairs the API renders from
 * `apps/api/src/services/notifications/notificationI18n.ts` for push, digest and
 * email. Edit both catalogs together — the API test
 * `notificationLocalization.test.ts` fails on any drift between them.
 */
export function notificationMessagePath(
  key: NotificationMessageKey,
  part: 'title' | 'body',
): string {
  return `notificationContent.${key}.${part}`;
}

/** Safely read a message descriptor from a new-style notification payload. */
function payloadMessage(payload: unknown): NotificationMessage | null {
  if (!payload || typeof payload !== 'object' || !('message' in payload)) return null;
  const parsed = notificationMessageSchema.safeParse((payload as Record<string, unknown>).message);
  return parsed.success ? parsed.data : null;
}

/**
 * The interpolation map to render with, honouring discreet mode (§6.16).
 *
 * The inbox is the one in-app surface whose money does not arrive as a number
 * the SPA formats — it arrives pre-chosen by the server inside a sentence — so
 * it cannot inherit the `lib/format` mask by construction. It gets the same
 * guarantee here instead: every param the descriptor marks as an absolute
 * amount is replaced by {@link DISCREET_MASK} before interpolation. The bell
 * renders on EVERY authenticated route, so a leak here defeats the whole mode.
 *
 * Marked ⇒ masked; everything else — symbols, percentages, dates, counts,
 * actor names and the currency code the amount was denominated in — renders
 * untouched, so the sentence still says what happened.
 *
 * Rows persisted before the wire marker existed carry no `money`, so the shared
 * key table stands in for them; a descriptor's own marker wins when present.
 */
function displayParams(message: NotificationMessage): NotificationMessageParams {
  if (!isDiscreetMode()) return message.params;
  const money = message.money ?? NOTIFICATION_MESSAGE_MONEY_PARAMS[message.key];
  if (!money) return message.params;
  const masked: NotificationMessageParams = { ...message.params };
  for (const amountParam of Object.keys(money)) {
    if (masked[amountParam] !== undefined) masked[amountParam] = DISCREET_MASK;
  }
  return masked;
}

/**
 * Render notification content in the active UI locale (#1138).
 *
 * Historical rows (or a key from a newer server that this client does not know)
 * fall back independently to the persisted title/body, so rollout is migration-
 * free and an old notice can never turn into a raw dot-path.
 *
 * That fallback is also the one place discreet mode cannot reach: a row with no
 * descriptor at all (pre-#1138) is a frozen server-rendered sentence, and the
 * only way to blank an amount inside it would be to pattern-match the prose.
 * Every row a current worker writes carries a descriptor, so the gap closes as
 * the inbox turns over rather than by guessing at stored text.
 */
export function notificationText(
  notification: Pick<Notification, 'title' | 'body' | 'payload'>,
  t: TranslateFn,
): { title: string; body: string } {
  const message = payloadMessage(notification.payload);
  if (!message) return { title: notification.title, body: notification.body };

  const params = displayParams(message);
  const titlePath = notificationMessagePath(message.key, 'title');
  const bodyPath = notificationMessagePath(message.key, 'body');
  const title = t(titlePath, params);
  const body = t(bodyPath, params);
  return {
    title: title === titlePath ? notification.title : title,
    body: body === bodyPath ? notification.body : body,
  };
}
