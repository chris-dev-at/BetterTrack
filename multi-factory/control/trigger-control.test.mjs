import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  evaluateTimerTrigger,
  evaluateUsageResetTrigger,
  evaluateUsageThresholdTrigger,
} from './trigger-control.mjs';

const NOW = Date.parse('2026-07-24T14:00:00Z');

test('scheduled stop survives a busy slot, retries, then fires exactly once', async () => {
  const trigger = {
    id: 'timer-stop',
    type: 'timer',
    action: 'stop',
    armed: true,
    fireAt: '2026-07-24T13:59:00Z',
  };
  const original = structuredClone(trigger);
  let attempts = 0;
  const performAction = async () => {
    attempts += 1;
    return attempts === 1 ? { ok: false, busy: true } : { ok: true };
  };

  const busy = await evaluateTimerTrigger(trigger, {
    now: NOW,
    running: true,
    performAction,
  });
  assert.equal(busy.busy, true);
  assert.deepEqual(trigger, original);

  const fired = await evaluateTimerTrigger(trigger, {
    now: NOW + 15_000,
    running: true,
    performAction,
  });
  assert.equal(fired.changed, true);
  assert.equal(trigger.armed, false);
  assert.equal(trigger.firedAt, '2026-07-24T14:00:15.000Z');

  const after = await evaluateTimerTrigger(trigger, {
    now: NOW + 30_000,
    running: true,
    performAction,
  });
  assert.equal(after.changed, false);
  assert.equal(attempts, 2);
});

test('usage stop collision preserves threshold state until one successful retry', async () => {
  const trigger = {
    id: 'usage-stop',
    type: 'usage',
    action: 'stop',
    metric: 'five_hour',
    threshold: 90,
    onReset: 'start',
    armed: true,
  };
  const metric = { pct: 95, resetsAt: '2026-07-24T15:00:00Z' };
  const original = structuredClone(trigger);
  let attempts = 0;
  const performAction = async () => {
    attempts += 1;
    return attempts === 1 ? { ok: false, busy: true } : { ok: true };
  };

  const busy = await evaluateUsageThresholdTrigger(trigger, metric, {
    now: NOW,
    running: true,
    performAction,
  });
  assert.equal(busy.busy, true);
  assert.deepEqual(trigger, original);

  const fired = await evaluateUsageThresholdTrigger(trigger, metric, {
    now: NOW + 15_000,
    running: true,
    performAction,
  });
  assert.equal(fired.changed, true);
  assert.equal(trigger.armed, false);
  assert.equal(trigger.waitingReset, true);
  assert.equal(trigger.firedResetsAt, metric.resetsAt);

  await evaluateUsageThresholdTrigger(trigger, metric, {
    now: NOW + 30_000,
    running: true,
    performAction,
  });
  assert.equal(attempts, 2);
});

test('reset-start collision preserves waiting state and re-arms only after one start', async () => {
  const trigger = {
    id: 'usage-reset-start',
    type: 'usage',
    action: 'stop',
    metric: 'five_hour',
    threshold: 90,
    onReset: 'start',
    repeat: true,
    armed: false,
    waitingReset: true,
    firedAt: '2026-07-24T13:00:00Z',
    firedResetsAt: '2026-07-24T14:00:00Z',
  };
  const metric = { pct: 2, resetsAt: '2026-07-24T19:00:00Z' };
  const original = structuredClone(trigger);
  let attempts = 0;
  const performAction = async (action) => {
    assert.equal(action, 'start');
    attempts += 1;
    return attempts === 1 ? { ok: false, busy: true } : { ok: true };
  };

  const busy = await evaluateUsageResetTrigger(trigger, metric, {
    running: false,
    performAction,
  });
  assert.equal(busy.busy, true);
  assert.deepEqual(trigger, original);

  const started = await evaluateUsageResetTrigger(trigger, metric, {
    running: false,
    performAction,
  });
  assert.equal(started.changed, true);
  assert.equal(trigger.waitingReset, false);
  assert.equal(trigger.armed, true);
  assert.equal(trigger.firedAt, null);

  await evaluateUsageResetTrigger(trigger, metric, {
    running: false,
    performAction,
  });
  assert.equal(attempts, 2);
});

test('busy no-op decisions retain exact state without invoking an action', async () => {
  const timer = {
    type: 'timer',
    action: 'stop',
    armed: true,
    fireAt: '2026-07-24T13:59:00Z',
  };
  const reset = {
    type: 'usage',
    threshold: 90,
    waitingReset: true,
    firedResetsAt: '2026-07-24T14:00:00Z',
  };
  const timerOriginal = structuredClone(timer);
  const resetOriginal = structuredClone(reset);
  let attempts = 0;
  const performAction = async () => {
    attempts += 1;
    return { ok: true };
  };

  assert.equal(
    (
      await evaluateTimerTrigger(timer, {
        now: NOW,
        running: false,
        slotBusy: true,
        performAction,
      })
    ).busy,
    true,
  );
  assert.equal(
    (
      await evaluateUsageResetTrigger(
        reset,
        { pct: 1, resetsAt: '2026-07-24T19:00:00Z' },
        { running: true, slotBusy: true, performAction },
      )
    ).busy,
    true,
  );
  assert.deepEqual(timer, timerOriginal);
  assert.deepEqual(reset, resetOriginal);
  assert.equal(attempts, 0);
});

test('genuine non-busy action failures retain consume-on-attempt semantics', async () => {
  const timer = {
    type: 'timer',
    action: 'stop',
    armed: true,
    fireAt: '2026-07-24T13:59:00Z',
  };
  const result = await evaluateTimerTrigger(timer, {
    now: NOW,
    running: true,
    performAction: async () => ({ ok: false, message: 'docker failed' }),
  });
  assert.equal(result.busy, false);
  assert.equal(result.changed, true);
  assert.equal(timer.armed, false);

  const usage = {
    type: 'usage',
    action: 'stop',
    threshold: 90,
    onReset: 'start',
    armed: true,
  };
  const usageResult = await evaluateUsageThresholdTrigger(
    usage,
    { pct: 95, resetsAt: '2026-07-24T15:00:00Z' },
    {
      now: NOW,
      running: true,
      performAction: async () => ({ ok: false, message: 'docker failed' }),
    },
  );
  assert.equal(usageResult.changed, true);
  assert.equal(usage.armed, false);
  assert.equal(usage.waitingReset, true);

  const reset = {
    type: 'usage',
    threshold: 90,
    repeat: true,
    armed: false,
    waitingReset: true,
    firedAt: '2026-07-24T13:00:00Z',
    firedResetsAt: '2026-07-24T14:00:00Z',
  };
  const resetResult = await evaluateUsageResetTrigger(
    reset,
    { pct: 1, resetsAt: '2026-07-24T19:00:00Z' },
    {
      running: false,
      performAction: async () => ({ ok: false, message: 'start failed' }),
    },
  );
  assert.equal(resetResult.changed, true);
  assert.equal(reset.waitingReset, false);
  assert.equal(reset.armed, true);
});

test('server exposes structured busy outcomes and keeps trigger retries interval-bound', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /const mfBusyResult = \(\) => \(\{\s*ok: false,\s*busy: true,/);
  assert.match(source, /evaluateTimerTrigger/);
  assert.match(source, /evaluateUsageThresholdTrigger/);
  assert.match(source, /evaluateUsageResetTrigger/);
  assert.match(source, /setInterval\(evalTriggers, 15000\)/);
  assert.match(source, /if \(triggerBusy\) return/);
});
