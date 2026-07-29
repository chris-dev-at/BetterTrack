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
    <div
      className={cx(
        'flex flex-col items-center justify-center gap-4 text-center',
        compact ? 'py-10' : 'py-16',
        className,
      )}
    >
      {icon != null ? (
        <span className="text-4xl" style={{ color: 'var(--bt-faint)' }} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="bt-empty__title">{title}</p>
        {description ? <p className="bt-muted text-sm">{description}</p> : null}
      </div>
      {cta != null ? <div>{cta}</div> : null}
    </div>
  );
}
