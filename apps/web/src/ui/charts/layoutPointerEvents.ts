import { pointerToLocal, renderScale, type ClientPoint } from '../../lib/pointerToLocal';

/**
 * Every event / `Touch` already corrected, across ALL installed containers: a
 * `Touch` can sit in `touches`, `targetTouches` and `changedTouches` at once,
 * an event inside two nested charts passes two capture listeners, and during a
 * press the document-level listener and the container listener both see the
 * same event. A second correction would divide by the scale twice.
 */
const corrected = new WeakSet<object>();

const CAPTURE = { capture: true } as const;
// Passive: this only rewrites coordinates and must never hold up a scroll.
const PASSIVE_CAPTURE = { capture: true, passive: true } as const;
const MOUSE_TYPES = ['mouseenter', 'mousemove', 'mousedown', 'mouseup', 'dblclick'] as const;
const TOUCH_TYPES = ['touchstart', 'touchmove', 'touchend'] as const;
/** What the library listens for on `documentElement` while a press lasts. */
const PRESS_TYPES = ['mousemove', 'mouseup'] as const;

/**
 * Feed `lightweight-charts` pointer coordinates it can trust under the
 * interface scale.
 *
 * The library turns every pointer event — hover, press-and-slide, tap, long-tap
 * tracking, double-click — into a plot position in ONE place
 * (`MouseEventHandler._private__makeCompatEvent`, lightweight-charts 5.2.1):
 *
 *     localX = event.clientX - target.getBoundingClientRect().left
 *
 * and reads `localX` as its own layout px. Under the root `zoom` (or any
 * ancestor `transform: scale()`) that subtraction is a RENDERED distance, so at
 * 125 % the crosshair lands 1.25× as far from the left edge as the cursor —
 * the owner's "hover inspects the wrong point" (see `lib/pointerToLocal.ts`).
 *
 * It offers no option or hook for that coordinate, so events are corrected on
 * their way down, in the capture phase, before any library listener reads
 * them: each gets the one `clientX/Y` for which the library's own subtraction
 * yields {@link pointerToLocal} — the pointer in the target canvas's layout px.
 *
 *  - Hover, enter, double-click, the press itself: a capture listener on the
 *    chart container, measured against the canvas under the pointer.
 *  - Press-and-slide: on a left-button press the library moves its
 *    `mousemove`/`mouseup` listeners to `documentElement` and measures them
 *    against the canvas the press STARTED on — and once the pointer leaves the
 *    chart those events never cross the container (and the library clamps the
 *    crosshair to the plot edge rather than hiding it). So for as long as the
 *    press lasts, a capture listener on the document corrects them against
 *    that canvas, wherever the pointer is. It goes away on the left-button
 *    release, on the first move with the button already up (a release nobody
 *    saw), or with the disposer.
 *  - Touch: a touch is delivered to the element it started on for its whole
 *    life, so even a finger slid off the chart still crosses the container
 *    with that canvas as target. The container listener covers it; no
 *    document listener is needed.
 *
 * Side effect, by necessity: the rewrite is on the shared event object, so
 * every listener that runs after it — the library's, React's synthetic
 * events, bubble-phase document/window listeners and, while a chart press
 * lasts, page-wide `mousemove`/`mouseup` listeners — sees the corrected
 * `clientX/Y`. Nothing in `apps/web` reads `clientX/Y` today; cursor-anchored
 * UI built around a chart should take its position from {@link pointerToLocal}
 * (or the library's `param.point`) rather than from the raw event.
 *
 * At scale 1 nothing is touched — no event is rewritten and no document
 * listener is installed — so the library reads the event the browser produced.
 * On an engine with legacy `zoom` semantics (where `getBoundingClientRect()`
 * and `offsetWidth` agree under zoom — possibly older WebKit; only Chromium
 * was measured) the measured scale is 1 and this is a no-op: those engines
 * stay as they were, and can never be corrected twice.
 *
 * If a lightweight-charts upgrade ever divides by the scale itself, this would
 * apply twice: `layoutPointerEvents.test.ts` pins the formula in the installed
 * builds, and the nightly `e2e/chart-ui-scale.spec.ts` guards a division added
 * anywhere downstream of it.
 *
 * @returns a disposer that removes every listener it installed.
 */
export function layoutPointerEvents(container: HTMLElement): () => void {
  const doc = container.ownerDocument;
  /** The canvas a left-button press started on, while that press lasts. */
  let pressTarget: HTMLElement | null = null;

  /**
   * Rewrite `point` (once) against `reference`. Measures the box and its scale
   * once and hands both to {@link pointerToLocal}. Returns whether `reference`
   * renders scaled at all.
   */
  function correct(point: ClientPoint, reference: HTMLElement): boolean {
    const rect = reference.getBoundingClientRect();
    const scale = renderScale(reference, rect);
    if (scale.x === 1 && scale.y === 1) return false;
    if (corrected.has(point)) return true;
    corrected.add(point);
    const local = pointerToLocal(point, reference, { rect, scale });
    Object.defineProperty(point, 'clientX', { configurable: true, value: rect.left + local.x });
    Object.defineProperty(point, 'clientY', { configurable: true, value: rect.top + local.y });
    return true;
  }

  function endPress() {
    if (pressTarget === null) return;
    pressTarget = null;
    for (const type of PRESS_TYPES) doc.removeEventListener(type, onPressed, CAPTURE);
  }

  function startPress(target: HTMLElement) {
    endPress();
    pressTarget = target;
    for (const type of PRESS_TYPES) doc.addEventListener(type, onPressed, CAPTURE);
  }

  /** Document level, during a press: runs before the container listener. */
  function onPressed(event: MouseEvent) {
    const target = pressTarget;
    if (target === null) return;
    // Left button already up with no mouseup seen: the press is over.
    if (event.type === 'mousemove' && (event.buttons & 1) === 0) {
      endPress();
      return;
    }
    correct(event, target);
    if (event.type === 'mouseup' && event.button === 0) endPress();
  }

  function onMouse(event: MouseEvent) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target === null) return;
    if (event.type === 'mousedown') {
      // Only the left button starts the library's press (it ignores others).
      if (correct(event, target) && event.button === 0) startPress(target);
      return;
    }
    // A stale press (its release reached nobody) must not pin this hover.
    if (pressTarget !== null && event.type !== 'mouseup' && (event.buttons & 1) === 0) endPress();
    // During a live press the document listener already corrected this event
    // against the pressed canvas, and `correct` will not touch it twice.
    correct(event, pressTarget ?? target);
  }

  function onTouch(event: TouchEvent) {
    for (const list of [event.touches, event.targetTouches, event.changedTouches]) {
      if (!list) continue;
      for (let i = 0; i < list.length; i += 1) {
        const touch = list[i];
        if (touch && touch.target instanceof HTMLElement && container.contains(touch.target)) {
          correct(touch, touch.target);
        }
      }
    }
  }

  for (const type of MOUSE_TYPES) container.addEventListener(type, onMouse, CAPTURE);
  for (const type of TOUCH_TYPES) container.addEventListener(type, onTouch, PASSIVE_CAPTURE);
  return () => {
    for (const type of MOUSE_TYPES) container.removeEventListener(type, onMouse, CAPTURE);
    for (const type of TOUCH_TYPES) container.removeEventListener(type, onTouch, PASSIVE_CAPTURE);
    endPress();
  };
}
