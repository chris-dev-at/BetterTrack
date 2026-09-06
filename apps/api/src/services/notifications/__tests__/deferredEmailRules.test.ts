import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuditRepository } from '../../../data/repositories/auditRepository';
import { createEmailLogRepository } from '../../../data/repositories/emailLogRepository';
import { createNotificationDigestRepository } from '../../../data/repositories/notificationDigestRepository';
import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import type { Database } from '../../../data/db';
import { emailLog, notificationDigestQueue, notificationSettings } from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { createAuditService } from '../../audit/auditService';
import { createEmailService, type EmailService } from '../../email/emailService';
import type { MailTransport, OutgoingMail } from '../../email/transport';
import { createDigestService, type DigestService } from '../digestService';
import type { PushMessage } from '../fcm';
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from '../notificationDispatcher';

/**
 * The per-type e-mail rules on the DEFERRED paths (#1816, §13.5 V5-P3). A digest
 * row and a quiet-hours deferral are rendered from the queue row rather than
 * from the event, so the instant path's rules — escape what the user supplied,
 * withhold chat content, ship no e-mail for a type that has no template, deep-
 * link to the notification's own target, log the real template — have to hold at
 * enqueue and release time too. They did not.
 */

const OCCURRED_AT = '2026-07-18T23:00:00.000Z';

// SMTP env flips config.email.enabled on so the email service actually delivers.
const SMTP_ENV = {
  SMTP_HOST: 'smtp.test.local',
  SMTP_PORT: '587',
  SMTP_FROM: 'BetterTrack <no-reply@test.local>',
} satisfies Partial<NodeJS.ProcessEnv>;

// A UTC overnight quiet window 22:00→07:00.
const QUIET_START = 22 * 60;
const QUIET_END = 7 * 60;

const INSIDE_WINDOW = new Date('2026-07-18T23:00:00.000Z');
const AFTER_WINDOW = new Date('2026-07-19T07:00:30.000Z');

let harness: TestHarness;
let db: Database;
let transport: MailTransport & { sent: OutgoingMail[] };
let email: EmailService;
let digestRepo: ReturnType<typeof createNotificationDigestRepository>;
let userRepo: ReturnType<typeof createUserRepository>;
let pushCalls: { userId: string; message: PushMessage }[];
let clock: Date;

function makeDispatcher(): NotificationDispatcher {
  return createNotificationDispatcher({
    bus: harness.ctx.events,
    repo: createNotificationRepository(db),
    email,
    users: userRepo,
    fcm: {
      async deliver(userId: string, message: PushMessage) {
        pushCalls.push({ userId, message });
      },
    } as never,
    digest: {
      cadenceFor: (userId, type) => digestRepo.cadenceFor(userId, type),
      enqueue: (item) => digestRepo.enqueue(item),
    },
    quietHours: { enqueueDeferred: (item) => digestRepo.enqueueDeferred(item) },
    now: () => clock,
    logger: harness.ctx.logger,
  });
}

function makeDigestService(): DigestService {
  return createDigestService({
    repo: digestRepo,
    users: userRepo,
    email,
    fcm: {
      async deliver(userId: string, message: PushMessage) {
        pushCalls.push({ userId, message });
      },
    },
    quietHours: digestRepo,
    routing: createNotificationRepository(db),
    now: () => clock,
    logger: harness.ctx.logger,
  });
}

/** Opt a user into email for the given types (email defaults OFF, V4-P0c). */
async function enableEmailFor(userId: string, ...types: string[]): Promise<void> {
  await db.insert(notificationSettings).values({
    userId,
    channel: 'email',
    enabled: true,
    config: Object.fromEntries(types.map((type) => [type, true])),
  });
}

async function enableQuietHours(userId: string): Promise<void> {
  await userRepo.setQuietHours(userId, {
    enabled: true,
    startMinute: QUIET_START,
    endMinute: QUIET_END,
    timezone: null,
  });
}

async function queueRows(userId: string) {
  return db
    .select()
    .from(notificationDigestQueue)
    .where(eq(notificationDigestQueue.userId, userId));
}

async function logFor(recipient: string) {
  const rows = await db.select().from(emailLog).orderBy(desc(emailLog.id));
  return rows.filter((r) => r.recipient === recipient);
}

beforeEach(async () => {
  harness = await createTestApp({ env: SMTP_ENV });
  db = harness.db;
  transport = {
    sent: [],
    async send(mail) {
      (transport.sent as OutgoingMail[]).push(mail);
    },
  } as MailTransport & { sent: OutgoingMail[] };
  email = createEmailService({
    config: harness.ctx.config,
    logger: harness.ctx.logger,
    audit: createAuditService(createAuditRepository(db)),
    emailLog: createEmailLogRepository(db),
    transport,
  });
  digestRepo = createNotificationDigestRepository(db);
  userRepo = createUserRepository(db);
  pushCalls = [];
  clock = INSIDE_WINDOW;
});

afterEach(async () => {
  await harness.ctx.events.close();
});

describe('deferred email — user-supplied markup stays inert (#1816)', () => {
  it('renders a mirrorchain name carrying markup as text through the quiet-hours path', async () => {
    // 99 chars, so it passes `chainNameSchema` (trim, min 1, max 120).
    const chainName = '</td></tr><tr><td><a href="https://evil.example">Reset your password</a>';
    const user = await harness.seedUser({ email: 'mirror@bt.test', username: 'mirroruser' });
    await enableEmailFor(user.id, 'mirror.member_joined');
    await enableQuietHours(user.id);

    await makeDispatcher().dispatch({
      type: 'mirror.member_joined',
      userId: user.id,
      chainId: 'chain-1',
      chainName,
      actorId: 'actor-1',
      ownerId: user.id,
      subjectUserIds: [],
      actorUsername: 'mallory',
      refId: 'join-1',
      occurredAt: OCCURRED_AT,
    });
    // Held back: nothing sent inside the window.
    expect(transport.sent).toHaveLength(0);

    clock = AFTER_WINDOW;
    // `sent` counts every channel; the e-mail is the one under test.
    await makeDigestService().deliverDeferred();
    expect(transport.sent).toHaveLength(1);

    const html = transport.sent[0]!.html ?? '';
    expect(html).not.toContain('href="https://evil.example"');
    expect(html).not.toContain('</td></tr><tr><td><a');
    expect(html).toContain('&lt;/td&gt;&lt;/tr&gt;');
    // The template's own button is the only anchor that survives.
    expect(html.match(/<a /g) ?? []).toHaveLength(1);
  });
});

describe('deferred email — the chat content policy (#1816)', () => {
  const PREVIEW = 'my IBAN is AT61 1904 3002 3457 3201';

  function chatEvent(userId: string, messageId: string) {
    return {
      type: 'chat.message',
      userId,
      senderId: 'sender-1',
      senderUsername: 'alice',
      conversationId: 'conv-1',
      messageId,
      bodyPreview: PREVIEW,
      hasChip: false,
      occurredAt: OCCURRED_AT,
    } as const;
  }

  it('delivers no message preview when quiet hours defer the chat notification', async () => {
    const user = await harness.seedUser({ email: 'chat@bt.test', username: 'chatuser' });
    await enableEmailFor(user.id, 'chat.message');
    await enableQuietHours(user.id);

    await makeDispatcher().dispatch(chatEvent(user.id, 'msg-1'));
    // Not even the queue row carries it — the digest line is built from this body.
    const queued = await queueRows(user.id);
    const emailRow = queued.find((row) => row.channel === 'email')!;
    expect(emailRow.body).not.toContain('IBAN');
    expect(emailRow.body).toContain('alice');

    clock = AFTER_WINDOW;
    // `sent` counts every channel; the e-mail is the one under test.
    await makeDigestService().deliverDeferred();
    expect(transport.sent).toHaveLength(1);
    const mail = transport.sent[0]!;
    expect(mail.html ?? '').not.toContain('IBAN');
    expect(mail.text ?? '').not.toContain('IBAN');
    expect(mail.html ?? '').toContain('alice');

    // And the log row records no content either (§6.10: never bodies).
    const rows = await logFor(user.email);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('IBAN');
  });

  it('delivers no message preview inside a daily digest, nor in its summary line', async () => {
    const user = await harness.seedUser({ email: 'chatd@bt.test', username: 'chatdigest' });
    await enableEmailFor(user.id, 'chat.message');
    await digestRepo.setCadences(user.id, { 'chat.message': 'daily' });

    await makeDispatcher().dispatch(chatEvent(user.id, 'msg-2'));
    expect(transport.sent).toHaveLength(0);

    // A later period closes the queued one.
    clock = new Date('2026-07-26T09:00:00.000Z');
    await makeDigestService().deliverDue('daily');
    expect(transport.sent).toHaveLength(1);
    const mail = transport.sent[0]!;
    // The summary line is `title: body` — both come from the sanitized row.
    expect(mail.html ?? '').not.toContain('IBAN');
    expect(mail.text ?? '').not.toContain('IBAN');
    expect(mail.text ?? '').toContain('alice');

    const rows = await logFor(user.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.template).toBe('digest');
  });

  it('withholds the preview on the instant path too — the deferred body matches it', async () => {
    const user = await harness.seedUser({ email: 'chati@bt.test', username: 'chatinstant' });
    await enableEmailFor(user.id, 'chat.message');

    clock = new Date('2026-07-18T09:00:00.000Z'); // outside any window; no quiet hours set
    await makeDispatcher().dispatch(chatEvent(user.id, 'msg-3'));
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.html ?? '').not.toContain('IBAN');
    expect((await logFor(user.email))[0]!.template).toBe('chat_message');
  });
});

describe('deferred email — types that ship no email template (#1816)', () => {
  function budgetEvent(userId: string, fireId: string) {
    return {
      type: 'budget.exceeded',
      userId,
      budgetId: 'budget-1',
      categoryId: 'tag-1',
      categoryName: 'Groceries',
      period: '2026-07',
      fireId,
      amount: 200,
      spent: 260,
      currency: 'EUR',
      occurredAt: OCCURRED_AT,
    } as const;
  }

  it('sends no budget.exceeded email from a daily digest, even with email routed on', async () => {
    const user = await harness.seedUser({ email: 'budget@bt.test', username: 'budgetuser' });
    await enableEmailFor(user.id, 'budget.exceeded');
    await digestRepo.setCadences(user.id, { 'budget.exceeded': 'daily' });

    await makeDispatcher().dispatch(budgetEvent(user.id, 'fire-1'));

    // The push row still queued — the drop is the EMAIL cell, not the event.
    const channels = (await queueRows(user.id)).map((row) => row.channel).sort();
    expect(channels).not.toContain('email');
    expect(channels).toContain('push');

    clock = new Date('2026-07-26T09:00:00.000Z');
    await makeDigestService().deliverDue('daily');
    expect(transport.sent).toHaveLength(0);
    expect(await logFor(user.email)).toHaveLength(0);
    expect(pushCalls).toHaveLength(1);
  });

  it('sends no budget.exceeded email from a quiet-hours release either', async () => {
    const user = await harness.seedUser({ email: 'budgetq@bt.test', username: 'budgetquiet' });
    await enableEmailFor(user.id, 'budget.exceeded');
    await enableQuietHours(user.id);

    await makeDispatcher().dispatch(budgetEvent(user.id, 'fire-2'));
    const channels = (await queueRows(user.id)).map((row) => row.channel);
    expect(channels).not.toContain('email');

    clock = AFTER_WINDOW;
    await makeDigestService().deliverDeferred();
    expect(transport.sent).toHaveLength(0);
    expect(await logFor(user.email)).toHaveLength(0);
  });

  it('drops an email row queued before the rule, at release time', async () => {
    const user = await harness.seedUser({ email: 'legacy@bt.test', username: 'legacyuser' });
    await enableEmailFor(user.id, 'budget.exceeded');
    // The shape the dispatcher used to enqueue.
    await digestRepo.enqueueDeferred({
      userId: user.id,
      type: 'budget.exceeded',
      channel: 'email',
      title: 'Budget exceeded',
      body: 'Groceries is over budget.',
      deliverAfter: INSIDE_WINDOW,
    });

    clock = AFTER_WINDOW;
    const res = await makeDigestService().deliverDeferred();
    expect(res.sent).toBe(0);
    expect(res.dropped).toBe(1);
    expect(transport.sent).toHaveLength(0);
  });
});

describe('deferred email — log row and deep link (#1816)', () => {
  it('logs a quiet-hours release under `deferred`, not `digest`, and keeps the deep link', async () => {
    const user = await harness.seedUser({ email: 'orders@bt.test', username: 'orderuser' });
    await enableEmailFor(user.id, 'standing_order.skipped');
    await enableQuietHours(user.id);
    const standingOrderId = '00000000-0000-7000-8000-00000000a111';

    await makeDispatcher().dispatch({
      type: 'standing_order.skipped',
      userId: user.id,
      standingOrderId,
      periodKey: '2026-07-01',
      outcome: 'booking_failed',
      orderLabel: 'Netflix',
      occurredAt: OCCURRED_AT,
    });
    expect(transport.sent).toHaveLength(0);

    clock = AFTER_WINDOW;
    // `sent` counts every channel; the e-mail is the one under test.
    await makeDigestService().deliverDeferred();
    expect(transport.sent).toHaveLength(1);

    const mail = transport.sent[0]!;
    expect(mail.html ?? '').toContain(`/workbench/forecasts#standing-order-${standingOrderId}`);
    expect(mail.text ?? '').toContain(`/workbench/forecasts#standing-order-${standingOrderId}`);

    const rows = await logFor(user.email);
    expect(rows).toHaveLength(1);
    // A single held-back notification is NOT a digest — support has to be able
    // to tell them apart in the admin email log.
    expect(rows[0]!.template).toBe('deferred');
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.subject).toBe(mail.subject);
  });
});
