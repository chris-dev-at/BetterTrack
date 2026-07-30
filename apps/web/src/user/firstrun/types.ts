/**
 * The first-run wizard's step contract (`/welcome`).
 *
 * Kept free of component imports so both the registry and the storage module can
 * depend on it without a cycle.
 *
 * **The contract in one line:** the frame owns the chrome — the question, the
 * stepper, Back / Continue / "Do this later" — and a step owns only its single
 * control. A step never renders a primary button and never navigates; it simply
 * {@link FirstRunStepProps.report}s whether it has been satisfied, and the frame
 * records that status when Continue is pressed. Adding a step is therefore one
 * component plus one registry row: nothing in the frame changes.
 */

import type { ComponentType } from 'react';

export type FirstRunStepId =
  | 'profile'
  | 'verifyEmail'
  | 'security'
  | 'preferences'
  | 'tax'
  | 'publicProfile'
  | 'done';

/**
 * What a step recorded when the user moved past it. `complete` means the thing
 * was actually set up (or was already on); `skipped` means they moved past it.
 */
export type FirstRunStepStatus = 'complete' | 'skipped';

export interface FirstRunStepReport {
  status: FirstRunStepStatus;
  /** True while the step is saving — the frame disables Continue meanwhile. */
  busy?: boolean;
}

export interface FirstRunStepProps {
  /**
   * Publish this step's state to the frame. Stable across renders (it is a
   * `useState` setter), so a step can list it in effect deps safely. A step that
   * never reports counts as `skipped` — the honest default for "walked past it".
   */
  report: (state: FirstRunStepReport) => void;
}

export interface FirstRunStep {
  id: FirstRunStepId;
  /** Short label for the stepper's "step N of M · <label>" line. */
  labelKey: string;
  /** The step's single question — rendered by the frame as the `h1`. */
  titleKey: string;
  /** One supporting line under the question. Omit when the question suffices. */
  hintKey?: string;
  Component: ComponentType<FirstRunStepProps>;
  /**
   * The step's small live figure, rendered by the frame above the question. Takes
   * no props: a figure reads the same state its step does (see
   * `FirstRunFigures.tsx`), which is what keeps it honest and keeps the step
   * component free of decoration.
   */
  Figure?: ComponentType;
  /**
   * Terminal step: the frame drops "Do this later" (there is nothing left to
   * defer) and the gold CTA leaves the wizard instead of advancing.
   */
  terminal?: boolean;
}
