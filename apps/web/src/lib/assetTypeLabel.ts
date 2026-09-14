/**
 * The singular, translated label for an asset type — the badge shown beside a
 * symbol on the ⌘K palette, the search results and the asset detail header
 * (PROJECTPLAN.md §6.3). One mapping for all three surfaces: the same asset
 * rendering "Aktie" in the palette and "stock" on `/search` was #1874.
 *
 * `custom` HAS a label. Search does return a caller's own custom assets — the
 * repository's `visibleTo` predicate includes `owner_id = $user`, and
 * `searchRanking.test.ts` asserts a `type: 'custom'` row comes back — so the
 * badge genuinely renders it. Anything outside the taxonomy reads "Other".
 *
 * Distinct from `user/portfolio/assetTypeLabels.ts`, which carries the PLURAL
 * group names for allocation charts ("Stocks", "ETFs").
 */

/** Asset types with a label of their own under `common.assetType.*`. */
const LABELLED_TYPES: ReadonlySet<string> = new Set([
  'stock',
  'etf',
  'index',
  'fx',
  'commodity',
  'crypto',
  'custom',
]);

/** i18n key for an asset type's singular badge label (`stock` → "Stock"). */
export function assetTypeLabelKey(type: string): string {
  return LABELLED_TYPES.has(type) ? `common.assetType.${type}` : 'common.assetType.other';
}
