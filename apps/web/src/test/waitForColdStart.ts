import { waitFor } from '@testing-library/react';

/**
 * Wait for a first render that must settle its initial query cascade, including
 * routes that also cross a cold lazy import. Keep ordinary interaction waits on
 * Testing Library's short default so regressions still fail quickly.
 */
export function waitForColdStart<T>(assertion: () => T | Promise<T>): Promise<T> {
  return waitFor(assertion, { timeout: 5_000 });
}
