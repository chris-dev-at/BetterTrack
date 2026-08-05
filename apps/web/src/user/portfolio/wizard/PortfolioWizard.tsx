import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { Button, ODialog } from '../../../ui/origin';
import { DEFAULT_PORTFOLIO_KIND, setPortfolioKind } from '../portfolioKinds';
import { usePortfolioStore } from '../PortfolioStoreProvider';
import { PORTFOLIO_WIZARD_STEPS } from './steps';
import type { PortfolioDraft, PortfolioWizardStepReport } from './types';

/**
 * The add-portfolio wizard (PROJECTPLAN.md §6.8) — the single "Add portfolio"
 * entry point in the switcher footer.
 *
 * ── ONE SCREEN (owner, 2026-07-31) ──
 *
 * It used to be four: name, icon, who keeps the book, and a read-back of what
 * was made. Four presses of Continue for three questions, two of which have a
 * perfectly good default and none of which depends on an earlier answer — so
 * they are one panel now, and making a portfolio is one press. The dot stepper
 * comes back automatically if a genuinely dependent question is ever added:
 * this frame reads `steps` and renders the stepper whenever there is more than
 * one, so the collapse cost the architecture nothing.
 *
 * WHERE CREATION HAPPENS. Nothing exists server-side until the primary is
 * pressed, so Escape is always safe — there is nothing to undo. On the shared
 * branch the wizard creates nothing at all: it hands off to the MIRRORCHAIN
 * create-chain → invite-a-friend flow, which creates its own group portfolio,
 * so nobody ends up with an orphan plain portfolio beside the group one.
 *
 * CREATION HAPPENS ONCE, and the guard is a ref rather than the mutation's
 * `isPending`: pending only becomes true on the next render, so a double-click
 * or a held Enter would otherwise fire a second POST inside the same tick. The
 * ref is released only when the create *failed*.
 */
export function PortfolioWizard({
  allowShared = true,
  onClose,
  onCreated,
  onSharedBook,
}: {
  allowShared?: boolean;
  onClose: () => void;
  /** A plain portfolio was created and the user is done: activate it. */
  onCreated: (portfolio: PortfolioSummary) => void;
  /**
   * The user wants a group book: hand off to the MIRRORCHAIN create flow (§11),
   * carrying the name they already typed so it is not asked for twice.
   */
  onSharedBook: (name: string) => void;
}) {
  const t = useT();
  const store = usePortfolioStore();
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<PortfolioDraft>({
    name: '',
    kind: DEFAULT_PORTFOLIO_KIND,
    book: 'solo',
  });
  const [reported, setReported] = useState<PortfolioWizardStepReport>({ ready: false });
  const [created, setCreated] = useState<PortfolioSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const bodyRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** Synchronous once-only latch for the POST — see the note above. */
  const creatingRef = useRef(false);

  // `allowShared` no longer removes a step — the book choice is a section
  // inside the one panel, so the step itself decides whether to render it.
  const steps = PORTFOLIO_WIZARD_STEPS;
  const step = steps[index];
  const total = steps.length;

  // Stable identities: steps list both in effect deps (see types.ts).
  const patch = useCallback(
    (next: Partial<PortfolioDraft>) => setDraft((current) => ({ ...current, ...next })),
    [],
  );
  const report = useCallback((next: PortfolioWizardStepReport) => setReported(next), []);

  /**
   * Create the portfolio and write its icon through the same store the Settings
   * picker uses — one code path for "this portfolio's icon".
   */
  const commit = useMutation({
    mutationFn: async (): Promise<PortfolioSummary> => {
      const portfolio = await store.createPortfolio(draft.name.trim());
      setPortfolioKind(portfolio.id, draft.kind);
      return portfolio;
    },
    onSuccess: (portfolio) => {
      setError(null);
      setCreated(portfolio);
      // The portfolio EXISTS now, so every list of portfolios is stale from this
      // moment. This used to be refreshed only by `onCreated` on a terminal
      // step's Continue, so closing the wizard any other way left the switcher
      // showing a list without the portfolio you had just made (owner,
      // 2026-07-31). With no terminal step left, the wizard's job is done here:
      // hand the portfolio over and get out of the way.
      void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
      onCreated(portfolio);
      onClose();
    },
    onError: (err) => {
      // Nothing was created, so let the next attempt through.
      creatingRef.current = false;
      // A name clash is only fixable on the name step, so land the user there
      // with the message rather than stranding them on a step that cannot help.
      setError(
        err instanceof ApiError && err.code === 'PORTFOLIO_NAME_TAKEN'
          ? t('portfolio.switcher.nameTakenError')
          : t('portfolio.switcher.createError'),
      );
      goTo(0);
    },
  });

  /**
   * Dismissing the wizard is not the same as abandoning the portfolio. If one was
   * created, report it on the way out — otherwise pressing Escape on the final
   * step left the user looking at their OLD portfolio with the new one nowhere
   * in the switcher.
   */
  const handleClose = useCallback(() => {
    if (created) onCreated(created);
    onClose();
  }, [created, onClose, onCreated]);

  function goTo(nextIndex: number) {
    setReported({ ready: false });
    setIndex(Math.max(0, Math.min(nextIndex, total - 1)));
  }

  /** The primary — and Enter, since the panel is a form. */
  function advance() {
    if (!step || reported.busy || commit.isPending) return;
    // Not the last step: this only fires once a dependent question is added.
    if (index < total - 1) {
      goTo(index + 1);
      return;
    }
    // A group book is created by the MIRRORCHAIN flow, not here — hand off with
    // the name already typed so it is never asked for twice.
    if (allowShared && draft.book === 'shared') {
      onSharedBook(draft.name.trim());
      return;
    }
    if (creatingRef.current || created !== null) return;
    creatingRef.current = true;
    commit.mutate();
  }

  // Hand focus to the step's own control (the checked radio, else the field),
  // falling back to the primary on a read-only step. Runs after ODialog's own
  // mount focus — parent effects flush after child effects — so this wins.
  useEffect(() => {
    const target =
      bodyRef.current?.querySelector<HTMLElement>('[aria-checked="true"], input, button') ??
      formRef.current?.querySelector<HTMLElement>('button[type="submit"]');
    target?.focus();
  }, [index]);

  if (!step) return null;
  const { Component } = step;
  const busy = commit.isPending || Boolean(reported.busy);

  return (
    <ODialog
      onClose={handleClose}
      open
      phoneSheet
      size="wizard"
      title={t('portfolio.wizard.title')}
    >
      <form
        className="bt-money-surface bt-pfw"
        onSubmit={(event) => {
          event.preventDefault();
          advance();
        }}
        ref={formRef}
      >
        {/* The stepper is chrome for a JOURNEY. With one step there is no
            journey, and "step 1 of 1" beside a single dot is noise. */}
        {total > 1 ? (
          <div className="bt-pfw__stepper">
            <div aria-hidden="true" className="bt-pfw__dots">
              {steps.map((entry, position) => (
                <span
                  className="bt-pfw__dot"
                  data-state={
                    position === index ? 'current' : position < index ? 'done' : 'upcoming'
                  }
                  key={entry.id}
                />
              ))}
            </div>
            <p className="bt-pfw__stepnow">
              {t('portfolio.wizard.stepOf', { current: index + 1, total })}
              {' · '}
              {t(step.labelKey)}
            </p>
          </div>
        ) : null}

        {/* Keyed so each step mounts fresh — no state leaks between questions. */}
        <div className="bt-pfw__body" key={step.id} ref={bodyRef}>
          <h3 className="bt-pfw__q">{t(step.titleKey)}</h3>
          {step.hintKey ? <p className="bt-pfw__hint">{t(step.hintKey)}</p> : null}
          <Component
            allowShared={allowShared}
            created={created}
            draft={draft}
            error={error}
            patch={patch}
            report={report}
          />
        </div>

        <div className="bt-pfw__foot">
          {index > 0 && !step.terminal ? (
            <Button disabled={busy} onClick={() => goTo(index - 1)} type="button" variant="quiet">
              {t('common.back')}
            </Button>
          ) : (
            <span />
          )}
          <Button disabled={!reported.ready || busy} type="submit" variant="primary">
            {busy
              ? t('common.saving')
              : step.primaryKey
                ? t(step.primaryKey)
                : t('common.continue')}
          </Button>
        </div>
      </form>
    </ODialog>
  );
}
