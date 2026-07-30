import { useEffect } from 'react';

import { useT } from '../../../../i18n';
import { Field, Input } from '../../../../ui/origin';
import { Alert } from '../../../components/ui';
import { ParkedRow } from '../ParkedRow';
import type { PortfolioWizardStepProps } from '../types';

/** §6.8 portfolio-name rule, unchanged from the dialog this step replaces. */
const NAME_MAX = 120;

/**
 * Step 1 — the name. The same trimmed-name field, the same 120-char cap and the
 * same copy as the one-field create dialog it replaces; the frame does the
 * trimming and owns the `PORTFOLIO_NAME_TAKEN` error, which lands back here
 * because this is the only step that can fix it.
 */
export function NameStep({ draft, patch, report, error }: PortfolioWizardStepProps) {
  const t = useT();
  const trimmed = draft.name.trim();
  const ready = trimmed.length > 0 && trimmed.length <= NAME_MAX;

  useEffect(() => {
    report({ ready });
  }, [report, ready]);

  return (
    <>
      <Field htmlFor="bt-pfw-name" label={t('portfolio.switcher.nameLabel')}>
        <Input
          aria-label={t('portfolio.switcher.nameAriaLabel')}
          id="bt-pfw-name"
          maxLength={NAME_MAX}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder={t('portfolio.switcher.namePlaceholder')}
          value={draft.name}
        />
      </Field>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="bt-pfw__parkedset">
        <ParkedRow label={t('portfolio.wizard.parked.currency')} />
        <ParkedRow label={t('portfolio.wizard.parked.template')} />
      </div>
    </>
  );
}
