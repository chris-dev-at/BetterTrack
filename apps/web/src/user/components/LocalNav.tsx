import { useEffect, useRef } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';

import { useT } from '../../i18n';
import { cx } from '../../lib/cx';

export interface LocalNavItem {
  /** Target route (absolute). */
  to: string;
  /** Tab label. */
  label: string;
  /** Only match the exact path (a section's overview tab). */
  end?: boolean;
  /** Marks a parked destination — present in the structure, build lands later. */
  parked?: boolean;
}

/**
 * The named search params of the current URL, serialised for a sibling link.
 * Carries the portfolio scope `?portfolio=<id>` across a section's own
 * destinations (V3-P0 bug, #322) — shared by this strip and the rail's section
 * groups (`components/sectionNav.ts`) so the two stay in step.
 */
export function usePreservedSearch(preserveParams?: readonly string[]): string {
  const [searchParams] = useSearchParams();
  const preserved = new URLSearchParams();
  for (const key of preserveParams ?? []) {
    const value = searchParams.get(key);
    if (value !== null) preserved.set(key, value);
  }
  return preserved.toString();
}

/**
 * Origin local navigation: the horizontal tab rule under a destination's
 * header (portfolio workspace, Workbench, People…). Long strips scroll with a
 * fade-out continuation cue (styles/origin.css `.bt-tabs`). `preserveParams`
 * carries named search params — most importantly the portfolio scope
 * `?portfolio=<id>` — across the section's own tabs (V3-P0 bug, #322).
 */
export function LocalNav({
  items,
  preserveParams,
  ariaLabel,
  className,
}: {
  items: readonly LocalNavItem[];
  preserveParams?: readonly string[];
  ariaLabel?: string;
  /** Extra classes — e.g. the rail's desktop de-duplication helper. */
  className?: string;
}) {
  const t = useT();
  const search = usePreservedSearch(preserveParams);
  const navRef = useRef<HTMLElement | null>(null);
  const { pathname } = useLocation();

  // V5-P13b: at phone widths the strip scrolls, so a tab past the fold would
  // otherwise sit off-screen with no indication of where you are. Runs on mount
  // and on every route change; `NavLink`'s own `aria-current` marks the target,
  // so this never re-implements the active rule. `inline: 'nearest'` is a no-op
  // when the tab is already visible and `block: 'nearest'` keeps the page from
  // scrolling vertically. Guarded because jsdom has no `scrollIntoView`
  // (mirrors `CmdKPalette.tsx`).
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);

  return (
    <nav
      aria-label={ariaLabel ?? t('nav.section')}
      className={cx('bt-tabs', className)}
      ref={navRef}
    >
      {items.map((item) => (
        <NavLink
          className={({ isActive }) => cx('bt-tab', isActive && 'is-active')}
          end={item.end}
          key={item.to}
          to={search ? { pathname: item.to, search } : item.to}
        >
          {item.label}
          {item.parked ? (
            <span
              aria-label={t('common.parked')}
              className="bt-dot bt-dot--gold"
              role="img"
              title={t('common.parked')}
            />
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}
