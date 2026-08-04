import { useNavigate, useParams } from 'react-router-dom';

import { useT } from '../../i18n';
import {
  ChatThreadPane,
  ConversationListPane,
  useChatRealtimeSync,
  type ChatTarget,
} from './chatSurface';
import { CHAT_WINDOW_PATH } from './chatWindow';

/**
 * `/chat-window` — the friend chat popped out into its own browser window (R2).
 *
 * A minimal standalone frame: no rail, no topbar, no bottombar, no footer, just
 * the conversation list or the open thread filling the window. It wears `bt-app`
 * so the ink, type, selection and focus ring are the app's, and it runs the SAME
 * `chatSurface` panes as `/people/chat` — same queries, same realtime, same
 * bubbles — so the two views of a conversation never disagree.
 *
 * Selection is routed, not local state: `/chat-window/:userId` (or
 * `/chat-window/c/:conversationId` for a deleted partner, #362) means the window
 * is deep-linkable, refresh-safe and back/forward works inside it. Popping out
 * does nothing to the in-app page, which keeps working untouched.
 */
export function ChatWindowPage() {
  const t = useT();
  const navigate = useNavigate();
  const { userId, conversationId } = useParams<{ userId?: string; conversationId?: string }>();
  const selected = userId ?? conversationId;

  useChatRealtimeSync();

  function openTarget(target: ChatTarget) {
    navigate(
      target.userId
        ? `${CHAT_WINDOW_PATH}/${target.userId}`
        : `${CHAT_WINDOW_PATH}/c/${target.conversationId}`,
    );
  }

  return (
    <div className="bt-app bt-phone-surface bt-chatwindow">
      <main aria-label={t('social.chat.title')} className="bt-chatwindow__frame">
        {selected ? (
          <ChatThreadPane
            fixedConversationId={conversationId}
            key={selected}
            onBack={() => navigate(CHAT_WINDOW_PATH)}
            userId={userId}
          />
        ) : (
          <ConversationListPane
            onSelect={openTarget}
            selectedConversationId={undefined}
            selectedUserId={undefined}
          />
        )}
      </main>
    </div>
  );
}
