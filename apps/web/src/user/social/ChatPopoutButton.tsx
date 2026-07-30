import { useNavigate } from 'react-router-dom';

import { useT } from '../../i18n';
import type { ChatTarget } from './chatSurface';
import { CHAT_WINDOW_NAME, chatWindowFeatures, chatWindowPath } from './chatWindow';

/** "Open in a separate window" — not in the shared icon set, so it lives here. */
function PopoutIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.7}
      viewBox="0 0 24 24"
    >
      <path d="M10 5H6.5A2.5 2.5 0 0 0 4 7.5v10A2.5 2.5 0 0 0 6.5 20h10a2.5 2.5 0 0 0 2.5-2.5V14" />
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 12 12" />
    </svg>
  );
}

/**
 * Pops the friend chat out into its own window (R2), carrying the thread that is
 * currently open so a second screen lands exactly where the user was.
 *
 * A named target means clicking twice reuses the one window rather than
 * scattering copies. If the browser blocks the popup `window.open` returns null —
 * then this quietly navigates to the same route instead, so the action never just
 * fails silently.
 */
export function ChatPopoutButton({ target }: { target: ChatTarget | null }) {
  const t = useT();
  const navigate = useNavigate();
  const path = chatWindowPath(target);

  function popOut() {
    const opened = window.open(path, CHAT_WINDOW_NAME, chatWindowFeatures());
    if (opened) {
      // Re-focus an already-open pop-out instead of leaving it behind the app.
      opened.focus?.();
      return;
    }
    navigate(path);
  }

  return (
    // The visible label IS the accessible name; `title` carries the longer
    // explanation as a tooltip only.
    <button
      className="bt-btn bt-btn--quiet bt-btn--sm"
      onClick={popOut}
      title={t('social.chat.popoutHint')}
      type="button"
    >
      <PopoutIcon />
      {t('social.chat.popout')}
    </button>
  );
}
