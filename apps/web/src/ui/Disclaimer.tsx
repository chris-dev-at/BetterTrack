import type { ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface DisclaimerProps {
  /** The disclaimer copy — e.g. "BetterTrack is not investment advice." */
  children: ReactNode;
  className?: string;
}

/**
 * Subtle footnote-style disclaimer (PROJECTPLAN.md §10). Used app-wide for the
 * "not investment advice" footer and on the asset page for the unofficial /
 * delayed market-data notice. Purely presentational — no network.
 */
export function Disclaimer({ children, className }: DisclaimerProps) {
  return <p className={cx('text-xs text-neutral-500', className)}>{children}</p>;
}
