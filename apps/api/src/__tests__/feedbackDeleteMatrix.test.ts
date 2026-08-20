import { count, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  FEEDBACK_STATUSES,
  adminFeedbackListResponseSchema,
  myFeedbackResponseSchema,
  updateFeedbackStatusResponseSchema,
  type FeedbackStatus,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
type Agent = ReturnType<typeof request.agent>;

/**
 * #1443 — a submitter may leave ANY conversation, not only an untriaged one.
 *
 * This file is deliberately its own suite rather than a case inside
 * adminFeedback.test.ts: it is on vitest.config.integration.ts's include list,
 * so it runs against real postgres:17 + postgres-js as well as the default
 * PGlite path. That is the whole point. The tombstone UPDATE carries its
 * idempotence in raw COALESCE/CASE fragments, which sit OUTSIDE drizzle's
 * per-column type mapping, and postgres-js rejects a bare `Date` parameter
 * there at Bind time. PGlite serialises one happily — so the entire PGlite
 * suite stayed green while every production delete answered 500. A matrix that
 * only ever ran on PGlite could not have caught this, and still could not.
 */
describe('feedback delete-per-status matrix', () => {
  let harness: TestHarness;
  let owner: SeededUser;
  let ownerAgent: Agent;
  let adminAgent: Agent;

  beforeAll(async () => {
    harness = await createTestApp();
    adminAgent = await harness.loginAdmin(await harness.seedAdmin());
    owner = await harness.seedUser({
      email: 'feedback-delete-matrix@bt.test',
      username: 'feedbackdeletematrix',
    });
    ownerAgent = request.agent(harness.app);
    const login = await ownerAgent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: owner.email, password: owner.password });
    expect(login.status).toBe(200);
  }, 60_000);

  // The transition each status needs, keyed by status so a value added to the
  // enum later cannot silently drop out of the matrix (asserted below).
  const transitions: Record<FeedbackStatus, Record<string, string> | null> = {
    new: null,
    triaged: {},
    working_on_it: {},
    saved_as_future_idea: {},
    declined: { declinedReason: 'Out of scope for the current direction.' },
    shipped: { shippedVersion: '5.5.0' },
  };

  it('covers every wire status', () => {
    expect(Object.keys(transitions).sort()).toEqual([...FEEDBACK_STATUSES].sort());
  });

  for (const status of FEEDBACK_STATUSES) {
    it(`soft-deletes a ${status} submission idempotently`, async () => {
      // The reported row's exact shape: category `other`, with a subject set.
      const created = await ownerAgent
        .post('/api/v1/feedback')
        .set(...XRW)
        .send({ category: 'other', subject: `Delete a ${status} row`, message: 'Please remove.' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id as string;

      const transition = transitions[status];
      if (transition) {
        const patched = await adminAgent
          .patch(`/api/v1/admin/feedback/${id}`)
          .set(...XRW)
          .send({ status, ...transition });
        expect(patched.status, JSON.stringify(patched.body)).toBe(200);
        expect(updateFeedbackStatusResponseSchema.parse(patched.body).status).toBe(status);
      }

      const first = await ownerAgent.delete(`/api/v1/feedback/${id}`).set(...XRW);
      expect(first.status, JSON.stringify(first.body)).toBe(204);
      const [tombstoned] = await harness.db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.id, id));
      expect(tombstoned?.deletedByUserAt).toBeInstanceOf(Date);
      // A triaged outcome survives the tombstone: the owner's audit trail keeps
      // the classification the admin made, outcome details and all.
      expect(tombstoned?.status).toBe(status);
      expect(tombstoned?.declinedReason).toBe(
        status === 'declined' ? transition!.declinedReason : null,
      );
      expect(tombstoned?.shippedVersion).toBe(
        status === 'shipped' ? transition!.shippedVersion : null,
      );

      // Idempotent repeat: the same success, and the original stamps stand —
      // the COALESCE/CASE that broke is exactly what makes that true.
      const second = await ownerAgent.delete(`/api/v1/feedback/${id}`).set(...XRW);
      expect(second.status, JSON.stringify(second.body)).toBe(204);
      const [repeated] = await harness.db
        .select()
        .from(schema.feedback)
        .where(eq(schema.feedback.id, id));
      expect(repeated?.deletedByUserAt?.getTime()).toBe(tombstoned?.deletedByUserAt?.getTime());
      expect(repeated?.updatedAt.getTime()).toBe(tombstoned?.updatedAt.getTime());
    });
  }

  it('leaves the submitter rail empty, the owner trail whole and nobody notified', async () => {
    // Runs after the per-status cases above, on the rows they tombstoned.
    expect(
      myFeedbackResponseSchema.parse((await ownerAgent.get('/api/v1/feedback/mine')).body)
        .submissions,
    ).toEqual([]);

    const listed = adminFeedbackListResponseSchema.parse(
      (await adminAgent.get('/api/v1/admin/feedback')).body,
    );
    const mine = listed.submissions.filter((row) => row.submitter.id === owner.id);
    expect(mine).toHaveLength(FEEDBACK_STATUSES.length);
    expect(mine.every((row) => row.deletedByUser)).toBe(true);
    expect(mine.map((row) => row.status).sort()).toEqual([...FEEDBACK_STATUSES].sort());

    // Leaving a conversation is not an event anybody is told about.
    const [notified] = await harness.db
      .select({ value: count() })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, owner.id));
    expect(notified?.value).toBe(0);
  });
});
