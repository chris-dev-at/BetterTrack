import { afterEach, describe, expect, it } from 'vitest';

import { createBullmqAddCapture, type BullmqAddCapture } from '../../testing/bullmqAddCapture';
import { backfillJobId, createBackfillScheduler } from '../backfillScheduler';
import * as definitions from '../definitions';
import { createAnnouncementPublishEnqueuer } from '../definitions/announcementJobs';
import { customJobId } from '../jobIds';
import { ALL_QUEUE_NAMES, QUEUE_NAMES } from '../types';

/**
 * Custom BullMQ job ids must be ids BullMQ accepts (#1184).
 *
 * The rule, from the BullMQ the lockfile resolves (bullmq@5.81.3; apps/api
 * declares `^5.79.2`), `Job.validateOptions` in dist/cjs/classes/job.js, run on
 * every add before the Lua script:
 *
 *   - `Custom Id cannot contain :` — a custom `jobId` containing ':' throws
 *     unless it splits into EXACTLY three ':'-segments (the legacy
 *     `repeat:<key>:<millis>` shape, kept for old repeatable jobs; a TODO there
 *     tightens it to a plain `includes(':')` in the next breaking release);
 *   - `Custom Id cannot be integers` — an id that `parseInt` round-trips.
 *
 * Queue names have their own check in QueueBase (`Queue name cannot contain :`),
 * and scheduler ids become part of BullMQ's generated `repeat:<id>:<millis>` job
 * ids, so a ':' there breaks the three-segment shape BullMQ relies on.
 *
 * `prices.backfill:<assetId>` (two segments) failed every production enqueue:
 * catalog enrichment lost the rest of its run at the first new row, and the
 * first-reference trigger never warmed a history. The suites that cover these
 * producers record enqueues through fakes that accept any id, which is how it
 * shipped — so these tests run BullMQ's own validation instead.
 */

const ASSET_A = '0b9c3c62-6a3e-4f43-9d0e-2f1f3d6c8a11';
const ASSET_B = '7d4f1e20-1c55-4b8e-a3a7-5e0c9b2d4f60';
const ANNOUNCEMENT = 'c2a6d8e4-0f3b-4a71-b9d5-6e8f1a2c3b4d';

const captures: BullmqAddCapture[] = [];
function capture(...queues: Parameters<typeof createBullmqAddCapture>[0]): BullmqAddCapture {
  const c = createBullmqAddCapture(queues);
  captures.push(c);
  return c;
}

afterEach(async () => {
  await Promise.allSettled(captures.splice(0).map((c) => c.close()));
});

describe("the capture harness enforces BullMQ's own id rules", () => {
  // Without these, a BullMQ upgrade or a harness change that stopped running
  // `validateOptions` would turn every assertion below into a vacuous pass.
  it('refuses the ":"-joined id that shipped, with the production error', async () => {
    const { registry, added } = capture(QUEUE_NAMES.pricesBackfill);
    await expect(
      registry.enqueue(
        QUEUE_NAMES.pricesBackfill,
        { assetId: ASSET_A },
        { jobId: `${QUEUE_NAMES.pricesBackfill}:${ASSET_A}` },
      ),
    ).rejects.toThrow('Custom Id cannot contain :');
    expect(added).toHaveLength(0);
  });

  it('refuses an integer id', async () => {
    const { registry } = capture(QUEUE_NAMES.pricesBackfill);
    await expect(
      registry.enqueue(QUEUE_NAMES.pricesBackfill, { assetId: ASSET_A }, { jobId: '42' }),
    ).rejects.toThrow('Custom Id cannot be integers');
  });
});

describe('customJobId', () => {
  it('joins <queue>-<part>… with no ":"', () => {
    expect(backfillJobId(ASSET_A)).toBe(`prices.backfill-${ASSET_A}`);
    expect(customJobId(QUEUE_NAMES.announcementsPublishDue, ANNOUNCEMENT, 2, 5_000_123)).toBe(
      `announcements.publishDue-${ANNOUNCEMENT}-2-5000123`,
    );
  });

  it('escapes a ":" arriving inside a part, so BullMQ still accepts the id', async () => {
    const { registry, added } = capture(QUEUE_NAMES.pricesBackfill);
    const id = customJobId(QUEUE_NAMES.pricesBackfill, 'brk:b');

    expect(id).toBe('prices.backfill-brk%3Ab');
    await registry.enqueue(QUEUE_NAMES.pricesBackfill, { assetId: ASSET_A }, { jobId: id });
    expect(added.map((a) => a.jobId)).toEqual([id]);
    // The escape is reversible, so it cannot alias a part that spelled it out.
    expect(customJobId(QUEUE_NAMES.pricesBackfill, 'brk%3Ab')).not.toBe(id);
  });
});

describe('prices.backfill job id (#1184)', () => {
  it('is accepted by BullMQ, so a backfill enqueue no longer throws', async () => {
    const { registry, added } = capture(QUEUE_NAMES.pricesBackfill);
    const scheduler = createBackfillScheduler(registry);

    await expect(scheduler.enqueue(ASSET_A)).resolves.toBeUndefined();

    expect(added).toHaveLength(1);
    expect(added[0]!.queue).toBe(QUEUE_NAMES.pricesBackfill);
    expect(added[0]!.data).toEqual({ assetId: ASSET_A });
    expect(added[0]!.jobId).toBeDefined();
    expect(added[0]!.jobId).not.toContain(':');
  });

  it('still dedupes per asset: one id per asset, distinct across assets', async () => {
    const { registry, added } = capture(QUEUE_NAMES.pricesBackfill);
    const scheduler = createBackfillScheduler(registry);

    await scheduler.enqueue(ASSET_A);
    await scheduler.enqueue(ASSET_A);
    await scheduler.enqueue(ASSET_B);

    const [first, again, other] = added.map((a) => a.jobId);
    // BullMQ coalesces adds that share an id — the reason the id exists.
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    // The asset is IN the id (not a hash of it), so an operator reading the
    // queue can tell which asset a job is for.
    expect(first).toContain(ASSET_A);
    expect(other).toContain(ASSET_B);
  });
});

describe('announcements.publishDue job id (#1184 sweep)', () => {
  it('is accepted by BullMQ for the first pass, the bounded retry and a manual redelivery', async () => {
    const { registry, added } = capture(QUEUE_NAMES.announcementsPublishDue);
    const at = Date.parse('2026-10-29T12:00:00.000Z');
    const enqueue = createAnnouncementPublishEnqueuer(registry, () => at);

    const first = await enqueue({ announcementId: ANNOUNCEMENT, attempt: 0 });
    const retry = await enqueue({ announcementId: ANNOUNCEMENT, attempt: 1, delayMs: 60_000 });
    const manual = await enqueue({
      announcementId: ANNOUNCEMENT,
      attempt: 2,
      actorId: 'admin-1',
      dedupeWindowMs: 30_000,
    });

    expect(added.map((a) => a.jobId)).toEqual([first.jobId, retry.jobId, manual.jobId]);
    for (const { jobId } of [first, retry, manual]) expect(jobId).not.toContain(':');
    // Still three distinct passes — the retry and the redelivery must not be
    // swallowed by the first one.
    expect(new Set([first.jobId, retry.jobId, manual.jobId]).size).toBe(3);
  });

  it('still collapses repeated asks inside one dedupe window into one id', async () => {
    const { registry, added } = capture(QUEUE_NAMES.announcementsPublishDue);
    const t0 = Date.parse('2026-10-29T12:00:00.000Z');
    let clock = t0;
    const enqueue = createAnnouncementPublishEnqueuer(registry, () => clock);

    await enqueue({ announcementId: ANNOUNCEMENT, attempt: 0 });
    clock = t0 + 60_000;
    await enqueue({ announcementId: ANNOUNCEMENT, attempt: 0 });

    expect(added).toHaveLength(2);
    expect(added[1]!.jobId).toBe(added[0]!.jobId);
  });
});

describe('queue names and scheduler ids carry no ":" (#1184 sweep)', () => {
  it('no queue name contains ":" (QueueBase refuses one)', () => {
    expect(ALL_QUEUE_NAMES.length).toBeGreaterThan(0);
    for (const name of ALL_QUEUE_NAMES) expect(name).not.toContain(':');
  });

  it('no repeatable-job scheduler id contains ":"', () => {
    const schedulerIds = Object.entries(definitions)
      .filter(([key, value]) => key.endsWith('_SCHEDULER_ID') && typeof value === 'string')
      .map(([, value]) => value as string);
    // Guards the filter itself: every scheduled job exports one of these.
    expect(schedulerIds.length).toBeGreaterThanOrEqual(15);
    for (const id of schedulerIds) expect(id).not.toContain(':');
  });
});
