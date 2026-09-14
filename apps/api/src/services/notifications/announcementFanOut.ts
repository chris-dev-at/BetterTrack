import { resolveEmailLocale, type EmailLocale } from '../email/emailI18n';

import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { Logger } from '../../logger';

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

/** How many recipients were walked, how many rows landed, how many failed. */
export interface AnnouncementFanOutResult {
  users: number;
  inserted: number;
  /**
   * Recipients whose insert threw (#1723). Non-zero means the fan-out is
   * INCOMPLETE — the caller must not record the announcement as published, so
   * a later re-run can deliver the rows that are still missing.
   */
  failed: number;
}

/** Recipients per keyset page — bounded peak memory, one round trip per page. */
export const ANNOUNCEMENT_FAN_OUT_PAGE_SIZE = 500;

export interface AnnouncementFanOutParams {
  /**
   * Just the keyset-paged recipient read — this helper never touches other
   * user methods, and never loads a whole table into memory (#1723).
   */
  users: Pick<UserRepository, 'listRecipientsAfter'>;
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
  /** Structured warn on a per-recipient failure; the user id is never logged. */
  logger?: Pick<Logger, 'warn'>;
  /** Page size override (tests). Defaults to {@link ANNOUNCEMENT_FAN_OUT_PAGE_SIZE}. */
  pageSize?: number;
}

/**
 * Fan one announcement out to every existing user, once. Every row is a live
 * inbox notification (visible + unread) — never a hidden dedupe marker — so it
 * shows up in the bell and archives on read.
 *
 * Two properties the publish path depends on (#1723):
 *  - **Bounded** — recipients are walked in keyset pages, so a large account
 *    table never materializes in one query or one array.
 *  - **Isolated** — one recipient's insert failing (a transient DB error, a
 *    row deleted mid-walk) no longer aborts the remaining recipients; it is
 *    counted into `failed` and the walk continues. The caller decides what a
 *    non-zero `failed` means; for announcements it means "not published yet",
 *    and the eventKey dedupe makes the retry deliver exactly the missing rows.
 */
export async function fanOutAnnouncement(
  params: AnnouncementFanOutParams,
): Promise<AnnouncementFanOutResult> {
  const { users, notifications, type, eventKey, copy, payload, logger } = params;
  const pageSize = params.pageSize ?? ANNOUNCEMENT_FAN_OUT_PAGE_SIZE;
  let cursor: string | null = null;
  let seen = 0;
  let inserted = 0;
  let failed = 0;
  for (;;) {
    const page: Array<{ id: string; locale: string }> = await users.listRecipientsAfter(
      cursor,
      pageSize,
    );
    if (page.length === 0) break;
    for (const user of page) {
      seen += 1;
      const c = copy[resolveEmailLocale(user.locale)];
      try {
        const id = await notifications.insert({
          userId: user.id,
          type,
          title: c.title,
          body: c.body,
          payload: { ...payload, eventKey },
        });
        if (id) inserted += 1;
      } catch (err) {
        failed += 1;
        logger?.warn({ err, eventKey }, 'announcement fan-out recipient failed');
      }
    }
    cursor = page[page.length - 1]!.id;
    if (page.length < pageSize) break;
  }
  return { users: seen, inserted, failed };
}
