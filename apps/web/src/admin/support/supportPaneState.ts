import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_SEARCH_MAX_LENGTH,
  FEEDBACK_SHIPPED_VERSION_MAX_LENGTH,
  FEEDBACK_SORTS,
  FEEDBACK_STATUSES,
  type AdminFeedbackListQuery,
  type FeedbackCategory,
  type FeedbackSort,
  type FeedbackStatus,
} from '@bettertrack/contracts';

/**
 * The Support workspace's pane state machine (#1406 W3).
 *
 * Everything an operator can see is derived from the URL — the filters, the
 * page, and which thread is open — so a helpdesk view is a link you can paste
 * into a note and reopen a week later. That makes this module the one place
 * that decides what a URL means, which is why it is plain TypeScript with no
 * React in it: the rules are testable as functions rather than through a
 * rendered pane.
 *
 * The keyboard half lives here for the same reason. "j moves down" is a rule
 * about a list and a focus index, not about a DOM node.
 */

/** A filter's "no filter" sentinel — the empty string a `<select>` gives us. */
export const ANY = '';

/**
 * Unread is tri-state on the wire (absent / true / false) because "don't filter
 * on unread" and "only threads I have already read" are different questions.
 * The UI spells the three out rather than using a checkbox, which can only ever
 * express two of them.
 */
export const SUPPORT_UNREAD_FILTERS = ['all', 'unread', 'read'] as const;
export type SupportUnreadFilter = (typeof SUPPORT_UNREAD_FILTERS)[number];

/** Rows per inbox page. Small: the pane is a column, not a table. */
export const SUPPORT_PAGE_SIZE = 25;

export interface SupportQuery {
  q: string;
  category: FeedbackCategory | typeof ANY;
  status: FeedbackStatus | typeof ANY;
  version: string;
  unread: SupportUnreadFilter;
  archived: boolean;
  sort: FeedbackSort;
  page: number;
  /** The opened thread, or null for "inbox only". */
  thread: string | null;
}

function isCategory(value: string | null): value is FeedbackCategory {
  return value !== null && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

function isStatus(value: string | null): value is FeedbackStatus {
  return value !== null && (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

function isSort(value: string | null): value is FeedbackSort {
  return value !== null && (FEEDBACK_SORTS as readonly string[]).includes(value);
}

function isUnread(value: string | null): value is SupportUnreadFilter {
  return value !== null && (SUPPORT_UNREAD_FILTERS as readonly string[]).includes(value);
}

/**
 * Read the URL into a query. Every value is validated against the contract's
 * own enum on the way out, so a hand-typed `?status=lol` falls back to "no
 * filter" instead of reaching the API and being answered with a 400 the
 * operator cannot act on.
 */
export function readSupportQuery(params: URLSearchParams): SupportQuery {
  const rawPage = Number.parseInt(params.get('page') ?? '', 10);
  const sortParam = params.get('sort');
  const categoryParam = params.get('category');
  const statusParam = params.get('status');
  const unreadParam = params.get('unread');
  return {
    // Clamped to the contract's own bounds, not merely validated for shape: a
    // pasted link carrying 500 characters of search text would otherwise reach
    // the API and come back 400 — an error the operator can neither read nor
    // act on, from a URL they did not type.
    q: (params.get('q') ?? '').slice(0, FEEDBACK_SEARCH_MAX_LENGTH),
    category: isCategory(categoryParam) ? categoryParam : ANY,
    status: isStatus(statusParam) ? statusParam : ANY,
    version: (params.get('version') ?? '').slice(0, FEEDBACK_SHIPPED_VERSION_MAX_LENGTH),
    unread: isUnread(unreadParam) ? unreadParam : 'all',
    archived: params.get('archived') === 'true',
    sort: isSort(sortParam) ? sortParam : 'category',
    page: Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1,
    thread: params.get('thread'),
  };
}

/** The wire shape for `GET /admin/feedback`, with empty filters omitted. */
export function supportListParams(query: SupportQuery): Partial<AdminFeedbackListQuery> {
  return {
    ...(query.category ? { category: query.category } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.version ? { version: query.version } : {}),
    ...(query.q ? { q: query.q } : {}),
    // 'all' must send nothing at all: `unread=false` is a real, narrower filter.
    ...(query.unread === 'all' ? {} : { unread: query.unread === 'unread' }),
    archived: query.archived,
    sort: query.sort,
    page: query.page,
    limit: SUPPORT_PAGE_SIZE,
  };
}

/**
 * Whether the operator has narrowed the queue. Drives the "reset" control and
 * the choice between "nothing matches your filters" and "the inbox is empty" —
 * two different facts that must not share one sentence.
 *
 * `archived` counts: the archive is a different queue, not a narrower view of
 * this one, and an operator staring at an empty archive should be told which
 * one they are looking at.
 */
export function supportFiltersActive(query: SupportQuery): boolean {
  return Boolean(
    query.q || query.category || query.status || query.version || query.unread !== 'all',
  );
}

// ── Keyboard ────────────────────────────────────────────────────────────────

/**
 * What a keystroke means to the pane. Deliberately an intent rather than a
 * handler: the page decides how to carry it out, and a test can assert the
 * meaning without a DOM.
 */
export type SupportKeyIntent =
  | { kind: 'move'; delta: number }
  | { kind: 'open' }
  | { kind: 'close' }
  /** Leave a text field without touching the selection. */
  | { kind: 'blur' }
  | { kind: 'none' };

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Marks a subtree the inbox shortcuts must keep their hands off. The thread
 * pane carries it: `j`, `k` and `Enter` are about the QUEUE, and the queue is
 * not what the operator is working in once a conversation is open.
 */
export const SUPPORT_KEYS_OFF_ATTR = 'data-support-keys';
const KEYS_OFF_SELECTOR = `[${SUPPORT_KEYS_OFF_ATTR}='off']`;

/**
 * Controls that already own their keys. A focused `<button>` must get its own
 * Enter — the browser's activation behaviour — and a link must get its own.
 * Roles are included because an element can be a button without being one.
 */
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
].join(',');

/** Narrow an EventTarget to something we can run `closest` on. */
function asElement(target: EventTarget | null): { closest(selector: string): unknown } | null {
  if (target === null || typeof target !== 'object') return null;
  const candidate = target as { closest?: unknown };
  return typeof candidate.closest === 'function'
    ? (candidate as { closest(selector: string): unknown })
    : null;
}

function matches(target: EventTarget | null, selector: string): boolean {
  const element = asElement(target);
  if (element === null) return false;
  try {
    return element.closest(selector) !== null;
  } catch {
    // A malformed selector must never take the whole handler down.
    return false;
  }
}

/**
 * True when the keystroke landed in something the operator is typing into.
 * Without this, composing the word "jk" in a reply would walk the inbox and
 * silently swap the thread out from under the composer.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || !(typeof target === 'object') || !('tagName' in target)) return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  return typeof element.tagName === 'string' && EDITABLE_TAGS.has(element.tagName);
}

/**
 * True when the keystroke landed on a control that already has a meaning for
 * this key, or anywhere inside a keys-off subtree.
 *
 * This is the fix for the bug that shipped in review round 0: the handler is
 * bound to `window`, and treating "not a form field" as "safe to claim" meant
 * `Enter` on **Send reply** was `preventDefault()`-ed into an inbox navigation —
 * the reply was never sent, and the thread swapped underneath it.
 */
export function isShortcutFreeTarget(target: EventTarget | null): boolean {
  return matches(target, INTERACTIVE_SELECTOR) || matches(target, KEYS_OFF_SELECTOR);
}

export interface SupportKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}

/**
 * Map a keystroke to a pane intent.
 *
 * A modifier always wins: `Cmd+K` is the command palette and `Ctrl+J` belongs
 * to the browser, so the inbox claims neither. Inside a text field only Escape
 * is honoured, and it means "let me out of this box" rather than "close the
 * thread", so one press does not jump the operator out of what they are writing.
 *
 * On any other interactive control — and anywhere inside the thread pane —
 * Escape still closes, but nothing else is claimed. The queue shortcuts are for
 * the queue; a focused button's Enter belongs to that button.
 */
export function supportKeyIntent(event: SupportKeyEvent): SupportKeyIntent {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) {
    return { kind: 'none' };
  }
  const target = event.target ?? null;
  if (isEditableTarget(target)) {
    return event.key === 'Escape' ? { kind: 'blur' } : { kind: 'none' };
  }
  if (isShortcutFreeTarget(target)) {
    return event.key === 'Escape' ? { kind: 'close' } : { kind: 'none' };
  }
  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      return { kind: 'move', delta: 1 };
    case 'k':
    case 'ArrowUp':
      return { kind: 'move', delta: -1 };
    case 'Enter':
      return { kind: 'open' };
    case 'Escape':
      return { kind: 'close' };
    default:
      return { kind: 'none' };
  }
}

/**
 * Clamp rather than wrap. Wrapping means holding `j` at the bottom of the inbox
 * silently teleports the operator to the top, which in a triage queue reads as
 * "the list reset" — mail clients clamp for the same reason.
 */
export function clampFocus(index: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

/**
 * Where the highlight belongs after the list changes underneath it.
 *
 * The opened thread wins when it is on the page, so paging back to a thread you
 * are reading re-highlights it rather than jumping to the top. Otherwise the
 * previous position is held — replying to a row must not move the highlight —
 * and a position the new list is too short for clamps to the nearest row rather
 * than resetting to the first: after a filter shrinks the queue, the operator
 * was near the bottom, and the top is the one place they were not.
 */
export function deriveFocusIndex(
  ids: readonly string[],
  selectedId: string | null,
  previousIndex: number,
): number {
  if (ids.length === 0) return -1;
  if (selectedId !== null) {
    const selected = ids.indexOf(selectedId);
    if (selected >= 0) return selected;
  }
  return clampFocus(previousIndex, ids.length);
}
