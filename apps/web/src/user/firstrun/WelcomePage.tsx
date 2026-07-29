import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Wordmark } from '../../components/Wordmark';
import { useT } from '../../i18n';
import { useAuth } from '../AuthContext';
import { Button } from '../components/ui';
import { markFirstRunDone, markFirstRunStep } from './firstRunStorage';
import { FIRST_RUN_STEPS } from './steps';
import type { FirstRunStepReport } from './types';

/** A step that has not reported yet counts as walked-past, never as done. */
const UNREPORTED: FirstRunStepReport = { status: 'skipped', busy: false };

/**
 * First-run setup (`/welcome`, PROJECTPLAN.md §6.1 surface).
 *
 * A full-screen gate canvas holding exactly one question at a time: a slim dot
 * stepper, the question, that step's single control, and one gold Continue. The
 * quiet "Do this later" is always available and closes the run out — this
 * wizard is an offer, never a gate, so nothing here can trap a signed-in user.
 *
 * Authenticated-only (mounted under `RequireUser`) but never one-shot: `/welcome`
 * is reachable at any time, including from the ⌘K palette, and simply starts the
 * run again from the top. Progress lives in `localStorage` — see
 * `firstRunStorage.ts` for why there is no server-side completion flag.
 *
 * The frame owns all chrome and knows nothing about any individual step: steps
 * report a status, the frame records it on Continue. See `types.ts`.
 */
export function WelcomePage() {
  const t = useT();
  const navigate = useNavigate();
  const { completeFirstRun } = useAuth();

  const [index, setIndex] = useState(0);
  const [reported, setReported] = useState<FirstRunStepReport>(UNREPORTED);

  const step = FIRST_RUN_STEPS[index];
  const total = FIRST_RUN_STEPS.length;

  // Stable identity: steps list this in effect deps (see FirstRunStepProps).
  const report = useCallback((next: FirstRunStepReport) => setReported(next), []);

  /**
   * Close the run out and open the app. Records locally AND server-side: the
   * local flag keeps this device out of the gate even if the request fails, the
   * server flag is what stops the wizard reappearing on the next device.
   * `completeFirstRun` stamps the in-memory user first and swallows failures, so
   * leaving is never blocked on the network.
   */
  function leave() {
    markFirstRunDone();
    void completeFirstRun();
    navigate('/', { replace: true });
  }

  function goTo(nextIndex: number) {
    setReported(UNREPORTED);
    setIndex(nextIndex);
  }

  /**
   * Continue — and Enter, since the frame is a form. Records what the step
   * reported, then advances; on the terminal step it closes the run and opens
   * the app.
   */
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!step || reported.busy) return;
    markFirstRunStep(step.id, reported.status);
    if (step.terminal) {
      leave();
      return;
    }
    goTo(Math.min(index + 1, total - 1));
  }

  if (!step) return null;
  const { Component } = step;

  return (
    <div className="bt-app bt-fr">
      <form className="bt-fr__inner" onSubmit={onSubmit}>
        <header className="bt-fr__head">
          <Wordmark edition="Web" />
          <div className="flex flex-col gap-2.5">
            <div className="bt-fr__dots" aria-hidden="true">
              {FIRST_RUN_STEPS.map((entry, position) => (
                <span
                  key={entry.id}
                  className="bt-fr__dot"
                  data-state={
                    position === index ? 'current' : position < index ? 'done' : 'upcoming'
                  }
                />
              ))}
            </div>
            <p className="bt-fr__stepnow">
              {t('firstrun.stepOf', { current: index + 1, total })}
              {' · '}
              {t(step.labelKey)}
            </p>
          </div>
        </header>

        {/* Keyed so each step mounts fresh: local state never leaks across
            questions, and the 180ms enter animation replays. */}
        <div key={step.id} className="bt-fr__body bt-fr__step">
          <h1 className="bt-fr__q">{t(step.titleKey)}</h1>
          {step.hintKey ? <p className="bt-fr__hint">{t(step.hintKey)}</p> : null}
          <Component report={report} />
        </div>

        <div className="bt-fr__foot">
          {index > 0 ? (
            <Button type="button" variant="ghost" onClick={() => goTo(index - 1)}>
              {t('common.back')}
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={reported.busy}>
            {step.terminal ? t('firstrun.finish') : t('common.continue')}
          </Button>
        </div>

        {/* Always available, always quiet — the way out is never hidden. */}
        {step.terminal ? null : (
          <div className="bt-fr__later">
            <button type="button" onClick={leave}>
              {t('firstrun.later')}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

export default WelcomePage;
