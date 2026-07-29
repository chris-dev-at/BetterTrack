import { useT } from '../../i18n';
import { MAIN_SERIES } from '../../ui/charts/palette';
import { Icon } from '../../ui/origin';

/**
 * The decorative figures on the auth brand panel (R2): four small product-shaped
 * cards drifting over the graphite panel, each stating one true thing about
 * BetterTrack — what everything is worth, that portfolios nest, that they can be
 * shared, and that the month gets summarised.
 *
 * Sample content, not anybody's data: these render on the PUBLIC screens before
 * a session exists, and the whole panel is `aria-hidden` (the form column
 * announces the brand), so the figures are read by eyes only. They still go
 * through i18n — a German visitor should not meet English labels or
 * dot-separated thousands.
 *
 * Composition is deliberately a loose diagonal rather than a symmetric group: it
 * leads the eye from the value figure down to the sign-in column beside it.
 */
export function AuthFigures() {
  const t = useT();

  return (
    <div className="bt-authfig" aria-hidden="true">
      {/* What it is all worth — the same headline + change-pill pairing the Home
          hero uses, so the first impression matches the product. */}
      <div className="bt-authfig__card bt-authfig__value">
        <span className="bt-authfig__label">{t('auth.figures.valueLabel')}</span>
        <strong className="bt-authfig__amount">{t('auth.figures.valueAmount')}</strong>
        <span className="bt-authfig__pill">{t('auth.figures.valueDelta')}</span>
      </div>

      {/* Portfolios nest — the child row sits behind the same hairline guide the
          navigation rail uses for its trees. */}
      <div className="bt-authfig__card bt-authfig__nest">
        <div className="bt-authfig__row">
          <Icon name="portfolios" size={15} />
          <span className="bt-authfig__rowlabel">{t('auth.figures.nestParent')}</span>
          <span className="bt-authfig__rowvalue">{t('auth.figures.nestParentValue')}</span>
        </div>
        <div className="bt-authfig__children">
          <div className="bt-authfig__row bt-authfig__row--child">
            <Icon name="piggy-bank" size={14} />
            <span className="bt-authfig__rowlabel">{t('auth.figures.nestChild')}</span>
            <span className="bt-authfig__rowvalue">{t('auth.figures.nestChildValue')}</span>
          </div>
          <div className="bt-authfig__row bt-authfig__row--child">
            <Icon name="building" size={14} />
            <span className="bt-authfig__rowlabel">{t('auth.figures.nestChildTwo')}</span>
            <span className="bt-authfig__rowvalue">{t('auth.figures.nestChildTwoValue')}</span>
          </div>
        </div>
      </div>

      {/* Shared books — two people, one ledger. */}
      <div className="bt-authfig__card bt-authfig__shared">
        <span className="bt-authfig__faces">
          <Icon name="users" size={15} />
        </span>
        <span className="bt-authfig__stack">
          <strong className="bt-authfig__title">{t('auth.figures.sharedTitle')}</strong>
          <span className="bt-authfig__meta">{t('auth.figures.sharedMeta')}</span>
        </span>
      </div>

      {/* The month, drawn. A hand-plotted curve rather than a chart component:
          this is ornament, and it must not pull the charting runtime into the
          login bundle. */}
      <div className="bt-authfig__card bt-authfig__trend">
        <span className="bt-authfig__label">{t('auth.figures.trendLabel')}</span>
        <svg
          className="bt-authfig__spark"
          viewBox="0 0 120 34"
          preserveAspectRatio="none"
          role="presentation"
        >
          <path
            d="M2 27 L16 24 L30 25 L44 17 L58 19 L72 12 L86 14 L100 7 L118 4"
            fill="none"
            stroke={MAIN_SERIES}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="118" cy="4" r="3" fill={MAIN_SERIES} />
        </svg>
      </div>
    </div>
  );
}
