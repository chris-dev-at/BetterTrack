import type { ReactNode } from 'react';

import { cx } from '../lib/cx';

/** Owner-tunable passion tagline — the single place to edit the app-wide footer copy. */
export const TAGLINE = 'BetterTrack — finances under your control';

export interface DisclaimerProps {
  /** The footnote copy — e.g. the passion tagline, or the asset page's market-data notice. */
  children: ReactNode;
  className?: string;
}

/**
 * Subtle footnote-style disclaimer (PROJECTPLAN.md §10). Used app-wide for the
 * passion-tagline footer and on the asset page for the unofficial /
 * delayed market-data notice. Purely presentational — no network.
 */
export function Disclaimer({ children, className }: DisclaimerProps) {
  return <p className={cx('text-xs text-neutral-500', className)}>{children}</p>;
}
