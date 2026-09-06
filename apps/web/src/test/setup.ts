import '@testing-library/jest-dom/vitest';

import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from 'node:timers';

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
// its last render). One frame here — after the last `cleanup()`, so every
// store's listeners are gone and notifying is a no-op — runs the callbacks
// still queued and disarms their fallbacks while the window is alive.
afterAll(async () => {
  // The real timer both bounds the wait and covers the case a file leaves a
  // fake clock installed, where jsdom would never deliver the frame: it
  // outlasts RTK's 100 ms fallback, which by then has fired inside the
  // still-live environment. `node:timers` is immune to the fake clock, which
  // only replaces the globals.
  await new Promise<void>((resolve) => {
    const bound = setRealTimeout(resolve, 150);
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => {
      clearRealTimeout(bound);
      resolve();
    });
  });
});
