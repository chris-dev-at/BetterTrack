import { pointerToLocal, renderScale, type ClientPoint } from '../../lib/pointerToLocal';

/**
 * Every event / `Touch` already corrected, across ALL installed containers: a
 * `Touch` can sit in `touches`, `targetTouches` and `changedTouches` at once,
 * and an event inside two nested charts passes two capture listeners. A second
 * correction would divide by the scale twice.
 */
const corrected = new WeakSet<object>();

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
 * It offers no option or hook for that coordinate, so the chart's container
 * corrects the events on their way down: a capture-phase listener runs before
 * the library's own listeners on its canvases (and before its document-level
 * listeners for a press in progress) and gives the event the one `clientX/Y`
 * for which the library's own subtraction yields {@link pointerToLocal} — the
 * pointer in the target's layout px.
 *
 * At scale 1 nothing is touched: the event the library reads is the event the
 * browser produced. If a lightweight-charts upgrade ever divides by the scale
 * itself, this correction would apply twice — `layoutPointerEvents.test.ts`
 * pins the library's formula against the installed build so that upgrade
 * fails a test instead of shipping.
 *
 * @returns a disposer that removes the listeners.
 */
export function layoutPointerEvents(container: HTMLElement): () => void {
  // During a press the library measures against the canvas the press STARTED
  // on (its document-level move/up listeners belong to that canvas), not the
  // element currently under the pointer.
  let pressTarget: HTMLElement | null = null;

  function correct(point: ClientPoint, reference: HTMLElement) {
    if (corrected.has(point)) return;
    corrected.add(point);
    const rect = reference.getBoundingClientRect();
    const scale = renderScale(reference, rect);
    if (scale.x === 1 && scale.y === 1) return;
    const local = pointerToLocal(point, reference);
    Object.defineProperty(point, 'clientX', { configurable: true, value: rect.left + local.x });
    Object.defineProperty(point, 'clientY', { configurable: true, value: rect.top + local.y });
  }

  function onMouse(event: MouseEvent) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (event.type === 'mousedown') pressTarget = target;
    // A press that ended outside the chart never reached this listener: no
    // button down any more means no press, whatever was remembered.
    else if (event.buttons === 0 && event.type !== 'mouseup') pressTarget = null;
    const reference = pressTarget ?? target;
    if (event.type === 'mouseup') pressTarget = null;
    if (reference) correct(event, reference);
  }

  function onTouch(event: TouchEvent) {
    // A touch is delivered to the element it started on for its whole life,
    // which is the element the library measures it against.
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

  const mouseTypes = ['mouseenter', 'mousemove', 'mousedown', 'mouseup', 'dblclick'] as const;
  const touchTypes = ['touchstart', 'touchmove', 'touchend'] as const;
  const capture = { capture: true } as const;
  // Passive: this only rewrites coordinates and must never hold up a scroll.
  const passiveCapture = { capture: true, passive: true } as const;
  for (const type of mouseTypes) container.addEventListener(type, onMouse, capture);
  for (const type of touchTypes) container.addEventListener(type, onTouch, passiveCapture);
  return () => {
    for (const type of mouseTypes) container.removeEventListener(type, onMouse, capture);
    for (const type of touchTypes) container.removeEventListener(type, onTouch, passiveCapture);
  };
}
