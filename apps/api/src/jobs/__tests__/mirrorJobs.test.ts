import type { Job } from 'bullmq';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../logger';
import type { MirrorService } from '../../services/mirror/mirrorService';
import { createMirrorReplicateJob, type MirrorReplicateJobDeps } from '../definitions';
import type { JobContext } from '../types';

/**
 * V5-P7 MIRRORCHAIN replicate job (issue #680, design §2/§11). The member-facing
 * `mirror.sync_stalled` notice must signal a GENUINE stall (retries exhausted →
 * dead-letter → Problems), never a transient blip that heals on retry — the job
 * fires `notifyChainStalled` only on the FINAL attempt, not on every failed one.
 */

const logger = pino({ level: 'silent' }) as unknown as Logger;

function makeCtx(): JobContext {
  return {
    events: {
      publish: async () => {},
      subscribe: async () => async () => {},
      close: async () => {},
    },
    // The handler never touches deadLetter/redis; keep the ctx minimal.
    deadLetter: {} as JobContext['deadLetter'],
    redis: {} as JobContext['redis'],
    logger,
  };
}

/** A fake job at attempt `attemptsMade + 1` of `attempts` (BullMQ's 0-based counter). */
function makeJob(
  chainId: string,
  opts: { attemptsMade: number; attempts: number },
): Job<{
  chainId: string;
}> {
  return {
    id: 'job-1',
    name: 'mirror.replicate',
    data: { chainId },
    attemptsMade: opts.attemptsMade,
    opts: { attempts: opts.attempts },
    timestamp: Date.now(),
  } as unknown as Job<{ chainId: string }>;
}

function makeDeps(mirror: Partial<Pick<MirrorService, 'replicateChain' | 'notifyChainStalled'>>): {
  deps: MirrorReplicateJobDeps;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  return {
    deps: {
      mirror: {
        replicateChain: vi.fn().mockResolvedValue({ applied: 0, lagging: 0 }),
        notifyChainStalled: vi.fn().mockResolvedValue(undefined),
        ...mirror,
      } as MirrorReplicateJobDeps['mirror'],
      enqueue,
    },
    enqueue,
  };
}

describe('mirror.replicate job — sync_stalled fires only on permanent failure', () => {
  it('a successful run never notifies and chains a follow-up when copies still lag', async () => {
    const { deps, enqueue } = makeDeps({
      replicateChain: vi.fn().mockResolvedValue({ applied: 2, lagging: 1 }),
    });
    const def = createMirrorReplicateJob(deps);

    await def.handler(makeJob('chain-1', { attemptsMade: 0, attempts: 3 }), makeCtx());

    expect(deps.mirror.notifyChainStalled).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('chain-1'); // lagging > 0 → catch the tail
  });

  it('a transient (non-final) attempt failure re-throws WITHOUT notifying — BullMQ will retry', async () => {
    const err = new Error('mirror.replicate: 1 of 2 copies stalled on chain chain-1: db blip');
    const { deps } = makeDeps({ replicateChain: vi.fn().mockRejectedValue(err) });
    const def = createMirrorReplicateJob(deps);

    // attempt 1 of 3 (attemptsMade 0) and attempt 2 of 3 (attemptsMade 1) both retryable.
    for (const attemptsMade of [0, 1]) {
      await expect(
        def.handler(makeJob('chain-1', { attemptsMade, attempts: 3 }), makeCtx()),
      ).rejects.toThrow(err);
    }
    expect(deps.mirror.notifyChainStalled).not.toHaveBeenCalled();
  });

  it('the final attempt failure notifies exactly once (permanent stall → member + owner), then re-throws', async () => {
    const err = new Error('mirror.replicate: 1 of 2 copies stalled on chain chain-1: poison op');
    const { deps } = makeDeps({ replicateChain: vi.fn().mockRejectedValue(err) });
    const def = createMirrorReplicateJob(deps);

    // attempt 3 of 3 → attemptsMade 2; the throw here exhausts the retries.
    await expect(
      def.handler(makeJob('chain-1', { attemptsMade: 2, attempts: 3 }), makeCtx()),
    ).rejects.toThrow(err);

    expect(deps.mirror.notifyChainStalled).toHaveBeenCalledTimes(1);
    expect(deps.mirror.notifyChainStalled).toHaveBeenCalledWith('chain-1');
  });

  it('notifies on the only attempt when retries are disabled (attempts = 1)', async () => {
    const err = new Error('stalled');
    const { deps } = makeDeps({ replicateChain: vi.fn().mockRejectedValue(err) });
    const def = createMirrorReplicateJob(deps);

    await expect(
      def.handler(makeJob('chain-1', { attemptsMade: 0, attempts: 1 }), makeCtx()),
    ).rejects.toThrow(err);

    expect(deps.mirror.notifyChainStalled).toHaveBeenCalledTimes(1);
  });

  it('a notify failure on the final attempt never masks the replicate error (best-effort)', async () => {
    const replicateErr = new Error('mirror.replicate: poison op');
    const { deps } = makeDeps({
      replicateChain: vi.fn().mockRejectedValue(replicateErr),
      notifyChainStalled: vi.fn().mockRejectedValue(new Error('notify blew up')),
    });
    const def = createMirrorReplicateJob(deps);

    // The ORIGINAL replicate error still propagates (so the job dead-letters).
    await expect(
      def.handler(makeJob('chain-1', { attemptsMade: 2, attempts: 3 }), makeCtx()),
    ).rejects.toThrow(replicateErr);
    expect(deps.mirror.notifyChainStalled).toHaveBeenCalledTimes(1);
  });
});
