/**
 * Pointer → element-local coordinates, correct under the interface scale.
 *
 * The Control Center's interface scale is CSS `zoom` on the root element
 * (`user/uiScale.ts`, `styles/origin.css`). Under it, a browser reports two
 * different px at once (measured in Chromium 153 at zoom 1.25 for this module):
 *
 *  - RENDERED px — `MouseEvent.clientX/Y`, `Touch.clientX/Y` and
 *    `getBoundingClientRect()` — what the user sees;
 *  - LAYOUT px — `offsetWidth/Height`, `clientWidth`, a `ResizeObserver`
 *    content box — what the element was laid out (and a chart drew) in.
 *
 * `clientX - rect.left` is therefore a rendered distance, and handing it to
 * code that thinks in layout px puts every reading `scale ×` too far from the
 * element's origin: the hovered point drifts away from the cursor, more the
 * further right it is and the larger the scale. `transform: scale()` on an
 * ancestor has the same shape, so both are handled by measuring the element
 * rather than by reading the setting.
 *
 * At scale 1 every function here returns exactly what the naive subtraction
 * did, so an unscaled page is byte-identical.
 */

/** Anything carrying viewport coordinates: a mouse/pointer event or a `Touch`. */
export interface ClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

/** A position in an element's own coordinate space. */
export interface LocalPoint {
  x: number;
  y: number;
}

/** How much larger the element renders than it is laid out, per axis. */
export interface RenderScale {
  x: number;
  y: number;
}

/**
 * `offsetWidth`/`offsetHeight` are whole px, so a fractional layout box differs
 * from its rendered box by up to one px with no scale at all. Below that, the
 * ratio is rounding noise and is reported as exactly 1 — which is what keeps
 * the unscaled page byte-identical. (The smallest interface step is 1.1, so a
 * real scale clears this on anything wider than ~15 px.)
 */
function axisScale(rendered: number, layout: number): number {
  if (!(layout > 0) || !(rendered > 0)) return 1;
  if (Math.abs(rendered - layout) < 1) return 1;
  return rendered / layout;
}

/**
 * Rendered ÷ layout size of an HTML element, measured — so it covers `zoom`,
 * `transform: scale()` and both together without knowing which is in play.
 */
export function renderScale(element: Element, rect = element.getBoundingClientRect()): RenderScale {
  const html = element as HTMLElement;
  return {
    x: axisScale(rect.width, html.offsetWidth),
    y: axisScale(rect.height, html.offsetHeight),
  };
}

function isSvgGraphics(element: Element): element is SVGGraphicsElement {
  return typeof (element as SVGGraphicsElement).getScreenCTM === 'function';
}

/**
 * Map a pointer into the element's own, untransformed coordinate space.
 *
 *  - SVG: the element's user space (viewBox units) via the inverse of
 *    `getScreenCTM()`, which already folds in zoom, transforms and viewBox.
 *    Inverted by hand rather than through `DOMMatrix`/`DOMPoint`, which jsdom
 *    does not ship.
 *  - HTML (including `<canvas>`): `(client − rect.left) ÷ (rect.width ÷
 *    offsetWidth)` per axis — layout px from the element's top-left corner.
 */
export function pointerToLocal(pointer: ClientPoint, element: Element): LocalPoint {
  if (isSvgGraphics(element)) {
    const m = element.getScreenCTM();
    const det = m ? m.a * m.d - m.b * m.c : 0;
    if (m && det !== 0) {
      const dx = pointer.clientX - m.e;
      const dy = pointer.clientY - m.f;
      return { x: (m.d * dx - m.c * dy) / det, y: (m.a * dy - m.b * dx) / det };
    }
    // Not rendered (no CTM): nothing to scale against — plain offset.
    const rect = element.getBoundingClientRect();
    return { x: pointer.clientX - rect.left, y: pointer.clientY - rect.top };
  }
  const rect = element.getBoundingClientRect();
  const scale = renderScale(element, rect);
  return {
    x: (pointer.clientX - rect.left) / scale.x,
    y: (pointer.clientY - rect.top) / scale.y,
  };
}
