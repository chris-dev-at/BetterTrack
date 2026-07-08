import { NavLink, useSearchParams } from 'react-router-dom';

import { useT } from '../../i18n';
import { cx } from './ui';

export interface SubNavItem {
  /** Target route (absolute). */
  to: string;
  /** Tab label. */
  label: string;
  /** Only match the exact path (used for a section's index/overview tab). */
  end?: boolean;
  /** Marks the destination as a not-yet-built surface (§7.2 [Coming Soon]). */
  comingSoon?: boolean;
}

/**
 * Per-section tab strip (PROJECTPLAN.md §7.4). Each of the five sections wires
 * its own `items`; every entry routes to an implemented page or a designed
 * `ComingSoon` surface (§7.2), so every tab resolves without a 404. Coming-soon
 * tabs still navigate — they just carry a muted "soon" hint.
 *
 * On narrow (phone) viewports the strip scrolls horizontally instead of
 * wrapping: tabs stay on one line (`whitespace-nowrap` + `overflow-x-auto`) and
 * the scrollbar is hidden (`.no-scrollbar`), so sections with many subnav
 * entries (e.g. Settings' seven) never clip or push the page wider than 375px.
 *
 * `preserveParams` names the search-param keys a section carries across its own
 * tabs. Some section state lives only in the URL query — most notably the
 * Portfolio section's active portfolio (`?portfolio=<id>`, {@link PortfolioSwitcher})
 * — and a plain path link would drop it, silently reverting the selection to the
 * default when opening Transactions or Custom Assets (V3-P0 bug, #322). Only the
 * named keys are carried, so no stray params leak between sections.
 */
export function SubNav({
  items,
  preserveParams,
}: {
  items: readonly SubNavItem[];
  preserveParams?: readonly string[];
}) {
  const t = useT();
  const [searchParams] = useSearchParams();
  const preserved = new URLSearchParams();
  for (const key of preserveParams ?? []) {
    const value = searchParams.get(key);
    if (value !== null) preserved.set(key, value);
  }
  const search = preserved.toString();

  return (
    <nav
      aria-label={t('nav.section')}
      className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto border-b border-neutral-800 px-4 pb-px sm:mx-0 sm:px-0"
    >
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={search ? { pathname: item.to, search } : item.to}
          end={item.end}
          className={({ isActive }) =>
            cx(
              'relative -mb-px flex min-h-[40px] flex-none items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'border-sky-400 text-white'
                : 'border-transparent text-neutral-400 hover:text-neutral-200',
            )
          }
        >
          {item.label}
          {item.comingSoon ? (
            <span
              className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-neutral-500"
              title={t('common.comingSoon')}
            >
              {t('common.soon')}
            </span>
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}
