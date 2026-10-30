import { describe, expect, test } from 'vitest';

import { pointerToLocal, renderScale } from './pointerToLocal';

/**
 * The geometry root `zoom: s` produces, as measured in Chromium 153 for this
 * helper: `getBoundingClientRect()` (like `clientX`) is the layout box times
 * `s`, while `offsetWidth`/`offsetHeight` stay the layout size.
 */
function scaledBox(
  s: number,
  layout = { left: 100, top: 50, width: 400, height: 200 },
  offset = { width: layout.width, height: layout.height },
) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: offset.width });
  Object.defineProperty(el, 'offsetHeight', { value: offset.height });
  const rect = {
    left: layout.left * s,
    top: layout.top * s,
    width: layout.width * s,
    height: layout.height * s,
  };
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      x: rect.left,
      y: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON: () => rect,
    }) as DOMRect;
  return el;
}

/** Where a layout-space point inside the box is drawn — and so where the cursor is. */
function clientAt(s: number, x: number, y: number, origin = { left: 100, top: 50 }) {
  return { clientX: (origin.left + x) * s, clientY: (origin.top + y) * s };
}

describe('pointerToLocal — HTML elements', () => {
  test.each([0.8, 1, 1.25, 1.5])('at scale %s the pointer maps back to layout px', (s) => {
    const el = scaledBox(s);
    for (const [x, y] of [
      [0, 0],
      [100, 40],
      [399, 199],
      [250.5, 120.25],
    ] as const) {
      const local = pointerToLocal(clientAt(s, x, y), el);
      expect(local.x).toBeCloseTo(x, 9);
      expect(local.y).toBeCloseTo(y, 9);
    }
  });

  test('the naive subtraction it replaces is off by exactly the scale', () => {
    // The bug, stated as numbers: at 125 % a cursor 300 layout px in reads 375.
    const el = scaledBox(1.25);
    const pointer = clientAt(1.25, 300, 0);
    expect(pointer.clientX - el.getBoundingClientRect().left).toBe(375);
    expect(pointerToLocal(pointer, el).x).toBe(300);
  });

  test('at scale 1 it is exactly the plain subtraction, fractional boxes included', () => {
    // offsetWidth is whole px; a 400.4 px box reports 400 — that is rounding,
    // not a scale, and must not nudge an unscaled page by a hair.
    const el = scaledBox(
      1,
      { left: 10.3, top: 7.7, width: 400.4, height: 199.6 },
      { width: 400, height: 200 },
    );
    const pointer = { clientX: 333.3, clientY: 99.9 };
    expect(pointerToLocal(pointer, el)).toEqual({ x: 333.3 - 10.3, y: 99.9 - 7.7 });
    expect(renderScale(el)).toEqual({ x: 1, y: 1 });
  });

  test('measures each axis on its own (a non-uniform transform)', () => {
    const el = scaledBox(1);
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 600, height: 100, right: 600, bottom: 100 }) as DOMRect;
    expect(renderScale(el)).toEqual({ x: 1.5, y: 0.5 });
    expect(pointerToLocal({ clientX: 300, clientY: 50 }, el)).toEqual({ x: 200, y: 100 });
  });

  test('an unlaid-out element (zero size) falls back to the plain offset', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () =>
      ({ left: 20, top: 10, width: 0, height: 0, right: 20, bottom: 10 }) as DOMRect;
    expect(pointerToLocal({ clientX: 25, clientY: 12 }, el)).toEqual({ x: 5, y: 2 });
  });
});

describe('pointerToLocal — SVG through the inverse screen CTM', () => {
  /**
   * An `<svg width=400 height=200 viewBox="0 0 800 400">` at (100, 50): its
   * CTM is viewBox → screen, so it carries the viewBox ratio (0.5) times the
   * zoom — Chromium 153 reported a = d = 0.625, e = 125 at zoom 1.25.
   */
  function scaledSvg(s: number, ctm?: Partial<DOMMatrix>) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const matrix = { a: 0.5 * s, b: 0, c: 0, d: 0.5 * s, e: 100 * s, f: 50 * s, ...ctm };
    (svg as unknown as { getScreenCTM: () => unknown }).getScreenCTM = () => matrix;
    return svg;
  }

  test.each([0.8, 1, 1.25, 1.5])('at scale %s the pointer maps to viewBox units', (s) => {
    const svg = scaledSvg(s);
    for (const [ux, uy] of [
      [0, 0],
      [400, 200],
      [799, 399],
      [123.5, 77.25],
    ] as const) {
      // A user-space point is drawn at e + a·x — that is where the cursor is.
      const pointer = { clientX: 100 * s + 0.5 * s * ux, clientY: 50 * s + 0.5 * s * uy };
      const local = pointerToLocal(pointer, svg);
      expect(local.x).toBeCloseTo(ux, 9);
      expect(local.y).toBeCloseTo(uy, 9);
    }
  });

  test('inverts a rotated/skewed CTM, not just a scale', () => {
    // 90° rotation then translate: x' = −y + 10, y' = x + 20.
    const svg = scaledSvg(1, { a: 0, b: 1, c: -1, d: 0, e: 10, f: 20 });
    const local = pointerToLocal({ clientX: 10 - 7, clientY: 20 + 3 }, svg);
    expect(local.x).toBeCloseTo(3, 12);
    expect(local.y).toBeCloseTo(7, 12);
  });

  test('without a CTM (not rendered) it falls back to the plain offset', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    (svg as unknown as { getScreenCTM: () => null }).getScreenCTM = () => null;
    svg.getBoundingClientRect = () =>
      ({ left: 5, top: 6, width: 10, height: 10, right: 15, bottom: 16 }) as DOMRect;
    expect(pointerToLocal({ clientX: 8, clientY: 9 }, svg)).toEqual({ x: 3, y: 3 });
  });
});
