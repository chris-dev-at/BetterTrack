import { describe, expect, it } from 'vitest';

import {
  HOME_LAYOUT_MAX_BYTES,
  HOME_LAYOUT_MAX_WIDGETS,
  homeLayoutEnvelopeSchema,
  homeLayoutSchema,
} from './settings';

/**
 * The Home board contract's one non-negotiable rule: it validates SHAPE and
 * SIZE, never the widget vocabulary. The web client that writes a board is
 * routinely a deploy ahead of the API that stores it, so turning `type`, `size`
 * or the `settings` keys into anything closed here would silently delete the
 * widgets a user arranged on their newer device. These tests exist to fail the
 * moment someone tries.
 */

function widget(over: Record<string, unknown> = {}) {
  return { id: 'w-1', type: 'net-worth', size: 'l', settings: {}, ...over };
}

describe('homeLayoutSchema — vocabulary is the client’s, not ours', () => {
  it('accepts a widget type, size and settings keys this build has never heard of', () => {
    const parsed = homeLayoutSchema.parse({
      version: 99,
      widgets: [
        widget({
          type: 'quantum-sentiment-radar',
          size: 'xxl',
          settings: { horizon: 'lunar', depth: 42, live: true, cleared: null, cohorts: ['a'] },
        }),
      ],
    });

    // Verbatim — no coercion, no dropped keys.
    expect(parsed).toEqual({
      version: 99,
      widgets: [
        {
          id: 'w-1',
          type: 'quantum-sentiment-radar',
          size: 'xxl',
          settings: { horizon: 'lunar', depth: 42, live: true, cleared: null, cohorts: ['a'] },
        },
      ],
    });
  });

  it('fixes the widget frame so new attributes have to go in `settings`', () => {
    expect(
      homeLayoutSchema.safeParse({ version: 1, widgets: [widget({ pinned: true })] }).success,
    ).toBe(false);
    expect(
      homeLayoutSchema.safeParse({ version: 1, widgets: [widget()], theme: 'dark' }).success,
    ).toBe(false);
  });

  it('keeps a settings value flat — a nested object needs this contract widened first', () => {
    expect(
      homeLayoutSchema.safeParse({ version: 1, widgets: [widget({ settings: { k: { n: 1 } } })] })
        .success,
    ).toBe(false);
    expect(
      homeLayoutSchema.safeParse({ version: 1, widgets: [widget({ settings: { k: [['x']] } })] })
        .success,
    ).toBe(false);
  });
});

describe('homeLayoutSchema — the abuse boundary', () => {
  const widgets = (count: number, settings: Record<string, unknown> = {}) =>
    Array.from({ length: count }, (_, i) => widget({ id: `w-${i}`, settings }));

  it('rejects rather than truncates past the widget cap', () => {
    expect(
      homeLayoutSchema.safeParse({ version: 1, widgets: widgets(HOME_LAYOUT_MAX_WIDGETS) }).success,
    ).toBe(true);
    expect(
      homeLayoutSchema.safeParse({ version: 1, widgets: widgets(HOME_LAYOUT_MAX_WIDGETS + 1) })
        .success,
    ).toBe(false);
  });

  it('caps the serialised document even when every field is inside its own cap', () => {
    const settings = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`k${i}`, 'v'.repeat(100)]),
    );
    const layout = { version: 1, widgets: widgets(HOME_LAYOUT_MAX_WIDGETS, settings) };

    expect(new TextEncoder().encode(JSON.stringify(layout)).length).toBeGreaterThan(
      HOME_LAYOUT_MAX_BYTES,
    );
    expect(homeLayoutSchema.safeParse(layout).success).toBe(false);
  });
});

describe('homeLayoutEnvelopeSchema — the reader’s view', () => {
  it('passes a layout through unvalidated so a newer board degrades instead of failing', () => {
    // Over this build's widget cap: the strict schema rejects it, the envelope
    // hands it to the SPA's forward-safe board parser.
    const fromTheFuture = { version: 2, widgets: widgetsOverCap() };

    expect(homeLayoutSchema.safeParse(fromTheFuture).success).toBe(false);
    expect(
      homeLayoutEnvelopeSchema.parse({ layout: fromTheFuture, updatedAt: null }).layout,
    ).toEqual(fromTheFuture);
  });

  it('still holds the sync revision to a real datetime', () => {
    expect(homeLayoutEnvelopeSchema.safeParse({ layout: null, updatedAt: 'soon' }).success).toBe(
      false,
    );
    expect(homeLayoutEnvelopeSchema.safeParse({ layout: null, updatedAt: null }).success).toBe(
      true,
    );
  });
});

function widgetsOverCap() {
  return Array.from({ length: HOME_LAYOUT_MAX_WIDGETS + 5 }, (_, i) => widget({ id: `w-${i}` }));
}
