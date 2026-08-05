import { waitFor } from '@testing-library/react';

/**
 * Wait for a first render that has to cross a cold lazy import and/or the
 * initial query cascade it unlocks. Keep ordinary interaction waits on Testing
 * Library's short default so regressions still fail quickly.
 */
export function waitForColdStart<T>(assertion: () => T | Promise<T>): Promise<T> {
  return waitFor(assertion, { timeout: 5_000 });
}
