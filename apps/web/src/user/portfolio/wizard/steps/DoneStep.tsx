import { useEffect } from 'react';

import { useT } from '../../../../i18n';
import { PortfolioIconChip } from '../../PortfolioIconChip';
import { PORTFOLIO_KIND_ICONS } from '../../portfolioKinds';
import { ParkedRow } from '../ParkedRow';
import type { PortfolioWizardStepProps } from '../types';

/**
 * Step 4 — done. The portfolio exists by the time this renders (the frame
 * created it on the way here), so this is a read-back, not a form: what was
 * made, and what is not possible yet. The frame's gold primary activates it.
 */
export function DoneStep({ created, draft, report }: PortfolioWizardStepProps) {
  const t = useT();

  useEffect(() => {
    report({ ready: true });
  }, [report]);

  return (
    <>
      <div className="bt-pfw__summary">
        <PortfolioIconChip icon={PORTFOLIO_KIND_ICONS[draft.kind]} size="lg" tint={draft.kind} />
        <span className="bt-pfw__summary-text">
          <strong>{created?.name ?? draft.name.trim()}</strong>
          <small>{t(`portfolio.kinds.${draft.kind}`)}</small>
        </span>
      </div>

      <div className="bt-pfw__parkedset">
        <ParkedRow label={t('portfolio.wizard.parked.balances')} />
        <ParkedRow label={t('portfolio.wizard.parked.import')} />
      </div>
    </>
  );
}
