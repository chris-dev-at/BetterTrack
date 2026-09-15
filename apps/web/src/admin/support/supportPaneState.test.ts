import { describe, expect, test } from 'vitest';

import {
  FEEDBACK_SEARCH_MAX_LENGTH,
  FEEDBACK_SHIPPED_VERSION_MAX_LENGTH,
} from '@bettertrack/contracts';

import {
  SUPPORT_KEYS_OFF_ATTR,
  clampFocus,
  deriveFocusIndex,
  isEditableTarget,
  isShortcutFreeTarget,
  readSupportQuery,
  supportFiltersActive,
  supportKeyIntent,
  supportListParams,
} from './supportPaneState';

/**
 * The Support pane's rules (#1406 W3), tested as functions.
 *
 * These are the assertions that stop a helpdesk link from meaning something
 * different tomorrow, and the ones that keep `j` out of a half-written reply.
 */

function q(search: string) {
  return readSupportQuery(new URLSearchParams(search));
}

describe('readSupportQuery', () => {
  test('an empty URL is the default queue: active, category-first, page one', () => {
    expect(q('')).toEqual({
      q: '',
      category: '',
      status: '',
      version: '',
      unread: 'all',
      archived: false,
      sort: 'category',
      page: 1,
      thread: null,
    });
  });

  test('round-trips every filter a link can carry', () => {
    const parsed = q(
      'q=dividend&category=bug&status=triaged&version=5.2.0&unread=unread&archived=true&sort=aging&page=3&thread=abc',
    );
    expect(parsed).toEqual({
      q: 'dividend',
      category: 'bug',
      status: 'triaged',
      version: '5.2.0',
      unread: 'unread',
      archived: true,
      sort: 'aging',
      page: 3,
      thread: 'abc',
    });
  });

  test('a hand-typed value that is not in the contract falls back, never reaches the API', () => {
    const parsed = q('category=elephant&status=lol&sort=sideways&unread=maybe');
    expect(parsed.category).toBe('');
    expect(parsed.status).toBe('');
    expect(parsed.sort).toBe('category');
    expect(parsed.unread).toBe('all');
  });

  test('clamps the free-text filters to the contract bounds', () => {
    // A pasted link must not be able to send a value the API answers with a
    // 400 the operator can neither read nor act on.
    const longQ = 'a'.repeat(400);
    const longVersion = 'v'.repeat(200);
    const parsed = q(`q=${longQ}&version=${longVersion}`);
    expect(parsed.q).toHaveLength(FEEDBACK_SEARCH_MAX_LENGTH);
    expect(parsed.version).toHaveLength(FEEDBACK_SHIPPED_VERSION_MAX_LENGTH);
    // And what survives is a prefix of what was asked for, not a truncation
    // marker or an empty string.
    expect(longQ.startsWith(parsed.q)).toBe(true);
  });

  test('a nonsense page number is page one, not NaN or zero', () => {
    expect(q('page=0').page).toBe(1);
    expect(q('page=-4').page).toBe(1);
    expect(q('page=abc').page).toBe(1);
    expect(q('page=12').page).toBe(12);
  });

  test('archived is only true for the literal "true"', () => {
    // The string "false" is truthy in JavaScript; reading it as `true` would
    // silently show the operator the wrong queue.
    expect(q('archived=false').archived).toBe(false);
    expect(q('archived=1').archived).toBe(false);
    expect(q('archived=true').archived).toBe(true);
  });
});

describe('supportListParams', () => {
  test('omits empty filters entirely rather than sending blanks', () => {
    expect(supportListParams(q(''))).toEqual({
      archived: false,
      sort: 'category',
      page: 1,
      limit: 25,
    });
  });

  test('unread is tri-state: absent, true, and an explicit false', () => {
    expect(supportListParams(q('unread=all'))).not.toHaveProperty('unread');
    expect(supportListParams(q('unread=unread')).unread).toBe(true);
    // The explicit false is a real, narrower filter — not the same request as
    // omitting the key, and it must survive as `false` rather than be dropped.
    expect(supportListParams(q('unread=read')).unread).toBe(false);
  });

  test('carries the narrowing filters through', () => {
    const params = supportListParams(q('q=abc&category=bug&status=shipped&version=5.2.0'));
    expect(params).toMatchObject({
      q: 'abc',
      category: 'bug',
      status: 'shipped',
      version: '5.2.0',
    });
  });
});

describe('supportFiltersActive', () => {
  test('is false for the untouched queue', () => {
    expect(supportFiltersActive(q(''))).toBe(false);
  });

  test('an open thread is not a filter', () => {
    // Otherwise opening a thread would flip the empty state's wording to
    // "nothing matches your filters", which is a different (and untrue) claim.
    expect(supportFiltersActive(q('thread=abc'))).toBe(false);
    expect(supportFiltersActive(q('page=2'))).toBe(false);
  });

  test('each narrowing filter counts on its own', () => {
    for (const search of ['q=x', 'category=bug', 'status=new', 'version=1', 'unread=unread']) {
      expect(supportFiltersActive(q(search))).toBe(true);
    }
  });
});

describe('supportKeyIntent', () => {
  test('j/k and the arrows walk the list', () => {
    expect(supportKeyIntent({ key: 'j' })).toEqual({ kind: 'move', delta: 1 });
    expect(supportKeyIntent({ key: 'ArrowDown' })).toEqual({ kind: 'move', delta: 1 });
    expect(supportKeyIntent({ key: 'k' })).toEqual({ kind: 'move', delta: -1 });
    expect(supportKeyIntent({ key: 'ArrowUp' })).toEqual({ kind: 'move', delta: -1 });
  });

  test('Enter opens and Escape closes', () => {
    expect(supportKeyIntent({ key: 'Enter' })).toEqual({ kind: 'open' });
    expect(supportKeyIntent({ key: 'Escape' })).toEqual({ kind: 'close' });
  });

  test('a modifier always yields — Cmd+K is the palette, Ctrl+J is the browser', () => {
    expect(supportKeyIntent({ key: 'k', metaKey: true })).toEqual({ kind: 'none' });
    expect(supportKeyIntent({ key: 'j', ctrlKey: true })).toEqual({ kind: 'none' });
    expect(supportKeyIntent({ key: 'ArrowDown', altKey: true })).toEqual({ kind: 'none' });
  });

  test('typing in a field is typing, not navigation', () => {
    const target = document.createElement('textarea');
    // Composing "jk" in a reply must not walk the inbox out from under it.
    expect(supportKeyIntent({ key: 'j', target })).toEqual({ kind: 'none' });
    expect(supportKeyIntent({ key: 'k', target })).toEqual({ kind: 'none' });
    expect(supportKeyIntent({ key: 'Enter', target })).toEqual({ kind: 'none' });
  });

  test('Escape inside a field only leaves the field — a draft is not discarded', () => {
    expect(supportKeyIntent({ key: 'Escape', target: document.createElement('input') })).toEqual({
      kind: 'blur',
    });
  });

  test('an unmapped key is inert', () => {
    expect(supportKeyIntent({ key: 'x' })).toEqual({ kind: 'none' });
  });

  // ── K1 (review round 1) ───────────────────────────────────────────────────
  // The handler is bound to `window`. Treating "not a form field" as "safe to
  // claim" meant Enter on **Send reply** was preventDefault()-ed into an inbox
  // navigation: the reply was never sent and the thread swapped underneath it.

  test('a focused button keeps its own Enter', () => {
    const button = document.createElement('button');
    expect(supportKeyIntent({ key: 'Enter', target: button })).toEqual({ kind: 'none' });
    expect(supportKeyIntent({ key: 'j', target: button })).toEqual({ kind: 'none' });
  });

  test('Escape still closes from a button — only the claiming keys are dropped', () => {
    expect(supportKeyIntent({ key: 'Escape', target: document.createElement('button') })).toEqual({
      kind: 'close',
    });
  });

  test('a link and a role=button both keep their keys', () => {
    const link = document.createElement('a');
    link.setAttribute('href', '/somewhere');
    const fake = document.createElement('div');
    fake.setAttribute('role', 'button');
    expect(supportKeyIntent({ key: 'Enter', target: link })).toEqual({ kind: 'none' });
    expect(supportKeyIntent({ key: 'Enter', target: fake })).toEqual({ kind: 'none' });
  });

  test('the queue keys stop at the thread pane boundary', () => {
    const pane = document.createElement('div');
    pane.setAttribute(SUPPORT_KEYS_OFF_ATTR, 'off');
    const inside = document.createElement('p');
    pane.append(inside);

    expect(supportKeyIntent({ key: 'j', target: inside })).toEqual({ kind: 'none' });
    expect(supportKeyIntent({ key: 'Enter', target: inside })).toEqual({ kind: 'none' });
    // Escape is the one key the thread pane still answers — it is how you leave.
    expect(supportKeyIntent({ key: 'Escape', target: inside })).toEqual({ kind: 'close' });
  });

  test('an inbox row is NOT shortcut-free — it is what the keys are for', () => {
    const row = document.createElement('li');
    row.setAttribute('role', 'option');
    expect(isShortcutFreeTarget(row)).toBe(false);
    expect(supportKeyIntent({ key: 'Enter', target: row })).toEqual({ kind: 'open' });
  });
});

describe('isEditableTarget', () => {
  test('recognises the three form controls and contenteditable', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isEditableTarget(editable)).toBe(true);
  });

  test('a plain element and a null target are not editable', () => {
    expect(isEditableTarget(document.createElement('li'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('clampFocus', () => {
  test('clamps at both ends rather than wrapping', () => {
    // Wrapping at the bottom of a triage queue reads as "the list reset".
    expect(clampFocus(5, 3)).toBe(2);
    expect(clampFocus(-1, 3)).toBe(0);
    expect(clampFocus(1, 3)).toBe(1);
  });

  test('an empty list has no focus at all', () => {
    expect(clampFocus(0, 0)).toBe(-1);
  });
});

describe('deriveFocusIndex', () => {
  const ids = ['a', 'b', 'c'];

  test('the open thread takes the highlight when it is on the page', () => {
    expect(deriveFocusIndex(ids, 'c', 0)).toBe(2);
  });

  test('holds the previous position when nothing is open', () => {
    // Replying to a row must not move the highlight off it.
    expect(deriveFocusIndex(ids, null, 1)).toBe(1);
  });

  test('holds position when the open thread is NOT on this page', () => {
    // A thread opened from a link the filters exclude still renders; the inbox
    // just has nothing to highlight for it.
    expect(deriveFocusIndex(ids, 'zzz', 1)).toBe(1);
  });

  test('a position the shortened list cannot hold clamps to the nearest row', () => {
    // Not row 0: after a filter shrinks the queue the operator was near the
    // bottom, and the top is the one place they demonstrably were not.
    expect(deriveFocusIndex(ids, null, 9)).toBe(2);
  });

  test('a negative previous position lands on the first row', () => {
    expect(deriveFocusIndex(ids, null, -1)).toBe(0);
  });

  test('an empty list yields no focus', () => {
    expect(deriveFocusIndex([], 'a', 2)).toBe(-1);
  });
});
