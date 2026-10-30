import { describe, expect, it } from 'vitest';

import type {
  FeedbackRepository,
  FeedbackStatusWrite,
} from '../../../data/repositories/feedbackRepository';
import type { FeedbackRow } from '../../../data/schema';
import type { AuditService } from '../../audit/auditService';
import { createFeedbackService } from '../feedbackService';

/**
 * `bulkForAdmin` isolates rows from each other (owner directive 2026-10-29):
 * a row whose own write the database refuses with an integrity constraint
 * (SQLSTATE class 23) is THAT row's `invalid` result and the batch goes on —
 * but any other failure is an incident and must surface, never be folded into
 * a per-row answer. No real constraint is reachable from a validated body, so
 * the refusal is injected at the repository seam.
 */

const ADMIN = { id: '00000000-0000-7000-8000-00000000a0a0', ip: '203.0.113.7' };
const IDS = [
  '00000000-0000-7000-8000-000000000001',
  '00000000-0000-7000-8000-000000000002',
  '00000000-0000-7000-8000-000000000003',
];

function rowFor(id: string): FeedbackRow {
  const at = new Date('2026-10-29T10:00:00.000Z');
  return {
    id,
    userId: '00000000-0000-7000-8000-00000000beef',
    category: 'bug',
    subject: null,
    message: 'Row under test.',
    context: null,
    status: 'triaged',
    lastStatusChangeAt: at,
    declinedReason: null,
    shippedVersion: null,
    submitterLastReadAt: null,
    adminLastReadAt: null,
    deletedByUserAt: null,
    archivedAt: null,
    editedAt: null,
    createdAt: at,
    updatedAt: at,
  } as FeedbackRow;
}

function harness(fail: (id: string) => unknown) {
  const emitted: unknown[] = [];
  const audited: unknown[] = [];
  const repo = {
    async setStatus(id: string): Promise<FeedbackStatusWrite | null> {
      const failure = fail(id);
      if (failure) throw failure;
      return { row: rowFor(id), changed: true, previousStatus: 'new', message: null };
    },
  } as unknown as FeedbackRepository;
  const service = createFeedbackService({
    repo,
    notify: {
      async emit(event: unknown) {
        emitted.push(event);
      },
    } as never,
    audit: {
      async record(input: unknown) {
        audited.push(input);
      },
    } as unknown as AuditService,
  });
  return { service, emitted, audited };
}

describe('bulkForAdmin row isolation', () => {
  it('reports a class-23 refusal as that row invalid and still applies the rest', async () => {
    // A check violation, shaped as both drivers raise it (`.code` on the error).
    const refusal = Object.assign(new Error('violates check constraint'), { code: '23514' });
    const { service, emitted, audited } = harness((id) => (id === IDS[1] ? refusal : null));

    const response = await service.bulkForAdmin(ADMIN, {
      action: 'status',
      ids: IDS,
      status: 'triaged',
    });

    expect(response.results).toEqual([
      { id: IDS[0], result: 'ok' },
      { id: IDS[1], result: 'invalid' },
      { id: IDS[2], result: 'ok' },
    ]);
    expect(response.summary).toEqual({ ok: 2, unchanged: 0, not_found: 0, invalid: 1 });
    // The refused row emitted and audited nothing; the other two once each.
    expect(emitted).toHaveLength(2);
    expect(audited).toHaveLength(2);
  });

  it('lets every non-constraint failure escape as an incident', async () => {
    const outage = Object.assign(new Error('connection terminated'), { code: '08006' });
    const { service } = harness((id) => (id === IDS[1] ? outage : null));

    await expect(
      service.bulkForAdmin(ADMIN, { action: 'status', ids: IDS, status: 'triaged' }),
    ).rejects.toBe(outage);

    const bug = new TypeError('undefined is not a function');
    const { service: buggy } = harness(() => bug);
    await expect(
      buggy.bulkForAdmin(ADMIN, { action: 'status', ids: IDS, status: 'triaged' }),
    ).rejects.toBe(bug);
  });
});
