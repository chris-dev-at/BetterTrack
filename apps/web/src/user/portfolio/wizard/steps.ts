/**
 * The add-portfolio wizard's step registry.
 *
 * Adding a step is three lines and touches nothing else: a row in
 * {@link PORTFOLIO_WIZARD_STEP_META} (order + copy keys), a component honouring
 * {@link PortfolioWizardStepProps}, and its entry in {@link STEP_COMPONENTS}.
 * The frame reads only this array, so it never learns what any step does.
 */

import type { ComponentType } from 'react';

import { PORTFOLIO_WIZARD_STEP_META } from './stepMeta';
import { BookStep } from './steps/BookStep';
import { DoneStep } from './steps/DoneStep';
import { IconStep } from './steps/IconStep';
import { NameStep } from './steps/NameStep';
import type { PortfolioWizardStep, PortfolioWizardStepId, PortfolioWizardStepProps } from './types';

const STEP_COMPONENTS: Record<PortfolioWizardStepId, ComponentType<PortfolioWizardStepProps>> = {
  name: NameStep,
  icon: IconStep,
  book: BookStep,
  done: DoneStep,
};

export const PORTFOLIO_WIZARD_STEPS: readonly PortfolioWizardStep[] =
  PORTFOLIO_WIZARD_STEP_META.map((meta) => ({
    ...meta,
    Component: STEP_COMPONENTS[meta.id],
  }));

export type {
  PortfolioBook,
  PortfolioDraft,
  PortfolioWizardStep,
  PortfolioWizardStepId,
  PortfolioWizardStepProps,
} from './types';
