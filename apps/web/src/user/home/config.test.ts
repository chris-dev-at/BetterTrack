import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  addWidget,
  clearHomeConfig,
  DEFAULT_LAYOUT,
  HOME_CONFIG_STORAGE_KEY,
  moveWidget,
  parseHomeConfig,
  readHomeConfig,
  removeWidget,
  setWidgetSettings,
  setWidgetSize,
  WIDGET_SIZE_RULES,
  writeHomeConfig,
  type HomeConfig,
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
