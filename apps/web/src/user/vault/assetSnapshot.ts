import type { PortfolioAsset } from '@bettertrack/contracts';

/** The public catalog every non-custom asset row in this deployment came from. */
export const CATALOG_PROVIDER_ID = 'yahoo';

export interface LocalAssetSnapshotFacts {
  readonly isCustom?: unknown;
  readonly ownerId?: unknown;
  readonly providerId?: unknown;
  readonly type?: unknown;
}

/** Decide whether one row in the vault's local asset table is owner-local. */
export function isLocalAssetSnapshot(row: LocalAssetSnapshotFacts): boolean {
  // `portfolioAssetFromEntity` passes a looser payload and needs this explicit flag to win.
  return typeof row.isCustom === 'boolean'
    ? row.isCustom
    : row.ownerId != null ||
        (typeof row.providerId === 'string' ? row.providerId : 'manual') === 'manual' ||
        row.type === 'custom';
}

/**
 * The single producer of the vault's LOCAL ASSET TABLE rows. One `customAsset`
 * row is emitted for every asset the document references — market-catalog ones
 * included — because the client engine resolves each transaction, dividend and
 * standing order through this bucket (`engine/session.ts` graph validation,
 * `engine/model.ts`), and a paranoid client has to render and value a position
 * without any portfolio-linked server call.
 *
 * Only the OWNER's custom assets are vault data, though. A market asset lives
 * in the global `assets` table, survives the enable purge untouched, and is
 * re-resolved server-side on rehydration (`resolveReferencedAssets`), so its
 * snapshot here is client-only and is dropped again at the restore boundary
 * (`toStrictRestoreDocument`) — the server refuses a document that carries one.
 * Its `providerId`/`providerRef` therefore describe the public catalog the row
 * came from: that is the pair the §11 autonomy seam reads when a future client
 * fetches quotes without BetterTrack's API.
 *
 * A custom asset's identity must instead match, field for field, what the
 * server writes for a manual asset (`customAssetRepository.create`):
 * `providerId: 'manual'`, `providerRef: <the asset id>`, `ownerId: <owner>`.
 * `validateCustomAssetFacts` re-checks all three on the way back — over
 * tombstones too — and enable is one-way, so a mismatch would leave the account
 * with no exit but destruction.
 *
 * Every producer — the enable migration (`ui/migration.ts`) and the unlocked
 * store (`vaultPortfolioStore.ts`) — MUST build its rows here, so the two
 * boundaries agree by construction rather than by duplicated literals. Both
 * call sites still validate the produced row against
 * `VAULT_ENTITY_ROW_SCHEMAS.customAsset` before it enters a document.
 */
export interface OwnedAssetSnapshotInput {
  /** The vault entity id — also the identity the restore boundary derives `providerRef` from. */
  id: string;
  ownerId: string;
  symbol: string;
  name: string;
  currency: string;
  category: string;
  smoothing: boolean;
}

/** The owner's own (manual) asset — the only kind that crosses the restore boundary. */
export function ownedAssetSnapshotRow(input: OwnedAssetSnapshotInput): Record<string, unknown> {
  return {
    providerId: 'manual',
    providerRef: input.id,
    ownerId: input.ownerId,
    type: 'custom',
    symbol: input.symbol,
    name: input.name,
    exchange: null,
    currency: input.currency,
    meta: { category: input.category, smoothing: input.smoothing },
    searchText: `${input.symbol} ${input.name}`.trim(),
  };
}

export interface MarketAssetSnapshotSource {
  symbol: string;
  name: string;
  exchange: string | null;
  currency: string;
  type: string;
  /** The catalog pair when the caller has it (`assetSummarySchema`); defaulted otherwise. */
  providerId?: string;
  providerRef?: string;
}

/** A client-only snapshot of a market-catalog asset; never crosses the restore boundary. */
export function marketAssetSnapshotRow(asset: MarketAssetSnapshotSource): Record<string, unknown> {
  return {
    providerId: asset.providerId ?? CATALOG_PROVIDER_ID,
    providerRef: asset.providerRef ?? asset.symbol,
    ownerId: null,
    type: asset.type,
    symbol: asset.symbol,
    name: asset.name,
    exchange: asset.exchange,
    currency: asset.currency,
    meta: null,
    searchText: `${asset.symbol} ${asset.name}`.trim(),
  };
}

/** The row for one referenced `PortfolioAsset`, owned or market, keyed by `asset.isCustom`. */
export function assetSnapshotRow(
  asset: PortfolioAsset,
  ownerUserId: string,
): Record<string, unknown> {
  return asset.isCustom
    ? ownedAssetSnapshotRow({
        id: asset.id,
        ownerId: ownerUserId,
        symbol: asset.symbol,
        name: asset.name,
        currency: asset.currency,
        category: asset.category ?? 'other',
        smoothing: asset.smoothing === true,
      })
    : marketAssetSnapshotRow(asset);
}
