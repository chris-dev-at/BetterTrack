/**
 * The first-run wizard's step order and copy keys.
 *
 * Split out of `steps.ts` (which binds the components) purely so the Done
 * summary can read the order and the labels back without importing the
 * component registry — that would be an import cycle, since Done is itself one
 * of the registered components.
 *
 * This array is the source of truth for the order: `steps.ts` maps over it.
 */

import type { FirstRunStepId } from './types';

export interface FirstRunStepMeta {
  id: FirstRunStepId;
  /** Short label — the stepper's "step N of M · <label>" line and the summary. */
  labelKey: string;
  /** The step's single question, rendered by the frame as the `h1`. */
  titleKey: string;
  /** One supporting line under the question. */
  hintKey?: string;
  /** Terminal step: no "Do this later", and the gold CTA leaves the wizard. */
  terminal?: boolean;
}

export const FIRST_RUN_STEP_META: readonly FirstRunStepMeta[] = [
  {
    id: 'profile',
    labelKey: 'firstrun.profile.label',
    titleKey: 'firstrun.profile.title',
    hintKey: 'firstrun.profile.hint',
  },
  {
    id: 'verifyEmail',
    labelKey: 'firstrun.verifyEmail.label',
    titleKey: 'firstrun.verifyEmail.title',
  },
  {
    id: 'security',
    labelKey: 'firstrun.security.label',
    titleKey: 'firstrun.security.title',
    hintKey: 'firstrun.security.hint',
  },
  {
    id: 'preferences',
    labelKey: 'firstrun.preferences.label',
    titleKey: 'firstrun.preferences.title',
  },
  {
    id: 'tax',
    labelKey: 'firstrun.tax.label',
    titleKey: 'firstrun.tax.title',
    hintKey: 'firstrun.tax.hint',
  },
  {
    id: 'publicProfile',
    labelKey: 'firstrun.publicProfile.label',
    titleKey: 'firstrun.publicProfile.title',
  },
  {
    id: 'done',
    labelKey: 'firstrun.done.label',
    titleKey: 'firstrun.done.title',
    terminal: true,
  },
] as const;
