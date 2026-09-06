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
 * flush disarms those timers by letting one frame run while the window is
 * still alive.
 *
 * So this pins both halves — the chart really does arm a fallback beside each
 * frame, and one frame really does disarm every one of them, including the ones
 * unmounting arms. If Recharts or RTK ever queues its notification some other
 * way, or pushes the fallback past the bound the flush waits out, it fails here
 * rather than as an unattributable flake in whichever chart suite happens to
 * end within a frame of its last render.
 *
 * The counting hooks the two calls RTK makes rather than the process timer
 * table, which a CI runner's ambient timers make far too noisy to assert on.
 */

/** The real timer bounding the flush in `setup.ts`. */
const FLUSH_BOUND_MS = 150;

type TimerCallback = (...args: unknown[]) => unknown;

/** Frame callbacks queued and not yet delivered. */
const queuedFrames = new Set<unknown>();
/** Delay of each armed fallback that sits beside one of those frames, by id. */
const armedFallbacks = new Map<unknown, number>();

const realRequestAnimationFrame = window.requestAnimationFrame;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  queuedFrames.add(callback);
  return realRequestAnimationFrame((time) => {
    queuedFrames.delete(callback);
    callback(time);
  });
}) as typeof requestAnimationFrame;

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
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

const nextFrame = () =>
  new Promise<void>((resolve) => {
    realRequestAnimationFrame(() => resolve());
  });

test('a chart arms fallback timers that one frame disarms', async () => {
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

  await nextFrame();

  expect(queuedFrames.size).toBe(0);
  expect(armedFallbacks.size).toBe(0);
});
