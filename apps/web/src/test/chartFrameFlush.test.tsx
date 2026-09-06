import { setTimeout as setRealTimeout } from 'node:timers';

import { render } from '@testing-library/react';
import { Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { afterAll, expect, test, vi } from 'vitest';

/**
 * Guards the contract the teardown flush in `setup.ts` rests on.
 *
 * A Recharts chart batches its store notifications through RTK's
 * `autoBatchEnhancer({ type: 'raf' })`, which queues each notification as a
 * frame and arms a raw `setTimeout(callback, 100)` beside it with the very same
 * callback — whichever fires first cancels the other. That timer is a Node
 * timer: it outlives the jsdom window Vitest closes at environment teardown,
 * and firing afterwards throws `ReferenceError: cancelAnimationFrame is not
 * defined` outside any test, enough to red a run whose tests all passed. The
 * flush disarms those timers by waiting the race out while the window is still
 * alive.
 *
 * So this pins both halves — the chart really does arm a fallback beside each
 * frame, and the flush's own wait really does retire every one of them,
 * including the ones unmounting arms. If Recharts or RTK ever queues its
 * notification some other way, or pushes the fallback past the bound the flush
 * waits out, it fails here rather than as an unattributable flake in whichever
 * chart suite happens to end within a frame of its last render.
 *
 * The second test pins the case that made the flush's earlier, frame-ending
 * wait insufficient (#1879): `vi.useFakeTimers()` fakes `requestAnimationFrame`
 * as well, so a chart rendered under a fake clock captures the fake frame loop
 * for the life of its store and a dispatch after `vi.useRealTimers()` arms a
 * real fallback whose frame half is queued on a clock nothing advances again.
 * Nothing but waiting that fallback out retires it.
 *
 * Which side of RTK's race wins is not part of the contract, and asserting on
 * it is what made an earlier version of this guard flake: `verify` runs the API
 * and web suites concurrently, and on a runner that oversubscribed the fallback
 * beat jsdom's ~16 ms frame, cancelled the frame beside it and disarmed itself
 * — the safe outcome, inside a live window — while this file still counted the
 * cancelled frame as pending and failed. Both outcomes are fine and both are
 * counted here; only a callback that is still live when the flush returns is
 * not. So hook all three calls RTK makes, cancellation included, rather than
 * the process timer table, which a CI runner's ambient timers make far too
 * noisy to assert on.
 */

/** The real timer bounding the flush in `setup.ts`. */
const FLUSH_BOUND_MS = 150;

type TimerCallback = (...args: unknown[]) => unknown;

/** Frame callbacks queued and neither delivered nor cancelled. */
const queuedFrames = new Set<unknown>();
/** Those same callbacks by frame handle, which is all `cancelAnimationFrame` gets. */
const framesByHandle = new Map<number, unknown>();
/** Frames queued on a fake clock's loop, which stops advancing when it is uninstalled. */
const framesOnAFakeLoop = new Set<unknown>();
/** Each armed fallback that sits beside one of those frames, by timer id. */
const armedFallbacks = new Map<unknown, { delay: number; callback: unknown }>();

const realRequestAnimationFrame = window.requestAnimationFrame;
const realCancelAnimationFrame = window.cancelAnimationFrame;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** A frame is retired once it can no longer run: delivered or cancelled. */
const retireFrame = (handle: number, callback: unknown) => {
  framesByHandle.delete(handle);
  queuedFrames.delete(callback);
};

/**
 * Counts every frame queued through `underlying`, whichever frame loop that is:
 * the real one, or the fake `vi.useFakeTimers()` installs over it. A store
 * captures whatever `window.requestAnimationFrame` holds when it is built, so
 * hooking the fake loop too is the only way to see what a chart rendered under
 * a fake clock keeps calling once the clock is gone.
 */
const hookFrames = (underlying: typeof requestAnimationFrame, onAFakeLoop = false) =>
  ((callback: FrameRequestCallback) => {
    queuedFrames.add(callback);
    if (onAFakeLoop) framesOnAFakeLoop.add(callback);
    const handle = underlying((time) => {
      retireFrame(handle, callback);
      callback(time);
    });
    framesByHandle.set(handle, callback);
    return handle;
  }) as typeof requestAnimationFrame;

window.requestAnimationFrame = hookFrames(realRequestAnimationFrame);

window.cancelAnimationFrame = ((handle: number) => {
  // The winning half of RTK's race cancels the other, so a frame whose fallback
  // fired first is retired here and never delivered at all.
  const callback = framesByHandle.get(handle);
  if (callback !== undefined) retireFrame(handle, callback);
  realCancelAnimationFrame(handle);
}) as typeof cancelAnimationFrame;

globalThis.setTimeout = ((callback: TimerCallback, delay?: number, ...args: unknown[]) => {
  const id = realSetTimeout(callback, delay, ...args);
  // RTK arms the fallback with the callback it has just queued as a frame.
  if (queuedFrames.has(callback)) armedFallbacks.set(id, { delay: delay ?? 0, callback });
  return id;
}) as unknown as typeof setTimeout;

globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
  armedFallbacks.delete(id);
  realClearTimeout(id);
}) as typeof clearTimeout;

afterAll(() => {
  window.requestAnimationFrame = realRequestAnimationFrame;
  window.cancelAnimationFrame = realCancelAnimationFrame;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

/**
 * The wait `setup.ts` performs, in the same shape: a real timer that outlasts
 * the 100 ms fallback, ended by nothing else. `node:timers` keeps it off the
 * patched globals, so the guard never counts its own timer as a fallback.
 */
const flushWait = () =>
  new Promise<void>((resolve) => {
    setRealTimeout(resolve, FLUSH_BOUND_MS);
  });

const chart = (data: { x: number; y: number }[]) => (
  <LineChart width={300} height={200} data={data}>
    <XAxis dataKey="x" />
    <YAxis />
    <Tooltip />
    <Line dataKey="y" isAnimationActive={false} />
  </LineChart>
);

test('a chart arms fallback timers that the teardown flush disarms', async () => {
  const { unmount } = render(
    chart([
      { x: 1, y: 2 },
      { x: 2, y: 5 },
    ]),
  );

  expect(armedFallbacks.size).toBeGreaterThan(0);
  for (const { delay } of armedFallbacks.values()) expect(delay).toBeLessThan(FLUSH_BOUND_MS);

  // Unmounting dispatches too, so the flush has to survive what `cleanup()`
  // itself arms — which is the state it actually runs in.
  unmount();
  expect(armedFallbacks.size).toBeGreaterThan(0);

  await flushWait();

  // Nothing of the chart's is left to run: no frame still queued, and — the
  // half that would outlive the window — no fallback still armed.
  expect(queuedFrames.size).toBe(0);
  expect(armedFallbacks.size).toBe(0);
});

test('a chart built under a fake clock arms a fallback with no frame beside it', async () => {
  // A store created here captures the *faked* `requestAnimationFrame`, exactly
  // as a chart rendered inside a `vi.useFakeTimers()` test does. Hook that fake
  // loop as well, so the frames the store queues through it stay visible after
  // the clock is uninstalled and this file's own hooks are back.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.requestAnimationFrame = hookFrames(window.requestAnimationFrame, true);
  const { rerender, unmount } = render(
    chart([
      { x: 1, y: 2 },
      { x: 2, y: 5 },
    ]),
  );
  await vi.advanceTimersByTimeAsync(2 * FLUSH_BOUND_MS);
  vi.useRealTimers();

  // Only what the live clock arms from here on can outlive the environment.
  armedFallbacks.clear();
  queuedFrames.clear();
  framesByHandle.clear();

  // Any dispatch now — a re-render, or the unmount `cleanup()` performs — arms
  // a real fallback, while its frame goes to the fake clock nothing advances
  // again. So the pair is not a pair: the fallback is on its own.
  rerender(
    chart([
      { x: 1, y: 4 },
      { x: 2, y: 9 },
      { x: 3, y: 1 },
    ]),
  );
  unmount();
  expect(armedFallbacks.size).toBeGreaterThan(0);
  for (const { delay, callback } of armedFallbacks.values()) {
    expect(delay).toBeLessThan(FLUSH_BOUND_MS);
    // The half that would have retired this fallback early is queued on the
    // clock `vi.useRealTimers()` just took away, so no frame the live loop
    // delivers can reach it: a flush that ended on the next real frame would
    // return with the fallback still armed to fire into a torn-down
    // environment (#1879).
    expect(framesOnAFakeLoop.has(callback)).toBe(true);
  }

  // Waiting it out is what retires it, whichever way a loaded runner spaces
  // the two: Node fires the 100 ms fallback before the 150 ms bound armed
  // after it, and the environment is still live when it does.
  await flushWait();
  expect(armedFallbacks.size).toBe(0);
});
