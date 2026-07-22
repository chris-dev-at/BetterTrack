import type { MarketState } from '@bettertrack/contracts';

import { useT } from '../i18n';
import { cx } from '../lib/cx';

export interface MarketStateBadgeProps {
  /**
   * The exchange session. `null`/`undefined` (unknown, or a provider that does
   * not report it) renders nothing — a wrong badge is worse than none.
   */
  state: MarketState | null | undefined;
  className?: string;
}

/** Per-state dot colour + text tone + i18n key. `open` reads a live pulse. */
const STATE_STYLES: Record<
  MarketState,
  { dot: string; text: string; key: string; pulse?: boolean }
> = {
  open: {
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    key: 'common.marketState.open',
    pulse: true,
  },
  closed: { dot: 'bg-neutral-500', text: 'text-neutral-400', key: 'common.marketState.closed' },
  pre: { dot: 'bg-amber-400', text: 'text-amber-300', key: 'common.marketState.pre' },
  post: { dot: 'bg-amber-400', text: 'text-amber-300', key: 'common.marketState.post' },
};

/**
 * A small, reusable exchange-session badge (§13.5 V5-P1, owner "badge on every
 * stock"): green dot + "Open", muted + "Closed", amber + "Pre-market" / "After
 * hours". Crypto/24-7 assets report `open`. Rendered on the asset-detail header,
 * search rows and watchlist rows wherever a quote already renders. EN + DE.
 */
export function MarketStateBadge({ state, className }: MarketStateBadgeProps) {
  const t = useT();
  if (!state) return null;
  const style = STATE_STYLES[state];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.65rem] font-medium ring-1 ring-inset ring-neutral-700/60',
        style.text,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx('h-1.5 w-1.5 rounded-full', style.dot, style.pulse && 'animate-pulse')}
      />
      {t(style.key)}
    </span>
  );
}
