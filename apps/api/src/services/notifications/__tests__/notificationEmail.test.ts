import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuditRepository } from '../../../data/repositories/auditRepository';
import { createEmailLogRepository } from '../../../data/repositories/emailLogRepository';
import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import type { Database } from '../../../data/db';
import {
  emailLog,
  notifications,
  notificationSettings,
  type EmailLogRow,
} from '../../../data/schema';
import type { FriendRequestEvent } from '../../../events';
import { createAuditService } from '../../audit/auditService';
import { createEmailService, type EmailService } from '../../email/emailService';
import type { MailTransport, OutgoingMail } from '../../email/transport';
import {
  createTestApp,
  type CreateTestAppOptions,
  type TestHarness,
} from '../../../testing/createTestApp';
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from '../notificationDispatcher';

const OCCURRED_AT = '2026-07-04T00:00:00.000Z';

// SMTP env flips config.email.enabled on so the email service actually delivers.
const SMTP_ENV = {
  SMTP_HOST: 'smtp.test.local',
  SMTP_PORT: '587',
  SMTP_FROM: 'BetterTrack <no-reply@test.local>',
} satisfies Partial<NodeJS.ProcessEnv>;

function recordingTransport(
  opts: { fail?: boolean } = {},
): MailTransport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
      if (opts.fail) throw Object.assign(new Error('boom'), { code: 'ECONNECTION' });
    },
  };
}

let harness: TestHarness;
let db: Database;
let dispatcher: NotificationDispatcher;

async function setup(options: CreateTestAppOptions, transport: MailTransport | null) {
  harness = await createTestApp(options);
  db = harness.db;
  const email: EmailService = createEmailService({
    config: harness.ctx.config,
    logger: harness.ctx.logger,
    audit: createAuditService(createAuditRepository(db)),
    emailLog: createEmailLogRepository(db),
    transport,
  });
  dispatcher = createNotificationDispatcher({
    bus: harness.ctx.events,
    repo: createNotificationRepository(db),
    email,
    users: createUserRepository(db),
    logger: harness.ctx.logger,
  });
}

afterEach(async () => {
  await harness.ctx.events.close();
});

/** Inbox-visible rows only — hidden rows are dedupe markers (#368). */
async function visibleInappRows(userId: string) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
  return rows.filter((r) => !r.hidden);
}

async function logFor(recipient: string): Promise<EmailLogRow[]> {
  const rows = await db.select().from(emailLog).orderBy(desc(emailLog.id));
  return rows.filter((r) => r.recipient === recipient);
}

function friendRequestEvent(overrides: Partial<FriendRequestEvent> = {}): FriendRequestEvent {
  return {
    type: 'friend.request',
    userId: 'recipient',
    actorId: 'actor',
    actorUsername: 'alice',
    requestId: 'req-1',
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

/**
 * Opt a user into email for the given types (V4-P0c: email defaults OFF for
 * every non-account/security type, so the dispatcher's email fan-out only runs
 * when the user explicitly enabled it). Writes an email settings row with the
 * per-type overrides ON — the same shape the settings matrix persists.
 */
async function enableEmailFor(userId: string, ...types: string[]): Promise<void> {
  await db.insert(notificationSettings).values({
    userId,
    channel: 'email',
    enabled: true,
    config: Object.fromEntries(types.map((type) => [type, true])),
  });
}

describe('notification email dispatch (PROJECTPLAN.md §6.10)', () => {
  beforeEach(async () => {
    await setup({ env: SMTP_ENV }, recordingTransport());
  });

  it('sends a friend.request email and logs it as `sent`', async () => {
    const recipient = await harness.seedUser({ email: 'rex@bt.test', username: 'rex' });
    await enableEmailFor(recipient.id, 'friend.request');
    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id, actorUsername: 'anna' }));

    const rows = await logFor(recipient.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.template).toBe('friend_request');
    expect(rows[0]!.userId).toBe(recipient.id);
  });

  it('sends friend.accepted and portfolio.shared emails', async () => {
    const recipient = await harness.seedUser({ email: 'rec@bt.test', username: 'rec' });
    await enableEmailFor(recipient.id, 'friend.accepted', 'portfolio.shared');

    await dispatcher.dispatch({
      type: 'friend.accepted',
      userId: recipient.id,
      actorId: 'a',
      actorUsername: 'bob',
      requestId: 'req-9',
      occurredAt: OCCURRED_AT,
    });
    await dispatcher.dispatch({
      type: 'portfolio.shared',
      userId: recipient.id,
      actorId: 'o',
      actorUsername: 'carol',
      portfolioId: 'pf-1',
      occurredAt: OCCURRED_AT,
    });

    const templates = (await logFor(recipient.email)).map((r) => r.template).sort();
    expect(templates).toEqual(['friend_accepted', 'portfolio_shared']);
  });

  it('does not email when the recipient disabled the email channel', async () => {
    const recipient = await harness.seedUser({ email: 'quiet@bt.test', username: 'quiet' });
    await db
      .insert(notificationSettings)
      .values({ userId: recipient.id, channel: 'email', enabled: false });

    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));

    expect(await logFor(recipient.email)).toHaveLength(0);
  });

  it('bell-only: a type muted for email produces only the in-app row, no email', async () => {
    const recipient = await harness.seedUser({ email: 'bell@bt.test', username: 'bell' });
    await db.insert(notificationSettings).values({
      userId: recipient.id,
      channel: 'email',
      enabled: true,
      config: { 'friend.request': false },
    });

    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));

    expect(await logFor(recipient.email)).toHaveLength(0);
    expect(await visibleInappRows(recipient.id)).toHaveLength(1);
  });

  it('email-only: a type muted for in-app sends email but surfaces no inbox row', async () => {
    const recipient = await harness.seedUser({ email: 'mailonly@bt.test', username: 'mailonly' });
    await db.insert(notificationSettings).values({
      userId: recipient.id,
      channel: 'inapp',
      enabled: true,
      config: { 'friend.request': false },
    });
    // Email defaults OFF for friend.request now (V4-P0c) — opt in explicitly.
    await enableEmailFor(recipient.id, 'friend.request');

    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));

    expect(await logFor(recipient.email)).toHaveLength(1);
    // No visible inbox row — only the hidden dedupe marker (#368).
    expect(await visibleInappRows(recipient.id)).toHaveLength(0);
  });

  it('muted: a type off on both channels surfaces neither an inbox row nor an email', async () => {
    const recipient = await harness.seedUser({ email: 'muted@bt.test', username: 'muted' });
    await db.insert(notificationSettings).values([
      {
        userId: recipient.id,
        channel: 'inapp',
        enabled: true,
        config: { 'friend.request': false },
      },
      {
        userId: recipient.id,
        channel: 'email',
        enabled: true,
        config: { 'friend.request': false },
      },
    ]);

    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));

    expect(await logFor(recipient.email)).toHaveLength(0);
    expect(await visibleInappRows(recipient.id)).toHaveLength(0);
  });

  it('does not re-email a redelivered event (deduped via the in-app row)', async () => {
    const recipient = await harness.seedUser({ email: 'once@bt.test', username: 'once' });
    await enableEmailFor(recipient.id, 'friend.request');
    const event = friendRequestEvent({ userId: recipient.id });

    await dispatcher.dispatch(event);
    await dispatcher.dispatch(event);

    expect(await logFor(recipient.email)).toHaveLength(1);
  });
});

describe('notification email dispatch with SMTP unconfigured (PROJECTPLAN.md §6.10)', () => {
  beforeEach(async () => {
    // No SMTP env ⇒ channel unconfigured; the send is logged `suppressed`.
    await setup({}, null);
  });

  it('logs `suppressed` and sends nothing', async () => {
    const recipient = await harness.seedUser({ email: 'nomail@bt.test', username: 'nomail' });
    await enableEmailFor(recipient.id, 'friend.request');
    await dispatcher.dispatch(friendRequestEvent({ userId: recipient.id }));

    const rows = await logFor(recipient.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('suppressed');
    // The in-app row is still written — SMTP being off doesn't suppress in-app.
    expect(await visibleInappRows(recipient.id)).toHaveLength(1);
  });
});
