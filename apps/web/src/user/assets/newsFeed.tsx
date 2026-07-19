import { useState } from 'react';

import type { NewsHeadline } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatDateTime } from '../../lib/format';

/**
 * Compact, expandable headline list (PROJECTPLAN.md §13.5 V5-P5, arc c). Shows
 * the first `initial` headlines and folds the rest behind a "show more" toggle —
 * the anti-bloat rule for feeds ("compact, expandable"). Shared by the asset-page
 * news block and the portfolio news-digest groups so both read identically.
 *
 * Each headline links out to the article (new tab, `noreferrer`); the publisher
 * and published time render as compact meta. Empty lists render nothing — the
 * caller decides whether an asset with no news appears at all.
 */
export function NewsHeadlineList({
  headlines,
  initial = 3,
}: {
  headlines: readonly NewsHeadline[];
  initial?: number;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  if (headlines.length === 0) return null;

  const shown = expanded ? headlines : headlines.slice(0, initial);
  const remaining = headlines.length - initial;

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {shown.map((h) => (
          <li key={h.id} className="flex flex-col gap-0.5">
            <a
              href={h.url}
              target="_blank"
              rel="noreferrer"
              className="rounded text-sm text-neutral-100 hover:text-sky-300 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {h.title}
            </a>
            <span className="text-xs text-neutral-500">
              {[h.publisher, h.publishedAt ? formatDateTime(h.publishedAt) : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-start rounded text-xs font-medium text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {expanded ? t('assets.news.showLess') : t('assets.news.showMore', { count: remaining })}
        </button>
      ) : null}
    </div>
  );
}
