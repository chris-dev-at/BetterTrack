import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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
