import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  addWidget,
  clearHomeConfig,
  COUNT_LIMITS,
  DEFAULT_LAYOUT,
  HOME_CONFIG_STORAGE_KEY,
  moveWidget,
  moveWidgetToSlot,
  parseHomeConfig,
  placementSlots,
  readHomeConfig,
  removeWidget,
  setWidgetSettings,
  setWidgetSize,
  WIDGET_SIZE_RULES,
  WIDGET_TYPES,
  writeHomeConfig,
  type HomeConfig,
  type WidgetType,
} from './config';

/**
 * The Home board's storage contract. The persisted key outlives deploys and
 * rollbacks, so the parser has to survive payloads this build did not write:
 * a newer schema version, widget types it has never heard of, hand-edited
 * junk. None of those may throw, and none may destroy what is stored.
 */

function stored(): unknown {
  const raw = localStorage.getItem(HOME_CONFIG_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function types(config: HomeConfig): string[] {
  return config.widgets.map((widget) => widget.type);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseHomeConfig — unreadable payloads fall back to the defaults', () => {
  test.each([
    ['absent', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['not JSON', '{nope'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '42'],
    ['JSON null', 'null'],
    ['no version', '{"widgets":[]}'],
    ['a future version', '{"version":2,"widgets":[{"type":"net-worth"}]}'],
    ['a past version', '{"version":0,"widgets":[{"type":"net-worth"}]}'],
    ['widgets not an array', '{"version":1,"widgets":{}}'],
  ])('%s ⇒ DEFAULT_LAYOUT', (_label, raw) => {
    expect(parseHomeConfig(raw as string | null | undefined)).toEqual(DEFAULT_LAYOUT);
  });

  test('a future version is never reinterpreted under this version’s rules', () => {
    // The widget list is perfectly readable — the version guard still wins,
    // because a v2 `settings` could mean something entirely different.
    const parsed = parseHomeConfig(
      JSON.stringify({ version: 2, widgets: [{ id: 'a', type: 'news', size: 's', settings: {} }] }),
    );
    expect(parsed).toEqual(DEFAULT_LAYOUT);
  });
});

describe('parseHomeConfig — readable payloads keep what this build understands', () => {
  test('drops unknown widget types and keeps the rest, in order', () => {
    const parsed = parseHomeConfig(
      JSON.stringify({
        version: 1,
        widgets: [
          { id: 'a', type: 'net-worth', size: 'l', settings: {} },
          { id: 'b', type: 'crystal-ball', size: 'm', settings: {} },
          { id: 'c', type: 'news', size: 'm', settings: {} },
        ],
      }),
    );
    expect(types(parsed)).toEqual(['net-worth', 'news']);
  });

  test('drops malformed entries without taking the board with them', () => {
    const parsed = parseHomeConfig(
      JSON.stringify({
        version: 1,
        widgets: [null, 'news', 7, [], { type: 'news' }],
      }),
    );
    expect(types(parsed)).toEqual(['news']);
  });

  test('drops duplicate ids, which would collide as React keys', () => {
    const parsed = parseHomeConfig(
      JSON.stringify({
        version: 1,
        widgets: [
          { id: 'same', type: 'news', size: 'm', settings: {} },
          { id: 'same', type: 'allocation', size: 'm', settings: {} },
        ],
      }),
    );
    expect(types(parsed)).toEqual(['news']);
  });

  test('backfills a missing id so the entry is still usable', () => {
    const parsed = parseHomeConfig(
      JSON.stringify({ version: 1, widgets: [{ type: 'news', size: 'm' }] }),
    );
    expect(parsed.widgets[0]?.id).toBe('news-0');
  });

  test('clamps a size the type does not allow to that type’s default', () => {
    // The hero refuses to be a narrow column (allowed: m, l).
    const parsed = parseHomeConfig(
      JSON.stringify({
        version: 1,
        widgets: [
          { id: 'a', type: 'net-worth', size: 's', settings: {} },
          { id: 'b', type: 'news', size: 'xxl', settings: {} },
          { id: 'c', type: 'allocation', size: 42, settings: {} },
        ],
      }),
    );
    expect(parsed.widgets.map((widget) => widget.size)).toEqual([
      WIDGET_SIZE_RULES['net-worth'].default,
      WIDGET_SIZE_RULES.news.default,
      WIDGET_SIZE_RULES.allocation.default,
    ]);
  });

  test('keeps only settings keys this build understands', () => {
    const parsed = parseHomeConfig(
      JSON.stringify({
        version: 1,
        widgets: [
          {
            id: 'a',
            type: 'top-movers',
            size: 'm',
            settings: {
              scope: 'portfolio-1',
              range: '6M',
              metric: 'total',
              sentiment: 'bullish',
              scopeDepth: 9,
            },
          },
        ],
      }),
    );
    expect(parsed.widgets[0]?.settings).toEqual({
      scope: 'portfolio-1',
      range: '6M',
      metric: 'total',
    });
  });

  test('rejects settings values of the wrong type instead of passing them through', () => {
    const parsed = parseHomeConfig(
      JSON.stringify({
        version: 1,
        widgets: [
          {
            id: 'a',
            type: 'top-movers',
            size: 'm',
            settings: { scope: 5, range: '', metric: 'x' },
          },
        ],
      }),
    );
    expect(parsed.widgets[0]?.settings).toEqual({});
  });

  test('a deliberately emptied board stays empty rather than resurrecting the defaults', () => {
    const parsed = parseHomeConfig(JSON.stringify({ version: 1, widgets: [] }));
    expect(parsed).toEqual({ version: 1, widgets: [] });
  });
});

describe('storage', () => {
  test('parsing never writes — a rollback cannot destroy a newer board', () => {
    const future = JSON.stringify({
      version: 1,
      widgets: [{ id: 'a', type: 'from-the-future', size: 'l', settings: {} }],
    });
    localStorage.setItem(HOME_CONFIG_STORAGE_KEY, future);

    const parsed = readHomeConfig();

    expect(parsed.widgets).toEqual([]);
    // Still byte-identical on disk: rolling forward again restores the widget.
    expect(localStorage.getItem(HOME_CONFIG_STORAGE_KEY)).toBe(future);
  });

  test('round-trips a board through storage', () => {
    const board: HomeConfig = {
      version: 1,
      widgets: [{ id: 'a', type: 'allocation', size: 's', settings: { scope: 'p1' } }],
    };
    writeHomeConfig(board);
    expect(stored()).toEqual(board);
    expect(readHomeConfig()).toEqual(board);
  });

  test('clearing returns the next read to the defaults', () => {
    writeHomeConfig({ version: 1, widgets: [] });
    clearHomeConfig();
    expect(readHomeConfig()).toEqual(DEFAULT_LAYOUT);
  });

  test('a storage failure degrades to the defaults instead of blanking the page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled');
    });
    expect(readHomeConfig()).toEqual(DEFAULT_LAYOUT);
  });

  test('a failing write is swallowed — the session keeps its layout', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeHomeConfig(DEFAULT_LAYOUT)).not.toThrow();
  });
});

describe('board edits are pure', () => {
  const board: HomeConfig = {
    version: 1,
    widgets: [
      { id: 'a', type: 'net-worth', size: 'l', settings: { scope: 'all' } },
      { id: 'b', type: 'news', size: 'm', settings: {} },
      { id: 'c', type: 'allocation', size: 'm', settings: {} },
    ],
  };

  test('addWidget appends with the type’s default size and settings', () => {
    const next = addWidget(board, 'top-movers', { scope: 'all', metric: 'day' });
    expect(next.widgets).toHaveLength(4);
    expect(next.widgets[3]).toMatchObject({
      type: 'top-movers',
      size: WIDGET_SIZE_RULES['top-movers'].default,
      settings: { scope: 'all', metric: 'day' },
    });
    expect(board.widgets).toHaveLength(3);
  });

  test('addWidget mints a distinct id every time', () => {
    const once = addWidget(board, 'news', {});
    const twice = addWidget(once, 'news', {});
    const ids = twice.widgets.map((widget) => widget.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('removeWidget drops exactly one widget', () => {
    expect(types(removeWidget(board, 'b'))).toEqual(['net-worth', 'allocation']);
    expect(types(removeWidget(board, 'nope'))).toEqual(types(board));
  });

  test('moveWidget reorders', () => {
    expect(types(moveWidget(board, 0, 2))).toEqual(['news', 'allocation', 'net-worth']);
    expect(types(moveWidget(board, 2, 0))).toEqual(['allocation', 'net-worth', 'news']);
  });

  test.each([
    ['same index', 1, 1],
    ['negative source', -1, 0],
    ['negative target', 0, -1],
    ['source past the end', 9, 0],
    ['target past the end', 0, 9],
  ])('moveWidget ignores an out-of-range move (%s)', (_label, from, to) => {
    expect(moveWidget(board, from, to)).toBe(board);
  });

  test('setWidgetSize clamps to what the type allows', () => {
    expect(setWidgetSize(board, 'a', 'm').widgets[0]?.size).toBe('m');
    // 's' is not allowed for the hero — it falls back to the type default.
    expect(setWidgetSize(board, 'a', 's').widgets[0]?.size).toBe(
      WIDGET_SIZE_RULES['net-worth'].default,
    );
  });

  test('setWidgetSettings merges a patch', () => {
    const next = setWidgetSettings(board, 'a', { scope: 'p1' });
    expect(next.widgets[0]?.settings).toEqual({ scope: 'p1' });
    expect(board.widgets[0]?.settings).toEqual({ scope: 'all' });
  });

  test('setWidgetSettings clears a key set to undefined', () => {
    const next = setWidgetSettings(board, 'a', { scope: undefined });
    expect(next.widgets[0]?.settings).toEqual({});
  });
});

// ─── The expanded catalog ─────────────────────────────────────────────────────

/**
 * The seven types added on top of the original board. These are storage-contract
 * tests like everything above: a type the parser refuses to recognise is a widget
 * that silently vanishes from the user's board on the next page load.
 */
describe('expanded widget catalog', () => {
  const ADDED: readonly WidgetType[] = [
    'net-worth-history',
    'asset-spotlight',
    'recent-transactions',
    'cash-balances',
    'watchlist',
    'dividends',
    'alerts',
  ];

  test.each(ADDED)('%s survives a round-trip through storage', (type) => {
    const board: HomeConfig = {
      version: 1,
      widgets: [{ id: `w-${type}`, type, size: WIDGET_SIZE_RULES[type].default, settings: {} }],
    };
    writeHomeConfig(board);
    expect(readHomeConfig()).toEqual(board);
  });

  test('every declared type is registered in WIDGET_SIZE_RULES', () => {
    // `clampSize` indexes the rules by type — a missing entry would throw on the
    // first parse rather than degrade, so this is the guard for that.
    const missing = WIDGET_TYPES.filter((type) => WIDGET_SIZE_RULES[type] === undefined);
    expect(missing).toEqual([]);
  });

  test('every type’s default size is one of its own allowed sizes', () => {
    const inconsistent = WIDGET_TYPES.filter(
      (type) => !WIDGET_SIZE_RULES[type].allowed.includes(WIDGET_SIZE_RULES[type].default),
    );
    expect(inconsistent).toEqual([]);
  });

  test('clamps a size the new types do not allow', () => {
    const parsed = parseHomeConfig(
      JSON.stringify({
        version: 1,
        widgets: [
          // The summed curve refuses to be a narrow column (allowed: m, l)…
          { id: 'a', type: 'net-worth-history', size: 's', settings: {} },
          // …and the alerts tile refuses to span the full width (allowed: s, m).
          { id: 'b', type: 'alerts', size: 'l', settings: {} },
        ],
      }),
    );
    expect(parsed.widgets.map((widget) => widget.size)).toEqual([
      WIDGET_SIZE_RULES['net-worth-history'].default,
      WIDGET_SIZE_RULES.alerts.default,
    ]);
  });
});

describe('the settings keys the expanded catalog introduced', () => {
  function settingsOf(settings: unknown): unknown {
    return parseHomeConfig(
      JSON.stringify({
        version: 1,
        widgets: [{ id: 'a', type: 'recent-transactions', size: 'm', settings }],
      }),
    ).widgets[0]?.settings;
  }

  test('count, watchlistId, assetId and assetLabel round-trip', () => {
    expect(
      settingsOf({ count: 15, watchlistId: 'wl-1', assetId: 'as-1', assetLabel: 'AAPL' }),
    ).toEqual({ count: 15, watchlistId: 'wl-1', assetId: 'as-1', assetLabel: 'AAPL' });
  });

  test.each([
    ['both bounds inclusive (min)', COUNT_LIMITS.min],
    ['both bounds inclusive (max)', COUNT_LIMITS.max],
    ['a count no picker offers, from a newer build', 25],
  ])('keeps a valid count — %s', (_label, count) => {
    expect(settingsOf({ count })).toEqual({ count });
  });

  test.each([
    ['zero', 0],
    ['negative', -5],
    ['past the ceiling', COUNT_LIMITS.max + 1],
    ['fractional', 7.5],
    ['a numeric string', '10'],
    ['NaN as null', null],
  ])('drops an unusable count (%s) rather than coercing it', (_label, count) => {
    // Dropped, not clamped: the widget then renders its own documented default,
    // which is a state it is built for — unlike a number nobody chose.
    expect(settingsOf({ count })).toEqual({});
  });

  test.each([
    ['empty', ''],
    ['not a string', 42],
  ])('drops an unusable watchlistId / assetId / assetLabel (%s)', (_label, value) => {
    expect(settingsOf({ watchlistId: value, assetId: value, assetLabel: value })).toEqual({});
  });

  test('still drops keys this build has never heard of', () => {
    expect(settingsOf({ count: 5, sentiment: 'bullish', assetIds: ['a', 'b'] })).toEqual({
      count: 5,
    });
  });
});

// ─── Click-to-place ──────────────────────────────────────────────────────────

/**
 * The rules behind the gold insertion lines. Worth testing directly: the
 * off-by-one between "the gap the user clicked" (numbered against the board as
 * shown) and "the index to splice into" (numbered after the widget is lifted out)
 * is exactly the kind of bug that moves a widget one place short and still looks
 * plausible.
 */
describe('placementSlots', () => {
  test('offers every gap except the two that mean "where it already is"', () => {
    // Five widgets ⇒ six gaps (0…5); arming index 2 rules out gaps 2 and 3.
    expect(placementSlots(5, 2)).toEqual([0, 1, 4, 5]);
  });

  test('the first widget cannot be placed before itself or before its successor', () => {
    expect(placementSlots(5, 0)).toEqual([2, 3, 4, 5]);
  });

  test('the last widget’s own gap and the end gap are both ruled out', () => {
    expect(placementSlots(5, 4)).toEqual([0, 1, 2, 3]);
  });

  test.each([2, 3, 5, 9])('a board of %i widgets always offers exactly N−1 slots', (count) => {
    for (let from = 0; from < count; from += 1) {
      expect(placementSlots(count, from)).toHaveLength(count - 1);
    }
  });

  test.each([
    ['a single widget has nowhere else to go', 1, 0],
    ['an empty board', 0, 0],
    ['a negative index', 5, -1],
    ['an index past the end', 5, 5],
  ])('%s ⇒ no slots', (_label, count, from) => {
    expect(placementSlots(count, from)).toEqual([]);
  });
});

describe('moveWidgetToSlot', () => {
  const board: HomeConfig = {
    version: 1,
    widgets: (['net-worth', 'news', 'allocation', 'upcoming'] as const).map((type, index) => ({
      id: `w${index}`,
      type,
      size: WIDGET_SIZE_RULES[type].default,
      settings: {},
    })),
  };

  test('moving forward lands the widget in front of the widget that named the gap', () => {
    // Gap 3 is "before upcoming"; w0 must end up immediately before it.
    expect(types(moveWidgetToSlot(board, 'w0', 3))).toEqual([
      'news',
      'allocation',
      'net-worth',
      'upcoming',
    ]);
  });

  test('moving backward needs no adjustment', () => {
    expect(types(moveWidgetToSlot(board, 'w2', 0))).toEqual([
      'allocation',
      'net-worth',
      'news',
      'upcoming',
    ]);
  });

  test('the end slot appends', () => {
    expect(types(moveWidgetToSlot(board, 'w0', 4))).toEqual([
      'news',
      'allocation',
      'upcoming',
      'net-worth',
    ]);
  });

  test('every offered slot puts the widget exactly where its label promised', () => {
    // The invariant the UI depends on: after moving into the gap before widget X,
    // the moved widget is X's immediate predecessor (or last, for the end gap).
    for (const [from, widget] of board.widgets.entries()) {
      for (const slot of placementSlots(board.widgets.length, from)) {
        const namedBefore = board.widgets[slot]?.id ?? null;
        const next = moveWidgetToSlot(board, widget.id, slot).widgets;
        const landed = next.findIndex((entry) => entry.id === widget.id);
        expect(
          namedBefore === null ? landed : next[landed + 1]?.id,
          `slot ${slot} for ${widget.id} (from ${from})`,
        ).toBe(namedBefore === null ? next.length - 1 : namedBefore);
      }
    }
  });

  test.each([
    ['its own gap', 1],
    ['the gap just after it', 2],
  ])('%s is a no-op and returns the same board', (_label, slot) => {
    expect(moveWidgetToSlot(board, 'w1', slot)).toBe(board);
  });

  test.each([
    ['an unknown id', 'nope', 0],
    ['a negative slot', 'w0', -1],
    ['a slot past the end gap', 'w0', 5],
  ])('%s is a no-op', (_label, id, slot) => {
    expect(moveWidgetToSlot(board, id, slot)).toBe(board);
  });

  test('leaves the original board untouched', () => {
    moveWidgetToSlot(board, 'w0', 4);
    expect(types(board)).toEqual(['net-worth', 'news', 'allocation', 'upcoming']);
  });
});
