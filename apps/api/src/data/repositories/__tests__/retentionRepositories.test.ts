import { lt } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createAuditRepository } from '../auditRepository';
import { createEmailLogRepository } from '../emailLogRepository';

const CUTOFF = new Date('2026-07-30T00:00:00.000Z');
const OLD = new Date('2026-07-29T23:59:59.000Z');
const RECENT = new Date('2026-07-30T00:00:00.000Z');

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

describe('bounded operational-log retention deletes', () => {
  it('deletes audit rows before the cutoff in bounded oldest-first batches', async () => {
    await harness.db.insert(schema.auditLog).values([
      { action: 'old.1', createdAt: OLD },
      { action: 'old.2', createdAt: OLD },
      { action: 'old.3', createdAt: OLD },
      { action: 'recent', createdAt: RECENT },
    ]);
    const repo = createAuditRepository(harness.db);

    expect(await repo.deleteOlderThan(CUTOFF, 2)).toBe(2);
    expect(
      await harness.db.select().from(schema.auditLog).where(lt(schema.auditLog.createdAt, CUTOFF)),
    ).toHaveLength(1);
    expect(await repo.deleteOlderThan(CUTOFF, 2)).toBe(1);
    expect(await repo.deleteOlderThan(CUTOFF, 2)).toBe(0);

    const survivors = await harness.db.select().from(schema.auditLog);
    expect(survivors.map((row) => row.action)).toEqual(['recent']);
  });

  it('deletes email-log rows before the cutoff in bounded oldest-first batches', async () => {
    await harness.db.insert(schema.emailLog).values([
      {
        recipient: 'old-1@bt.test',
        template: 'fixture',
        subject: 'Old 1',
        status: 'sent',
        createdAt: OLD,
      },
      {
        recipient: 'old-2@bt.test',
        template: 'fixture',
        subject: 'Old 2',
        status: 'sent',
        createdAt: OLD,
      },
      {
        recipient: 'old-3@bt.test',
        template: 'fixture',
        subject: 'Old 3',
        status: 'failed',
        createdAt: OLD,
      },
      {
        recipient: 'recent@bt.test',
        template: 'fixture',
        subject: 'Recent',
        status: 'sent',
        createdAt: RECENT,
      },
    ]);
    const repo = createEmailLogRepository(harness.db);

    expect(await repo.deleteOlderThan(CUTOFF, 2)).toBe(2);
    expect(
      await harness.db.select().from(schema.emailLog).where(lt(schema.emailLog.createdAt, CUTOFF)),
    ).toHaveLength(1);
    expect(await repo.deleteOlderThan(CUTOFF, 2)).toBe(1);
    expect(await repo.deleteOlderThan(CUTOFF, 2)).toBe(0);

    const survivors = await harness.db.select().from(schema.emailLog);
    expect(survivors.map((row) => row.recipient)).toEqual(['recent@bt.test']);
  });
});
