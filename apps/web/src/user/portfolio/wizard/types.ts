/**
 * The add-portfolio wizard's step contract (PROJECTPLAN.md §6.8).
 *
 * Kept free of component imports so the registry, the frame and the step meta
 * can all depend on it without a cycle — the same split `firstrun/types.ts`
 * makes for the first-run wizard.
 *
 * **The contract in one line:** the frame owns the chrome — the dialog, the dot
 * stepper, Back / the single gold primary — and the API calls; a step owns only
 * its own controls over the shared {@link PortfolioDraft}. A step never creates
 * anything, never navigates and never renders a primary button: it patches the
 * draft and {@link PortfolioWizardStepProps.report}s whether the frame may
 * advance. Adding a step is one component plus one row in `stepMeta.ts`.
 */

import type { ComponentType } from 'react';

import type { PortfolioSummary } from '@bettertrack/contracts';

import type { PortfolioKind } from '../portfolioKinds';

export type PortfolioWizardStepId = 'name' | 'icon' | 'book' | 'done';

/**
 * Who keeps the book. `solo` is a plain portfolio; `shared` hands off to the
 * existing MIRRORCHAIN create flow (§11) — see `PortfolioWizard`.
 */
export type PortfolioBook = 'solo' | 'shared';

/** Everything the wizard has collected so far. Nothing here exists server-side yet. */
export interface PortfolioDraft {
  /** Raw field value; the frame trims before it creates (§6.8 name rules). */
  name: string;
  kind: PortfolioKind;
  book: PortfolioBook;
}

export interface PortfolioWizardStepReport {
  /** False keeps the frame's single gold primary disabled. */
  ready: boolean;
  /** True while the step itself is busy — the frame disables the primary too. */
  busy?: boolean;
}

export interface PortfolioWizardStepProps {
  draft: PortfolioDraft;
  /** Merge a change into the draft. Stable across renders. */
  patch: (next: Partial<PortfolioDraft>) => void;
  /**
   * Publish this step's readiness to the frame. Stable across renders (a
   * `useState` setter), so a step can list it in effect deps safely.
   */
  report: (state: PortfolioWizardStepReport) => void;
  /**
   * The created portfolio, once the frame has created it — null on every step
   * before that. Only the terminal summary needs it.
   */
  created: PortfolioSummary | null;
  /** The frame's last create/rename failure, rendered by the step that caused it. */
  error: string | null;
}

export interface PortfolioWizardStep {
  id: PortfolioWizardStepId;
  /** Short label for the stepper's "step N of M · <label>" line. */
  labelKey: string;
  /** The step's single question — rendered by the frame as the panel heading. */
  titleKey: string;
  /** One supporting line under the question. Omit when the question suffices. */
  hintKey?: string;
  Component: ComponentType<PortfolioWizardStepProps>;
  /**
   * Terminal step: the gold primary leaves the wizard (activating the new
   * portfolio) instead of advancing, and Back is gone — the portfolio exists by
   * then, so there is nothing left to reconsider here.
   */
  terminal?: boolean;
  /** Copy key for the gold primary on this step. Defaults to `common.continue`. */
  primaryKey?: string;
}
