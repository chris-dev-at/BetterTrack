import { SOURCE_TAG_MANUAL, SOURCE_TAG_STANDING_ORDER } from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../i18n';

/**
 * Source-tag badge (V5-P0c, #552). A compact marker of how a ledger row entered
 * the system — `manual` / `import:<broker>` / `sync:<provider>` / `standing-order`.
 *
 * Anti-bloat (§13.5): `manual` is the overwhelming common case and stays
 * **visually silent** — the badge renders NOTHING for it, so hand-entered rows
 * read exactly as they did before. Only non-manual rows get a quiet pill, so
 * synced/imported data is never mistaken for hand entry.
 */

/** A curated label for a known import/sync slug; unknown slugs are prettified. */
const KNOWN_SLUGS: Record<string, string> = {
  trade_republic: 'Trade Republic',
  george: 'George (Erste)',
  flatex: 'Flatex',
  ibkr: 'IBKR',
  parqet: 'Parqet',
};

function prettifySlug(slug: string): string {
  return KNOWN_SLUGS[slug] ?? slug.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The human label for a source tag. `manual` returns `null` (rendered silently).
 * `import:<slug>` / `sync:<slug>` combine the localized verb with the provider
 * name; `standing-order` is a standalone label.
 */
export function sourceTagLabel(t: TranslateFn, source: string): string | null {
  if (source === SOURCE_TAG_MANUAL) return null;
  if (source === SOURCE_TAG_STANDING_ORDER) return t('portfolio.sourceTag.standingOrder');
  const [kind, slug] = source.split(':');
  if (kind === 'import' && slug) {
    return t('portfolio.sourceTag.importFrom', { source: prettifySlug(slug) });
  }
  if (kind === 'sync' && slug) {
    return t('portfolio.sourceTag.syncFrom', { source: prettifySlug(slug) });
  }
  // An unrecognized shape still shows verbatim rather than vanishing silently.
  return source;
}

export function SourceBadge({ source, className }: { source: string; className?: string }) {
  const t = useT();
  const label = sourceTagLabel(t, source);
  if (label === null) return null;
  return (
    <span
      className={
        'inline-flex items-center rounded-full border border-sky-800/60 bg-sky-950/40 px-1.5 py-0.5 text-[0.65rem] font-medium leading-none text-sky-300' +
        (className ? ` ${className}` : '')
      }
      title={label}
    >
      {label}
    </span>
  );
}
