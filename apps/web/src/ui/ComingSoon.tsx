import type { ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface ComingSoonProps {
  /** The surface's name — e.g. "Comparisons", "API Access". */
  title: string;
  /** One-line description of what will live here once the feature ships. */
  description?: string;
  /** Optional decorative glyph (emoji or icon node). */
  icon?: ReactNode;
  className?: string;
}

/**
 * Shared designed placeholder for not-yet-built surfaces (PROJECTPLAN.md §7.1,
 * §7.4). Every route flagged **[Coming Soon]** in §7.2 renders one of these so a
 * deep link resolves to an intentional, on-brand page instead of a 404 or a
 * blank area. Purely presentational — no network.
 */
export function ComingSoon({ title, description, icon = '🚧', className }: ComingSoonProps) {
  return (
    <section
      className={cx(
        'flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-neutral-800 bg-neutral-900/40 px-6 py-16 text-center',
        className,
      )}
    >
      <span className="text-4xl text-neutral-600" aria-hidden="true">
        {icon}
      </span>
      <div className="flex flex-col items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-neutral-800 px-2.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide text-neutral-400 ring-1 ring-inset ring-neutral-700">
          Coming soon
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-100">{title}</h1>
        {description ? <p className="max-w-md text-sm text-neutral-500">{description}</p> : null}
      </div>
    </section>
  );
}
