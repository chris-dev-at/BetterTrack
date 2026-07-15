import { resolveEmailLocale, type EmailLocale } from '../email/emailI18n';

import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { Logger } from '../../logger';

/**
 * One-time in-app announcement of the **lean email defaults** (V4-P0c, §16).
 *
 * The lean-defaults change is a pure service-level flip — email now defaults OFF
 * for every non-account/security type ({@link notificationChannelDefaultEnabled})
 * with no stored settings row migrated — so the only migration action is to tell
 * existing users about it. This inserts exactly ONE account-category in-app
 * notification per existing user, rendered in their stored locale (EN/DE, the
 * same server-copy pattern as the notification emails), deep-linking to the
 * Settings → Notifications matrix where they can re-enable anything they want.
 *
 * Idempotent by construction: every row carries the fixed {@link ANNOUNCEMENT_EVENT_KEY}
 * in its payload, and the partial unique index on `(user_id, payload->>'eventKey')`
 * collapses a re-run to a no-op — so running it again after a later deploy is
 * safe (and only reaches users who joined before the announcement, i.e. never
 * a brand-new account, which already starts with the lean defaults).
 */

/** The notification `type` for the one-off notice — account category, never event-dispatched. */
export const ANNOUNCEMENT_NOTIFICATION_TYPE = 'account.notice';

/** The fixed dedupe key that makes the announcement one-per-user, forever. */
export const ANNOUNCEMENT_EVENT_KEY = 'account.notice:lean-email-defaults:v4p0c';

interface AnnouncementCopy {
  title: string;
  body: string;
}

const ANNOUNCEMENT_COPY: Record<EmailLocale, AnnouncementCopy> = {
  en: {
    title: 'Email notifications are now off by default',
    body: 'To keep your inbox quiet, most email notifications are now off by default — only account and security emails stay on. Open Settings → Notifications to turn any of them back on.',
  },
  de: {
    title: 'E-Mail-Benachrichtigungen sind jetzt standardmäßig aus',
    body: 'Damit dein Postfach ruhig bleibt, sind die meisten E-Mail-Benachrichtigungen jetzt standardmäßig deaktiviert — nur Konto- und Sicherheits-E-Mails bleiben aktiv. Unter Einstellungen → Benachrichtigungen kannst du sie einzeln wieder einschalten.',
  },
};

export interface AnnounceLeanEmailDefaultsDeps {
  users: Pick<UserRepository, 'list'>;
  notifications: Pick<NotificationRepository, 'insert'>;
  logger?: Logger;
}

/** Result of the announcement run — how many rows were newly inserted vs skipped. */
export interface AnnounceLeanEmailDefaultsResult {
  users: number;
  inserted: number;
}

export async function announceLeanEmailDefaults(
  deps: AnnounceLeanEmailDefaultsDeps,
): Promise<AnnounceLeanEmailDefaultsResult> {
  const { users, notifications, logger } = deps;
  const all = await users.list();
  let inserted = 0;
  for (const user of all) {
    const copy = ANNOUNCEMENT_COPY[resolveEmailLocale(user.locale)];
    const id = await notifications.insert({
      userId: user.id,
      type: ANNOUNCEMENT_NOTIFICATION_TYPE,
      title: copy.title,
      body: copy.body,
      payload: { eventKey: ANNOUNCEMENT_EVENT_KEY, notice: 'lean-email-defaults' },
    });
    if (id) inserted += 1;
  }
  logger?.info(
    { users: all.length, inserted },
    'lean email defaults: in-app announcement delivered',
  );
  return { users: all.length, inserted };
}
