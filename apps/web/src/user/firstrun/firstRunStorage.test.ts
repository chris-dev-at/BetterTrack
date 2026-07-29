import { beforeEach, expect, test } from 'vitest';

import { clearFirstRun, markFirstRunDone, markFirstRunStep, readFirstRun } from './firstRunStorage';

const KEY = 'bt.firstrun.v1';

beforeEach(() => {
  localStorage.clear();
});

test('an untouched browser reads as a fresh run', () => {
  expect(readFirstRun()).toEqual({ done: false, steps: {} });
});

test('step statuses accumulate and survive a re-read', () => {
  markFirstRunStep('security', 'complete');
  markFirstRunStep('tax', 'skipped');

  expect(readFirstRun()).toEqual({
    done: false,
    steps: { security: 'complete', tax: 'skipped' },
  });
});

test('a step recorded twice keeps the latest status', () => {
  markFirstRunStep('security', 'skipped');
  markFirstRunStep('security', 'complete');

  expect(readFirstRun().steps.security).toBe('complete');
});

test('marking the run done preserves the recorded steps', () => {
  markFirstRunStep('profile', 'complete');
  markFirstRunDone();

  expect(readFirstRun()).toEqual({ done: true, steps: { profile: 'complete' } });
});

test('clearing removes the record entirely', () => {
  markFirstRunStep('profile', 'complete');
  clearFirstRun();

  expect(localStorage.getItem(KEY)).toBeNull();
  expect(readFirstRun()).toEqual({ done: false, steps: {} });
});

// ── Defensive reads: a hand-edited or half-written record must never throw ──

test('unparseable JSON reads as a fresh run', () => {
  localStorage.setItem(KEY, '{not json');
  expect(readFirstRun()).toEqual({ done: false, steps: {} });
});

test('a non-object payload reads as a fresh run', () => {
  localStorage.setItem(KEY, '"a string"');
  expect(readFirstRun()).toEqual({ done: false, steps: {} });
});

test('unknown ids and bogus statuses are dropped rather than trusted', () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({ done: 'yes', steps: { profile: 'complete', ghost: 'complete', tax: 42 } }),
  );

  // `done` is only ever true for a literal `true`, and only known statuses survive.
  expect(readFirstRun()).toEqual({ done: false, steps: { profile: 'complete' } });
});
