import { useEffect } from 'react';

import { useT } from '../../../../i18n';
import { cx } from '../../../components/ui';
import { PortfolioIconChip } from '../../PortfolioIconChip';
import { PORTFOLIO_KINDS, PORTFOLIO_KIND_ICONS } from '../../portfolioKinds';
import type { PortfolioWizardStepProps } from '../types';

/**
 * Step 2 — the icon. The very same picker as the Settings tab (`bt-kind-picker`
 * + {@link PortfolioIconChip}), and it persists the same way: the frame writes
 * the pick through `setPortfolioKind` once the portfolio has an id, so there is
 * one store and one code path for "this portfolio's icon".
 *
 * Always ready — every portfolio has an icon, `private` by default.
 */
export function IconStep({ draft, patch, report }: PortfolioWizardStepProps) {
  const t = useT();

  useEffect(() => {
    report({ ready: true });
  }, [report]);

  return (
    <div
      aria-label={t('portfolio.settings.iconPickerAriaLabel')}
      className="bt-kind-picker"
      role="radiogroup"
    >
      {PORTFOLIO_KINDS.map((option) => (
        <button
          aria-checked={option === draft.kind}
          className={cx('bt-kind-option', option === draft.kind && 'is-active')}
          key={option}
          onClick={() => patch({ kind: option })}
          role="radio"
          type="button"
        >
          <PortfolioIconChip icon={PORTFOLIO_KIND_ICONS[option]} tint={option} />
          <span>{t(`portfolio.kinds.${option}`)}</span>
        </button>
      ))}
    </div>
  );
}
