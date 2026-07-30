/**
 * The add-portfolio wizard's step order and copy keys.
 *
 * Split out of `steps.ts` (which binds the components) so the order and labels
 * can be read without pulling in the component registry — the same reason
 * `firstrun/stepMeta.ts` exists. This array is the source of truth for the
 * order: `steps.ts` maps over it.
 *
 * Today: name → icon → book → done. Later steps (opening balances, a broker
 * import, templates) drop in as a row here plus one component; the frame never
 * learns what any step does. Everything the API cannot do yet stays a parked row
 * inside the step it belongs to — never a control that silently does nothing.
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
    id: 'name',
    labelKey: 'portfolio.wizard.name.label',
    titleKey: 'portfolio.wizard.name.title',
  },
  {
    id: 'icon',
    labelKey: 'portfolio.wizard.icon.label',
    titleKey: 'portfolio.wizard.icon.title',
    hintKey: 'portfolio.wizard.icon.hint',
  },
  {
    id: 'book',
    labelKey: 'portfolio.wizard.book.label',
    titleKey: 'portfolio.wizard.book.title',
  },
  {
    id: 'done',
    labelKey: 'portfolio.wizard.done.label',
    titleKey: 'portfolio.wizard.done.title',
    terminal: true,
    primaryKey: 'portfolio.wizard.done.primary',
  },
] as const;
