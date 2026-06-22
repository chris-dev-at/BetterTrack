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
  className?: string;
}

/**
 * Designed empty state (PROJECTPLAN.md §7.1 / §7.3 EmptyState) — every list
 * gets one instead of a blank area, with an optional CTA to the obvious next
 * step.
 */
export function EmptyState({ icon, title, description, cta, className }: EmptyStateProps) {
  return (
    <div
      className={cx('flex flex-col items-center justify-center gap-4 py-16 text-center', className)}
    >
      {icon != null ? (
        <span className="text-4xl text-neutral-600" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-neutral-300">{title}</p>
        {description ? <p className="text-sm text-neutral-500">{description}</p> : null}
      </div>
      {cta != null ? <div>{cta}</div> : null}
    </div>
  );
}
