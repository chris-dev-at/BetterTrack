import { useCallback, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useT } from '../../../i18n';
import { Icon } from '../../../ui/origin';
import { cx } from '../../../lib/cx';
import { ChatThreadPane, ConversationListPane, type ChatTarget } from '../../social/chatSurface';
import { AskDockPanel } from './AskDockPanel';
import {
  CHAT_DOCK_TABS,
  setChatDockOpen,
  setChatDockTab,
  useChatDockState,
  type ChatDockTab,
} from './chatDockStore';
import { useDockEligible } from './useDockEligible';

export const CHAT_DOCK_ID = 'bt-chatdock';

/**
 * The right-side chat dock (R2, owner: "a thing that comes in on the right side
 * of the screen so you can have the page open and open the chat on the side
 * while navigating the rest of the app").
 *
 * NON-MODAL by design, and that is the whole point: no scrim, no focus trap, no
 * `aria-modal`, no scroll lock. It is an `<aside>` (role complementary) pinned
 * under the topbar, so the canvas beneath stays fully readable, clickable and
 * navigable while it is open — the rail, the topbar and every link on the page
 * keep working, and the dock simply overlays the right edge of the canvas.
 *
 * Two tabs: the REAL People chat (the same `chatSurface.tsx` panes the
 * `/people/chat` page mounts — same queries, same realtime, same bubbles) and
 * the parked Ask-BetterTrack AI slot. The dock never touches the router, so
 * `/people/chat` deep links are untouched: selection here is local state.
 */
export function ChatDock() {
  const t = useT();
  const { open, tab } = useChatDockState();
  const eligible = useDockEligible();
  // Which thread is open INSIDE the dock. Local, not routed — opening a chat in
  // the dock must never navigate the page the user is working on.
  const [target, setTarget] = useState<ChatTarget | null>(null);

  const closeThread = useCallback(() => setTarget(null), []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    // A dialog opened FROM the dock (the share picker, the new-chat list) is not
    // portaled, so its own Escape handler and this one would both fire. While a
    // modal is up it owns Escape; the dock only closes once nothing is over it.
    if (document.querySelector('[aria-modal="true"]') !== null) return;
    event.stopPropagation();
    setChatDockOpen(false);
  }

  // Below the breakpoint the dock does not exist at all (the toggle navigates to
  // the page instead). The persisted `open` is left ALONE so widening the window
  // brings the dock back exactly as the user left it.
  if (!open || !eligible) return null;

  return (
    <aside
      aria-label={t('chatdock.aria.region')}
      className="bt-chatdock"
      id={CHAT_DOCK_ID}
      onKeyDown={onKeyDown}
    >
      <div className="bt-chatdock__head">
        <div aria-label={t('chatdock.aria.tabs')} className="bt-subtabs" role="tablist">
          {CHAT_DOCK_TABS.map((key) => (
            <button
              aria-controls={`${CHAT_DOCK_ID}-panel-${key}`}
              aria-selected={tab === key}
              className={cx('bt-subtab', tab === key && 'is-active')}
              id={`${CHAT_DOCK_ID}-tab-${key}`}
              key={key}
              onClick={() => setChatDockTab(key)}
              onKeyDown={(event) => {
                // Two tabs, so either arrow just moves to the other one.
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const next: ChatDockTab = key === 'chats' ? 'ask' : 'chats';
                setChatDockTab(next);
                document.getElementById(`${CHAT_DOCK_ID}-tab-${next}`)?.focus();
              }}
              role="tab"
              tabIndex={tab === key ? 0 : -1}
              type="button"
            >
              {t(`chatdock.tab.${key}`)}
            </button>
          ))}
        </div>
        <button
          aria-label={t('chatdock.close')}
          className="bt-btn bt-btn--quiet bt-btn--sm bt-btn--icon"
          onClick={() => setChatDockOpen(false)}
          title={t('chatdock.close')}
          type="button"
        >
          <Icon name="x" size={15} />
        </button>
      </div>

      <div
        aria-labelledby={`${CHAT_DOCK_ID}-tab-${tab}`}
        className="bt-chatdock__body"
        id={`${CHAT_DOCK_ID}-panel-${tab}`}
        role="tabpanel"
        tabIndex={-1}
      >
        {tab === 'chats' ? (
          target ? (
            <ChatThreadPane
              fixedConversationId={target.conversationId}
              key={target.userId ?? target.conversationId}
              onBack={closeThread}
              userId={target.userId}
            />
          ) : (
            <ConversationListPane
              onSelect={setTarget}
              selectedConversationId={undefined}
              selectedUserId={undefined}
            />
          )
        ) : (
          <AskDockPanel />
        )}
      </div>
    </aside>
  );
}
