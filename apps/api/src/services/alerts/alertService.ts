import {
  isRefPriceKind,
  type AlertSharingResponse,
  type CreateAlertRequest,
  type UpdateAlertSharingRequest,
} from '@bettertrack/contracts';

import type { AlertRecord, AlertRepository } from '../../data/repositories/alertRepository';
import type { AssetRepository } from '../../data/repositories/assetRepository';
import type { UserFollowsRepository } from '../../data/repositories/userFollowsRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { badGateway, badRequest, notFound } from '../../errors';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import type { NotificationCenter } from '../notifications/notificationCenter';

/**
 * Price-alert CRUD (PROJECTPLAN.md §14, V3-P10 arc b). Every read/write is
 * strictly scoped to the owning user (a foreign id is a 404, never a leak, §10);
 * the actual firing lives in the minute evaluator ({@link runAlertsEvaluation}).
 *
 * For the `*_from_ref` kinds the service snapshots the asset's **current quote**
 * as the reference price at creation (§14: "ref captured at creation"), reading
 * it through the cached market-data core like everything else.
 *
 * #455 adds the follower surface: `create` fans `follow.alert.created` out to
 * followers who opted into created-alert news — only while the owner's
 * `alertsVisibleToFollowers` opt-in is on (the recipient query joins the flag,
 * so nothing here decides visibility) — and the sharing getter/setter manage
 * that opt-in with the §16 friction-ladder acknowledgment.
 */

export interface AlertServiceDeps {
  repo: AlertRepository;
  assetRepo: AssetRepository;
  /** Alert-follow recipients (#455): opted-in followers of a visible owner. */
  follows: Pick<UserFollowsRepository, 'listAlertFollowRecipients'>;
  /** The owner's `alertsVisibleToFollowers` opt-in (#455). */
  users: Pick<UserRepository, 'getAlertsVisibleToFollowers' | 'setAlertsVisibleToFollowers'>;
  /** The central notification pipeline (#368) — `follow.alert.created` enters here. */
  notify: NotificationCenter;
  marketData: Pick<MarketDataService, 'getQuote'>;
  logger: Logger;
}

export interface AlertService {
  list(userId: string): Promise<AlertRecord[]>;
  create(userId: string, input: CreateAlertRequest): Promise<AlertRecord>;
  update(
    userId: string,
    id: string,
    patch: { threshold?: number; repeat?: boolean },
  ): Promise<AlertRecord>;
  /** Re-arm a one-shot (or disabled) alert back to `active`. */
  rearm(userId: string, id: string): Promise<AlertRecord>;
  remove(userId: string, id: string): Promise<void>;
  /** The caller's alert-visibility setting (#455). */
  getSharing(userId: string): Promise<AlertSharingResponse>;
  /** Set the caller's alert visibility (#455); enabling requires the ack (§16 ladder). */
  setSharing(userId: string, input: UpdateAlertSharingRequest): Promise<AlertSharingResponse>;
}

const SHARING_ACK_REQUIRED = () =>
  badRequest(
    'Sharing your alerts shows every follower which assets you watch and your price targets; you must acknowledge this to enable it.',
    'ALERT_SHARING_ACK_REQUIRED',
  );

export function createAlertService(deps: AlertServiceDeps): AlertService {
  const { repo, assetRepo, follows, users, notify, marketData, logger } = deps;

  return {
    async list(userId) {
      return repo.listForUser(userId);
    },

    async create(userId, input) {
      const asset = await assetRepo.findByIdForUser(input.assetId, userId);
      if (!asset) {
        throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
      }

      // Capture the reference price for the *_from_ref kinds from the current
      // cached quote (§14). Every other kind stores no reference.
      let refPrice: number | null = null;
      if (isRefPriceKind(input.kind)) {
        try {
          const quote = await marketData.getQuote({
            providerId: asset.providerId,
            providerRef: asset.providerRef,
          });
          refPrice = quote.value.price;
        } catch (err) {
          logger.warn(
            { assetId: input.assetId, err: err instanceof Error ? err.message : String(err) },
            'alert create: reference quote unavailable',
          );
          throw badGateway(
            'Could not read a current price to anchor this alert. Try again shortly.',
            'QUOTE_UNAVAILABLE',
          );
        }
      }

      const record = await repo.create({
        userId,
        assetId: input.assetId,
        kind: input.kind,
        threshold: input.threshold,
        refPrice,
        repeat: input.repeat ?? false,
      });

      // Alert-follow fan-out (#455): notify followers who opted into
      // created-alert news for this owner. The recipient query joins the
      // owner's `alertsVisibleToFollowers` opt-in, so an unshared owner fans
      // out to nobody. Best-effort AFTER the insert — the center never throws,
      // and a recipient-query failure must not fail the creation.
      try {
        const recipients = await follows.listAlertFollowRecipients(userId, 'create');
        const occurredAt = new Date().toISOString();
        for (const recipient of recipients) {
          await notify.emit({
            type: 'follow.alert.created',
            userId: recipient.followerId,
            actorId: userId,
            actorUsername: recipient.ownerUsername,
            alertId: record.id,
            assetId: record.assetId,
            occurredAt,
          });
        }
      } catch (err) {
        logger.warn(
          { alertId: record.id, err: err instanceof Error ? err.message : String(err) },
          'alert create: follower fan-out failed',
        );
      }

      return record;
    },

    async update(userId, id, patch) {
      const updated = await repo.update(userId, id, patch);
      if (!updated) throw notFound('Alert not found.', 'ALERT_NOT_FOUND');
      return updated;
    },

    async rearm(userId, id) {
      const rearmed = await repo.rearm(userId, id);
      if (!rearmed) throw notFound('Alert not found.', 'ALERT_NOT_FOUND');
      return rearmed;
    },

    async remove(userId, id) {
      const removed = await repo.remove(userId, id);
      if (!removed) throw notFound('Alert not found.', 'ALERT_NOT_FOUND');
    },

    async getSharing(userId) {
      return { visibleToFollowers: await users.getAlertsVisibleToFollowers(userId) };
    },

    async setSharing(userId, input) {
      // §16 friction ladder, mirrored server-side (like the public-profile ack):
      // exposing alerts to followers ≈ exposing them to anyone (anyone may
      // follow), so enabling needs the explicit acknowledgment. Disabling never
      // does, and stops follower delivery immediately (the fan-out queries
      // re-check the flag at every emission).
      if (input.visibleToFollowers && input.acknowledgeFollowers !== true) {
        throw SHARING_ACK_REQUIRED();
      }
      await users.setAlertsVisibleToFollowers(userId, input.visibleToFollowers);
      return { visibleToFollowers: input.visibleToFollowers };
    },
  };
}
