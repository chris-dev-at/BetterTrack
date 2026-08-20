import { count, eq } from 'drizzle-orm';
import type { Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  API_KEY_SCOPES,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  apiErrorSchema,
  createApiKeyResponseSchema,
  createFeedbackResponseSchema,
  feedbackThreadResponseSchema,
  impliedReadScope,
  myFeedbackResponseSchema,
  sendFeedbackMessageResponseSchema,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { FIRST_PARTY_CLIENTS } from '../services/oauth/firstPartyClients';
import { progressiveKeys } from '../services/security/progressiveLimiter';
import { createTestApp, type SeededUser, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-7000-8000-000000000099';

type Agent = ReturnType<typeof request.agent>;

let harness: TestHarness;
let keySequence = 0;

beforeEach(async () => {
  harness = await createTestApp();
  keySequence = 0;
});

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
  keySequence += 1;
  const user = await harness.seedUser({
    email: `feedback-key-${keySequence}@bt.test`,
    username: `feedbackkey${keySequence}`,
  });
  const agent = await loginAgent(harness.app, user);
  const response = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: 'feedback client', scopes });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { token: createApiKeyResponseSchema.parse(response.body).token, user };
}

const validBody = {
  category: 'feature' as const,
  subject: 'Improve the forecast',
  message: 'Please add scenario presets.',
  context: {
    platform: 'android',
    appVersion: '5.0.0',
    osVersion: '16',
    device: 'Pixel',
    locale: 'de-AT',
    screen: '/forecast',
    futureDiagnostic: { supported: true },
  },
};

describe('POST /api/v1/feedback', () => {
  it('persists a valid session submission as new and returns its id + creation stamp', async () => {
    const user = await harness.seedUser({ email: 'feedback@bt.test', username: 'feedback' });
    const agent = await loginAgent(harness.app, user);

    const response = await agent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send(validBody);

    expect(response.status).toBe(201);
    const created = createFeedbackResponseSchema.parse(response.body);
    const [row] = await harness.db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.id, created.id));
    expect(row).toMatchObject({
      userId: user.id,
      category: 'feature',
      subject: validBody.subject,
      message: validBody.message,
      context: validBody.context,
      status: 'new',
    });
    expect(row!.createdAt.toISOString()).toBe(created.createdAt);
  });

  it('accepts empty subjects and preserves supplied subject text verbatim', async () => {
    const user = await harness.seedUser({
      email: 'feedback-subject@bt.test',
      username: 'feedbacksubject',
    });
    const agent = await loginAgent(harness.app, user);

    for (const subject of ['', '  Keep this spacing  ']) {
      const response = await agent
        .post('/api/v1/feedback')
        .set(...XRW)
        .send({ category: 'other', message: 'Subject contract', subject });
      expect(response.status).toBe(201);

      const created = createFeedbackResponseSchema.parse(response.body);
      const [row] = await harness.db
        .select({ subject: schema.feedback.subject })
        .from(schema.feedback)
        .where(eq(schema.feedback.id, created.id));
      expect(row?.subject).toBe(subject);
    }
  });

  it('accepts exactly 5000 message characters and returns standard validation errors beyond it', async () => {
    const user = await harness.seedUser({ email: 'bounds@bt.test', username: 'bounds' });
    const agent = await loginAgent(harness.app, user);

    const atLimit = await agent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send({ category: 'bug', message: 'x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH) });
    expect(atLimit.status).toBe(201);

    for (const body of [
      { category: 'bug', message: 'x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH + 1) },
      { category: 'unknown', message: 'A message' },
    ]) {
      const invalid = await agent
        .post('/api/v1/feedback')
        .set(...XRW)
        .send(body);
      expect(invalid.status).toBe(400);
      expect(apiErrorSchema.parse(invalid.body).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects unauthenticated submissions', async () => {
    const response = await request(harness.app)
      .post('/api/v1/feedback')
      .set(...XRW)
      .send(validBody);
    expect(response.status).toBe(401);
    expect(apiErrorSchema.parse(response.body).error.code).toBe('UNAUTHENTICATED');
  });

  it('accepts feedback:write bearer submissions and persists their principal', async () => {
    const { token, user } = await mintKey(['feedback:write']);
    const response = await request(harness.app)
      .post('/api/v1/feedback')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'other', message: 'Mobile feedback' });

    expect(response.status).toBe(201);
    const created = createFeedbackResponseSchema.parse(response.body);
    const [row] = await harness.db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.id, created.id));
    expect(row).toMatchObject({ userId: user.id, category: 'other', status: 'new' });
  });

  it('returns INSUFFICIENT_SCOPE, not API_KEY_FORBIDDEN, without feedback:write', async () => {
    const { token } = await mintKey(['portfolio:read']);
    const response = await request(harness.app)
      .post('/api/v1/feedback')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody);

    expect(response.status).toBe(403);
    expect(apiErrorSchema.parse(response.body).error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('keeps the configured five-per-hour capture budget closed through cooldown recovery', async () => {
    harness = await createTestApp({ rateLimitsEnabled: true });
    const user = await harness.seedUser({ email: 'limited@bt.test', username: 'limited' });
    const agent = await loginAgent(harness.app, user);
    const configuredLimit = harness.ctx.config.rateLimits.feedback.limit;
    expect(configuredLimit).toBe(5);
    let threadId = '';

    for (let index = 0; index < configuredLimit; index += 1) {
      const accepted = await agent
        .post('/api/v1/feedback')
        .set(...XRW)
        .send({ category: 'other', message: `Feedback ${index}` });
      expect(accepted.status).toBe(201);
      if (index === 0) threadId = createFeedbackResponseSchema.parse(accepted.body).id;
    }

    const limited = await agent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send({ category: 'other', message: 'One too many for the capture budget.' });
    expect(limited.status).toBe(429);
    expect(apiErrorSchema.parse(limited.body).error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();

    // A spent capture allowance is an anti-spam guard on *new* submissions; it
    // must never silence a live conversation, so the reply rail is unaffected.
    const replyWhileClosed = await agent
      .post(`/api/v1/feedback/${threadId}/messages`)
      .set(...XRW)
      .send({ body: 'Answering the owner’s question mid-cooldown.' });
    expect(replyWhileClosed.status).toBe(201);

    const keys = progressiveKeys('feedback', user.id);
    expect(await harness.ctx.redis.get(keys.count)).toBe(String(configuredLimit + 1));

    // Simulate the one-minute first cooldown expiring while the original hourly
    // counter is still live. A fresh five-row allowance must not open here.
    await harness.ctx.redis.del(keys.cooldown);
    const afterCooldown = await agent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send({ category: 'other', message: 'Still inside the same hour.' });
    expect(afterCooldown.status).toBe(429);
    expect(apiErrorSchema.parse(afterCooldown.body).error.code).toBe('RATE_LIMITED');

    let [stored] = await harness.db.select({ value: count() }).from(schema.feedback);
    expect(stored?.value).toBe(configuredLimit);

    // Simulate the hourly window and its bounded cooldown expiring together.
    // The next request starts a new allowance and persists normally.
    await harness.ctx.redis.del(keys.count, keys.cooldown);
    const nextWindow = await agent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send({ category: 'other', message: 'A new hourly window' });
    expect(nextWindow.status).toBe(201);

    [stored] = await harness.db.select({ value: count() }).from(schema.feedback);
    expect(stored?.value).toBe(configuredLimit + 1);
  });

  it('meters thread replies on their own conversation budget', async () => {
    harness = await createTestApp({ rateLimitsEnabled: true });
    const user = await harness.seedUser({
      email: 'thread-limited@bt.test',
      username: 'threadlimited',
    });
    const agent = await loginAgent(harness.app, user);
    const created = await agent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send({ category: 'other', message: 'Opening submission.' });
    expect(created.status).toBe(201);
    const threadId = createFeedbackResponseSchema.parse(created.body).id;

    const captureKeys = progressiveKeys('feedback', user.id);
    const threadKeys = progressiveKeys('feedback_thread', user.id);
    const threadLimit = harness.ctx.config.rateLimits.feedbackThread.limit;
    expect(threadLimit).toBeGreaterThan(harness.ctx.config.rateLimits.feedback.limit);

    const reply = await agent
      .post(`/api/v1/feedback/${threadId}/messages`)
      .set(...XRW)
      .send({ body: 'A first reply.' });
    expect(reply.status).toBe(201);
    // The reply counted against the conversation budget only — the capture
    // counter still shows just the single submission above.
    expect(await harness.ctx.redis.get(threadKeys.count)).toBe('1');
    expect(await harness.ctx.redis.get(captureKeys.count)).toBe('1');

    // Exhausting the conversation budget closes replies — and only replies.
    await harness.ctx.redis.set(threadKeys.count, String(threadLimit), 'EX', 3600);
    const limitedReply = await agent
      .post(`/api/v1/feedback/${threadId}/messages`)
      .set(...XRW)
      .send({ body: 'One reply too many.' });
    expect(limitedReply.status).toBe(429);
    expect(apiErrorSchema.parse(limitedReply.body).error.code).toBe('RATE_LIMITED');
    expect(limitedReply.headers['retry-after']).toBeDefined();

    const stillCapturing = await agent
      .post('/api/v1/feedback')
      .set(...XRW)
      .send({ category: 'bug', message: 'A separate report while mid-conversation.' });
    expect(stillCapturing.status).toBe(201);
  });
});

describe('GET /api/v1/feedback/mine', () => {
  it('returns only the caller-owned rows, newest first, with reserved unread counts', async () => {
    const caller = await harness.seedUser({ email: 'mine@bt.test', username: 'mine' });
    const other = await harness.seedUser({ email: 'other@bt.test', username: 'otherfeedback' });
    const [olderMine, newerMine, otherRow] = await harness.db
      .insert(schema.feedback)
      .values([
        {
          userId: caller.id,
          category: 'feature',
          message: 'This shipped.',
          status: 'shipped',
          shippedVersion: '5.4.0',
          createdAt: new Date('2026-08-16T08:00:00.000Z'),
          lastStatusChangeAt: new Date('2026-08-18T08:00:00.000Z'),
        },
        {
          userId: caller.id,
          category: 'bug',
          message: 'This is new.',
          createdAt: new Date('2026-08-17T08:00:00.000Z'),
        },
        {
          userId: other.id,
          category: 'other',
          message: 'This belongs to somebody else.',
          status: 'declined',
          declinedReason: 'It is outside BetterTrack’s product scope.',
          createdAt: new Date('2026-08-18T08:00:00.000Z'),
        },
      ])
      .returning();
    const agent = await loginAgent(harness.app, caller);

    const response = await agent.get('/api/v1/feedback/mine');
    expect(response.status).toBe(200);
    const mine = myFeedbackResponseSchema.parse(response.body);
    expect(mine.submissions.map((row) => row.id)).toEqual([newerMine!.id, olderMine!.id]);
    expect(mine.submissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: olderMine!.id,
          status: 'shipped',
          shippedVersion: '5.4.0',
          declinedReason: null,
          unreadReplyCount: 0,
          lastStatusChangeAt: '2026-08-18T08:00:00.000Z',
        }),
      ]),
    );
    expect(mine.submissions.some((row) => row.id === otherRow!.id)).toBe(false);
  });

  it('admits feedback:read bearers and returns INSUFFICIENT_SCOPE without it', async () => {
    const allowed = await mintKey(['feedback:read']);
    await harness.db.insert(schema.feedback).values({
      userId: allowed.user.id,
      category: 'feature',
      message: 'Native status read-back.',
    });

    const reached = await request(harness.app)
      .get('/api/v1/feedback/mine')
      .set('Authorization', `Bearer ${allowed.token}`);
    expect(reached.status, JSON.stringify(reached.body)).toBe(200);
    expect(myFeedbackResponseSchema.parse(reached.body).submissions).toHaveLength(1);

    const denied = await mintKey(['portfolio:read']);
    const rejected = await request(harness.app)
      .get('/api/v1/feedback/mine')
      .set('Authorization', `Bearer ${denied.token}`);
    expect(rejected.status).toBe(403);
    expect(apiErrorSchema.parse(rejected.body).error.code).toBe('INSUFFICIENT_SCOPE');
  });
});

describe('feedback submission threads', () => {
  it('lets a submitter post/read their thread while another user gets the same no-leak 404 as missing', async () => {
    const owner = await harness.seedUser({
      email: 'thread-owner@bt.test',
      username: 'threadowner',
    });
    const other = await harness.seedUser({
      email: 'thread-other@bt.test',
      username: 'threadother',
    });
    const [submission] = await harness.db
      .insert(schema.feedback)
      .values({ userId: owner.id, category: 'bug', message: 'Thread ownership.' })
      .returning();
    const ownerAgent = await loginAgent(harness.app, owner);
    const otherAgent = await loginAgent(harness.app, other);

    const posted = await ownerAgent
      .post(`/api/v1/feedback/${submission!.id}/messages`)
      .set(...XRW)
      .send({ body: '  More reproduction details.  ' });
    expect(posted.status).toBe(201);
    expect(sendFeedbackMessageResponseSchema.parse(posted.body).message).toMatchObject({
      feedbackId: submission!.id,
      senderId: owner.id,
      authorSide: 'submitter',
      body: 'More reproduction details.',
    });

    const threadResponse = await ownerAgent.get(`/api/v1/feedback/${submission!.id}/messages`);
    expect(threadResponse.status).toBe(200);
    const thread = feedbackThreadResponseSchema.parse(threadResponse.body);
    expect(thread.thread).toEqual({ id: submission!.id, unreadCount: 0 });
    expect(thread.messages.map((message) => message.body)).toEqual(['More reproduction details.']);

    const otherMine = myFeedbackResponseSchema.parse(
      (await otherAgent.get('/api/v1/feedback/mine')).body,
    );
    expect(otherMine.submissions).toEqual([]);

    const foreignRead = await otherAgent.get(`/api/v1/feedback/${submission!.id}/messages`);
    const missingRead = await otherAgent.get(`/api/v1/feedback/${MISSING_ID}/messages`);
    expect(foreignRead.status).toBe(404);
    expect(missingRead.status).toBe(404);
    expect(apiErrorSchema.parse(foreignRead.body)).toEqual(apiErrorSchema.parse(missingRead.body));

    const foreignPost = await otherAgent
      .post(`/api/v1/feedback/${submission!.id}/messages`)
      .set(...XRW)
      .send({ body: 'Must not land.' });
    const missingPost = await otherAgent
      .post(`/api/v1/feedback/${MISSING_ID}/messages`)
      .set(...XRW)
      .send({ body: 'Must not land.' });
    expect(foreignPost.status).toBe(404);
    expect(missingPost.status).toBe(404);
    expect(apiErrorSchema.parse(foreignPost.body)).toEqual(apiErrorSchema.parse(missingPost.body));

    const foreignReadMark = await otherAgent
      .post(`/api/v1/feedback/${submission!.id}/read`)
      .set(...XRW);
    const missingReadMark = await otherAgent
      .post(`/api/v1/feedback/${MISSING_ID}/read`)
      .set(...XRW);
    expect(foreignReadMark.status).toBe(404);
    expect(missingReadMark.status).toBe(404);
    expect(apiErrorSchema.parse(foreignReadMark.body)).toEqual(
      apiErrorSchema.parse(missingReadMark.body),
    );

    const [stored] = await harness.db.select({ value: count() }).from(schema.feedbackMessages);
    expect(stored?.value).toBe(1);
  });

  it('admits feedback:read bearers on a thread and scope-refuses other keys', async () => {
    const allowed = await mintKey(['feedback:read']);
    const [allowedSubmission] = await harness.db
      .insert(schema.feedback)
      .values({ userId: allowed.user.id, category: 'other', message: 'Bearer thread.' })
      .returning();
    const reached = await request(harness.app)
      .get(`/api/v1/feedback/${allowedSubmission!.id}/messages`)
      .set('Authorization', `Bearer ${allowed.token}`);
    expect(reached.status, JSON.stringify(reached.body)).toBe(200);
    expect(feedbackThreadResponseSchema.parse(reached.body).thread.id).toBe(allowedSubmission!.id);

    const denied = await mintKey(['portfolio:read']);
    const [deniedSubmission] = await harness.db
      .insert(schema.feedback)
      .values({ userId: denied.user.id, category: 'other', message: 'Still scope-gated.' })
      .returning();
    const rejected = await request(harness.app)
      .get(`/api/v1/feedback/${deniedSubmission!.id}/messages`)
      .set('Authorization', `Bearer ${denied.token}`);
    expect(rejected.status).toBe(403);
    expect(apiErrorSchema.parse(rejected.body).error.code).toBe('INSUFFICIENT_SCOPE');
  });
});

describe('feedback status storage constraints', () => {
  it('rejects declined rows without reasons and shipped rows without versions', async () => {
    const user = await harness.seedUser({
      email: 'feedback-check@bt.test',
      username: 'feedbackcheck',
    });

    await expect(
      harness.db.insert(schema.feedback).values({
        userId: user.id,
        category: 'other',
        message: 'Missing reason.',
        status: 'declined',
      }),
    ).rejects.toThrow();
    await expect(
      harness.db.insert(schema.feedback).values({
        userId: user.id,
        category: 'feature',
        message: 'Missing version.',
        status: 'shipped',
      }),
    ).rejects.toThrow();
  });

  it('rejects empty and whitespace-only thread bodies at the database constraint', async () => {
    const user = await harness.seedUser({
      email: 'feedback-message-check@bt.test',
      username: 'feedbackmessagecheck',
    });
    const [submission] = await harness.db
      .insert(schema.feedback)
      .values({ userId: user.id, category: 'other', message: 'Storage constraint parent.' })
      .returning();

    for (const body of ['', '   ', '\n\t']) {
      await expect(
        harness.db.insert(schema.feedbackMessages).values({
          feedbackId: submission!.id,
          authorSide: 'submitter',
          authorUserId: user.id,
          body,
        }),
      ).rejects.toThrow();
    }
  });
});

describe('feedback OAuth scope catalog', () => {
  it('grants both scopes to BetterTrackMobile and makes write imply read', () => {
    const mobile = FIRST_PARTY_CLIENTS.find((client) => client.name === 'BetterTrackMobile');
    expect(API_KEY_SCOPES).toContain('feedback:write');
    expect(API_KEY_SCOPES).toContain('feedback:read');
    expect(mobile?.scopeCeiling).toContain('feedback:write');
    expect(mobile?.scopeCeiling).toContain('feedback:read');
    expect(impliedReadScope('feedback:write')).toBe('feedback:read');
  });
});
