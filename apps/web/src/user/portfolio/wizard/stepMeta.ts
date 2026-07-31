/**
 * The add-portfolio wizard's step order and copy keys.
 *
 * Split out of `steps.ts` (which binds the components) so the order and labels
 * can be read without pulling in the component registry — the same reason
 * `firstrun/stepMeta.ts` exists. This array is the source of truth for the
 * order: `steps.ts` maps over it.
 *
 * Today: ONE step. Name, icon and who keeps the book were four screens until
 * 2026-07-31; none of the later questions depended on an earlier answer, so
 * they collapsed into a single panel (see `steps/SetupStep.tsx`). The registry
 * stays because the shape is still right for a question that genuinely does
 * depend on an earlier one — opening balances differ by book, a broker import
 * needs the currency — and the frame shows its stepper again the moment there
 * is more than one row here. Everything the API cannot do yet stays a parked
 * row inside the step it belongs to, never a control that silently does nothing.
 */

import type { PortfolioWizardStepId } from './types';

export interface PortfolioWizardStepMeta {
  id: PortfolioWizardStepId;
  labelKey: string;
  titleKey: string;
  hintKey?: string;
  terminal?: boolean;
  primaryKey?: string;
}

export const PORTFOLIO_WIZARD_STEP_META: readonly PortfolioWizardStepMeta[] = [
  {
    id: 'setup',
    labelKey: 'portfolio.wizard.setup.label',
    titleKey: 'portfolio.wizard.setup.title',
    primaryKey: 'portfolio.wizard.setup.primary',
  },
] as const;
