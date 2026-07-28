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

/**
 * Per-state Origin badge tone + dot tone + i18n key. `open` reads a live pulse.
 * A session that is neither open nor closed (pre/post) is an "attention" state,
 * so it takes the gold accent rather than a second semantic colour.
 */
const STATE_STYLES: Record<
  MarketState,
  { dot: string; badge: string; key: string; pulse?: boolean }
> = {
  open: {
    dot: 'bt-dot--pos',
    badge: 'bt-badge--pos',
    key: 'common.marketState.open',
    pulse: true,
  },
  closed: { dot: '', badge: '', key: 'common.marketState.closed' },
  pre: { dot: 'bt-dot--gold', badge: 'bt-badge--gold', key: 'common.marketState.pre' },
  post: { dot: 'bt-dot--gold', badge: 'bt-badge--gold', key: 'common.marketState.post' },
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
    <span className={cx('bt-badge', style.badge, className)}>
      <span
        aria-hidden="true"
        className={cx('bt-dot', style.dot, style.pulse && 'animate-pulse')}
        style={{ width: 5, height: 5 }}
      />
      {t(style.key)}
    </span>
  );
}
