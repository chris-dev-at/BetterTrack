/**
 * The first-run wizard's step registry (`/welcome`).
 *
 * Adding a step is three lines and touches nothing else: a row in
 * {@link FIRST_RUN_STEP_META} (order + copy keys), a component honouring
 * {@link FirstRunStepProps}, and its entry in {@link STEP_COMPONENTS}. The frame
 * reads only this array, so it never learns what any individual step does.
 */

import type { ComponentType } from 'react';

import {
  DoneFigure,
  PreferencesFigure,
  ProfileFigure,
  PublicProfileFigure,
  SecurityFigure,
  TaxFigure,
  VerifyEmailFigure,
} from './FirstRunFigures';
import { FIRST_RUN_STEP_META } from './stepMeta';
import { DoneStep } from './steps/DoneStep';
import { PreferencesStep } from './steps/PreferencesStep';
import { ProfileStep } from './steps/ProfileStep';
import { PublicProfileStep } from './steps/PublicProfileStep';
import { SecurityStep } from './steps/SecurityStep';
import { TaxStep } from './steps/TaxStep';
import { VerifyEmailStep } from './steps/VerifyEmailStep';
import type { FirstRunStep, FirstRunStepId, FirstRunStepProps } from './types';

const STEP_COMPONENTS: Record<FirstRunStepId, ComponentType<FirstRunStepProps>> = {
  profile: ProfileStep,
  verifyEmail: VerifyEmailStep,
  security: SecurityStep,
  preferences: PreferencesStep,
  tax: TaxStep,
  publicProfile: PublicProfileStep,
  done: DoneStep,
};

const STEP_FIGURES: Record<FirstRunStepId, ComponentType> = {
  profile: ProfileFigure,
  verifyEmail: VerifyEmailFigure,
  security: SecurityFigure,
  preferences: PreferencesFigure,
  tax: TaxFigure,
  publicProfile: PublicProfileFigure,
  done: DoneFigure,
};

export const FIRST_RUN_STEPS: readonly FirstRunStep[] = FIRST_RUN_STEP_META.map((meta) => ({
  ...meta,
  Component: STEP_COMPONENTS[meta.id],
  Figure: STEP_FIGURES[meta.id],
}));

export type { FirstRunStep, FirstRunStepId, FirstRunStepProps } from './types';
