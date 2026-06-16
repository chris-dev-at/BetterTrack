import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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
});
