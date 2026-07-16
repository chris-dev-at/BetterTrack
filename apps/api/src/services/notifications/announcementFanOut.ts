import { resolveEmailLocale, type EmailLocale } from '../email/emailI18n';

import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { UserRepository } from '../../data/repositories/userRepository';

/**
 * The shared "fan out one announcement to every existing user" primitive
 * (§13.4 V4-P0c one-off + V4-P5b composed announcements). Reuses the existing
 * {@link NotificationRepository} — a per-user `payload.eventKey` deduped inbox
 * row — so nothing about the delivery side of notifications is duplicated.
 *
 * Idempotency comes from the notifications table's partial unique index on
 * `(user_id, payload->>'eventKey')`: the fan-out inserts one row per user
 * carrying the fixed `eventKey`, and a re-run of the same fan-out collapses
 * every duplicate to a no-op at the DB level. Content is per-locale (EN/DE
 * today) so each user sees their language — the same server-copy pattern the
 * notification emails use.
 */

/** One per-locale content bundle. */
export interface AnnouncementLocaleCopy {
  title: string;
  body: string;
}

/** The per-locale copy set every fan-out ships. */
export type AnnouncementCopyMap = Record<EmailLocale, AnnouncementLocaleCopy>;

/** How many users were considered and how many rows were newly inserted. */
export interface AnnouncementFanOutResult {
  users: number;
  inserted: number;
}

export interface AnnouncementFanOutParams {
  /** Just the `list()` shape — this helper never touches other user methods. */
  users: Pick<UserRepository, 'list'>;
  /** Just the `insert()` shape — the dedupe is the DB's partial unique index. */
  notifications: Pick<NotificationRepository, 'insert'>;
  /** Notification `type` written on every row (`account.notice` in V4-P5b). */
  type: string;
  /** Fixed dedupe key stamped in `payload.eventKey`; one row per user, forever. */
  eventKey: string;
  /** Per-locale copy resolved by the recipient's stored locale. */
  copy: AnnouncementCopyMap;
  /**
   * Extra payload fields merged alongside `eventKey`. Consumers use this to
   * carry the deep-link ids (e.g. `announcementId`) the bell resolves via
   * `NotificationBell.notificationLink`.
   */
  payload?: Record<string, unknown>;
}

/**
 * Fan one announcement out to every existing user, once. Every row is a live
 * inbox notification (visible + unread) — never a hidden dedupe marker — so it
 * shows up in the bell and archives on read.
 */
export async function fanOutAnnouncement(
  params: AnnouncementFanOutParams,
): Promise<AnnouncementFanOutResult> {
  const { users, notifications, type, eventKey, copy, payload } = params;
  const all = await users.list();
  let inserted = 0;
  for (const user of all) {
    const c = copy[resolveEmailLocale(user.locale)];
    const id = await notifications.insert({
      userId: user.id,
      type,
      title: c.title,
      body: c.body,
      payload: { ...payload, eventKey },
    });
    if (id) inserted += 1;
  }
  return { users: all.length, inserted };
}
