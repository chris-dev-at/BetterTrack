import { useT } from '../../i18n';
import { cx } from '../../lib/cx';

/**
 * Per-asset integration-support flags (PROJECTPLAN.md §13.5 V5-P0c). A static,
 * client-side registry keyed by asset type — no API shape is involved, so the
 * tags render from the type the search/detail responses already carry. Adding a
 * future connector is one entry here (writer's call, per the issue: a
 * purely client-side registry is acceptable; documented in the PR).
 *
 * Parqet (V6-11) syncs listed securities and crypto — stocks, ETFs and crypto.
 */
export interface AssetCapabilityTag {
  /** Stable id, also the i18n suffix under `assets.capability.<provider>`. */
  provider: 'parqet';
}

const PARQET_TYPES: ReadonlySet<string> = new Set(['stock', 'etf', 'crypto']);

/** The capability tags an asset of `type` supports, in display order. */
export function assetCapabilityTags(type: string): AssetCapabilityTag[] {
  const tags: AssetCapabilityTag[] = [];
  if (PARQET_TYPES.has(type)) tags.push({ provider: 'parqet' });
  return tags;
}

/**
 * Compact capability badges rendered on the asset detail page and the search
 * picker rows. Renders nothing when the asset supports no integrations, so
 * surfaces stay byte-identical for unsupported types (anti-bloat).
 */
export function CapabilityTags({ type, className }: { type: string; className?: string }) {
  const t = useT();
  const tags = assetCapabilityTags(type);
  if (tags.length === 0) return null;
  return (
    <span className={cx('flex flex-wrap items-center gap-1', className)}>
      {tags.map((tag) => (
        <span
          key={tag.provider}
          title={t(`assets.capability.${tag.provider}`)}
          className="rounded bg-teal-900/50 px-1.5 py-0.5 text-xs font-medium text-teal-300"
        >
          {t(`assets.capability.${tag.provider}`)}
        </span>
      ))}
    </span>
  );
}
