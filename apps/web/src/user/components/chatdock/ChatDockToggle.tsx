import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { useT } from '../../../i18n';
import { listConversations } from '../../../lib/chatApi';
import { Icon } from '../../../ui/origin';
import { CONVERSATIONS_KEY, useChatRealtimeSync } from '../../social/chatSurface';
import { CHAT_DOCK_ID } from './ChatDock';
import { toggleChatDock, useChatDockState } from './chatDockStore';
import { useDockEligible } from './useDockEligible';

/** Shared visuals with the neighbouring notification bell, so the pair matches. */
const TRIGGER_CLASS =
  'relative grid h-9 w-9 place-items-center rounded-full bt-muted transition-colors hover:bt-soft';

function ChatGlyph() {
  return <Icon name="message" size={19} />;
}

/** The gold unread dot, positioned like the bell's badge. */
function UnreadDot() {
  return (
    <span
      aria-hidden="true"
      className="bt-dot bt-dot--gold absolute right-1 top-1"
      style={{ boxShadow: '0 0 0 2px var(--bt-bg)' }}
    />
  );
}

/**
 * Does the account have any unread conversation?
 *
 * Freshness trade-off (deliberate): this rides the same `CONVERSATIONS_KEY` the
 * dock's list uses, so opening the dock costs no extra request — but it does NOT
 * add a background poll of its own. The topbar is mounted on every page, and a
 * 20s poll everywhere for a decoration is not worth the load. Instead the dot is
 * correct on load, goes live over the realtime `chat.message` push, and refreshes
 * when the tab regains focus. With the socket down it can therefore lag until the
 * next focus or until the dock is opened (which starts the list's own poll). The
 * dot is a hint, never the source of truth — the count in the list is.
 */
function useChatUnread(): boolean {
  useChatRealtimeSync();
  const { data } = useQuery({
    queryKey: CONVERSATIONS_KEY,
    queryFn: ({ signal }) => listConversations(signal),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  return (data?.unreadTotal ?? 0) > 0;
}

/**
 * Topbar chat trigger, beside the notification bell.
 *
 * Wide viewports open/close the {@link ChatDock} in place (`aria-expanded`, a
 * real disclosure). Below the dock breakpoint it becomes a plain link to
 * `/people/chat` — the dock is a desktop luxury and the page is the small-screen
 * answer, so nothing is hidden from anyone.
 */
export function ChatDockToggle() {
  const t = useT();
  const { open } = useChatDockState();
  const eligible = useDockEligible();
  const unread = useChatUnread();

  const label = unread ? t('chatdock.toggleUnread') : t('chatdock.toggle');

  if (!eligible) {
    // Not a disclosure: it navigates, so it carries no aria-expanded.
    return (
      <Link aria-label={label} className={TRIGGER_CLASS} title={label} to="/people/chat">
        <ChatGlyph />
        {unread ? <UnreadDot /> : null}
      </Link>
    );
  }

  return (
    <button
      aria-controls={CHAT_DOCK_ID}
      aria-expanded={open}
      aria-label={label}
      className={TRIGGER_CLASS}
      onClick={toggleChatDock}
      title={label}
      type="button"
    >
      <ChatGlyph />
      {unread ? <UnreadDot /> : null}
    </button>
  );
}
