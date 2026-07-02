import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../../logger';
import { createRecordingBackfill } from '../../../testing/marketDataStubs';
import { createReferenceBackfill } from '../referenceBackfill';

/**
 * Unit tests for the first-reference history trigger (§6.2/§9): enqueue a
 * backfill only for assets with no price history yet, and never let a probe or
 * enqueue failure escape into the user's write path.
 */

function makeLogger() {
  const warn = vi.fn();
  return { logger: { warn } as unknown as Logger, warn };
}

describe('referenceBackfill', () => {
  it('enqueues a backfill for an asset with no price history', async () => {
    const backfill = createRecordingBackfill();
    const { logger } = makeLogger();
    const trigger = createReferenceBackfill({
      assetRepo: { hasPriceHistory: async () => false },
      backfill,
      logger,
    });

    await trigger.ensureHistory('asset-1');
    expect(backfill.enqueued).toEqual(['asset-1']);
  });

  it('skips assets that already have history', async () => {
    const backfill = createRecordingBackfill();
    const { logger } = makeLogger();
    const trigger = createReferenceBackfill({
      assetRepo: { hasPriceHistory: async () => true },
      backfill,
      logger,
    });

    await trigger.ensureHistory('asset-1');
    expect(backfill.enqueued).toEqual([]);
  });

  it('swallows probe and enqueue failures — the user write must not fail', async () => {
    const { logger, warn } = makeLogger();

    const probeFails = createReferenceBackfill({
      assetRepo: {
        hasPriceHistory: async () => {
          throw new Error('db down');
        },
      },
      backfill: createRecordingBackfill(),
      logger,
    });
    await expect(probeFails.ensureHistory('asset-1')).resolves.toBeUndefined();

    const enqueueFails = createReferenceBackfill({
      assetRepo: { hasPriceHistory: async () => false },
      backfill: {
        enqueue: async () => {
          throw new Error('redis down');
        },
      },
      logger,
    });
    await expect(enqueueFails.ensureHistory('asset-2')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
