import { eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  FEEDBACK_NOT_EDITABLE,
  FEEDBACK_STATUSES,
  apiErrorSchema,
  createApiKeyResponseSchema,
  myFeedbackResponseSchema,
  myFeedbackSubmissionSchema,
  type ApiKeyScope,
  type FeedbackStatus,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { ApiError } from '../errors';
import { limiterKeyForUser } from '../http/middleware/rateLimit';
import { progressiveKeys } from '../services/security/progressiveLimiter';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

/**
 * Owner directive 2026-10-29 — `PATCH /api/v1/feedback/{id}`: a submitter edits
 * their own submission while it is still `new`. Also pins the `/mine` and
 * `DELETE` shapes the mobile client has shipped against since #1315/#1338, so
 * the additive change cannot quietly regress them.
 *
 * Runs on both engines (vitest.config.integration.ts): the edit is a locked
 * read-modify-write, and the race case below only discriminates on real
 * Postgres, where two sessions genuinely overlap.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-7000-8000-000000000099';
const CREATED_AT = new Date('2026-10-20T08:00:00.000Z');
const STATUS_CHANGED_AT = new Date('2026-10-20T08:00:00.000Z');

/** The `/feedback/mine` item keys, in wire order — pre-2026-10-29 keys first. */
const MINE_ITEM_KEYS = [
  'id',
  'category',
  'subject',
  'message',
  'status',
  'lastStatusChangeAt',
  'declinedReason',
  'shippedVersion',
  'unreadReplyCount',
  'createdAt',
  'editedAt',
];

type Agent = ReturnType<typeof request.agent>;

let harness: TestHarness;
let userSequence = 0;

beforeEach(async () => {
  harness = await createTestApp();
  userSequence = 0;
});

async function seedUser(label: string): Promise<SeededUser> {
  userSequence += 1;
  return harness.seedUser({
    email: `feedback-edit-${label}-${userSequence}@bt.test`,
    username: `fbedit${label}${userSequence}`,
  });
}

async function loginAgent(app: Application, user: SeededUser): Promise<Agent> {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(response.status).toBe(200);
  return agent;
}

async function mintKey(scopes: ApiKeyScope[]): Promise<{ token: string; user: SeededUser }> {
  const user = await seedUser('key');
  const agent = await loginAgent(harness.app, user);
  const response = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: 'feedback edit client', scopes });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { token: createApiKeyResponseSchema.parse(response.body).token, user };
}

/** The lifecycle details each status requires by the storage CHECK. */
function statusDetails(status: FeedbackStatus) {
  return {
    status,
    declinedReason: status === 'declined' ? 'Outside the product scope.' : null,
    shippedVersion: status === 'shipped' ? '5.6.0' : null,
  };
}

async function seedRow(
  userId: string,
  overrides: Partial<typeof schema.feedback.$inferInsert> = {},
) {
  const [row] = await harness.db
    .insert(schema.feedback)
    .values({
      userId,
      category: 'bug',
      subject: 'Original subject',
      message: 'Original message.',
      context: { platform: 'android', appVersion: '5.0.0' },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      lastStatusChangeAt: STATUS_CHANGED_AT,
      ...overrides,
    })
    .returning();
  return row!;
}

async function storedRow(id: string) {
  const [row] = await harness.db.select().from(schema.feedback).where(eq(schema.feedback.id, id));
  return row!;
}

describe('PATCH /api/v1/feedback/:id — edit while new', () => {
  it('edits the caller own new row and answers exactly the /mine item, editedAt stamped', async () => {
    const owner = await seedUser('owner');
    const row = await seedRow(owner.id);
    const agent = await loginAgent(harness.app, owner);

    const response = await agent
      .patch(`/api/v1/feedback/${row.id}`)
      .set(...XRW)
      .send({ category: 'help', subject: null, message: '  Edited, verbatim.  ' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const edited = myFeedbackSubmissionSchema.parse(response.body);
    expect(Object.keys(response.body as object)).toEqual(MINE_ITEM_KEYS);
    expect(edited).toMatchObject({
      id: row.id,
      category: 'help',
      subject: null,
      // Stored verbatim, exactly as capture stores it.
      message: '  Edited, verbatim.  ',
      status: 'new',
      lastStatusChangeAt: STATUS_CHANGED_AT.toISOString(),
      createdAt: CREATED_AT.toISOString(),
      unreadReplyCount: 0,
    });
    expect(edited.editedAt).not.toBeNull();

    // The response IS the `/mine` item a client would read next.
    const mine = myFeedbackResponseSchema.parse((await agent.get('/api/v1/feedback/mine')).body);
    expect(mine.submissions).toEqual([edited]);

    const stored = await storedRow(row.id);
    expect(stored.editedAt?.toISOString()).toBe(edited.editedAt);
    // The diagnostic snapshot is filing-time state and never editable; the
    // lifecycle stamp is the notification identity and must not move.
    expect(stored.context).toEqual({ platform: 'android', appVersion: '5.0.0' });
    expect(stored.lastStatusChangeAt.toISOString()).toBe(STATUS_CHANGED_AT.toISOString());
  });

  it('applies a partial edit to only the supplied keys', async () => {
    const owner = await seedUser('partial');
    const row = await seedRow(owner.id);
    const agent = await loginAgent(harness.app, owner);

    const response = await agent
      .patch(`/api/v1/feedback/${row.id}`)
      .set(...XRW)
      .send({ message: 'Only the message changes.' });
    expect(response.status).toBe(200);
    expect(myFeedbackSubmissionSchema.parse(response.body)).toMatchObject({
      category: 'bug',
      subject: 'Original subject',
      message: 'Only the message changes.',
    });
  });

  it('refuses every status past new with 409 FEEDBACK_NOT_EDITABLE and leaves the text alone', async () => {
    const owner = await seedUser('locked');
    const agent = await loginAgent(harness.app, owner);

    for (const status of FEEDBACK_STATUSES.filter((value) => value !== 'new')) {
      const row = await seedRow(owner.id, statusDetails(status));
      const response = await agent
        .patch(`/api/v1/feedback/${row.id}`)
        .set(...XRW)
        .send({ message: `Rewritten after ${status}.` });

      expect(response.status, status).toBe(409);
      expect(apiErrorSchema.parse(response.body).error.code, status).toBe(FEEDBACK_NOT_EDITABLE);
      const stored = await storedRow(row.id);
      expect(stored.message, status).toBe('Original message.');
      expect(stored.editedAt, status).toBeNull();
      expect(stored.updatedAt.toISOString(), status).toBe(CREATED_AT.toISOString());
    }
  });

  it('reopens the edit window when an admin moves the row back to new (accepted, §16)', async () => {
    const owner = await seedUser('reopen');
    const admin = await harness.seedAdmin();
    const row = await seedRow(owner.id);
    const agent = await loginAgent(harness.app, owner);

    await harness.ctx.feedback.updateStatus(admin.id, row.id, { status: 'triaged' });
    await agent
      .patch(`/api/v1/feedback/${row.id}`)
      .set(...XRW)
      .send({ message: 'Refused while triaged.' })
      .expect(409);

    await harness.ctx.feedback.updateStatus(admin.id, row.id, { status: 'new' });
    const reopened = await agent
      .patch(`/api/v1/feedback/${row.id}`)
      .set(...XRW)
      .send({ message: 'Editable again.' });
    expect(reopened.status).toBe(200);
    expect(myFeedbackSubmissionSchema.parse(reopened.body).message).toBe('Editable again.');
  });

  it('answers foreign, missing and tombstoned rows with one indistinguishable 404', async () => {
    const owner = await seedUser('nl');
    const other = await seedUser('nlother');
    const foreignNew = await seedRow(other.id);
    // A foreign row past `new` must ALSO be a 404: a 409 would confirm to a
    // stranger that the id exists and has been triaged.
    const foreignTriaged = await seedRow(other.id, statusDetails('triaged'));
    const tombstoned = await seedRow(owner.id, { deletedByUserAt: new Date() });
    const agent = await loginAgent(harness.app, owner);

    const responses = [];
    for (const id of [foreignNew.id, foreignTriaged.id, tombstoned.id, MISSING_ID]) {
      const response = await agent
        .patch(`/api/v1/feedback/${id}`)
        .set(...XRW)
        .send({ message: 'Must not land.' });
      expect(response.status, id).toBe(404);
      responses.push(apiErrorSchema.parse(response.body));
    }
    for (const body of responses.slice(1)) expect(body).toEqual(responses[0]);

    for (const id of [foreignNew.id, foreignTriaged.id, tombstoned.id]) {
      const stored = await storedRow(id);
      expect(stored.message).toBe('Original message.');
      expect(stored.editedAt).toBeNull();
    }
  });

  it('treats an edit that changes nothing as a retry: 200, no write, no editedAt bump', async () => {
    const owner = await seedUser('noop');
    const row = await seedRow(owner.id);
    const agent = await loginAgent(harness.app, owner);

    // Re-sending the values the row already holds never marks it edited.
    const untouched = await agent
      .patch(`/api/v1/feedback/${row.id}`)
      .set(...XRW)
      .send({ category: 'bug', subject: 'Original subject', message: 'Original message.' });
    expect(untouched.status).toBe(200);
    expect(myFeedbackSubmissionSchema.parse(untouched.body).editedAt).toBeNull();
    expect((await storedRow(row.id)).updatedAt.toISOString()).toBe(CREATED_AT.toISOString());

    const first = myFeedbackSubmissionSchema.parse(
      (
        await agent
          .patch(`/api/v1/feedback/${row.id}`)
          .set(...XRW)
          .send({ message: 'A real edit.' })
          .expect(200)
      ).body,
    );
    expect(first.editedAt).not.toBeNull();
    const afterFirst = await storedRow(row.id);

    // The HTTP retry of that same edit answers the same item and moves nothing.
    const retry = await agent
      .patch(`/api/v1/feedback/${row.id}`)
      .set(...XRW)
      .send({ message: 'A real edit.' });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first);
    const afterRetry = await storedRow(row.id);
    expect(afterRetry.editedAt?.toISOString()).toBe(afterFirst.editedAt?.toISOString());
    expect(afterRetry.updatedAt.toISOString()).toBe(afterFirst.updatedAt.toISOString());
  });

  it('refuses malformed bodies and ids with the standard validation error', async () => {
    const owner = await seedUser('invalid');
    const row = await seedRow(owner.id);
    const agent = await loginAgent(harness.app, owner);

    for (const body of [
      {},
      { message: '' },
      { message: 'x'.repeat(5001) },
      { subject: 's'.repeat(121) },
      { category: 'unknown' },
      { message: 'ok', context: { platform: 'web' } },
      { message: 'ok', status: 'shipped' },
    ]) {
      const response = await agent
        .patch(`/api/v1/feedback/${row.id}`)
        .set(...XRW)
        .send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(apiErrorSchema.parse(response.body).error.code).toBe('VALIDATION_ERROR');
    }
    const badId = await agent
      .patch('/api/v1/feedback/not-a-uuid')
      .set(...XRW)
      .send({ message: 'ok' });
    expect(badId.status).toBe(400);
    expect((await storedRow(row.id)).editedAt).toBeNull();
  });

  it('rejects unauthenticated edits', async () => {
    const owner = await seedUser('anon');
    const row = await seedRow(owner.id);
    const response = await request(harness.app)
      .patch(`/api/v1/feedback/${row.id}`)
      .set(...XRW)
      .send({ message: 'Anonymous rewrite.' });
    expect(response.status).toBe(401);
    expect(apiErrorSchema.parse(response.body).error.code).toBe('UNAUTHENTICATED');
  });

  it('admits feedback:write bearers and refuses feedback:read alone with INSUFFICIENT_SCOPE', async () => {
    const writer = await mintKey(['feedback:write']);
    const writable = await seedRow(writer.user.id);
    const accepted = await request(harness.app)
      .patch(`/api/v1/feedback/${writable.id}`)
      .set('Authorization', `Bearer ${writer.token}`)
      .send({ message: 'Edited from the mobile app.' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(myFeedbackSubmissionSchema.parse(accepted.body).message).toBe(
      'Edited from the mobile app.',
    );

    // Read access (the status history) must never imply the right to rewrite
    // what was submitted.
    for (const scopes of [['feedback:read'], ['portfolio:read']] as ApiKeyScope[][]) {
      const reader = await mintKey(scopes);
      const readable = await seedRow(reader.user.id);
      const refused = await request(harness.app)
        .patch(`/api/v1/feedback/${readable.id}`)
        .set('Authorization', `Bearer ${reader.token}`)
        .send({ message: 'Must not land.' });
      expect(refused.status, scopes.join()).toBe(403);
      expect(apiErrorSchema.parse(refused.body).error.code).toBe('INSUFFICIENT_SCOPE');
      expect((await storedRow(readable.id)).message).toBe('Original message.');
    }
  });

  it('meters edits on the conversation budget, leaving the capture allowance whole', async () => {
    harness = await createTestApp({ rateLimitsEnabled: true });
    const owner = await seedUser('limited');
    const row = await seedRow(owner.id);
    const agent = await loginAgent(harness.app, owner);

    await agent
      .patch(`/api/v1/feedback/${row.id}`)
      .set(...XRW)
      .send({ message: 'Fixing a typo.' })
      .expect(200);
    const captureKeys = progressiveKeys('feedback', limiterKeyForUser(owner.id));
    const threadKeys = progressiveKeys('feedback_thread', limiterKeyForUser(owner.id));
    expect(await harness.ctx.redis.get(threadKeys.count)).toBe('1');
    expect(await harness.ctx.redis.get(captureKeys.count)).toBeNull();

    const threadLimit = harness.ctx.config.rateLimits.feedbackThread.limit;
    await harness.ctx.redis.set(threadKeys.count, String(threadLimit), 'EX', 3600);
    const limited = await agent
      .patch(`/api/v1/feedback/${row.id}`)
      .set(...XRW)
      .send({ message: 'One edit too many.' });
    expect(limited.status).toBe(429);
    expect(apiErrorSchema.parse(limited.body).error.code).toBe('RATE_LIMITED');
    expect((await storedRow(row.id)).message).toBe('Fixing a typo.');
  });

  it('serialises an edit racing a triage on the row lock: the edit sees the new status and is refused', async () => {
    const owner = await seedUser('race');
    const row = await seedRow(owner.id);

    let releaseTriage!: () => void;
    const triageMayCommit = new Promise<void>((resolve) => {
      releaseTriage = resolve;
    });
    let signalLocked!: () => void;
    const triageHoldsLock = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    // An admin transition holding the row lock (exactly what `setStatus` takes)
    // with its write applied but not yet committed.
    const triage = harness.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.feedback.id })
        .from(schema.feedback)
        .where(eq(schema.feedback.id, row.id))
        .for('update');
      const at = new Date();
      await tx
        .update(schema.feedback)
        .set({ status: 'triaged', lastStatusChangeAt: at, updatedAt: at })
        .where(eq(schema.feedback.id, row.id));
      signalLocked();
      await triageMayCommit;
    });
    await triageHoldsLock;

    // The edit starts while the triage is in flight. On Postgres its locked
    // SELECT blocks on the triage's row lock; without that lock it would read
    // the committed `new`, pass the check, and overwrite the triaged text.
    const edit = harness.ctx.feedback
      .editMine(owner.id, row.id, { message: 'Rewritten under the admin.' })
      .then(
        (value) => ({ value, error: null as unknown }),
        (error: unknown) => ({ value: null, error }),
      );
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseTriage();
    await triage;

    const outcome = await edit;
    expect(outcome.value).toBeNull();
    expect(outcome.error).toBeInstanceOf(ApiError);
    expect(outcome.error).toMatchObject({ statusCode: 409, code: FEEDBACK_NOT_EDITABLE });
    const stored = await storedRow(row.id);
    expect(stored.status).toBe('triaged');
    expect(stored.message).toBe('Original message.');
    expect(stored.editedAt).toBeNull();
  });
});

describe('pinned submitter wire shapes the mobile client ships against', () => {
  it('keeps the /mine envelope and every pre-existing item key, appending editedAt only', async () => {
    const owner = await seedUser('pinmine');
    const row = await seedRow(owner.id, statusDetails('declined'));
    const agent = await loginAgent(harness.app, owner);

    const response = await agent.get('/api/v1/feedback/mine');
    expect(response.status).toBe(200);
    expect(Object.keys(response.body as object)).toEqual(['submissions']);
    expect(response.body.submissions).toEqual([
      {
        id: row.id,
        category: 'bug',
        subject: 'Original subject',
        message: 'Original message.',
        status: 'declined',
        lastStatusChangeAt: STATUS_CHANGED_AT.toISOString(),
        declinedReason: 'Outside the product scope.',
        shippedVersion: null,
        unreadReplyCount: 0,
        createdAt: CREATED_AT.toISOString(),
        editedAt: null,
      },
    ]);
    expect(Object.keys(response.body.submissions[0] as object)).toEqual(MINE_ITEM_KEYS);
  });

  it('keeps DELETE an idempotent, bodiless 204 at every status — withdraw is never gated on new', async () => {
    const owner = await seedUser('pindelete');
    const agent = await loginAgent(harness.app, owner);

    for (const status of FEEDBACK_STATUSES) {
      const row = await seedRow(owner.id, statusDetails(status));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await agent.delete(`/api/v1/feedback/${row.id}`).set(...XRW);
        expect(response.status, `${status} #${attempt}`).toBe(204);
        expect(response.text, status).toBe('');
      }
      expect((await storedRow(row.id)).deletedByUserAt, status).toBeInstanceOf(Date);
    }

    // An edited row withdraws the same way, and the 404 for a foreign id is
    // the same body it has always been.
    const edited = await seedRow(owner.id);
    await agent
      .patch(`/api/v1/feedback/${edited.id}`)
      .set(...XRW)
      .send({ message: 'Edited before withdrawing.' })
      .expect(200);
    await agent
      .delete(`/api/v1/feedback/${edited.id}`)
      .set(...XRW)
      .expect(204);
    const missing = await agent.delete(`/api/v1/feedback/${MISSING_ID}`).set(...XRW);
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(missing.body).error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Feedback not found.',
    });
  });
});
