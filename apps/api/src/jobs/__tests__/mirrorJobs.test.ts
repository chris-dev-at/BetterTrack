import type { Job } from 'bullmq';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../logger';
import type { MirrorService } from '../../services/mirror/mirrorService';
import {
  MIRROR_REPLICATE_CHAIN_DELAY_MS,
  createMirrorReplicateJob,
  type MirrorReplicateJobDeps,
} from '../definitions';
import type { JobContext } from '../types';

/**
 * V5-P7 MIRRORCHAIN replicate job (issue #680, design §2/§11). The member-facing
 * `mirror.sync_stalled` notice must signal a GENUINE stall (retries exhausted →
 * dead-letter → Problems), never a transient blip that heals on retry — the job
 * fires `notifyChainStalled` only on the FINAL attempt, not on every failed one.
 *
 * The tail-catch re-enqueue must also be BOUNDED (#1611): a copy nothing can
 * replay is reported as a skip, not a failure, so a run over it returns
 * normally with `lagging > 0` forever — re-enqueueing on that alone is a tight
 * infinite job loop that never syncs, never throws and never notifies anyone.
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

function makeDeps(
  mirror: Partial<
    Pick<MirrorService, 'replicateChain' | 'notifyChainStalled' | 'escalateStalledChain'>
  >,
): {
  deps: MirrorReplicateJobDeps;
  enqueue: ReturnType<typeof vi.fn>;
  captureError: ReturnType<typeof vi.fn>;
} {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const captureError = vi.fn();
  return {
    deps: {
      mirror: {
        replicateChain: vi
          .fn()
          .mockResolvedValue({ applied: 0, lagging: 0, skipped: 0, advanced: 0 }),
        notifyChainStalled: vi.fn().mockResolvedValue(undefined),
        escalateStalledChain: vi.fn().mockResolvedValue({ escalated: true, stalled: 1 }),
        ...mirror,
      } as MirrorReplicateJobDeps['mirror'],
      enqueue,
      problems: { captureError },
    },
    enqueue,
    captureError,
  };
}

describe('mirror.replicate job — sync_stalled fires only on permanent failure', () => {
  it('a successful run never notifies and chains a delayed follow-up when copies still lag', async () => {
    const { deps, enqueue } = makeDeps({
      replicateChain: vi
        .fn()
        .mockResolvedValue({ applied: 2, lagging: 1, skipped: 0, advanced: 2 }),
    });
    const def = createMirrorReplicateJob(deps);

    await def.handler(makeJob('chain-1', { attemptsMade: 0, attempts: 3 }), makeCtx());

    expect(deps.mirror.notifyChainStalled).not.toHaveBeenCalled();
    // lagging > 0 AND a watermark moved → catch the tail, spaced out.
    expect(enqueue).toHaveBeenCalledWith('chain-1', { delay: MIRROR_REPLICATE_CHAIN_DELAY_MS });
    expect(deps.mirror.escalateStalledChain).not.toHaveBeenCalled();
  });

  it('a caught-up run chains nothing at all', async () => {
    const { deps, enqueue } = makeDeps({
      replicateChain: vi
        .fn()
        .mockResolvedValue({ applied: 3, lagging: 0, skipped: 0, advanced: 2 }),
    });
    const def = createMirrorReplicateJob(deps);

    await def.handler(makeJob('chain-1', { attemptsMade: 0, attempts: 3 }), makeCtx());

    expect(enqueue).not.toHaveBeenCalled();
    expect(deps.mirror.escalateStalledChain).not.toHaveBeenCalled();
  });

  it('a pass with zero forward progress stops chaining and escalates instead (no infinite loop)', async () => {
    // The unreplayable-member state: nothing applied, nothing advanced, a copy
    // still behind — the exact result the old handler re-enqueued on forever.
    const { deps, enqueue, captureError } = makeDeps({
      replicateChain: vi
        .fn()
        .mockResolvedValue({ applied: 0, lagging: 1, skipped: 1, advanced: 0 }),
    });
    const def = createMirrorReplicateJob(deps);

    for (let run = 0; run < 5; run++) {
      await def.handler(makeJob('chain-1', { attemptsMade: 0, attempts: 3 }), makeCtx());
    }

    // The chain of jobs is BOUNDED — it never starts.
    expect(enqueue).toHaveBeenCalledTimes(0);
    expect(deps.mirror.escalateStalledChain).toHaveBeenCalledTimes(5);
    expect(deps.mirror.escalateStalledChain).toHaveBeenCalledWith('chain-1');
    // ...and the ops surface sees it (the Problems repository folds the repeats).
    expect(captureError).toHaveBeenCalled();
    expect((captureError.mock.calls[0]![0] as Error).name).toBe('mirror: chain cannot replicate');
  });

  it('escalation without a stalled copy (the chain healed meanwhile) reports nothing', async () => {
    const { deps, enqueue, captureError } = makeDeps({
      replicateChain: vi
        .fn()
        .mockResolvedValue({ applied: 0, lagging: 1, skipped: 0, advanced: 0 }),
      escalateStalledChain: vi.fn().mockResolvedValue({ escalated: false, stalled: 0 }),
    });
    const def = createMirrorReplicateJob(deps);

    await def.handler(makeJob('chain-1', { attemptsMade: 0, attempts: 3 }), makeCtx());

    expect(enqueue).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
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
