import type { BackoffOptions } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { BACKOFF_BASE_MS, DEFAULT_JOB_OPTIONS } from '../options';

describe('DEFAULT_JOB_OPTIONS (§9 retries)', () => {
  it('applies 3 attempts', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
  });

  it('uses exponential backoff with a positive base delay', () => {
    const backoff = DEFAULT_JOB_OPTIONS.backoff as BackoffOptions;
    expect(backoff.type).toBe('exponential');
    expect(backoff.delay).toBe(BACKOFF_BASE_MS);
    expect(backoff.delay).toBeGreaterThan(0);
  });

  it('bounds retained completed and failed jobs', () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toBeTruthy();
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toBeTruthy();
  });
});
