import type {
  AcknowledgeAnnouncementRequest,
  AnnouncementContentLocale,
  AcknowledgeAnnouncementResponse,
  AnnouncementAcknowledgement,
  AnnouncementSeverity,
  AnnouncementStatus,
  PendingAcknowledgement,
  UserAnnouncement,
} from '@bettertrack/contracts';
import { ANNOUNCEMENT_ERROR_CODES } from '@bettertrack/contracts';

import type {
  AnnouncementReceiptRepository,
  AnnouncementViewer,
  ViewerReceipt,
} from '../../data/repositories/announcementReceiptRepository';
import type { AnnouncementReceiptRow, AnnouncementRow } from '../../data/schema';
import { ApiError, badRequest, conflict, notFound } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import {
  announcementContentSha256,
  availableLocales,
  chooseTitleLocale,
  renderAnnouncement,
} from './announcementContent';

/**
 * The user side of announcements (PROJECTPLAN §6.19, contract §4): the list,
 * the per-id read, `seen`, `dismiss`, `acknowledge`, and the pending
 * acknowledgements every `MeResponse` carries. Visibility is the receipt
 * repository's SQL; this layer renders, orders the refusals exactly as the
 * contract numbers them, and writes the acknowledgement's audit row in the
 * acknowledgement's own transaction.
 */

export const ANNOUNCEMENT_AUDIT_ACKNOWLEDGE = AuditAction.AnnouncementAcknowledged;

/** Who is asking. Admin-kind principals never reach this service. */
export interface UserAnnouncementCaller {
  id: string;
  createdAt: Date | string;
  /** The stored locale — the default rendering locale. */
  locale: string | null | undefined;
}

/**
 * How the acknowledging request authenticated. Only these two are possible:
 * the route refuses a personal API key and a third-party OAuth token before
 * the service is reached (`403 API_KEY_FORBIDDEN`, audited), and this type has
 * no third case so the service cannot be handed one.
 */
export type AcknowledgementChannel =
  | { via: 'web_session' }
  | { via: 'first_party_oauth'; grantId: string };

export interface UserAnnouncementServiceDeps {
  receipts: AnnouncementReceiptRepository;
  audit: Pick<AuditService, 'recordInTransaction'>;
  now?: () => Date;
}

export interface UserAnnouncementService {
  list(caller: UserAnnouncementCaller, locale?: string): Promise<UserAnnouncement[]>;
  get(id: string, caller: UserAnnouncementCaller, locale?: string): Promise<UserAnnouncement>;
  seen(id: string, caller: UserAnnouncementCaller): Promise<void>;
  dismiss(id: string, caller: UserAnnouncementCaller): Promise<void>;
  acknowledge(
    id: string,
    caller: UserAnnouncementCaller,
    body: AcknowledgeAnnouncementRequest,
    channel: AcknowledgementChannel,
  ): Promise<AcknowledgeAnnouncementResponse>;
  /**
   * `MeResponse.pendingAcknowledgements` — and the gate's question (§6.19.7).
   * `preferredLocales` is the request's `Accept-Language`, parsed; titles are
   * chosen by {@link chooseTitleLocale}.
   */
  pendingAcknowledgements(
    caller: UserAnnouncementCaller,
    preferredLocales?: readonly AnnouncementContentLocale[],
  ): Promise<PendingAcknowledgement[]>;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function viewerOf(caller: UserAnnouncementCaller): AnnouncementViewer {
  return { id: caller.id, createdAt: new Date(caller.createdAt) };
}

function statusOf(row: AnnouncementRow, at: Date): AnnouncementStatus {
  if (row.lifecycle === 'archived') return 'archived';
  if (row.endsAt && row.endsAt.getTime() <= at.getTime()) return 'ended';
  return 'active';
}

function toUserAnnouncement(
  row: AnnouncementRow,
  receipt: ViewerReceipt,
  requestedLocale: string | null | undefined,
  at: Date,
): UserAnnouncement {
  const rendered = renderAnnouncement(row, requestedLocale);
  return {
    id: row.id,
    severity: row.severity as AnnouncementSeverity,
    title: rendered.title,
    body: rendered.body,
    publishedAt: iso(row.publishedAt),
    kind: row.kind,
    bodyFormat: row.bodyFormat,
    bodyDoc: rendered.bodyDoc,
    contentLocale: rendered.contentLocale,
    availableLocales: rendered.availableLocales,
    contentSha256: rendered.contentSha256,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    dismissible: row.kind !== 'ack_required',
    status: statusOf(row, at),
    receipt: {
      seenAt: iso(receipt.seenAt),
      dismissedAt: iso(receipt.dismissedAt),
      acknowledgedAt: iso(receipt.acknowledgedAt),
      lapsedAt: iso(receipt.lapsedAt),
      lapseReason: receipt.lapseReason,
    },
  };
}

function toAcknowledgement(receipt: AnnouncementReceiptRow): AnnouncementAcknowledgement {
  return {
    announcementId: receipt.announcementId,
    acknowledgedAt: receipt.acknowledgedAt!.toISOString(),
    via: receipt.acknowledgedVia!,
    locale: receipt.acknowledgedLocale as 'en' | 'de',
    contentSha256: receipt.acknowledgedContentSha256!,
  };
}

export function toPendingAcknowledgement(
  row: AnnouncementRow,
  storedLocale: string | null | undefined,
  preferredLocales: readonly AnnouncementContentLocale[] = [],
): PendingAcknowledgement {
  const contentLocale = chooseTitleLocale(row, preferredLocales, storedLocale);
  return {
    id: row.id,
    severity: row.severity as AnnouncementSeverity,
    title: contentLocale === 'de' && row.titleDe !== null ? row.titleDe : row.titleEn,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
  };
}

export function createUserAnnouncementService(
  deps: UserAnnouncementServiceDeps,
): UserAnnouncementService {
  const { receipts, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const notFoundError = () =>
    notFound('Announcement not found.', ANNOUNCEMENT_ERROR_CODES.notFound);

  async function pending(
    caller: UserAnnouncementCaller,
    preferredLocales: readonly AnnouncementContentLocale[] = [],
  ): Promise<PendingAcknowledgement[]> {
    const rows = await receipts.listPendingAcknowledgements(viewerOf(caller), now());
    return rows.map((row) => toPendingAcknowledgement(row, caller.locale, preferredLocales));
  }

  return {
    async list(caller, locale) {
      const at = now();
      const rows = await receipts.listOpenForViewer(viewerOf(caller), at);
      return rows.map(({ row, receipt }) =>
        toUserAnnouncement(row, receipt, locale ?? caller.locale, at),
      );
    },

    async get(id, caller, locale) {
      const at = now();
      const found = await receipts.findOpenedForViewer(id, viewerOf(caller), at);
      if (!found) throw notFoundError();
      return toUserAnnouncement(found.row, found.receipt, locale ?? caller.locale, at);
    },

    async seen(id, caller) {
      const at = now();
      const row = await receipts.isOpenForViewer(id, viewerOf(caller), at);
      if (!row) throw notFoundError();
      await receipts.markSeen(caller.id, id, at);
    },

    async dismiss(id, caller) {
      const at = now();
      const row = await receipts.isOpenForViewer(id, viewerOf(caller), at);
      if (!row) throw notFoundError();
      if (row.kind === 'ack_required') {
        throw conflict(
          'This announcement must be acknowledged; it cannot be dismissed.',
          ANNOUNCEMENT_ERROR_CODES.notDismissible,
        );
      }
      await receipts.markDismissed(caller.id, id, at);
    },

    /**
     * Contract §4.5, refusals in its numbered order: (1) not visible → 404;
     * (2) not `ack_required` → 409; (3) already acknowledged → the ORIGINAL,
     * whatever this request says; (4) not pending → 409; (5) locale not
     * available → 400; (6) hash of that locale's current text differs → 409;
     * (7) record. Steps 3, 4 and 7 are decided again inside the repository's
     * locked transaction, so a race with an archive, a lapse or a second
     * acknowledge resolves there and never double-writes.
     */
    async acknowledge(id, caller, body, channel) {
      const at = now();
      const found = await receipts.findOpenedForViewer(id, viewerOf(caller), at);
      if (!found) throw notFoundError();
      const { row, receipt } = found;
      if (row.kind !== 'ack_required') {
        throw conflict(
          'Only an announcement that asks for an acknowledgement can be acknowledged.',
          ANNOUNCEMENT_ERROR_CODES.notAcknowledgeable,
        );
      }
      const notPending = () =>
        conflict(
          'This announcement no longer needs an acknowledgement.',
          ANNOUNCEMENT_ERROR_CODES.notPending,
        );
      if (receipt.acknowledgedAt === null) {
        if (statusOf(row, at) !== 'active' || receipt.lapsedAt !== null) throw notPending();
        if (!availableLocales(row).includes(body.locale)) {
          throw badRequest(
            'This announcement is not available in that language.',
            ANNOUNCEMENT_ERROR_CODES.localeUnavailable,
          );
        }
        if (announcementContentSha256(row, body.locale) !== body.contentSha256) {
          throw conflict(
            'The announcement changed since it was shown. Reload it and confirm again.',
            ANNOUNCEMENT_ERROR_CODES.contentChanged,
          );
        }
      }

      const outcome = await receipts.acknowledge(
        {
          userId: caller.id,
          announcementId: id,
          via: channel.via,
          grantId: channel.via === 'first_party_oauth' ? channel.grantId : null,
          locale: body.locale,
          contentSha256: body.contentSha256,
        },
        // Data minimisation (CEO addendum 2026-10-30): the trail names the
        // person, the announcement and the instant — no IP, no channel, no
        // locale. The receipt is the evidence; this row is its independent
        // witness, written once, in the receipt's own transaction.
        (tx) =>
          audit.recordInTransaction(tx, {
            actorId: caller.id,
            action: ANNOUNCEMENT_AUDIT_ACKNOWLEDGE,
            targetType: 'announcement',
            targetId: id,
            ip: null,
          }),
      );
      switch (outcome.status) {
        case 'recorded':
        case 'replayed':
          return {
            acknowledgement: toAcknowledgement(outcome.receipt),
            pendingAcknowledgements: await pending(caller),
          };
        case 'not-pending':
          throw notPending();
        case 'not-found':
          throw notFoundError();
        default:
          throw new ApiError(500, 'INTERNAL', 'Unexpected acknowledgement outcome.');
      }
    },

    pendingAcknowledgements: pending,
  };
}
