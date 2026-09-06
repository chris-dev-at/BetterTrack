import { render } from '@testing-library/react';
import { Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { expect, test } from 'vitest';

/**
 * Guards the contract `setup.ts`'s teardown flush rests on.
 *
 * A Recharts chart batches its store notifications through RTK's
 * `autoBatchEnhancer({ type: 'raf' })`, which arms a raw `setTimeout(…, 100)`
 * next to every queued frame. That timer is a Node timer: it outlives the jsdom
 * window Vitest closes at environment teardown, and firing afterwards throws
 * `ReferenceError: cancelAnimationFrame is not defined` outside any test —
 * enough to red a run whose tests all passed. The flush disarms those timers by
 * letting one frame run while the window is still alive.
 *
 * So this pins both halves: rendering a chart really does arm extra timers, and
 * a single frame really does clear them. If Recharts or RTK ever queues its
 * notification some other way — a longer fallback, or one a frame no longer
 * cancels — this fails here rather than as an unattributable flake in whichever
 * chart suite happens to end within a frame of its last render.
 */
const pendingTimers = () =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

test('a chart arms fallback timers that one frame disarms', async () => {
  const idle = pendingTimers();

  render(
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

  expect(pendingTimers()).toBeGreaterThan(idle);

  await nextFrame();

  expect(pendingTimers()).toBe(idle);
});
