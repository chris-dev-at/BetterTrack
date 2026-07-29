import { useSyncExternalStore } from 'react';

/**
 * Open/closed + last-tab state for the right-side {@link ChatDock}.
 *
 * The toggle lives in the topbar and the dock at the shell root — two siblings
 * far apart in the tree — so the state is a tiny module store (the
 * `portfolioKinds.ts` pattern) rather than props threaded through `OriginShell`
 * or another context provider. That keeps the shell's diff to the two mount
 * points and lets any future surface open the dock without a prop chain.
 *
 * Only the preference persists: which tab, and whether the dock was open. The
 * SELECTED CONVERSATION deliberately does not — a reload reopens the dock on the
 * conversation list, so the composer never steals the caret on page load and the
 * dock never resurrects a stale thread.
 */

const STORAGE_KEY = 'bt.chatdock';

export const CHAT_DOCK_TABS = ['chats', 'ask'] as const;
export type ChatDockTab = (typeof CHAT_DOCK_TABS)[number];

export interface ChatDockState {
  readonly open: boolean;
  readonly tab: ChatDockTab;
}

const CLOSED: ChatDockState = Object.freeze({ open: false, tab: 'chats' as ChatDockTab });

function isTab(value: unknown): value is ChatDockTab {
  return typeof value === 'string' && (CHAT_DOCK_TABS as readonly string[]).includes(value);
}

/**
 * Cached snapshot. `useSyncExternalStore` requires a stable object identity
 * between notifications (a fresh parse each read would loop forever), so the
 * parsed state is memoised and only replaced when something actually writes.
 */
let snapshot: ChatDockState | null = null;
const listeners = new Set<() => void>();

function read(): ChatDockState {
  if (snapshot !== null) return snapshot;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      snapshot = CLOSED;
      return snapshot;
    }
    const record = parsed as Record<string, unknown>;
    snapshot = Object.freeze({
      open: record.open === true,
      tab: isTab(record.tab) ? record.tab : 'chats',
    });
  } catch {
    // Private-mode / disabled storage / corrupt JSON: the dock is a convenience,
    // so degrade to "closed on the Chats tab" rather than breaking the shell.
    snapshot = CLOSED;
  }
  return snapshot;
}

function write(next: ChatDockState): void {
  snapshot = Object.freeze(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Write failed (quota/private mode) — the in-memory snapshot still updates,
    // so this session stays consistent; it just won't survive a reload.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Open or close the dock. */
export function setChatDockOpen(open: boolean): void {
  const current = read();
  if (current.open === open) return;
  write({ ...current, open });
}

/** Flip the dock open/closed — what the topbar toggle does. */
export function toggleChatDock(): void {
  const current = read();
  write({ ...current, open: !current.open });
}

/** Select a tab (persisted, so the dock reopens where it was left). */
export function setChatDockTab(tab: ChatDockTab): void {
  const current = read();
  if (current.tab === tab) return;
  write({ ...current, tab });
}

/** Test/teardown helper: drop the in-memory snapshot so storage is re-read. */
export function resetChatDockCache(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

/** Subscribe to the dock's open state and tab. */
export function useChatDockState(): ChatDockState {
  return useSyncExternalStore(subscribe, read, () => CLOSED);
}
