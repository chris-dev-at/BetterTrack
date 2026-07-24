// Transactional state transitions for persisted background triggers.
//
// A lifecycle action can return { busy: true } when another operation owns the
// multi-factory slot. In that case the trigger must remain byte-for-byte
// equivalent so the next evaluator tick retries it. Other failures retain the
// historical consume-on-attempt behavior.

const unchanged = (busy = false) => ({
  changed: false,
  busy,
  attempted: false,
  actionResult: null,
});

export function actionResultIsBusy(result) {
  return result?.busy === true;
}

export function timerTriggerDue(trigger, now = Date.now()) {
  return (
    trigger?.type === 'timer' &&
    trigger.armed === true &&
    Number.isFinite(Date.parse(trigger.fireAt)) &&
    now >= Date.parse(trigger.fireAt)
  );
}

export function usageThresholdReached(trigger, metric) {
  return (
    trigger?.type === 'usage' &&
    trigger.armed === true &&
    typeof metric?.pct === 'number' &&
    metric.pct >= trigger.threshold
  );
}

export function usageResetReady(trigger, metric) {
  if (trigger?.type !== 'usage' || trigger.waitingReset !== true || !metric) return false;
  const nextReset = Date.parse(metric.resetsAt);
  const firedReset = Date.parse(trigger.firedResetsAt || 0);
  return (
    (Number.isFinite(nextReset) &&
      Number.isFinite(firedReset) &&
      nextReset > firedReset + 60_000) ||
    (typeof metric.pct === 'number' && metric.pct < Math.min(trigger.threshold / 2, 10))
  );
}

export async function evaluateTimerTrigger(
  trigger,
  { now = Date.now(), running = false, slotBusy = false, performAction } = {},
) {
  if (!timerTriggerDue(trigger, now)) return unchanged();
  if (!running && slotBusy) return unchanged(true);
  let actionResult = null;
  if (running) {
    actionResult = await performAction(trigger.action);
    if (actionResultIsBusy(actionResult))
      return { ...unchanged(true), attempted: true, actionResult };
  }
  trigger.armed = false;
  trigger.firedAt = new Date(now).toISOString();
  if (!running) trigger.note = 'factory was not running at fire time';
  return { changed: true, busy: false, attempted: running, actionResult };
}

export async function evaluateUsageThresholdTrigger(
  trigger,
  metric,
  { now = Date.now(), running = false, slotBusy = false, performAction } = {},
) {
  if (!usageThresholdReached(trigger, metric)) return unchanged();
  if (!running && slotBusy) return unchanged(true);
  let actionResult = null;
  if (running) {
    actionResult = await performAction(trigger.action);
    if (actionResultIsBusy(actionResult))
      return { ...unchanged(true), attempted: true, actionResult };
  }
  trigger.armed = false;
  trigger.firedAt = new Date(now).toISOString();
  trigger.firedResetsAt = metric.resetsAt;
  if (trigger.onReset === 'start') trigger.waitingReset = true;
  return { changed: true, busy: false, attempted: running, actionResult };
}

export async function evaluateUsageResetTrigger(
  trigger,
  metric,
  { running = false, slotBusy = false, performAction } = {},
) {
  if (!usageResetReady(trigger, metric)) return unchanged();
  if (slotBusy) return unchanged(true);
  let actionResult = null;
  if (!running) {
    actionResult = await performAction('start');
    if (actionResultIsBusy(actionResult))
      return { ...unchanged(true), attempted: true, actionResult };
  }
  trigger.waitingReset = false;
  if (trigger.repeat) {
    trigger.armed = true;
    trigger.firedAt = null;
  }
  return { changed: true, busy: false, attempted: !running, actionResult };
}
