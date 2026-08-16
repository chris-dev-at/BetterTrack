import type { ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface EmptyStateProps {
  /** Optional decorative glyph (emoji or icon node). */
  icon?: ReactNode;
  /** Headline — the "Search your first stock →" line. */
  title: string;
  /** Optional supporting sentence. */
  description?: string;
  /** Call-to-action slot — e.g. a Button or link. */
  cta?: ReactNode;
  /** Use reduced vertical spacing when the surrounding surface is already compact. */
  compact?: boolean;
  className?: string;
}

/**
 * Designed empty state (PROJECTPLAN.md §7.1 / §7.3 EmptyState) — every list
 * gets one instead of a blank area, with an optional CTA to the obvious next
 * step.
 *
 * Typography and tone come from the Origin tokens (`bt-empty__title`, `bt-muted`);
 * the vertical rhythm stays on layout utilities so `compact` keeps working.
 */
export function EmptyState({
  icon,
  title,
  description,
  cta,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div className={cx('bt-state bt-state--center', compact ? 'py-8' : 'py-12', className)}>
      {icon != null ? (
        <span className="bt-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="bt-state__title">{title}</p>
      {description ? <p className="bt-state__body">{description}</p> : null}
      {cta != null ? <div className="bt-state__action">{cta}</div> : null}
    </div>
  );
}
