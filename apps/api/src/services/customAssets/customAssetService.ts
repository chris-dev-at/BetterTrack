import {
  CUSTOM_ASSET_VAULT_SNAPSHOT_ERROR_CODES,
  CUSTOM_ASSET_VAULT_SNAPSHOT_VALUES_MAX,
  customAssetCategorySchema,
  customAssetVaultSnapshotsResponseSchema,
  type CreateCustomAssetRequest,
  type CreateCustomAssetResponse,
  type CustomAsset,
  type CustomAssetCategory,
  type CustomAssetListItem,
  type CustomAssetVaultSnapshotsResponse,
  type UpdateCustomAssetRequest,
  type ValuePoint,
} from '@bettertrack/contracts';

import type { CustomAssetRepository } from '../../data/repositories/customAssetRepository';
import type { AssetRow } from '../../data/schema';
import { badRequest, conflict, notFound } from '../../errors';
import type { ConglomerateService } from '../conglomerate/conglomerateService';
import type { PortfolioService } from '../portfolio/portfolioService';
import type { PortfolioSnapshotService } from '../portfolio/portfolioSnapshots';
import type { VaultedPortfolioGuard } from '../account/vaultedPortfolioEnforcement';

/**
 * Custom-investment service (PROJECTPLAN.md §6.9, §5.1).
 *
 * Creates and edits the user's own assets (a house, a vehicle, cash …) wired to
 * the `manual` provider, plus their value-points editor. Value points live in
 * `price_history`, so the manual provider's latest value point *is* the asset's
 * quote — the rest of the system values a custom asset exactly like a stock.
 *
 * The optional initial purchase is recorded as an ordinary BUY transaction
 * through the {@link PortfolioService}. Value-point / smoothing / deletion
 * changes here reshape the reconstructed series of EVERY portfolio holding the
 * asset, so they invalidate the V5-P1 daily snapshots asset-scoped (issue
 * #553, §16 2026-07-17 rule 7): each holding portfolio, from the earliest
 * changed day — or, with smoothing ON, from the day after the surviving mark
 * preceding it, because interpolation reshapes backward to that mark — floored
 * at that portfolio's first transaction on the asset.
 */

export interface CustomAssetServiceDeps {
  repo: CustomAssetRepository;
  portfolio: PortfolioService;
  snapshots: PortfolioSnapshotService;
  /** E2 portfolio boundary for the optional server-side initial purchase. */
  vaultedPortfolio?: Pick<VaultedPortfolioGuard, 'runOwnedPortfolioAllowed'>;
  /**
   * The blueprint side of a delete (#1776): a custom asset is usable in
   * blueprints (§6.8.5), and its position rows cascade away with it, so the
   * baskets that held it are re-run through the §6.5 activation gate.
   */
  conglomerates: Pick<ConglomerateService, 'basketsHoldingAsset' | 'revalidateAfterAssetRemoval'>;
}

export interface CustomAssetService {
  /** Every custom asset the user owns, each with its latest value point (§6.9). */
  list(userId: string): Promise<CustomAssetListItem[]>;
  create(userId: string, input: CreateCustomAssetRequest): Promise<CreateCustomAssetResponse>;
  update(userId: string, id: string, patch: UpdateCustomAssetRequest): Promise<CustomAsset>;
  remove(userId: string, id: string): Promise<void>;
  getValuePoints(userId: string, id: string): Promise<ValuePoint[]>;
  putValuePoints(userId: string, id: string, points: ValuePoint[]): Promise<ValuePoint[]>;
  /**
   * #1529: the exact current state of the caller's own manual assets among
   * `ids`, in vault-entity row shape (decimal strings, verbatim `meta`) — the
   * lossless seam the per-portfolio move needs in both directions. Ids that
   * are not the caller's manual assets are simply absent (no oracle).
   */
  vaultSnapshots(
    userId: string,
    ids: readonly string[],
  ): Promise<CustomAssetVaultSnapshotsResponse>;
  /** How many of the user's custom assets still need re-categorizing (V3-P2). */
  recategorizationStatus(userId: string): Promise<{ pending: number }>;
  /** Dismiss the re-categorize banner: clear every flag the user owns (V3-P2). */
  dismissRecategorization(userId: string): Promise<void>;
}

interface CustomAssetMeta {
  category?: string;
  smoothing?: boolean;
  recategorize?: boolean;
}

function metaOf(row: AssetRow): CustomAssetMeta {
  return (row.meta ?? {}) as CustomAssetMeta;
}

/** ISO day immediately after `day` (UTC) — the smoothing invalidation anchor. */
function dayAfter(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function categoryOf(row: AssetRow): CustomAssetCategory {
  const parsed = customAssetCategorySchema.safeParse(metaOf(row).category);
  return parsed.success ? parsed.data : 'other';
}

function toDto(row: AssetRow): CustomAsset {
  const meta = metaOf(row);
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    category: categoryOf(row),
    currency: row.currency,
    type: row.type,
    smoothing: meta.smoothing === true,
    needsRecategorization: meta.recategorize === true,
  };
}

export function createCustomAssetService(deps: CustomAssetServiceDeps): CustomAssetService {
  const { repo, portfolio, snapshots } = deps;

  async function requireOwned(userId: string, id: string): Promise<AssetRow> {
    const row = await repo.findForUser(userId, id);
    if (!row) throw notFound('Custom asset not found.', 'CUSTOM_ASSET_NOT_FOUND');
    return row;
  }

  return {
    async list(userId) {
      const rows = await repo.listForUser(userId);
      const latest = await repo.latestValuePoints(rows.map((r) => r.id));
      return rows.map((row) => {
        const point = latest.get(row.id);
        return {
          ...toDto(row),
          latestValue: point ? { date: point.date, value: point.value } : null,
        };
      });
    },

    async create(userId, input) {
      const createForPortfolio = async (
        initialPurchasePortfolioId: string | null,
      ): Promise<CreateCustomAssetResponse> => {
        // The asset row and its value metadata are account-common. When an
        // initial purchase is requested, however, do not create even that row
        // until the destination portfolio has passed the stable E2 boundary;
        // otherwise a refused vault write leaves a half-created custom asset.
        const row = await repo.create({
          ownerId: userId,
          // Custom investments have no ticker; the name doubles as the symbol so
          // search/holdings/workboard render something meaningful.
          symbol: input.name,
          name: input.name,
          currency: input.currency,
          category: input.category,
          smoothing: input.smoothing,
        });

        let transactionId: string | null = null;
        if (input.initialPurchase && initialPurchasePortfolioId) {
          const p = input.initialPurchase;
          // Recorded as a BUY through the portfolio service: it validates, inserts
          // and invalidates the value-series cache in one place (§6.9).
          const [txn] = await portfolio.createTransactions(userId, initialPurchasePortfolioId, [
            {
              assetId: row.id,
              side: 'buy',
              quantity: p.quantity,
              price: p.price,
              fee: p.fee,
              executedAt: p.executedAt,
              note: p.note ?? null,
            },
          ]);
          transactionId = txn?.id ?? null;
        }

        return { asset: toDto(row), transactionId };
      };

      if (!input.initialPurchase) return createForPortfolio(null);

      // A locked stub can retain the account's historical default ordering.
      // Prefer the default only while it is plain, then the first active plain
      // sibling. This preserves custom-asset functionality for mixed accounts.
      const { portfolios: summaries } = await portfolio.listPortfolios(userId);
      const target =
        summaries.find((candidate) => candidate.isDefault && candidate.vaultId == null) ??
        summaries.find((candidate) => candidate.vaultId == null);
      const portfolioId = target?.id ?? (await portfolio.getDefaultPortfolioId(userId));
      if (!deps.vaultedPortfolio) return createForPortfolio(portfolioId);
      return deps.vaultedPortfolio.runOwnedPortfolioAllowed(userId, portfolioId, () =>
        createForPortfolio(portfolioId),
      );
    },

    async update(userId, id, patch) {
      const existing = await requireOwned(userId, id);

      // Merge category / smoothing into the stored meta only when the patch
      // touches them (name-only edits leave meta untouched). Re-categorizing an
      // asset clears its one-time migration flag so the banner fades (V3-P2).
      let meta: CustomAssetMeta | undefined;
      if (patch.category !== undefined || patch.smoothing !== undefined) {
        meta = { ...metaOf(existing) };
        if (patch.category !== undefined) {
          meta.category = patch.category;
          delete meta.recategorize;
        }
        if (patch.smoothing !== undefined) meta.smoothing = patch.smoothing;
      }

      const updated = await repo.update(userId, id, { name: patch.name, meta });
      if (!updated) throw notFound('Custom asset not found.', 'CUSTOM_ASSET_NOT_FOUND');

      // Smoothing reshapes the asset's whole reconstructed value series (§6.9),
      // so a toggle invalidates every holding portfolio's snapshots from its
      // first transaction on the asset (§16 rule 7) — same as a value-point edit.
      if (
        patch.smoothing !== undefined &&
        patch.smoothing !== (metaOf(existing).smoothing === true)
      ) {
        await snapshots.invalidateForAsset(id);
      }

      return toDto(updated);
    },

    async recategorizationStatus(userId) {
      return { pending: await repo.countNeedingRecategorization(userId) };
    },

    async dismissRecategorization(userId) {
      await repo.clearRecategorization(userId);
    },

    async remove(userId, id) {
      // Resolve the holding portfolios BEFORE the delete — the transactions the
      // fan-out reads cascade away with the asset — but invalidate only AFTER
      // it commits, so a fast recompute can never persist pre-delete data and
      // then be trusted (§16 rule 7).
      const refs = await snapshots.resolveAssetReferences(id);
      // Same reason, blueprint side (#1776): `conglomerate_positions.asset_id`
      // is ON DELETE CASCADE, so the baskets holding this asset must be named
      // now — after the delete nothing records that they ever did.
      const baskets = await deps.conglomerates.basketsHoldingAsset(userId, id);
      const deleted = await repo.deleteForUser(userId, id);
      if (!deleted) throw notFound('Custom asset not found.', 'CUSTOM_ASSET_NOT_FOUND');
      for (const ref of refs) {
        await snapshots.invalidate(ref.portfolioId, ref.fromDay);
      }
      // §6.8.5 keeps this a hard delete — a custom asset is an asset like any
      // other and deleting one already discards its transactions. So the
      // blueprints it silently gutted are relabelled instead: every basket that
      // held it, and every ancestor above them, is re-run through the §6.5
      // activation gate, because a basket left `active` while part of it
      // resolves to nothing is the state #1755 ruled invalid — the donut claims
      // fully invested while the Invest Calculator withholds the missing slice.
      await deps.conglomerates.revalidateAfterAssetRemoval(userId, baskets);
    },

    async vaultSnapshots(userId, ids) {
      const { present, absentIds } = await repo.vaultSnapshotsForOwner(userId, ids);
      const totalValues = present.reduce((total, { values }) => total + values.length, 0);
      if (totalValues > CUSTOM_ASSET_VAULT_SNAPSHOT_VALUES_MAX) {
        // Size, not security: one response stays bounded; the client asks
        // for fewer ids per request.
        throw conflict(
          `The requested manual assets carry ${totalValues} value points; at most ${CUSTOM_ASSET_VAULT_SNAPSHOT_VALUES_MAX} fit one read.`,
          CUSTOM_ASSET_VAULT_SNAPSHOT_ERROR_CODES.tooLarge,
        );
      }
      const response = customAssetVaultSnapshotsResponseSchema.safeParse({
        present: present.map(({ asset, values }) => ({
          id: asset.id,
          asset: {
            providerId: asset.providerId,
            providerRef: asset.providerRef,
            ownerId: asset.ownerId,
            type: asset.type,
            symbol: asset.symbol,
            name: asset.name,
            exchange: asset.exchange,
            currency: asset.currency,
            meta: asset.meta ?? null,
            // `search_text` is GENERATED ALWAYS server-side; the vault's own
            // snapshot producer (`assetSnapshotRow`) spells it as `symbol name`.
            searchText: `${asset.symbol} ${asset.name}`.trim(),
          },
          values: values.map(({ date, close }) => ({ assetId: asset.id, date, close })),
        })),
        absentIds,
      });
      if (!response.success) {
        // TYPED (review F2): a bare ZodError would become a client 400 —
        // but nothing about the request is invalid; a STORED row is not
        // exactly servable, so the move must refuse the asset, not the request.
        throw conflict(
          'A stored manual-asset row cannot be served exactly in vault-entity shape.',
          CUSTOM_ASSET_VAULT_SNAPSHOT_ERROR_CODES.unservable,
        );
      }
      return response.data;
    },

    async getValuePoints(userId, id) {
      await requireOwned(userId, id);
      const points = await repo.getValuePoints(id);
      return points.map((p) => ({ date: p.date, value: p.value }));
    },

    async putValuePoints(userId, id, points) {
      const existing = await requireOwned(userId, id);

      // One value point per day (§6.9). Reject duplicate dates loudly rather
      // than silently collapsing them.
      const seen = new Set<string>();
      for (const p of points) {
        if (seen.has(p.date)) {
          throw badRequest(`Duplicate value point for ${p.date}.`, 'DUPLICATE_VALUE_POINT', {
            date: p.date,
          });
        }
        seen.add(p.date);
      }

      // Diff against the stored points to find the earliest day the replace
      // actually changes — carry-forward means the series reshapes from there
      // on (§16 rule 7). An identical re-save invalidates nothing.
      const before = await repo.getValuePoints(id);
      const beforeByDate = new Map(before.map((p) => [p.date, p.value]));
      const afterByDate = new Map(points.map((p) => [p.date, p.value]));
      let changedFrom: string | undefined;
      for (const date of new Set([...beforeByDate.keys(), ...afterByDate.keys()])) {
        if (beforeByDate.get(date) === afterByDate.get(date)) continue;
        if (changedFrom === undefined || date < changedFrom) changedFrom = date;
      }

      // With smoothing ON the changed mark also linearly reshapes every
      // interpolated day back to the PRECEDING surviving mark (V3-P2), so the
      // anchor moves to that mark's day + 1 — the mark's own day stays exact,
      // interpolation endpoints are exact by construction (§16 rule 7). Marks
      // before the earliest change are identical in both sets: any difference
      // would have moved `changedFrom` earlier.
      let invalidateFrom = changedFrom;
      if (changedFrom !== undefined && metaOf(existing).smoothing === true) {
        let precedingMark: string | undefined;
        for (const date of afterByDate.keys()) {
          if (date < changedFrom && (precedingMark === undefined || date > precedingMark)) {
            precedingMark = date;
          }
        }
        if (precedingMark !== undefined) invalidateFrom = dayAfter(precedingMark);
      }

      await repo.replaceValuePoints(
        id,
        points.map((p) => ({ date: p.date, value: p.value })),
      );
      if (invalidateFrom !== undefined) {
        await snapshots.invalidateForAsset(id, invalidateFrom);
      }

      const stored = await repo.getValuePoints(id);
      return stored.map((p) => ({ date: p.date, value: p.value }));
    },
  };
}
