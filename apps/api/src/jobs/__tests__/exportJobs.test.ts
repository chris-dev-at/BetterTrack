import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createExportBuildEnqueuer } from '../definitions/exportJobs';
import type { QueueRegistry } from '../queues';

function registryStub(): { registry: QueueRegistry; enqueue: ReturnType<typeof vi.fn> } {
  const enqueue = vi.fn(async () => ({}) as never);
  const registry = {
    get: vi.fn(),
    enqueue,
    close: vi.fn(),
  } as unknown as QueueRegistry;
  return { registry, enqueue };
}

describe('createExportBuildEnqueuer', () => {
  it('enqueues the build with no options when no delay is requested', async () => {
    const { registry, enqueue } = registryStub();

    await createExportBuildEnqueuer(registry)('job-1');

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('data.export', { jobId: 'job-1' });
  });

  it('maps a deferral delay onto the BullMQ delay so the re-drive waits', async () => {
    const { registry, enqueue } = registryStub();

    await createExportBuildEnqueuer(registry)('job-2', { delayMs: 60_000 });

    expect(enqueue).toHaveBeenCalledWith('data.export', { jobId: 'job-2' }, { delay: 60_000 });
  });

  // The worker is the process that actually defers a build, and TypeScript
  // accepts a one-parameter closure for a two-parameter dep — a bespoke enqueue
  // there would silently drop `delayMs` and turn the deferral into an
  // unthrottled self-re-enqueue loop (#1812). Both composition roots must go
  // through the single mapping above.
  it.each([
    ['../../scripts/worker.ts', 'worker bootstrap'],
    ['../../http/context.ts', 'API context'],
  ])('wires %s (%s) through the shared enqueuer', (relativePath) => {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

    expect(source).toContain('createExportBuildEnqueuer(');
    expect(source).not.toMatch(/enqueue\(\s*'data\.export'/);
  });
});
