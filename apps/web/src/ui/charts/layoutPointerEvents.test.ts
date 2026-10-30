import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { layoutPointerEvents } from './layoutPointerEvents';

/**
 * A canvas laid out at `layout` (unscaled px) on a page under root `zoom: s`:
 * rendered rect = layout × s, offsetWidth/Height = layout (Chromium 153).
 */
function canvasAt(
  parent: HTMLElement,
  layout: { left: number; top: number; width: number; height: number },
  scale: () => number,
) {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'offsetWidth', { value: layout.width });
  Object.defineProperty(canvas, 'offsetHeight', { value: layout.height });
  canvas.getBoundingClientRect = () => {
    const s = scale();
    const r = {
      left: layout.left * s,
      top: layout.top * s,
      width: layout.width * s,
      height: layout.height * s,
    };
    return {
      ...r,
      x: r.left,
      y: r.top,
      right: r.left + r.width,
      bottom: r.top + r.height,
    } as DOMRect;
  };
  parent.appendChild(canvas);
  return canvas;
}

/** lightweight-charts' own reading of an event against its target (5.2.1). */
function libraryLocal(point: { clientX: number; clientY: number }, target: HTMLElement) {
  const box = target.getBoundingClientRect();
  return { x: point.clientX - box.left, y: point.clientY - box.top };
}

let scale = 1;
let release: Array<() => void> = [];
afterEach(() => {
  for (const r of release) r();
  release = [];
  document.body.innerHTML = '';
  scale = 1;
});

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  // The pane, and the price axis to its right.
  const pane = canvasAt(container, { left: 40, top: 100, width: 600, height: 300 }, () => scale);
  const axis = canvasAt(container, { left: 640, top: 100, width: 60, height: 300 }, () => scale);
  release.push(layoutPointerEvents(container));
  return { container, pane, axis };
}

/** The rendered position of a layout point inside `layout`-placed element. */
function at(left: number, top: number, x: number, y: number) {
  return { clientX: (left + x) * scale, clientY: (top + y) * scale };
}

describe('layoutPointerEvents — hover', () => {
  test.each([1.1, 1.25, 1.4])('at %s× the library reads layout px off its canvas', (s) => {
    scale = s;
    const { pane } = setup();
    const seen: Array<{ x: number; y: number }> = [];
    pane.addEventListener('mousemove', (e) => seen.push(libraryLocal(e, pane)));
    pane.addEventListener('mouseenter', (e) => seen.push(libraryLocal(e, pane)));

    pane.dispatchEvent(new MouseEvent('mouseenter', at(40, 100, 10, 20)));
    pane.dispatchEvent(new MouseEvent('mousemove', { ...at(40, 100, 450, 150), bubbles: true }));

    expect(seen[0]!.x).toBeCloseTo(10, 9);
    expect(seen[0]!.y).toBeCloseTo(20, 9);
    expect(seen[1]!.x).toBeCloseTo(450, 9);
    expect(seen[1]!.y).toBeCloseTo(150, 9);
  });

  test('without it the library reads the scaled distance — the owner’s bug', () => {
    scale = 1.25;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const pane = canvasAt(container, { left: 40, top: 100, width: 600, height: 300 }, () => scale);
    let x = NaN;
    pane.addEventListener('mousemove', (e) => (x = libraryLocal(e, pane).x));
    pane.dispatchEvent(new MouseEvent('mousemove', at(40, 100, 450, 150)));
    expect(x).toBe(562.5);
  });

  test('at scale 1 the event is left exactly as the browser made it', () => {
    const { pane } = setup();
    const event = new MouseEvent('mousemove', { clientX: 123.4, clientY: 56.7, bubbles: true });
    pane.dispatchEvent(event);
    expect(Object.getOwnPropertyDescriptor(event, 'clientX')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(event, 'clientY')).toBeUndefined();
    expect(event.clientX).toBe(123.4);
  });

  test('an event inside two installed containers is corrected once, not twice', () => {
    scale = 1.25;
    const { container, pane } = setup();
    release.push(layoutPointerEvents(container)); // a second, nested-equivalent install
    let x = NaN;
    pane.addEventListener('mousemove', (e) => (x = libraryLocal(e, pane).x));
    pane.dispatchEvent(new MouseEvent('mousemove', { ...at(40, 100, 300, 0), bubbles: true }));
    expect(x).toBeCloseTo(300, 9);
  });

  test('the disposer stops correcting', () => {
    scale = 1.25;
    const { pane } = setup();
    for (const r of release) r();
    release = [];
    let x = NaN;
    pane.addEventListener('mousemove', (e) => (x = libraryLocal(e, pane).x));
    pane.dispatchEvent(new MouseEvent('mousemove', { ...at(40, 100, 300, 0), bubbles: true }));
    expect(x).toBe(375);
  });
});

describe('layoutPointerEvents — press-and-slide', () => {
  test('a slide that crosses onto another canvas is still measured against the pressed one', () => {
    scale = 1.25;
    const { pane, axis } = setup();
    // The library's document-level listeners for a press belong to the canvas
    // the press started on, and measure against IT.
    const seen: number[] = [];
    const onDoc = (e: MouseEvent) => seen.push(libraryLocal(e, pane).x);
    document.addEventListener('mousemove', onDoc);
    document.addEventListener('mouseup', onDoc);

    pane.dispatchEvent(
      new MouseEvent('mousedown', { ...at(40, 100, 500, 10), buttons: 1, bubbles: true }),
    );
    // Slid right onto the price axis: 610 layout px from the pane's left edge.
    axis.dispatchEvent(
      new MouseEvent('mousemove', { ...at(40, 100, 610, 10), buttons: 1, bubbles: true }),
    );
    axis.dispatchEvent(
      new MouseEvent('mouseup', { ...at(40, 100, 615, 10), buttons: 0, bubbles: true }),
    );
    document.removeEventListener('mousemove', onDoc);
    document.removeEventListener('mouseup', onDoc);

    expect(seen[0]).toBeCloseTo(610, 9);
    expect(seen[1]).toBeCloseTo(615, 9);
  });

  test('a press released outside the chart does not pin later hovers to the old canvas', () => {
    scale = 1.25;
    const { pane, axis } = setup();
    pane.dispatchEvent(
      new MouseEvent('mousedown', { ...at(40, 100, 100, 10), buttons: 1, bubbles: true }),
    );
    // (mouseup happened elsewhere — this container never saw it)
    let x = NaN;
    axis.addEventListener('mousemove', (e) => (x = libraryLocal(e, axis).x));
    axis.dispatchEvent(
      new MouseEvent('mousemove', { ...at(640, 100, 30, 200), buttons: 0, bubbles: true }),
    );
    // Measured against the stale pane instead, this would read −120.
    expect(x).toBeCloseTo(30, 9);
  });

  /**
   * The review-of-record repro (#2075): press inside, slide ABOVE or BELOW the
   * chart. Those events target whatever is under the pointer — never the
   * container — yet the library's `documentElement` listeners still read them
   * against the pressed canvas, and clamp the crosshair into the plot.
   */
  test.each([
    ['below', 520],
    ['above', -60],
  ])('a slide that leaves the chart %s it is still measured against the pressed canvas', (_, y) => {
    scale = 1.25;
    const { pane } = setup();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    // Where the library listens during a press: documentElement, bubble phase.
    const seen: number[] = [];
    const onRoot = (e: MouseEvent) => seen.push(libraryLocal(e, pane).x);
    document.documentElement.addEventListener('mousemove', onRoot);
    document.documentElement.addEventListener('mouseup', onRoot);

    pane.dispatchEvent(
      new MouseEvent('mousedown', { ...at(40, 100, 100, 10), buttons: 1, bubbles: true }),
    );
    outside.dispatchEvent(
      new MouseEvent('mousemove', { ...at(40, 100, 400, y), buttons: 1, bubbles: true }),
    );
    outside.dispatchEvent(
      new MouseEvent('mouseup', { ...at(40, 100, 410, y), buttons: 0, bubbles: true }),
    );
    // After the release the page is the page again: nothing is rewritten.
    const later = new MouseEvent('mousemove', { ...at(40, 100, 420, y), bubbles: true });
    outside.dispatchEvent(later);
    document.documentElement.removeEventListener('mousemove', onRoot);
    document.documentElement.removeEventListener('mouseup', onRoot);

    // Uncorrected, these read 500 / 512.5 — the clamped wrong day on screen.
    expect(seen[0]).toBeCloseTo(400, 9);
    expect(seen[1]).toBeCloseTo(410, 9);
    expect(Object.getOwnPropertyDescriptor(later, 'clientX')).toBeUndefined();
  });

  test('only a left-button press follows the pointer off the chart', () => {
    scale = 1.25;
    const { pane } = setup();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    pane.dispatchEvent(
      new MouseEvent('mousedown', {
        ...at(40, 100, 100, 10),
        button: 2,
        buttons: 2,
        bubbles: true,
      }),
    );
    const move = new MouseEvent('mousemove', {
      ...at(40, 100, 400, 520),
      buttons: 2,
      bubbles: true,
    });
    outside.dispatchEvent(move);
    // The library ignores a non-left press, so the page keeps its own event.
    expect(Object.getOwnPropertyDescriptor(move, 'clientX')).toBeUndefined();
  });

  test('the disposer, mid-press, also drops the document listener', () => {
    scale = 1.25;
    const { pane } = setup();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    pane.dispatchEvent(
      new MouseEvent('mousedown', { ...at(40, 100, 100, 10), buttons: 1, bubbles: true }),
    );
    for (const r of release) r();
    release = [];
    const move = new MouseEvent('mousemove', {
      ...at(40, 100, 400, 520),
      buttons: 1,
      bubbles: true,
    });
    outside.dispatchEvent(move);
    expect(Object.getOwnPropertyDescriptor(move, 'clientX')).toBeUndefined();
  });

  test('at scale 1 a press installs nothing on the document', () => {
    const { pane } = setup();
    const added = vi.spyOn(document, 'addEventListener');
    pane.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true }));
    expect(added).not.toHaveBeenCalled();
    added.mockRestore();
  });
});

describe('layoutPointerEvents — touch', () => {
  /** A TouchEvent stand-in: jsdom has no `Touch` constructor to build real lists from. */
  function touchEvent(type: string, touch: object, lists: { touches?: boolean } = {}) {
    const event = new Event(type, { bubbles: true });
    const list = [touch];
    Object.defineProperty(event, 'changedTouches', { value: list });
    Object.defineProperty(event, 'targetTouches', { value: list });
    Object.defineProperty(event, 'touches', { value: lists.touches === false ? [] : list });
    return event;
  }

  test('a scrub by finger reads layout px, and a Touch in several lists is corrected once', () => {
    scale = 1.4;
    const { pane } = setup();
    const seen: number[] = [];
    pane.addEventListener('touchmove', (e) => {
      const touch = (e as unknown as TouchEvent).changedTouches[0]!;
      seen.push(libraryLocal(touch, pane).x);
    });
    const touch = { identifier: 1, target: pane, ...at(40, 100, 250, 50) };
    pane.dispatchEvent(touchEvent('touchmove', touch));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeCloseTo(250, 9);
  });

  test('a finger slid off the chart is still corrected: its target stays the canvas', () => {
    // Why touch needs no document listener: the event is dispatched to the
    // canvas the touch started on, so it crosses the container wherever the
    // finger is.
    scale = 1.25;
    const { pane } = setup();
    const touch = { identifier: 1, target: pane, ...at(40, 100, 300, 600) };
    let x = NaN;
    document.documentElement.addEventListener('touchmove', function onRoot(e) {
      x = libraryLocal((e as unknown as TouchEvent).changedTouches[0]!, pane).x;
      document.documentElement.removeEventListener('touchmove', onRoot);
    });
    pane.dispatchEvent(touchEvent('touchmove', touch));
    expect(x).toBeCloseTo(300, 9);
  });

  test('a touch that belongs to another part of the page is left alone', () => {
    scale = 1.4;
    const { pane } = setup();
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    const foreign = { identifier: 2, target: elsewhere, clientX: 10, clientY: 10 };
    const event = new Event('touchmove', { bubbles: true });
    const own = { identifier: 1, target: pane, ...at(40, 100, 100, 0) };
    Object.defineProperty(event, 'touches', { value: [own, foreign] });
    Object.defineProperty(event, 'targetTouches', { value: [own] });
    Object.defineProperty(event, 'changedTouches', { value: [own] });
    pane.dispatchEvent(event);
    expect(Object.getOwnPropertyDescriptor(foreign, 'clientX')?.value).toBe(10);
    expect(libraryLocal(own, pane).x).toBeCloseTo(100, 9);
  });
});

/**
 * The correction above is only right while lightweight-charts measures
 * `clientX - getBoundingClientRect().left` WITHOUT dividing by a scale. If an
 * upgrade starts doing that itself, every hover would be corrected twice — so
 * the installed build's formula is pinned here, in both bundles it ships.
 *
 * This is a source pin on ONE expression: it goes red if the compat event
 * itself divides (review of #2075: 2 failed | 11 passed under that mutation),
 * but a division added further downstream — in the pane widget, say — leaves
 * it green (13 passed). The guard for that kind of upgrade is the nightly
 * `e2e/chart-ui-scale.spec.ts`, which runs the real library under real zoom.
 */
describe('lightweight-charts still reads pointers as clientX − rect.left', () => {
  const pkg = createRequire(import.meta.url).resolve('lightweight-charts/package.json');
  const dist = join(dirname(pkg), 'dist');
  const FORMULA =
    /localX:\s*\(?\s*(\w+)\.clientX\s*-\s*(\w+)\.left\s*\)?\s*,\s*localY:\s*\(?\s*\1\.clientY\s*-\s*\2\.top\s*\)?\s*,/g;

  test.each(['lightweight-charts.production.mjs', 'lightweight-charts.development.mjs'])(
    '%s',
    (file) => {
      const source = readFileSync(join(dist, file), 'utf8');
      expect(source.match(FORMULA)).toHaveLength(1);
    },
  );
});
