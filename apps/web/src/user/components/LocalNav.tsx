import { NavLink, useSearchParams } from 'react-router-dom';

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
}: {
  items: readonly LocalNavItem[];
  preserveParams?: readonly string[];
  ariaLabel?: string;
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
    <nav aria-label={ariaLabel ?? t('nav.section')} className="bt-tabs">
      {items.map((item) => (
        <NavLink
          className={({ isActive }) => cx('bt-tab', isActive && 'is-active')}
          end={item.end}
          key={item.to}
          to={search ? { pathname: item.to, search } : item.to}
        >
          {item.label}
          {item.parked ? (
            <span aria-label={t('common.parked')} className="bt-dot bt-dot--gold" role="img" title={t('common.parked')} />
          ) : null}
        </NavLink>
      ))}
    </nav>
  );
}
