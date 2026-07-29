import { type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useT } from '../../../i18n';
import { Button, Icon } from '../../../ui/origin';
import { ParkedPage } from '../../parked/ParkedPage';
import { setAskDockOpen, useAskDockOpen } from './askDockStore';
import { useAskDockEligible } from './useAskDockEligible';

export const ASK_DOCK_ID = 'bt-askdock';

/**
 * Ask BetterTrack as a floating panel (R2, owner: "the chat shouldnt be a thing
 * that is on the side that should only be the AI chat … the AI chat should go
 * over the thing … like not inside the content of the page like it should go
 * over").
 *
 * So it reads as an overlay, never as a page column: inset from the right and
 * bottom edges with its own rounded corners, border and overlay shadow, floating
 * clear of the topbar. It is AI-ONLY — the friend chat is its own thing now (the
 * `/people/chat` page and its pop-out window), not a tab in here.
 *
 * Still NON-MODAL, which is the point: no scrim, no focus trap, no `aria-modal`,
 * no scroll lock. It is an `<aside>` (role complementary), so the page below
 * stays readable, clickable and navigable while it is open.
 *
 * The surface itself is the SAME parked one the `/ask` page renders
 * (`ParkedPage page="ask"`) rather than a second copy of the promise, so the
 * panel can never drift from the plan or invent a claim the product doesn't make
 * yet. The composer below it is inert: no submit path, no canned answer.
 */
export function AskDock() {
  const t = useT();
  const open = useAskDockOpen();
  const eligible = useAskDockEligible();

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    // Nothing in here opens a modal today, but a dialog reached from the parked
    // links would own Escape — the panel only closes with nothing over it.
    if (document.querySelector('[aria-modal="true"]') !== null) return;
    event.stopPropagation();
    setAskDockOpen(false);
  }

  // Below the breakpoint the panel does not exist at all (the rail row stays a
  // link to `/ask`). The persisted open state is left ALONE, so widening the
  // window brings the panel back exactly as the user left it.
  if (!open || !eligible) return null;

  return (
    <aside
      aria-label={t('askdock.aria.region')}
      className="bt-askdock"
      id={ASK_DOCK_ID}
      onKeyDown={onKeyDown}
    >
      <div className="bt-askdock__head">
        <span className="bt-askdock__title">
          <Icon name="sparkles" size={15} />
          {t('nav.ask')}
        </span>
        <button
          aria-label={t('askdock.close')}
          className="bt-btn bt-btn--quiet bt-btn--sm bt-btn--icon"
          onClick={() => setAskDockOpen(false)}
          title={t('askdock.close')}
          type="button"
        >
          <Icon name="x" size={15} />
        </button>
      </div>

      <div className="bt-askdock__scroll">
        <div className="bt-askdock__parked">
          <ParkedPage page="ask" />
        </div>
      </div>

      {/* Not a <form>: nothing can be submitted, so there is no handler to write
          and no way for a stray Enter to imply an answer is coming. */}
      <div className="bt-askdock__composer bt-t-rule">
        <textarea
          aria-describedby="bt-askdock-hint"
          className="bt-textarea max-h-32 flex-1 resize-none"
          disabled
          placeholder={t('askdock.composerPlaceholder')}
          rows={1}
          style={{ minHeight: 34 }}
        />
        <Button className="shrink-0" disabled type="button" variant="primary">
          {t('askdock.send')}
        </Button>
      </div>
      <p className="bt-askdock__hint bt-meta" id="bt-askdock-hint">
        {t('askdock.hint')}
      </p>
    </aside>
  );
}
