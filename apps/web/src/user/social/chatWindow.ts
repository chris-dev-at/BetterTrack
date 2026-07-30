import type { ChatTarget } from './chatSurface';

/**
 * The friend chat's pop-out window (R2, owner: "the chat should be able to have
 * a popout so you could pop out the chat and put it on another screen").
 *
 * A real route, not a portal trick: the window is a second document loading the
 * app at `/chat-window`, so it is deep-linkable, survives a refresh, keeps its
 * own realtime socket and can live on another monitor. It sits OUTSIDE the shell
 * chrome (no rail, topbar, bottombar or footer) like the other chrome-free
 * surfaces (`/workbench/blueprints/new`, `/portfolio/tax/print`).
 */
export const CHAT_WINDOW_PATH = '/chat-window';

/** The named target, so clicking pop-out twice reuses the one window. */
export const CHAT_WINDOW_NAME = 'bettertrack-chat';

/**
 * Sized for a second-screen column. `noopener` is deliberately NOT passed: it
 * makes `window.open` return null, which is exactly the signal used to detect a
 * blocked popup.
 */
export const CHAT_WINDOW_FEATURES = 'popup=yes,width=440,height=760';

/** The pop-out URL for a thread, or the conversation list when nothing is open. */
export function chatWindowPath(target: ChatTarget | null): string {
  if (target?.userId) return `${CHAT_WINDOW_PATH}/${target.userId}`;
  // A deleted partner has no user id to address the thread by (#362).
  if (target?.conversationId) return `${CHAT_WINDOW_PATH}/c/${target.conversationId}`;
  return CHAT_WINDOW_PATH;
}
