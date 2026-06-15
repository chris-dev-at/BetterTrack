import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Unmount React trees and reset jsdom between tests so component state never
// leaks across cases.
afterEach(() => {
  cleanup();
});
