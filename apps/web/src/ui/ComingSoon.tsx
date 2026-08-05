import type { ReactNode } from 'react';

import { useT } from '../i18n';
import { cx } from '../lib/cx';

export interface ComingSoonProps {
  /** The surface's name — e.g. "Comparisons", "API Access". */
  title: string;
  /** One-line description of what will live here once the feature ships. */
  description?: string;
  /** Optional decorative glyph (emoji or icon node). */
  icon?: ReactNode;
  /** Optional call-to-action, such as a link or a button. */
  cta?: ReactNode;
  className?: string;
}

/**
 * Shared designed placeholder for not-yet-built surfaces (PROJECTPLAN.md §7.1,
 * §7.4). Every route flagged **[Coming Soon]** in §7.2 renders one of these so a
 * deep link resolves to an intentional, on-brand page instead of a 404 or a
 * blank area. Purely presentational — no network.
 *
 * Rendered in the Origin "parked surface" family (styles/origin.css `bt-parked`):
 * a dashed-bordered panel with a faint gold wash and a gold flag — present in
 * the IA, honest about waiting on its build. Same props, same copy, same keys.
 */
export function ComingSoon({ title, description, icon = '🚧', cta, className }: ComingSoonProps) {
  const t = useT();
  return (
    <section className={cx('bt-parked', className)}>
      <span className="mb-3 block text-3xl" style={{ color: 'var(--bt-faint)' }} aria-hidden="true">
        {icon}
      </span>
      <span className="bt-parked__flag">{t('common.comingSoon')}</span>
      <h1 className="bt-parked__title">{title}</h1>
      {description ? <p className="bt-parked__body">{description}</p> : null}
      {cta != null ? <div className="mt-4">{cta}</div> : null}
    </section>
  );
}
