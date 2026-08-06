import {
  notificationMessageSchema,
  type Notification,
  type NotificationMessage,
  type NotificationMessageKey,
} from '@bettertrack/contracts';

import type { TranslateFn } from '../i18n';

/** The web-catalog path for one localizable notification title/body. */
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
 * Render notification content in the active UI locale (#1138).
 *
 * Historical rows (or a key from a newer server that this client does not know)
 * fall back independently to the persisted title/body, so rollout is migration-
 * free and an old notice can never turn into a raw dot-path.
 */
export function notificationText(
  notification: Pick<Notification, 'title' | 'body' | 'payload'>,
  t: TranslateFn,
): { title: string; body: string } {
  const message = payloadMessage(notification.payload);
  if (!message) return { title: notification.title, body: notification.body };

  const titlePath = notificationMessagePath(message.key, 'title');
  const bodyPath = notificationMessagePath(message.key, 'body');
  const title = t(titlePath, message.params);
  const body = t(bodyPath, message.params);
  return {
    title: title === titlePath ? notification.title : title,
    body: body === bodyPath ? notification.body : body,
  };
}
