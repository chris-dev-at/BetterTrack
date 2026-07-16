import type {
  ActiveAnnouncement,
  Announcement,
  AnnouncementSeverity,
  CreateAnnouncementRequest,
  UpdateAnnouncementRequest,
} from '@bettertrack/contracts';
import { ANNOUNCEMENT_NOTIFICATION_TYPE } from '@bettertrack/contracts';

import type {
  AnnouncementRepository,
  UpdateAnnouncementInput,
} from '../../data/repositories/announcementRepository';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { AnnouncementRow } from '../../data/schema';
import { badRequest, notFound } from '../../errors';
import type { Logger } from '../../logger';
import type { AuditService } from '../audit/auditService';
import { resolveEmailLocale, type EmailLocale } from '../email/emailI18n';
import { fanOutAnnouncement } from '../notifications/announcementFanOut';

/**
 * Admin-composed in-app announcements (§13.4 V4-P5b). Owns:
 *  1. Admin CRUD over the composer's rows (list / create / update / delete), each
 *     audit-logged with a stable action tag.
 *  2. Publish fan-out: flipping `active` from off → on runs the shared
 *     {@link fanOutAnnouncement} primitive — one inbox notification per user in
 *     their stored locale, deduped per-user by the announcement's `eventKey`.
 *  3. The user surface — `listActiveForUser` returns the currently-active,
 *     not-dismissed set for the caller in their locale; `dismiss` stamps a per-user
 *     dismissal (idempotent).
 *
 * Delivery is banner + inbox only. No email / phone push / web push routing runs
 * through the notification matrix — the fan-out inserts inbox rows directly and
 * the banner is a separate SPA surface. That's the V4-P5b acceptance criterion.
 */

/** Per-announcement event key: makes a re-publish idempotent per user, forever. */
export function announcementEventKey(id: string): string {
  return `account.notice:announcement:${id}:v1`;
}

/** Audit action tags — the admin write log a change on every mutation. */
const AUDIT = {
  create: 'announcement.create',
  update: 'announcement.update',
  publish: 'announcement.publish',
  unpublish: 'announcement.unpublish',
  delete: 'announcement.delete',
} as const;

export interface AnnouncementServiceActor {
  id: string;
  ip?: string | null;
}

export interface AnnouncementServiceDeps {
  repo: AnnouncementRepository;
  users: Pick<UserRepository, 'list'>;
  notifications: Pick<NotificationRepository, 'insert'>;
  /** Admin audit trail; every mutation lands one row. */
  audit: AuditService;
  logger?: Logger;
  /** Clock seam — used for active-window resolution. */
  now?: () => Date;
}

export interface AnnouncementService {
  // ── Admin CRUD (§13.4 V4-P5b) ─────────────────────────────────────────────
  list(): Promise<Announcement[]>;
  create(input: CreateAnnouncementRequest, actor: AnnouncementServiceActor): Promise<Announcement>;
  update(
    id: string,
    input: UpdateAnnouncementRequest,
    actor: AnnouncementServiceActor,
  ): Promise<Announcement>;
  remove(id: string, actor: AnnouncementServiceActor): Promise<void>;
  // ── User surface ──────────────────────────────────────────────────────────
  listActiveForUser(
    userId: string,
    userLocale: string | null | undefined,
  ): Promise<ActiveAnnouncement[]>;
  dismiss(userId: string, announcementId: string): Promise<void>;
}

function toAnnouncement(row: AnnouncementRow): Announcement {
  return {
    id: row.id,
    severity: row.severity as AnnouncementSeverity,
    titleEn: row.titleEn,
    bodyEn: row.bodyEn,
    titleDe: row.titleDe,
    bodyDe: row.bodyDe,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    active: row.active,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Render the announcement in one locale (EN fallback for any unknown code). */
function renderForLocale(
  row: AnnouncementRow,
  locale: EmailLocale,
): { title: string; body: string } {
  return locale === 'de'
    ? { title: row.titleDe, body: row.bodyDe }
    : { title: row.titleEn, body: row.bodyEn };
}

export function createAnnouncementService(deps: AnnouncementServiceDeps): AnnouncementService {
  const { repo, users, notifications, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const announcementNotFound = () => notFound('Announcement not found.', 'ANNOUNCEMENT_NOT_FOUND');

  /**
   * Actually deliver the announcement to every existing user: shared fan-out
   * with the per-announcement event key. Stamps `published_at` (or refreshes
   * it on a re-publish). Idempotent by construction — the per-user unique
   * (user_id, payload->>'eventKey') index collapses a re-run to zero inserts.
   */
  async function publish(row: AnnouncementRow): Promise<void> {
    const eventKey = announcementEventKey(row.id);
    const result = await fanOutAnnouncement({
      users,
      notifications,
      type: ANNOUNCEMENT_NOTIFICATION_TYPE,
      eventKey,
      copy: {
        en: { title: row.titleEn, body: row.bodyEn },
        de: { title: row.titleDe, body: row.bodyDe },
      },
      // The deep-link routes off announcementId so the bell click surfaces the
      // banner-linked content (`NotificationBell.notificationLink` maps
      // `account.notice` to /settings/notifications by default; a payload with
      // `announcementId` lets a future landing surface deep-link precisely).
      payload: { notice: 'announcement', announcementId: row.id },
    });
    await repo.update(row.id, { publishedAt: now() });
    logger?.info(
      { announcementId: row.id, users: result.users, inserted: result.inserted },
      'announcement published',
    );
  }

  return {
    async list(): Promise<Announcement[]> {
      const rows = await repo.listAll();
      return rows.map(toAnnouncement);
    },

    async create(input, actor): Promise<Announcement> {
      const startsAt =
        input.startsAt === undefined ? null : input.startsAt ? new Date(input.startsAt) : null;
      const endsAt =
        input.endsAt === undefined ? null : input.endsAt ? new Date(input.endsAt) : null;
      const active = input.active ?? false;
      const row = await repo.create({
        severity: input.severity,
        titleEn: input.titleEn,
        bodyEn: input.bodyEn,
        titleDe: input.titleDe,
        bodyDe: input.bodyDe,
        startsAt,
        endsAt,
        active,
        createdBy: actor.id,
      });
      await audit.record({
        actorId: actor.id,
        action: AUDIT.create,
        targetType: 'announcement',
        targetId: row.id,
        ip: actor.ip ?? null,
        meta: { severity: row.severity, active: row.active },
      });
      // Creating in the active state is a publish — do the fan-out here so the
      // admin's "publish on save" path also works in one call.
      if (row.active) {
        await publish(row);
        await audit.record({
          actorId: actor.id,
          action: AUDIT.publish,
          targetType: 'announcement',
          targetId: row.id,
          ip: actor.ip ?? null,
        });
      }
      const refreshed = (await repo.findById(row.id)) ?? row;
      return toAnnouncement(refreshed);
    },

    async update(id, input, actor): Promise<Announcement> {
      const before = await repo.findById(id);
      if (!before) throw announcementNotFound();

      // Reject a window that would flip start > end (repo has a CHECK too;
      // this gives a clean 400 instead of a raw db error).
      const nextStart =
        input.startsAt === undefined
          ? before.startsAt
          : input.startsAt
            ? new Date(input.startsAt)
            : null;
      const nextEnd =
        input.endsAt === undefined ? before.endsAt : input.endsAt ? new Date(input.endsAt) : null;
      if (nextStart && nextEnd && nextStart.getTime() > nextEnd.getTime()) {
        throw badRequest('endsAt must be at or after startsAt.', 'INVALID_ANNOUNCEMENT_WINDOW');
      }

      const patch: UpdateAnnouncementInput = {};
      if (input.severity !== undefined) patch.severity = input.severity;
      if (input.titleEn !== undefined) patch.titleEn = input.titleEn;
      if (input.bodyEn !== undefined) patch.bodyEn = input.bodyEn;
      if (input.titleDe !== undefined) patch.titleDe = input.titleDe;
      if (input.bodyDe !== undefined) patch.bodyDe = input.bodyDe;
      if (input.startsAt !== undefined) patch.startsAt = nextStart;
      if (input.endsAt !== undefined) patch.endsAt = nextEnd;
      if (input.active !== undefined) patch.active = input.active;

      const updated = await repo.update(id, patch);
      if (!updated) throw announcementNotFound();

      const publishing = input.active === true && before.active === false;
      const unpublishing = input.active === false && before.active === true;

      await audit.record({
        actorId: actor.id,
        action: AUDIT.update,
        targetType: 'announcement',
        targetId: id,
        ip: actor.ip ?? null,
        meta: {
          severity: updated.severity,
          active: updated.active,
        },
      });

      if (publishing) {
        await publish(updated);
        await audit.record({
          actorId: actor.id,
          action: AUDIT.publish,
          targetType: 'announcement',
          targetId: id,
          ip: actor.ip ?? null,
        });
      } else if (unpublishing) {
        await audit.record({
          actorId: actor.id,
          action: AUDIT.unpublish,
          targetType: 'announcement',
          targetId: id,
          ip: actor.ip ?? null,
        });
      }

      const refreshed = (await repo.findById(id)) ?? updated;
      return toAnnouncement(refreshed);
    },

    async remove(id, actor): Promise<void> {
      const before = await repo.findById(id);
      if (!before) throw announcementNotFound();
      const ok = await repo.remove(id);
      if (!ok) throw announcementNotFound();
      await audit.record({
        actorId: actor.id,
        action: AUDIT.delete,
        targetType: 'announcement',
        targetId: id,
        ip: actor.ip ?? null,
      });
    },

    async listActiveForUser(userId, userLocale): Promise<ActiveAnnouncement[]> {
      const rows = await repo.listActiveForUser(userId, now());
      const locale = resolveEmailLocale(userLocale);
      return rows.map((row) => {
        const rendered = renderForLocale(row, locale);
        return {
          id: row.id,
          severity: row.severity as AnnouncementSeverity,
          title: rendered.title,
          body: rendered.body,
          publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
        };
      });
    },

    async dismiss(userId, announcementId): Promise<void> {
      const row = await repo.findById(announcementId);
      if (!row) throw announcementNotFound();
      await repo.dismissForUser(userId, announcementId);
    },
  };
}
