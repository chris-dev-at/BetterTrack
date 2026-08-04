import { useLayoutEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useT } from '../../i18n';
import { EmptyState } from '../../ui';
import { PageHead } from '../../ui/origin';
import { cx } from '../components/ui';
import {
  ChatThreadPane,
  ConversationListPane,
  useChatRealtimeSync,
  type ChatTarget,
} from './chatSurface';
import { ChatPopoutButton } from './ChatPopoutButton';

/**
 * `/people/chat` (and `/people/chat/:userId`) — friend chat (PROJECTPLAN.md
 * §13.3 V3-P8). A master-detail layout: the conversation list beside the open
 * thread. Realtime pushes over the §4.5 gateway invalidate the relevant queries;
 * each query keeps a TanStack Query poll so chat stays live with the socket
 * absent. Share chips are resolved per-viewer server-side (never a leak).
 *
 * R2: the panes themselves live in `chatSurface.tsx` and are shared with the
 * pop-out window (`ChatWindowPage`). This page owns only the URL contract —
 * selection is a route, so every `/people/chat/...` deep link keeps working
 * unchanged, and popping out never disturbs it.
 */
export function ChatPage() {
  const t = useT();
  const navigate = useNavigate();
  // `/people/chat/:userId` opens by friend; `/people/chat/c/:conversationId`
  // opens a thread directly — the only path to one whose partner was deleted (#362).
  const { userId, conversationId } = useParams<{ userId?: string; conversationId?: string }>();
  const selected = userId ?? conversationId;
  const surfaceRef = useRef<HTMLDivElement>(null);

  useChatRealtimeSync();

  // `dvh` shrinks with the on-screen keyboard, but the chat starts below the
  // shell + People tabs. Measure that real offset so the thread can fill only
  // the remaining visual viewport; its composer then stays above the keyboard
  // while the message log remains the sole scrolling region.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const measure = () => {
      const visualViewport = window.visualViewport;
      const viewportBottom = visualViewport
        ? visualViewport.height + visualViewport.offsetTop
        : window.innerHeight;
      surface.style.setProperty(
        '--bt-chat-top',
        `${Math.max(0, surface.getBoundingClientRect().top)}px`,
      );
      surface.style.setProperty('--bt-chat-viewport-height', `${viewportBottom}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
    };
  }, []);

  // A deleted partner has no user id to route by — the thread deep-links by
  // conversation id instead (#362).
  function openTarget(target: ChatTarget) {
    navigate(
      target.userId ? `/people/chat/${target.userId}` : `/people/chat/c/${target.conversationId}`,
    );
  }

  return (
    <div className="bt-phone-surface bt-chat-page flex flex-col">
      <PageHead
        actions={
          <ChatPopoutButton
            target={userId ? { userId } : conversationId ? { conversationId } : null}
          />
        }
        title={t('social.chat.title')}
      />

      <div className="bt-chat-page__surface flex h-[calc(70*var(--bt-vh))] gap-4" ref={surfaceRef}>
        <aside className={cx('w-full shrink-0 md:w-80', selected && 'hidden md:block')}>
          <ConversationListPane
            onSelect={openTarget}
            selectedConversationId={conversationId}
            selectedUserId={userId}
          />
        </aside>
        <section className={cx('min-w-0 flex-1', !selected && 'hidden md:block')}>
          {selected ? (
            <ChatThreadPane key={selected} userId={userId} fixedConversationId={conversationId} />
          ) : (
            <div
              className="bt-panel flex h-full items-center justify-center"
              style={{ padding: 24 }}
            >
              <EmptyState
                icon="💬"
                title={t('social.chat.selectTitle')}
                description={t('social.chat.selectBody')}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
