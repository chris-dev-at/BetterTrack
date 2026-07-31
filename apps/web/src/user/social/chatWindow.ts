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
 * Sized for a second-screen column, as a share of the screen it opens on rather
 * than a fixed 440 × 760 (owner: the chat "shouldnt be too small nor to big no
 * matter what device" — that box is a comfortable column on a laptop and a
 * postage stamp on a 1440p monitor). Clamped at both ends so it stays a chat
 * column: never narrower than a message bubble needs, never a second full
 * window. `noopener` is deliberately NOT passed: it makes `window.open` return
 * null, which is exactly the signal used to detect a blocked popup.
 */
export function chatWindowFeatures(screen?: { availWidth: number; availHeight: number }): string {
  const available = screen ?? globalThis.screen;
  const width = clamp(Math.round((available?.availWidth ?? 1440) * 0.26), 420, 620);
  const height = clamp(Math.round((available?.availHeight ?? 900) * 0.82), 620, 1040);
  return `popup=yes,width=${width},height=${height}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The pop-out URL for a thread, or the conversation list when nothing is open. */
export function chatWindowPath(target: ChatTarget | null): string {
  if (target?.userId) return `${CHAT_WINDOW_PATH}/${target.userId}`;
  // A deleted partner has no user id to address the thread by (#362).
  if (target?.conversationId) return `${CHAT_WINDOW_PATH}/c/${target.conversationId}`;
  return CHAT_WINDOW_PATH;
}
