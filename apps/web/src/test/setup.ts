import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Route and feature chunks resolve asynchronously in production and Vitest
// transforms the same dynamic modules on first use. Keep DOM waits bounded but
// give a loaded CI worker enough room to cross that real lazy boundary.
configure({ asyncUtilTimeout: 5_000 });

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
