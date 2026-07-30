import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useT } from '../../../i18n';
import { cx } from '../../../lib/cx';
import { Button, Icon } from '../../../ui/origin';
import { ParkedPage } from '../../parked/ParkedPage';
import {
  setAskDockOpen,
  toggleAskDockMaximized,
  toggleAskDockPinned,
  useAskDockState,
} from './askDockStore';
import { useAskDockEligible } from './useAskDockEligible';

export const ASK_DOCK_ID = 'bt-askdock';

/** The panel's own trigger, found by the ARIA relationship it already declares. */
const TRIGGER_SELECTOR = `[aria-controls="${ASK_DOCK_ID}"]`;

/**
 * Roots that belong to something the panel itself put on screen — a portalled
 * dialog, a popover, a menu. A pointerdown inside one of these is not an
 * "outside" click, the same guard the shell's own popovers apply.
 */
const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"], .bt-popover';

/** A pin that tilts when engaged, so the two states differ in shape, not just tone. */
function PinIcon() {
  return (
    <svg
      aria-hidden="true"
      className="bt-askdock__pin-glyph"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
    >
      <path d="M12 15v5.5" />
      <path d="M8 4h8l-1 6 2.5 2.5v1.5H6.5V12.5L9 10Z" />
    </svg>
  );
}

/** Corner brackets pointing out (grow) / in (shrink) — unmistakable at 15px. */
function ResizeIcon({ maximized }: { maximized: boolean }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
    >
      {maximized ? (
        <>
          <path d="M9.5 4.5v5h-5" />
          <path d="M14.5 19.5v-5h5" />
          <path d="M4 4l5.5 5.5" />
          <path d="M20 20l-5.5-5.5" />
        </>
      ) : (
        <>
          <path d="M14.5 4.5h5v5" />
          <path d="M9.5 19.5h-5v-5" />
          <path d="M19.5 4.5 14 10" />
          <path d="M4.5 19.5 10 14" />
        </>
      )}
    </svg>
  );
}

/**
 * Ask BetterTrack as a floating panel (R2, owner: "the chat shouldnt be a thing
 * that is on the side that should only be the AI chat … the AI chat should go
 * over the thing … like not inside the content of the page like it should go
 * over").
 *
 * It reads as an overlay, never as a page column: docked, it is inset from the
 * right and bottom edges with its own corners, border and overlay shadow;
 * maximized, it takes the Control Center's popup geometry so the two feel like
 * one system.
 *
 * NON-MODAL in BOTH sizes, deliberately — no scrim, no focus trap, no
 * `aria-modal`, no scroll lock. Maximize is about size, not about trapping the
 * user, so the page underneath stays readable, clickable and navigable, and the
 * panel never covers the viewport: only its own box takes pointer events.
 *
 * Dismissal, per the owner: an outside pointerdown closes it, and that same
 * click still does whatever it would normally do on the page — nothing is
 * swallowed. The ✕ and Escape also close. The pin suspends the outside-click
 * rule so the panel survives clicking and navigating around; it is a persisted
 * preference, so pin → ✕ → reopen comes back still pinned.
 *
 * The surface itself is the SAME parked one the `/ask` page renders
 * (`ParkedPage page="ask"`) rather than a second copy of the promise, so the
 * panel can never drift from the plan or invent a claim the product doesn't make
 * yet. The composer below it is inert: no submit path, no canned answer.
 */
export function AskDock() {
  const t = useT();
  const { open, pinned, maximized } = useAskDockState();
  const eligible = useAskDockEligible();
  const panelRef = useRef<HTMLElement>(null);

  /**
   * Deliberate dismissals (✕, Escape) hand focus back to the rail row that
   * opened the panel, so the keyboard never lands on `<body>`. A click-away does
   * NOT do this: that click has already put focus where the user aimed it.
   */
  const closeAndRestoreFocus = useCallback(() => {
    setAskDockOpen(false);
    document.querySelector<HTMLElement>(TRIGGER_SELECTOR)?.focus();
  }, []);

  // Click-away. Non-modal means there is no scrim to catch this, so it is a
  // document listener — and pointedly NOT a capturing one, with no
  // preventDefault/stopPropagation: the click that closes the panel still
  // reaches the page underneath and does its normal thing (owner: "close if i
  // click anywhere else"). Pinning suspends the whole rule.
  useEffect(() => {
    if (!open || pinned || !eligible) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Inside the panel: not an outside click.
      if (panelRef.current?.contains(target)) return;
      // The trigger owns the toggle. Without this the pointerdown would close
      // and the click right after would reopen — the row would look dead.
      if (target.closest(TRIGGER_SELECTOR)) return;
      // Anything the panel itself opened, portalled out of our subtree.
      if (target.closest(OVERLAY_SELECTOR)) return;
      setAskDockOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, pinned, eligible]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    // Anything modal above us owns Escape; the panel closes once nothing does.
    if (document.querySelector('[aria-modal="true"]') !== null) return;
    event.stopPropagation();
    // Escape is an explicit dismissal, so it closes even when pinned — the pin
    // is about surviving stray clicks, not about refusing to go away.
    closeAndRestoreFocus();
  }

  // Below the breakpoint the panel does not exist at all (the rail row stays a
  // link to `/ask`). The persisted state is left ALONE, so widening the window
  // brings the panel back exactly as the user left it.
  if (!open || !eligible) return null;

  return (
    <aside
      aria-label={t('askdock.aria.region')}
      className={cx('bt-askdock', maximized && 'bt-askdock--max', pinned && 'is-pinned')}
      id={ASK_DOCK_ID}
      onKeyDown={onKeyDown}
      ref={panelRef}
    >
      <div className="bt-askdock__head">
        <span className="bt-askdock__title">
          <Icon name="sparkles" size={15} />
          {t('nav.ask')}
        </span>
        <div className="bt-askdock__actions">
          <button
            aria-label={pinned ? t('askdock.unpin') : t('askdock.pin')}
            aria-pressed={pinned}
            className={cx('bt-askdock__mode', pinned && 'is-on')}
            onClick={toggleAskDockPinned}
            title={pinned ? t('askdock.unpin') : t('askdock.pin')}
            type="button"
          >
            <PinIcon />
          </button>
          <button
            aria-label={maximized ? t('askdock.restore') : t('askdock.maximize')}
            aria-pressed={maximized}
            className={cx('bt-askdock__mode', maximized && 'is-on')}
            onClick={toggleAskDockMaximized}
            title={maximized ? t('askdock.restore') : t('askdock.maximize')}
            type="button"
          >
            <ResizeIcon maximized={maximized} />
          </button>
          <Button
            aria-label={t('askdock.close')}
            icon="x"
            iconOnly
            onClick={closeAndRestoreFocus}
            size="sm"
            variant="quiet"
          />
        </div>
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
