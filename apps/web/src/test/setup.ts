import '@testing-library/jest-dom/vitest';

import { setTimeout as setRealTimeout } from 'node:timers';

import { cleanup } from '@testing-library/react';
import { afterAll, afterEach } from 'vitest';

// The default 1 s `asyncUtilTimeout` stays: a failing wait must report fast on
// a suite this size. The few cases that really do cross a cold lazy boundary
// (a route/vault chunk Vitest transforms on first use) pass an explicit
// `{ timeout }` at the call site instead.

// jsdom has no ResizeObserver; chart components observe their container for
// responsive resizing. A no-op stub is enough for unit tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Unmount React trees and reset jsdom between tests so component state never
// leaks across cases.
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  window.dispatchEvent(new Event('resize'));
});

// Every Recharts chart owns a Redux store that batches subscriber
// notifications through RTK's `autoBatchEnhancer({ type: 'raf' })`: a batched
// dispatch queues the notification on `requestAnimationFrame` AND arms a raw
// `setTimeout(…, 100)` fallback, and whichever fires first cancels the other.
// jsdom's frame loop dies with the window Vitest closes at environment
// teardown; the fallback is a plain Node timer that survives it, and when it
// fires it calls `cancelAnimationFrame` — a global Vitest has by then deleted.
// The resulting `ReferenceError: cancelAnimationFrame is not defined` lands
// outside any test, so it fails the whole run from a file whose tests all
// passed (that is what reds a chart suite that only ended within a frame of
// its last render).
//
// So this waits that fallback out, rather than racing it. The wait is armed
// after the last `cleanup()`, so every fallback a chart could still have
// pending was armed before it — and Node fires timers in expiry order, so a
// 100 ms fallback armed earlier always runs before this later-armed 150 ms
// bound, however far a loaded runner delays them both. By then every store's
// listeners are gone, so the notification the fallback delivers is a no-op.
//
// An earlier version ended the wait on the first frame instead, on the
// reasoning that either half of RTK's race retires the pair. That holds only
// while both halves are live, and one is not after `vi.useFakeTimers()`:
// Vitest fakes `requestAnimationFrame` too, so a chart rendered under a fake
// clock captures the fake one for the life of its store, and once the clock is
// uninstalled that frame is queued on a clock nothing advances again. A
// dispatch after `vi.useRealTimers()` — the unmount in `cleanup()` is one —
// then arms a *real* fallback whose frame half can never retire it, and a
// flush that returned on the next real frame left it to fire, ~100 ms later,
// into a torn-down environment (#1879).
afterAll(async () => {
  // `node:timers` is immune to the fake clock a file may leave installed,
  // which only replaces the globals.
  await new Promise<void>((resolve) => {
    setRealTimeout(resolve, 150);
  });
});
