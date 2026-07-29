import { useSyncExternalStore } from 'react';

/**
 * State for the floating {@link AskDock} AI panel.
 *
 * The trigger is the rail's "Ask BetterTrack" utility row and the panel is
 * mounted at the shell root — two places far apart in the tree — so the state is
 * a tiny module store (the `portfolioKinds.ts` pattern) rather than props
 * threaded through `OriginShell` or another context provider. That keeps the
 * heavily-tuned rail's diff to the one row that became a toggle.
 *
 * `pinned` and `maximized` are PREFERENCES, independent of `open` (owner: "when
 * i have ai chat open and make it stay then close it with the x and reopen it
 * still stays"). Closing the panel therefore never clears them — the whole
 * record is persisted together and only the flag that was toggled changes.
 *
 * The panel carries no conversation and no tab: the friend chat is a separate
 * thing (the `/people/chat` page and its pop-out window), not a mode of this.
 */

const STORAGE_KEY = 'bt.askdock';

export interface AskDockState {
  /** Is the panel on screen right now? */
  readonly open: boolean;
  /** "Stay open": outside clicks are ignored while this is set. */
  readonly pinned: boolean;
  /** Large centered popup instead of the corner dock. */
  readonly maximized: boolean;
}

const CLOSED: AskDockState = Object.freeze({ open: false, pinned: false, maximized: false });

/**
 * Cached snapshot. `useSyncExternalStore` requires a stable object identity
 * between notifications (a fresh parse each read would loop forever), so the
 * parsed record is memoised and only replaced when something actually writes.
 */
let snapshot: AskDockState | null = null;
const listeners = new Set<() => void>();

/**
 * Forward-safe: anything that isn't a recognisable record degrades to the
 * defaults instead of throwing. That covers corrupt JSON, a payload from a newer
 * build carrying fields this one doesn't know, and the plain `'open'`/`'closed'`
 * string this key held before the panel had modes.
 */
function parse(raw: string | null): AskDockState {
  if (raw === null) return CLOSED;
  if (raw === 'open') return Object.freeze({ ...CLOSED, open: true });
  if (raw === 'closed') return CLOSED;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return CLOSED;
    const record = parsed as Record<string, unknown>;
    return Object.freeze({
      open: record.open === true,
      pinned: record.pinned === true,
      maximized: record.maximized === true,
    });
  } catch {
    return CLOSED;
  }
}

function read(): AskDockState {
  if (snapshot !== null) return snapshot;
  try {
    snapshot = parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private-mode / disabled storage: the panel is a convenience, so degrade to
    // its defaults rather than breaking the shell.
    snapshot = CLOSED;
  }
  return snapshot;
}

function write(next: AskDockState): void {
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

/** Open or close the panel, leaving the pin and size preferences untouched. */
export function setAskDockOpen(open: boolean): void {
  const current = read();
  if (current.open === open) return;
  write({ ...current, open });
}

/** Flip the panel open/closed — what the rail's Ask row does. */
export function toggleAskDock(): void {
  const current = read();
  write({ ...current, open: !current.open });
}

/** Flip "stay open". Persisted, so it outlives the panel being closed. */
export function toggleAskDockPinned(): void {
  const current = read();
  write({ ...current, pinned: !current.pinned });
}

/** Flip between the corner dock and the large centered popup. */
export function toggleAskDockMaximized(): void {
  const current = read();
  write({ ...current, maximized: !current.maximized });
}

/** Test/teardown helper: drop the in-memory snapshot so storage is re-read. */
export function resetAskDockCache(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

/** Subscribe to the panel's open state and its persisted modes. */
export function useAskDockState(): AskDockState {
  return useSyncExternalStore(subscribe, read, () => CLOSED);
}
