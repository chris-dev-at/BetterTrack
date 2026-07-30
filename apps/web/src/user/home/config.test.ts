import { describe, expect, test } from 'vitest';

import {
  addWidget,
  COUNT_LIMITS,
  DEFAULT_LAYOUT,
  clampVariant,
  moveWidget,
  moveWidgetToSlot,
  parseHomeConfig,
  placementSlots,
  SCOPE_IDS_MAX,
  SCOPE_SELECTED,
  removeWidget,
  setWidgetSettings,
  setWidgetSize,
  WIDGET_SIZE_RULES,
  WIDGET_TYPES,
  WIDGET_VARIANT_RULES,
  widgetVariant,
  type HomeConfig,
  type WidgetType,
} from './config';

/**
 * The Home board's parsing contract. A stored board outlives deploys and
 * rollbacks and now travels between devices on different builds, so the parser
 * has to survive payloads this build did not write: a newer schema version,
 * widget types it has never heard of, hand-edited junk. None of those may
 * throw, and none may destroy what is stored — where the board is *kept* is
 * `homeSync.test.ts`.
 */

/** A board as it sits in storage or comes back from the API — a raw document. */
function payload(config: HomeConfig): string {
  return JSON.stringify(config);
}

function types(config: HomeConfig): string[] {
  return config.widgets.map((widget) => widget.type);
}

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

describe('round trips', () => {
  test('parsing never mutates its input — a rollback cannot destroy a newer board', () => {
    const future = {
      version: 1,
      widgets: [{ id: 'a', type: 'from-the-future', size: 'l', settings: { warp: 9 } }],
    };
    const document = JSON.stringify(future);

    const parsed = parseHomeConfig(document);

    expect(parsed.widgets).toEqual([]);
    // The document is untouched: whoever holds it — this device's cache, the
    // account copy on the server — still has the widget when the build rolls
    // forward again.
    expect(JSON.parse(document)).toEqual(future);
  });

  test('a board survives serialise → parse unchanged', () => {
    const board: HomeConfig = {
      version: 1,
      widgets: [{ id: 'a', type: 'allocation', size: 's', settings: { scope: 'p1' } }],
    };
    expect(parseHomeConfig(payload(board))).toEqual(board);
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

  test.each(ADDED)('%s survives a serialise → parse round-trip', (type) => {
    const board: HomeConfig = {
      version: 1,
      widgets: [{ id: `w-${type}`, type, size: WIDGET_SIZE_RULES[type].default, settings: {} }],
    };
    expect(parseHomeConfig(payload(board))).toEqual(board);
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

// ─── Display variants ────────────────────────────────────────────────────────

/**
 * A `variant` is the one settings key that **clamps** instead of dropping. The
 * reason is the rollback case: a board written by a build that had a third form
 * must still render as something, and "the type's default form" is the only
 * honest answer. Dropping would be equivalent here, but clamping keeps the
 * invariant that a variant-capable widget always has a resolvable form.
 */
describe('clampVariant', () => {
  test('keeps a form the type actually offers', () => {
    expect(clampVariant('cashflow-chart', 'columns')).toBe('columns');
    expect(clampVariant('allocation', 'bars')).toBe('bars');
  });

  test.each([
    ['a form from a newer build', 'sunburst'],
    ['another type’s form', 'donut'],
    ['not a string', 7],
    ['empty', ''],
  ])('falls back to the type’s default — %s', (_label, value) => {
    expect(clampVariant('cashflow-chart', value)).toBe(
      WIDGET_VARIANT_RULES['cashflow-chart']!.default,
    );
  });

  test('a type with no forms has none to clamp to', () => {
    // `attention` is a plain list — offering it a "display" would be a lie.
    expect(clampVariant('attention', 'bars')).toBeUndefined();
  });

  test('the performance chart offers value and return, defaulting to value', () => {
    expect(clampVariant('performance-chart', 'return')).toBe('return');
    expect(clampVariant('performance-chart', 'value')).toBe('value');
    // Value is the default deliberately: it is the one form that is honest at
    // every scope, so a board that has never touched the picker cannot be
    // showing a percentage that means something other than it appears to.
    expect(WIDGET_VARIANT_RULES['performance-chart']!.default).toBe('value');
  });

  test.each([
    ['a form from a newer build', 'twrr'],
    ['another type’s form', 'donut'],
    ['not a string', 7],
  ])('an unknown performance-chart form clamps to value — %s', (_label, value) => {
    expect(clampVariant('performance-chart', value)).toBe('value');
  });

  test('every declared default is one of that type’s own allowed forms', () => {
    const inconsistent = Object.entries(WIDGET_VARIANT_RULES).filter(
      ([, rules]) => rules !== undefined && !rules.allowed.includes(rules.default),
    );
    expect(inconsistent).toEqual([]);
  });

  test('no type declares a single form, which would be a picker with one option', () => {
    const pointless = Object.entries(WIDGET_VARIANT_RULES).filter(
      ([, rules]) => (rules?.allowed.length ?? 0) < 2,
    );
    expect(pointless).toEqual([]);
  });
});

describe('widgetVariant', () => {
  test('prefers the stored form over the default', () => {
    expect(widgetVariant('allocation', { variant: 'bars' })).toBe('bars');
  });

  test('falls back to the type’s default when unset', () => {
    expect(widgetVariant('allocation', {})).toBe('donut');
  });

  test('is undefined for a type with no forms', () => {
    expect(widgetVariant('attention', {})).toBeUndefined();
  });
});

describe('variant parsing', () => {
  function variantOf(type: WidgetType, settings: unknown): string | undefined {
    return parseHomeConfig(
      JSON.stringify({ version: 1, widgets: [{ id: 'a', type, size: 'm', settings }] }),
    ).widgets[0]?.settings.variant;
  }

  test('round-trips a known form', () => {
    expect(variantOf('cashflow-chart', { variant: 'columns' })).toBe('columns');
  });

  test('an unknown form is stored back as the type’s default', () => {
    expect(variantOf('cashflow-chart', { variant: 'treemap' })).toBe('net');
  });

  test('absent stays absent — the widget resolves its own default', () => {
    expect(variantOf('cashflow-chart', {})).toBeUndefined();
  });

  test('a form stored against a type that has none is dropped', () => {
    expect(variantOf('attention', { variant: 'bars' })).toBeUndefined();
  });

  test('an unknown performance-chart form is clamped, not dropped', () => {
    // Clamped rather than dropped so the widget always has a resolvable form —
    // and clamped to `value`, never to a percentage the payload never asked for.
    expect(variantOf('performance-chart', { variant: 'twrr' })).toBe('value');
    expect(variantOf('performance-chart', { variant: 'return' })).toBe('return');
  });

  test('clamping a variant on read leaves the stored document alone', () => {
    const raw = JSON.stringify({
      version: 1,
      widgets: [{ id: 'a', type: 'allocation', size: 'm', settings: { variant: 'sunburst' } }],
    });

    expect(parseHomeConfig(raw).widgets[0]?.settings.variant).toBe('donut');
    // The unknown variant survives in the document, so a build that ships
    // `sunburst` renders it again.
    expect(JSON.parse(raw).widgets[0].settings.variant).toBe('sunburst');
  });
});

// ─── Adding at a position ────────────────────────────────────────────────────

/**
 * The ⊕ on an insertion line hands its slot straight to `addWidget`, in the same
 * numbering the placement lines use. Anything unusable degrades to appending,
 * which is what the header's own Add button relies on.
 */
describe('addWidget at a slot', () => {
  const board: HomeConfig = {
    version: 1,
    widgets: (['net-worth', 'news', 'allocation'] as const).map((type, index) => ({
      id: `w${index}`,
      type,
      size: WIDGET_SIZE_RULES[type].default,
      settings: {},
    })),
  };

  test('appends when no slot is given', () => {
    expect(types(addWidget(board, 'alerts', {}))).toEqual([
      'net-worth',
      'news',
      'allocation',
      'alerts',
    ]);
  });

  test.each([
    ['the very start', 0, ['alerts', 'net-worth', 'news', 'allocation']],
    ['the middle', 1, ['net-worth', 'alerts', 'news', 'allocation']],
    ['before the last', 2, ['net-worth', 'news', 'alerts', 'allocation']],
    ['the end slot', 3, ['net-worth', 'news', 'allocation', 'alerts']],
  ])('inserts at %s', (_label, at, expected) => {
    expect(types(addWidget(board, 'alerts', {}, at))).toEqual(expected);
  });

  test.each([
    ['negative', -1],
    ['past the end slot', 9],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ])('an unusable slot (%s) appends rather than throwing away the widget', (_label, at) => {
    expect(types(addWidget(board, 'alerts', {}, at)).at(-1)).toBe('alerts');
    expect(addWidget(board, 'alerts', {}, at).widgets).toHaveLength(4);
  });

  test('carries the type’s default settings in and leaves the board alone', () => {
    const next = addWidget(board, 'liquidity', { scope: 'all', variant: 'bar' }, 0);
    expect(next.widgets[0]).toMatchObject({
      type: 'liquidity',
      size: WIDGET_SIZE_RULES.liquidity.default,
      settings: { scope: 'all', variant: 'bar' },
    });
    expect(board.widgets).toHaveLength(3);
  });
});

// ─── Multi-portfolio scope ───────────────────────────────────────────────────

/**
 * `scopeIds` is a *set of ids*, so parsing has to clean it without pretending to
 * know which ids are still alive — that is resolution's job (see homeData.test.ts).
 * What matters here is that the stored shape can never hand a widget something it
 * would misread: a non-array, a list of junk, duplicates, or an unbounded list.
 */
describe('scopeIds parsing', () => {
  function scopeOf(settings: unknown) {
    return parseHomeConfig(
      JSON.stringify({
        version: 1,
        widgets: [{ id: 'a', type: 'net-worth', size: 'l', settings }],
      }),
    ).widgets[0]?.settings;
  }

  test('round-trips a chosen set alongside its mode', () => {
    expect(scopeOf({ scope: SCOPE_SELECTED, scopeIds: ['p1', 'p2', 'p3'] })).toEqual({
      scope: SCOPE_SELECTED,
      scopeIds: ['p1', 'p2', 'p3'],
    });
  });

  test('de-duplicates, since a set counted twice would double a portfolio', () => {
    expect(scopeOf({ scope: SCOPE_SELECTED, scopeIds: ['p1', 'p2', 'p1'] })?.scopeIds).toEqual([
      'p1',
      'p2',
    ]);
  });

  test('drops non-string and empty entries but keeps the usable ones', () => {
    expect(
      scopeOf({ scope: SCOPE_SELECTED, scopeIds: ['p1', '', 7, null, { id: 'p9' }, 'p2'] })
        ?.scopeIds,
    ).toEqual(['p1', 'p2']);
  });

  test.each([
    ['not an array', 'p1'],
    ['an object', { 0: 'p1' }],
    ['null', null],
    ['only junk', [1, 2, '']],
  ])('an unusable list (%s) drops the key entirely', (_label, scopeIds) => {
    expect(scopeOf({ scope: SCOPE_SELECTED, scopeIds })?.scopeIds).toBeUndefined();
  });

  test('an empty list is dropped rather than stored — it would resolve as "all" anyway', () => {
    expect(scopeOf({ scope: SCOPE_SELECTED, scopeIds: [] })?.scopeIds).toBeUndefined();
  });

  test(`caps the list at ${SCOPE_IDS_MAX}, so a corrupt payload cannot fan out`, () => {
    const many = Array.from({ length: SCOPE_IDS_MAX + 15 }, (_, i) => `p${i}`);
    const parsed = scopeOf({ scope: SCOPE_SELECTED, scopeIds: many })?.scopeIds;
    expect(parsed).toHaveLength(SCOPE_IDS_MAX);
    // Kept from the front, so the cap truncates rather than reshuffles.
    expect(parsed?.[0]).toBe('p0');
    expect(parsed?.at(-1)).toBe(`p${SCOPE_IDS_MAX - 1}`);
  });

  test('a set stored without the "selected" mode still parses — resolution ignores it', () => {
    // Forward-safety: a build that only ever writes the pair must not choke on a
    // payload where the two drifted apart.
    expect(scopeOf({ scope: 'all', scopeIds: ['p1'] })).toEqual({
      scope: 'all',
      scopeIds: ['p1'],
    });
  });

  test('a payload from the build before this one keeps its exact meaning', () => {
    expect(scopeOf({ scope: 'p-main' })).toEqual({ scope: 'p-main' });
    expect(scopeOf({ scope: 'all' })).toEqual({ scope: 'all' });
  });

  test('cleaning a set on read leaves the stored document alone', () => {
    const raw = JSON.stringify({
      version: 1,
      widgets: [
        {
          id: 'a',
          type: 'net-worth',
          size: 'l',
          settings: { scope: SCOPE_SELECTED, scopeIds: ['p1', 'p1', 'p2'] },
        },
      ],
    });

    expect(parseHomeConfig(raw).widgets[0]?.settings.scopeIds).toEqual(['p1', 'p2']);
    // The duplicate survives in the document: cleaning happens on read, not in
    // what is stored.
    expect(JSON.parse(raw).widgets[0].settings.scopeIds).toEqual(['p1', 'p1', 'p2']);
  });

  test('setWidgetSettings can clear a set by patching it undefined', () => {
    const board: HomeConfig = {
      version: 1,
      widgets: [
        {
          id: 'a',
          type: 'net-worth',
          size: 'l',
          settings: { scope: SCOPE_SELECTED, scopeIds: ['p1'] },
        },
      ],
    };
    const next = setWidgetSettings(board, 'a', { scope: 'all', scopeIds: undefined });
    expect(next.widgets[0]?.settings).toEqual({ scope: 'all' });
  });
});
