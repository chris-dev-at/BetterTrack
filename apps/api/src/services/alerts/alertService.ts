import { isRefPriceKind, type CreateAlertRequest } from '@bettertrack/contracts';

import type { AlertRecord, AlertRepository } from '../../data/repositories/alertRepository';
import type { AssetRepository } from '../../data/repositories/assetRepository';
import { badGateway, notFound } from '../../errors';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';

/**
 * Price-alert CRUD (PROJECTPLAN.md §14, V3-P10 arc b). Every read/write is
 * strictly scoped to the owning user (a foreign id is a 404, never a leak, §10);
 * the actual firing lives in the minute evaluator ({@link runAlertsEvaluation}).
 *
 * For the `*_from_ref` kinds the service snapshots the asset's **current quote**
 * as the reference price at creation (§14: "ref captured at creation"), reading
 * it through the cached market-data core like everything else.
 */

export interface AlertServiceDeps {
  repo: AlertRepository;
  assetRepo: AssetRepository;
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
}

export function createAlertService(deps: AlertServiceDeps): AlertService {
  const { repo, assetRepo, marketData, logger } = deps;

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

      return repo.create({
        userId,
        assetId: input.assetId,
        kind: input.kind,
        threshold: input.threshold,
        refPrice,
        repeat: input.repeat ?? false,
      });
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
  };
}
