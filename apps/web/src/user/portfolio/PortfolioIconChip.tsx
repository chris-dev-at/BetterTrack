import { Icon, type IconName } from '../../ui/origin';
import { cx } from '../components/ui';
import type { PortfolioIconTint } from './portfolioKinds';

/**
 * A portfolio's **Icon** as the app draws it everywhere: a rounded chip with a
 * soft tint of its hue behind the glyph in that hue at full strength. One shared
 * component so the topbar trigger, every switcher row and the settings picker
 * can never drift apart.
 *
 * Decorative on purpose (`aria-hidden`): the row already says the portfolio's
 * name, and the glyph identity is asserted off the inert `data-icon` marker that
 * {@link Icon} stamps, so tests can read colour-carried meaning without giving a
 * garnish glyph an accessible name it would leak into the row.
 */
export function PortfolioIconChip({
  icon,
  tint,
  size = 'md',
}: {
  /** Which glyph to draw — see `portfolioIconName`. */
  icon: IconName;
  /**
   * Which hue to tint it with — see `portfolioIconTint`. Omitted only while no
   * portfolio has resolved yet: the chip then falls back to muted ink rather
   * than claiming an icon (and with it a purpose) the user never picked.
   */
  tint?: PortfolioIconTint;
  /** `lg` is the topbar trigger; `md` every list row and picker option. */
  size?: 'md' | 'lg';
}) {
  return (
    <span
      aria-hidden
      className={cx('bt-pf-chip', tint && `bt-pf-chip--${tint}`, size === 'lg' && 'bt-pf-chip--lg')}
    >
      <Icon name={icon} size={size === 'lg' ? 17 : 15} />
    </span>
  );
}
