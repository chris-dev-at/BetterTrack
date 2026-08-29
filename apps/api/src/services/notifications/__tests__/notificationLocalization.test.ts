import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALERT_KINDS,
  FEEDBACK_STATUSES,
  NOTIFICATION_MESSAGE_KEYS,
  notificationMessageSchema,
  type AlertKind,
  type FeedbackStatus,
  type NotificationMessageKey,
} from '@bettertrack/contracts';

import { createNotificationRepository } from '../../../data/repositories/notificationRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import type { AlertNotificationContext } from '../../../data/repositories/alertRepository';
import type { Database } from '../../../data/db';
import { notifications, notificationSettings, users } from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import {
  createNotificationDispatcher,
  DISPATCHABLE_EVENT_TYPES,
  type DispatchableEvent,
  type NotificationDispatcher,
} from '../notificationDispatcher';
import { NOTIFICATION_COPY, renderNotificationMessage } from '../notificationI18n';

const OCCURRED_AT = '2026-07-20T10:00:00.000Z';

interface CopyCase {
  key: NotificationMessageKey;
  event: DispatchableEvent;
}

const ALERT_SUFFIX: Record<AlertKind, string> = {
  price_above: 'PriceAbove',
  price_below: 'PriceBelow',
  pct_up_from_ref: 'PercentUpReference',
  pct_down_from_ref: 'PercentDownReference',
  pct_day_up: 'PercentDayUp',
  pct_day_down: 'PercentDayDown',
};

function alertKey(prefix: string, kind: AlertKind): NotificationMessageKey {
  return `${prefix}${ALERT_SUFFIX[kind]}` as NotificationMessageKey;
}

/**
 * Every feedback lifecycle status carries its OWN message key. Typed against
 * `FeedbackStatus` so a seventh status cannot silently inherit another's copy,
 * and shared by the copy-case table below and the distinct-title assertion.
 */
const FEEDBACK_STATUS_MESSAGE_KEYS = {
  new: 'feedbackStatusNew',
  triaged: 'feedbackStatusTriaged',
  working_on_it: 'feedbackStatusWorkingOnIt',
  saved_as_future_idea: 'feedbackStatusSavedAsFutureIdea',
  declined: 'feedbackStatusDeclined',
  shipped: 'feedbackStatusShipped',
} as const satisfies Record<FeedbackStatus, NotificationMessageKey>;

/**
 * One event for every copy branch. The two coverage assertions below bind this
 * table both to the dispatchable type tuple and to the message-key tuple, so a
 * future event/variant cannot silently inherit English copy.
 */
function copyCases(userId: string): CopyCase[] {
  const cases: CopyCase[] = [
    {
      key: 'friendRequest',
      event: {
        type: 'friend.request',
        userId,
        actorId: 'actor',
        actorUsername: 'anna',
        requestId: 'request-1',
        occurredAt: OCCURRED_AT,
      },
    },
    {
      key: 'friendAccepted',
      event: {
        type: 'friend.accepted',
        userId,
        actorId: 'actor',
        actorUsername: 'anna',
        requestId: 'request-2',
        occurredAt: OCCURRED_AT,
      },
    },
    {
      key: 'portfolioShared',
      event: {
        type: 'portfolio.shared',
        userId,
        actorId: 'actor',
        actorUsername: 'anna',
        portfolioId: 'portfolio-1',
        occurredAt: OCCURRED_AT,
      },
    },
    {
      key: 'watchlistShared',
      event: {
        type: 'watchlist.shared',
        userId,
        actorId: 'actor',
        actorUsername: 'anna',
        watchlistId: 'watchlist-1',
        occurredAt: OCCURRED_AT,
      },
    },
    {
      key: 'conglomerateShared',
      event: {
        type: 'conglomerate.shared',
        userId,
        actorId: 'actor',
        actorUsername: 'anna',
        conglomerateId: 'conglomerate-1',
        occurredAt: OCCURRED_AT,
      },
    },
  ];

  const friendActivities = [
    ['buy', 'friendActivityBuy'],
    ['sell', 'friendActivitySell'],
    ['watchlist_add', 'friendActivityWatchlistAdd'],
  ] as const;
  for (const [activity, key] of friendActivities) {
    cases.push({
      key,
      event: {
        type: 'friend.activity',
        userId,
        actorId: 'actor',
        actorUsername: 'anna',
        itemKind: activity === 'watchlist_add' ? 'watchlist' : 'portfolio',
        itemId: `item-${activity}`,
        activity,
        assetSymbol: 'AAPL',
        refId: `activity-${activity}`,
        occurredAt: OCCURRED_AT,
      },
    });
  }

  const publishedKinds = [
    ['portfolio', 'followPublishedPortfolio'],
    ['watchlist', 'followPublishedWatchlist'],
    ['conglomerate', 'followPublishedConglomerate'],
    ['idea', 'followPublishedIdea'],
  ] as const;
  for (const [itemKind, key] of publishedKinds) {
    cases.push({
      key,
      event: {
        type: 'follow.published',
        userId,
        actorId: 'actor',
        actorUsername: 'anna',
        itemKind,
        itemId: `published-${itemKind}`,
        itemName: 'Wachstum',
        occurredAt: OCCURRED_AT,
      },
    });
  }

  for (const kind of ALERT_KINDS) {
    cases.push(
      {
        key: alertKey('followAlertCreated', kind),
        event: {
          type: 'follow.alert.created',
          userId,
          actorId: 'actor',
          actorUsername: 'anna',
          alertId: `follow-created:${kind}`,
          assetId: `asset-${kind}`,
          occurredAt: OCCURRED_AT,
        },
      },
      {
        key: alertKey('followAlertFired', kind),
        event: {
          type: 'follow.alert.fired',
          userId,
          actorId: 'actor',
          actorUsername: 'anna',
          alertId: `follow-fired:${kind}`,
          assetId: `asset-${kind}`,
          occurredAt: OCCURRED_AT,
        },
      },
      {
        key: alertKey('alertTriggered', kind),
        event: {
          type: 'alert.triggered',
          userId,
          alertId: `owner:${kind}`,
          assetId: `asset-${kind}`,
          occurredAt: OCCURRED_AT,
        },
      },
    );
  }

  cases.push(
    {
      key: 'accountTempPassword',
      event: { type: 'account.temp_password', userId, occurredAt: OCCURRED_AT },
    },
    {
      key: 'accountDataExport',
      event: { type: 'account.data_export', userId, occurredAt: OCCURRED_AT },
    },
    {
      key: 'earningsReminderConfirmed',
      event: {
        type: 'earnings.reminder',
        userId,
        assetId: 'earnings-confirmed',
        symbol: 'AAPL',
        name: 'Apple',
        earningsDate: '2026-08-01T00:00:00.000Z',
        estimated: false,
        occurredAt: OCCURRED_AT,
      },
    },
    {
      key: 'earningsReminderEstimated',
      event: {
        type: 'earnings.reminder',
        userId,
        assetId: 'earnings-estimated',
        symbol: 'MSFT',
        name: 'Microsoft',
        earningsDate: '2026-08-02T00:00:00.000Z',
        estimated: true,
        occurredAt: OCCURRED_AT,
      },
    },
  );

  const chatVariants = [
    ['chatMessagePreview', 'preview'],
    ['chatMessageSharedItem', 'chip'],
    ['chatMessagePlain', 'plain'],
  ] as const;
  for (const [key, variant] of chatVariants) {
    cases.push({
      key,
      event: {
        type: 'chat.message',
        userId,
        senderId: 'actor',
        senderUsername: 'anna',
        conversationId: `conversation-${variant}`,
        messageId: `message-${variant}`,
        bodyPreview: variant === 'preview' ? 'Hallo' : null,
        hasChip: variant === 'chip',
        occurredAt: OCCURRED_AT,
      },
    });
  }

  cases.push(
    {
      key: 'dividendEvent',
      event: {
        type: 'dividend.event',
        userId,
        assetId: 'dividend-basic',
        symbol: 'AAPL',
        exDate: '2026-08-03T00:00:00.000Z',
        payDate: null,
        amount: null,
        currency: null,
        occurredAt: OCCURRED_AT,
      },
    },
    {
      key: 'dividendEventWithAmount',
      event: {
        type: 'dividend.event',
        userId,
        assetId: 'dividend-amount',
        symbol: 'MSFT',
        exDate: '2026-08-04T00:00:00.000Z',
        payDate: null,
        amount: 0.75,
        currency: 'USD',
        occurredAt: OCCURRED_AT,
      },
    },
    {
      key: 'budgetExceeded',
      event: {
        type: 'budget.exceeded',
        userId,
        budgetId: 'budget-1',
        categoryId: 'category-1',
        categoryName: 'Lebensmittel',
        period: '2026-07',
        amount: 300,
        spent: 325,
        currency: 'EUR',
        occurredAt: OCCURRED_AT,
      },
    },
  );

  const standingVariants = [
    ['standingOrderDeferredNamed', 'deferred', 1, 'Netflix'],
    ['standingOrderDeferredUnnamed', 'deferred', 1, null],
    ['standingOrderDroppedNamed', 'dropped', 1, 'Netflix'],
    ['standingOrderDroppedUnnamed', 'dropped', 1, null],
    ['standingOrderDroppedManyNamed', 'dropped', 3, 'Netflix'],
    ['standingOrderDroppedManyUnnamed', 'dropped', 3, null],
    ['standingOrderBookingFailedNamed', 'booking_failed', 1, 'Netflix'],
    ['standingOrderBookingFailedUnnamed', 'booking_failed', 1, null],
  ] as const;
  for (const [key, outcome, droppedCount, orderLabel] of standingVariants) {
    cases.push({
      key,
      event: {
        type: 'standing_order.skipped',
        userId,
        standingOrderId: `order-${key}`,
        periodKey: '2026-07-01',
        outcome,
        ...(outcome === 'dropped' ? { droppedCount } : {}),
        orderLabel,
        occurredAt: OCCURRED_AT,
      },
    });
  }

  const mirrorVariants = [
    ['mirror.invite', 'mirrorInvite'],
    ['mirror.member_joined', 'mirrorMemberJoined'],
    ['mirror.member_left', 'mirrorMemberLeft'],
    ['mirror.member_removed', 'mirrorMemberRemoved'],
    ['mirror.removed', 'mirrorRemoved'],
    ['mirror.ownership_transferred', 'mirrorOwnershipTransferred'],
    ['mirror.chain_dissolved', 'mirrorChainDissolved'],
    ['mirror.sync_stalled', 'mirrorSyncStalled'],
  ] as const;
  for (const [type, key] of mirrorVariants) {
    cases.push({
      key,
      event: {
        type,
        userId,
        chainId: 'chain-1',
        chainName: 'Familie',
        actorId: 'actor',
        ownerId: 'owner',
        subjectUserIds: ['actor'],
        actorUsername: 'anna',
        refId: `ref-${type}`,
        occurredAt: OCCURRED_AT,
      },
    });
  }

  for (const status of FEEDBACK_STATUSES) {
    cases.push({
      key: FEEDBACK_STATUS_MESSAGE_KEYS[status],
      event: {
        type: 'feedback.status_changed',
        userId,
        feedbackId: `feedback-${status}`,
        status,
        lastStatusChangeAt: OCCURRED_AT,
        occurredAt: OCCURRED_AT,
      },
    });
  }
  cases.push({
    key: 'feedbackReplyCreated',
    event: {
      type: 'feedback.reply_created',
      userId,
      feedbackId: 'feedback-reply',
      messageId: 'feedback-message-1',
      occurredAt: OCCURRED_AT,
    },
  });

  return cases;
}

function alertContext(userId: string, alertId: string): AlertNotificationContext | null {
  const kind = alertId.split(':').at(-1);
  if (!ALERT_KINDS.includes(kind as AlertKind)) return null;
  return {
    userId,
    assetId: `asset-${kind}`,
    symbol: 'AAPL',
    name: 'Apple',
    currency: 'EUR',
    kind: kind as AlertKind,
    threshold: 200,
  };
}

let harness: TestHarness;
let db: Database;

beforeEach(async () => {
  harness = await createTestApp();
  db = harness.db;
});

afterEach(async () => {
  await harness.ctx.events.close();
});

function dispatcherFor(userId: string): NotificationDispatcher {
  return createNotificationDispatcher({
    bus: harness.ctx.events,
    repo: createNotificationRepository(db),
    users: createUserRepository(db),
    resolveAlert: async (alertId) => alertContext(userId, alertId),
    logger: harness.ctx.logger,
  });
}

describe('dispatcher notification localization (#1138)', () => {
  it('renders every dispatcher type and copy variant in the DE recipient locale', async () => {
    const recipient = await harness.seedUser({ email: 'de@bt.test', username: 'de-user' });
    await db.update(users).set({ locale: 'de' }).where(eq(users.id, recipient.id));
    await db.insert(notificationSettings).values({
      userId: recipient.id,
      channel: 'inapp',
      enabled: true,
      config: Object.fromEntries(DISPATCHABLE_EVENT_TYPES.map((type) => [type, true])),
    });

    const cases = copyCases(recipient.id);
    expect(new Set(cases.map(({ event }) => event.type))).toEqual(
      new Set(DISPATCHABLE_EVENT_TYPES),
    );
    expect(new Set(cases.map(({ key }) => key))).toEqual(new Set(NOTIFICATION_MESSAGE_KEYS));

    const dispatcher = dispatcherFor(recipient.id);
    for (const testCase of cases) await dispatcher.dispatch(testCase.event);

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, recipient.id));
    expect(rows.filter((row) => !row.hidden)).toHaveLength(cases.length);

    const byKey = new Map(
      rows.map((row) => {
        const payload = row.payload as Record<string, unknown>;
        return [notificationMessageSchema.parse(payload.message).key, row] as const;
      }),
    );
    for (const testCase of cases) {
      const row = byKey.get(testCase.key);
      expect(row, testCase.key).toBeDefined();
      const payload = row!.payload as Record<string, unknown>;
      const message = notificationMessageSchema.parse(payload.message);
      const expected = renderNotificationMessage(message, 'de');
      expect({ title: row!.title, body: row!.body }, testCase.key).toEqual(expected);
      expect(expected, `${testCase.key}: German copy must not equal English`).not.toEqual(
        renderNotificationMessage(message, 'en'),
      );
      expect(`${row!.title} ${row!.body}`, testCase.key).not.toMatch(/\{\{/);
    }
    expect(byKey.get('friendRequest')).toMatchObject({
      title: 'Neue Freundschaftsanfrage',
      body: 'anna hat dir eine Freundschaftsanfrage gesendet.',
    });
  });

  it('keeps eventKey dedupe identical across locales and a later locale change', async () => {
    const de = await harness.seedUser({ email: 'dedupe-de@bt.test', username: 'dedupe-de' });
    const en = await harness.seedUser({ email: 'dedupe-en@bt.test', username: 'dedupe-en' });
    await db.update(users).set({ locale: 'de' }).where(eq(users.id, de.id));

    const eventFor = (userId: string): DispatchableEvent => ({
      type: 'friend.request',
      userId,
      actorId: 'actor',
      actorUsername: 'anna',
      requestId: 'same-logical-request',
      occurredAt: OCCURRED_AT,
    });
    await dispatcherFor(de.id).dispatch(eventFor(de.id));
    await dispatcherFor(en.id).dispatch(eventFor(en.id));

    const firstRows = await db.select().from(notifications);
    expect(firstRows).toHaveLength(2);
    expect(firstRows.map((row) => (row.payload as Record<string, string>).eventKey)).toEqual([
      'friend.request:same-logical-request',
      'friend.request:same-logical-request',
    ]);

    await db.update(users).set({ locale: 'en' }).where(eq(users.id, de.id));
    await dispatcherFor(de.id).dispatch(eventFor(de.id));
    expect(await db.select().from(notifications)).toHaveLength(2);
  });

  it('ships distinct EN and DE server templates for every stable message key', () => {
    expect(Object.keys(NOTIFICATION_COPY.en)).toEqual([...NOTIFICATION_MESSAGE_KEYS]);
    expect(Object.keys(NOTIFICATION_COPY.de)).toEqual([...NOTIFICATION_MESSAGE_KEYS]);
    for (const key of NOTIFICATION_MESSAGE_KEYS) {
      expect(NOTIFICATION_COPY.de[key], key).not.toEqual(NOTIFICATION_COPY.en[key]);
    }
  });

  it('keeps every feedback lifecycle title distinct within each locale', () => {
    // The property the per-status titles exist for: a push banner frequently
    // renders the title alone, so "under review" and "declined" must not both
    // read "Feedback update". Nothing else pins it — key coverage, the per-key
    // DE≠EN check and the server↔web byte-identity test all stay green if the
    // six titles are re-collapsed onto one shared string in both catalogs.
    // Byte-identity carries this to the web catalogs transitively.
    for (const locale of ['en', 'de'] as const) {
      const titles = FEEDBACK_STATUSES.map(
        (status) => NOTIFICATION_COPY[locale][FEEDBACK_STATUS_MESSAGE_KEYS[status]].title,
      );
      expect(new Set(titles).size, `${locale}: feedbackStatus* titles`).toBe(titles.length);
    }
  });

  it('keeps the server catalog byte-identical to the web inbox catalog', () => {
    // The same pairs are maintained twice: here for the persisted fallback,
    // push, digest and email bodies, and in the SPA catalogs for live inbox
    // re-rendering. Nothing but this assertion binds them, and a one-sided edit
    // would make the bell disagree with the push for the SAME event with
    // everything still green. The web catalogs are plain JSON, so reading them
    // across the package boundary costs one fs read and no build coupling.
    for (const locale of ['en', 'de'] as const) {
      const path = fileURLToPath(
        new URL(`../../../../../web/src/i18n/messages/${locale}.json`, import.meta.url),
      );
      const catalog = JSON.parse(readFileSync(path, 'utf8')) as {
        notificationContent?: Record<string, { title?: string; body?: string }>;
      };
      expect(catalog.notificationContent, `${locale}.json: notificationContent`).toBeDefined();
      for (const key of NOTIFICATION_MESSAGE_KEYS) {
        expect(catalog.notificationContent?.[key], `${locale}.json: ${key}`).toEqual(
          NOTIFICATION_COPY[locale][key],
        );
      }
    }
  });
});
