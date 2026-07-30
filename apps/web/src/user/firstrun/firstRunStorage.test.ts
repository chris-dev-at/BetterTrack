import { beforeEach, expect, test } from 'vitest';

import { clearFirstRun, markFirstRunDone, markFirstRunStep, readFirstRun } from './firstRunStorage';

/** The record is scoped to one account, so every call names it. */
const ACCOUNT = 'user-1';

const KEY = 'bt.firstrun.v1';

beforeEach(() => {
  localStorage.clear();
});

test('an untouched browser reads as a fresh run', () => {
  expect(readFirstRun(ACCOUNT)).toEqual({ done: false, steps: {} });
});

test('step statuses accumulate and survive a re-read', () => {
  markFirstRunStep(ACCOUNT, 'security', 'complete');
  markFirstRunStep(ACCOUNT, 'tax', 'skipped');

  expect(readFirstRun(ACCOUNT)).toEqual({
    done: false,
    steps: { security: 'complete', tax: 'skipped' },
  });
});

test('a step recorded twice keeps the latest status', () => {
  markFirstRunStep(ACCOUNT, 'security', 'skipped');
  markFirstRunStep(ACCOUNT, 'security', 'complete');

  expect(readFirstRun(ACCOUNT).steps.security).toBe('complete');
});

test('marking the run done preserves the recorded steps', () => {
  markFirstRunStep(ACCOUNT, 'profile', 'complete');
  markFirstRunDone(ACCOUNT);

  expect(readFirstRun(ACCOUNT)).toEqual({ done: true, steps: { profile: 'complete' } });
});

test('clearing removes the record entirely', () => {
  markFirstRunStep(ACCOUNT, 'profile', 'complete');
  clearFirstRun();

  expect(localStorage.getItem(KEY)).toBeNull();
  expect(readFirstRun(ACCOUNT)).toEqual({ done: false, steps: {} });
});

// ── Defensive reads: a hand-edited or half-written record must never throw ──

test('unparseable JSON reads as a fresh run', () => {
  localStorage.setItem(KEY, '{not json');
  expect(readFirstRun(ACCOUNT)).toEqual({ done: false, steps: {} });
});

test('a non-object payload reads as a fresh run', () => {
  localStorage.setItem(KEY, '"a string"');
  expect(readFirstRun(ACCOUNT)).toEqual({ done: false, steps: {} });
});

test('unknown ids and bogus statuses are dropped rather than trusted', () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      account: ACCOUNT,
      done: 'yes',
      steps: { profile: 'complete', ghost: 'complete', tax: 42 },
    }),
  );

  // `done` is only ever true for a literal `true`, and only known statuses survive.
  expect(readFirstRun(ACCOUNT)).toEqual({ done: false, steps: { profile: 'complete' } });
});

test('a record belonging to another account reads as a fresh run', () => {
  // The owner's bug: pressing "Do this later" once made every account created
  // in that browser afterwards skip setup, because the record was device-wide.
  markFirstRunDone(ACCOUNT);
  expect(readFirstRun(ACCOUNT).done).toBe(true);
  expect(readFirstRun('someone-else').done).toBe(false);
  expect(readFirstRun(undefined).done).toBe(false);
});
