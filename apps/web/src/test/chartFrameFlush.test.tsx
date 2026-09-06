import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from 'node:timers';

import { render } from '@testing-library/react';
import { Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { afterAll, expect, test } from 'vitest';

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
 * Which side of RTK's race wins is not part of that contract, and asserting on
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
/** Delay of each armed fallback that sits beside one of those frames, by id. */
const armedFallbacks = new Map<unknown, number>();

const realRequestAnimationFrame = window.requestAnimationFrame;
const realCancelAnimationFrame = window.cancelAnimationFrame;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** A frame is retired once it can no longer run: delivered or cancelled. */
const retireFrame = (handle: number, callback: unknown) => {
  framesByHandle.delete(handle);
  queuedFrames.delete(callback);
};

window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  queuedFrames.add(callback);
  const handle = realRequestAnimationFrame((time) => {
    retireFrame(handle, callback);
    callback(time);
  });
  framesByHandle.set(handle, callback);
  return handle;
}) as typeof requestAnimationFrame;

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
  if (queuedFrames.has(callback)) armedFallbacks.set(id, delay ?? 0);
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
 * The wait `setup.ts` performs, in the same shape: one frame, bounded by a real
 * timer that outlasts the fallback. `node:timers` keeps the bound off the
 * patched globals, so the guard never counts its own timer as a fallback.
 */
const flushWait = () =>
  new Promise<void>((resolve) => {
    const bound = setRealTimeout(resolve, FLUSH_BOUND_MS);
    realRequestAnimationFrame(() => {
      clearRealTimeout(bound);
      resolve();
    });
  });

test('a chart arms fallback timers that the teardown flush disarms', async () => {
  const { unmount } = render(
    <LineChart
      width={300}
      height={200}
      data={[
        { x: 1, y: 2 },
        { x: 2, y: 5 },
      ]}
    >
      <XAxis dataKey="x" />
      <YAxis />
      <Tooltip />
      <Line dataKey="y" isAnimationActive={false} />
    </LineChart>,
  );

  expect(armedFallbacks.size).toBeGreaterThan(0);
  for (const delay of armedFallbacks.values()) expect(delay).toBeLessThan(FLUSH_BOUND_MS);

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
