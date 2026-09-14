import {
  isUrgentNotification,
  type DigestCadence,
  type NotificationMessage,
  type NotificationCadence,
} from '@bettertrack/contracts';

import type { EventBus } from '../../events';
import type {
  AccountDataExportEvent,
  AccountTempPasswordEvent,
  AlertTriggeredEvent,
  BudgetExceededEvent,
  ChatMessageEvent,
  CommentCreatedEvent,
  ConglomerateSharedEvent,
  DividendEventNotice,
  EarningsReminderEvent,
  FeedbackReplyCreatedEvent,
  FeedbackStatusChangedEvent,
  FollowAlertCreatedEvent,
  FollowAlertFiredEvent,
  FollowPublishedEvent,
  FriendAcceptedEvent,
  FriendActivityEvent,
  FriendRequestEvent,
  MirrorNotificationEvent,
  PortfolioSharedEvent,
  StandingOrderSkippedEvent,
  WatchlistSharedEvent,
} from '../../events';
import type {
  NotificationRepository,
  TypeRouting,
} from '../../data/repositories/notificationRepository';
import type {
  EnqueueDeferredItemInput,
  EnqueueDigestItemInput,
} from '../../data/repositories/notificationDigestRepository';
import type { AlertNotificationContext } from '../../data/repositories/alertRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { alertNotificationMessage, followAlertNotificationMessage } from '../alerts/alertMessages';
import type { EmailService } from '../email/emailService';
import type { MirrorEmailVariant } from '../email/templates';
import type { Logger } from '../../logger';

import { notificationChannelSkippedTotal } from '../../metrics';

import type { DiscordChannel } from './discordChannel';
import { digestPeriodKey } from './digestService';
import { notificationTypeShipsEmail } from './emailTypeRules';
import type { DeactivatableChannel } from './killSwitch';
import type { FcmChannel, PushMessage } from './fcm';
import type { PresenceStore } from './presence';
import { isInQuietHours, quietHoursWindowEnd } from './quietHours';
import { quietHoursConfigForUser } from './quietHoursConfig';
import type { TelegramChannel } from './telegramChannel';
import type { WebPushChannel } from './webPush';
import { notificationMessage, renderNotificationMessage } from './notificationI18n';

/**
 * The central notification dispatcher (#368 Notifications v2; PROJECTPLAN.md
 * §6.10, §9, §14). ONE delivery core every notification-producing subsystem
 * feeds — never a per-source fork: an event arrives (via the durable
 * `notifications.dispatch` BullMQ job in production, directly in tests), the
 * dispatcher resolves the recipient's per-type × per-channel matrix and fans
 * out to the enabled channels: in-app inbox row, email, phone push (FCM),
 * browser push (web-push). Sources NEVER talk to channels directly.
 *
 * Delivery rules:
 *  - **Idempotent under at-least-once.** Every dispatch writes exactly one
 *    `notifications` row per (recipient, eventKey) — visible when in-app is
 *    routed, `hidden` (a pure dedupe marker) when it isn't — so a BullMQ retry
 *    or a duplicate emit re-reads the marker and no-ops. Channels after the
 *    marker are best-effort by design (the §6.10 email philosophy, extended to
 *    push): a transport failure logs and never throws back into the job.
 *  - **Global mute** (`users.notifications_muted`) suppresses every channel;
 *    only the hidden dedupe marker is written.
 *  - **Presence suppression** (#368 owner mandate): when the recipient is
 *    actively viewing the surface an event belongs to (v1: the chat
 *    conversation of a `chat.message`, TTL-bounded via {@link PresenceStore}),
 *    nothing notifies — the row persists already-read (no unread bump, no
 *    bell push, no email/push) and the message simply lands in the open thread.
 *  - **Defaults on.** A user with no settings row gets every channel; only an
 *    explicit override (or mute/presence) suppresses.
 *  - **A deactivated channel never CONSUMES an event** (V5-P0 kill-switch,
 *    #1795). Telegram and Discord arrive here as `null` while
 *    `BT_TELEGRAM_DISCORD_ENABLED` is off. The rule, in one sentence: *an event
 *    whose only destinations are deactivated channels the recipient is actually
 *    linked to is left undelivered and re-deliverable — no inbox row, no dedupe
 *    marker, nothing written* — so the very same event re-dispatched after the
 *    env flip delivers exactly once. It is deliberately NOT rerouted to the bell
 *    (that would invent a channel the user routed off) and deliberately NOT
 *    marked delivered (that is precisely the permanent swallow this rule exists
 *    to prevent). Two deliberate exclusions: a recipient with no linked chat /
 *    saved webhook loses nothing (the default matrix routes both channels ON for
 *    every type, so treating that as a loss would defer nearly every event on a
 *    deactivated deployment), and a globally muted recipient keeps the existing
 *    hidden marker (mute is the user's own decision, not a deployment failure).
 *    Every skipped fan-out — whether the event reached other live channels
 *    (`dropped`) or had none (`deferred`) — increments
 *    `bettertrack_notification_channel_skipped_total` and warns once per
 *    (channel, outcome) per process, so an operator running with the switch off
 *    can see what it costs.
 *
 * The dispatcher is NOT a bus subscriber anymore: the Redis pub/sub bus stays
 * strictly ephemeral (realtime fan-out — it still carries the
 * `notification.created` bell push this dispatcher publishes after a visible
 * insert). Durable event transport is the BullMQ queue (`notificationCenter`).
 */

/** Every event the center turns into a matrix-routed notification. */
export type DispatchableEvent =
  | FriendRequestEvent
  | FriendAcceptedEvent
  | PortfolioSharedEvent
  | WatchlistSharedEvent
  | ConglomerateSharedEvent
  | FriendActivityEvent
  | FollowPublishedEvent
  | CommentCreatedEvent
  | FollowAlertCreatedEvent
  | FollowAlertFiredEvent
  | AccountTempPasswordEvent
  | AccountDataExportEvent
  | AlertTriggeredEvent
  | EarningsReminderEvent
  | ChatMessageEvent
  | DividendEventNotice
  | BudgetExceededEvent
  | StandingOrderSkippedEvent
  | MirrorNotificationEvent
  | FeedbackStatusChangedEvent
  | FeedbackReplyCreatedEvent;

/** The `type` strings the dispatcher accepts (guards the job payload). */
export const DISPATCHABLE_EVENT_TYPES = [
  'friend.request',
  'friend.accepted',
  'portfolio.shared',
  'watchlist.shared',
  'conglomerate.shared',
  'friend.activity',
  'follow.published',
  'follow.alert.created',
  'follow.alert.fired',
  'account.temp_password',
  'account.data_export',
  'alert.triggered',
  'earnings.reminder',
  'chat.message',
  'dividend.event',
  'budget.exceeded',
  'mirror.invite',
  'mirror.member_joined',
  'mirror.member_left',
  'mirror.member_removed',
  'mirror.removed',
  'mirror.ownership_transferred',
  'mirror.chain_dissolved',
  'mirror.sync_stalled',
  'standing_order.skipped',
  'feedback.status_changed',
  'feedback.reply_created',
  'comment.created',
] as const satisfies ReadonlyArray<DispatchableEvent['type']>;

export function isDispatchableEvent(event: { type: string }): event is DispatchableEvent {
  return (DISPATCHABLE_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Resolves an `alert.triggered` event's display context (asset + rule) at
 * dispatch time (§14). Injected so the dispatcher doesn't own the alert tables.
 * Returns null if the alert is already gone.
 */
export type AlertContextResolver = (alertId: string) => Promise<AlertNotificationContext | null>;

/** The localizable notification descriptor for one event, shared by all channels. */
interface RenderedNotification {
  eventKey: string;
  message: NotificationMessage;
  /** Inbox payload (carries `eventKey` — the §6.10 dedupe key). */
  payload: Record<string, unknown>;
  /** String-valued deep-link ids for the push channels' data message. */
  data: Record<string, string>;
  /** The alert's symbol — only set for `alert.triggered` (email subject). */
  alertSymbol?: string;
}

type LocalizedNotification = RenderedNotification & { title: string; body: string };

/**
 * What a DEFERRED e-mail (a digest row or a quiet-hours deferral) may carry for
 * this event, or `null` when the type ships no e-mail at all (#1816).
 *
 * The instant path applies both rules inside `sendEmail`: a type with no e-mail
 * template returns without sending, and `chat.message` sends a template that
 * deliberately omits the message preview. A deferral is rendered from the queue
 * row instead of from the event, so the same rules have to be applied HERE, at
 * enqueue time — otherwise quiet hours and the digest deliver an e-mail the
 * instant path would never have sent, with content it deliberately withholds.
 */
function deferredEmailContent(
  event: DispatchableEvent,
  localized: LocalizedNotification,
  locale: string | null | undefined,
): { title: string; body: string } | null {
  if (!notificationTypeShipsEmail(event.type)) return null;
  if (event.type === 'chat.message' && event.bodyPreview) {
    // Carries no message content, exactly like the instant chat e-mail: the
    // no-preview bell copy is the same statement ("a message is waiting"),
    // already EN+DE, so no new copy key is involved. Withholding it here also
    // keeps it out of the digest summary line, which is built from this body.
    return renderNotificationMessage(
      notificationMessage('chatMessagePlain', { sender: event.senderUsername }),
      locale,
    );
  }
  return { title: localized.title, body: localized.body };
}

/**
 * The dedupe key per event: type + what makes the *logical* event unique.
 * Combined with the recipient userId (repo-side) this is §6.10's
 * "(user, event key)".
 */
function eventKeyFor(event: DispatchableEvent): string {
  switch (event.type) {
    case 'friend.request':
      return `friend.request:${event.requestId}`;
    case 'friend.accepted':
      return `friend.accepted:${event.requestId}`;
    case 'portfolio.shared':
      // Same item shared by the same owner is one logical event per friend;
      // the recipient userId (repo-side) keeps friends' rows distinct.
      return `portfolio.shared:${event.portfolioId}:${event.actorId}`;
    case 'watchlist.shared':
      return `watchlist.shared:${event.watchlistId}:${event.actorId}`;
    case 'conglomerate.shared':
      return `conglomerate.shared:${event.conglomerateId}:${event.actorId}`;
    case 'friend.activity':
      return `friend.activity:${event.refId}`;
    case 'follow.published':
      // Deduped per (follower, item, UTC day): the date folds into the key so a
      // followed user flapping an item public→private→public within a day never
      // re-notifies (#438 anti-noise), while a genuine re-publish on a later day
      // is a fresh key. The recipient userId (repo-side) keeps followers distinct.
      return `follow.published:${event.itemKind}:${event.itemId}:${event.occurredAt.slice(0, 10)}`;
    case 'follow.alert.created':
      // One creation per alert, ever — the alert id alone keys it; the
      // recipient userId (repo-side) keeps followers distinct.
      return `follow.alert.created:${event.alertId}`;
    case 'follow.alert.fired':
      // Deduped per (alert, trigger window) exactly like the owner's
      // `alert.triggered` below — a redelivered fire no-ops, a repeat alert's
      // next window is fresh.
      return `follow.alert.fired:${event.alertId}:${event.occurredAt.slice(0, 16)}`;
    case 'account.temp_password':
      // Every reset is a fresh notice — the timestamp keys the occurrence.
      return `account.temp_password:${event.occurredAt}`;
    case 'account.data_export':
      // Every completed export is a fresh notice — the timestamp keys it.
      return `account.data_export:${event.occurredAt}`;
    case 'alert.triggered':
      // Deduped per (alert, trigger window): the occurredAt minute folds in, so
      // a redelivered fire no-ops while a repeat alert's next window is fresh.
      return `alert.triggered:${event.alertId}:${event.occurredAt.slice(0, 16)}`;
    case 'earnings.reminder':
      // Deduped per (asset, report date): one reminder per upcoming report, so a
      // daily re-scan across the multi-day lead window never re-notifies. The
      // recipient userId (repo-side) keeps every holder/watcher's row distinct.
      // REPORT-level identity (an estimated date firming up is still one report,
      // #1758) is resolved by the producer, which is the only layer that sees
      // the date move: `marketIntel/earningsReminder.ts` holds a per-(user,
      // asset) anchor and simply does not emit the second time. This key stays
      // date-shaped because here it backstops REDELIVERY of one emit, and a
      // redelivered emit always carries the same date.
      return `earnings.reminder:${event.assetId}:${event.earningsDate.slice(0, 10)}`;
    case 'chat.message':
      return `chat.message:${event.messageId}`;
    case 'dividend.event':
      // Deduped per (recipient, asset, ex-date): the daily scan re-sees the same
      // upcoming event for days on end, but only the first emit surfaces; the
      // recipient userId (repo-side) keeps holders distinct.
      return `dividend.event:${event.assetId}:${event.exDate.slice(0, 10)}`;
    case 'budget.exceeded':
      // Deduped per FIRE CLAIM, which the producer takes before emitting; this
      // key backs it up at the dispatch layer so a redelivered/duplicated emit
      // no-ops. The cash producer sends the claim's id (#1754) because it
      // RELEASES the claim once the budget falls back under its target, so the
      // same month may legitimately alert again — keying on (budget, period)
      // alone would have swallowed that second, genuine overrun forever. The
      // retired expense island sends no `fireId` and keeps the old key, whose
      // marker is never released and so still means one alert per month.
      return event.fireId
        ? `budget.exceeded:${event.budgetId}:${event.period}:${event.fireId}`
        : `budget.exceeded:${event.budgetId}:${event.period}`;
    case 'standing_order.skipped':
      // A retriable defer may be observed by every daily retry, while the same
      // period can later be permanently dropped. Fold the outcome into the key
      // so retries dedupe without swallowing that later state transition.
      return `standing_order.skipped:${event.standingOrderId}:${event.periodKey}:${event.outcome}`;
    case 'mirror.invite':
    case 'mirror.member_joined':
    case 'mirror.member_left':
    case 'mirror.member_removed':
    case 'mirror.removed':
    case 'mirror.ownership_transferred':
    case 'mirror.chain_dissolved':
    case 'mirror.sync_stalled':
      // Deduped per (chain, occurrence): `refId` is the invite id / target
      // member id / stalled-copy watermark, so a redelivered membership notice
      // no-ops while a later distinct occurrence gets a fresh key (design §11).
      // The recipient userId (repo-side) keeps every member's row distinct.
      return `${event.type}:${event.chainId}:${event.refId}`;
    case 'feedback.status_changed':
      // Idempotency key: submission id + the persisted transition timestamp.
      // An HTTP retry preserves lastStatusChangeAt, and a BullMQ redelivery of
      // that transition therefore resolves to this exact same durable marker.
      return `feedback.status_changed:${event.feedbackId}:${event.lastStatusChangeAt}`;
    case 'feedback.reply_created':
      // Idempotency key: the durable message id. A redelivered insert event can
      // never create a second notification for the same staff reply.
      return `feedback.reply_created:${event.messageId}`;
    case 'comment.created':
      // One notice per comment, ever — the comment id alone keys it. A
      // redelivered emit (or a retried dispatch job) therefore no-ops, and the
      // recipient userId (repo-side) keeps it scoped to the item owner.
      return `comment.created:${event.commentId}`;
  }
}

/** Localizable MIRRORCHAIN lifecycle descriptor (design §11). */
function mirrorMessage(event: MirrorNotificationEvent): NotificationMessage {
  const params = { chain: event.chainName, actor: event.actorUsername };
  switch (event.type) {
    case 'mirror.invite':
      return notificationMessage('mirrorInvite', params);
    case 'mirror.member_joined':
      return notificationMessage('mirrorMemberJoined', params);
    case 'mirror.member_left':
      return notificationMessage('mirrorMemberLeft', params);
    case 'mirror.member_removed':
      return notificationMessage('mirrorMemberRemoved', params);
    case 'mirror.removed':
      return notificationMessage('mirrorRemoved', params);
    case 'mirror.ownership_transferred':
      return notificationMessage('mirrorOwnershipTransferred', params);
    case 'mirror.chain_dissolved':
      return notificationMessage('mirrorChainDissolved', params);
    case 'mirror.sync_stalled':
      return notificationMessage('mirrorSyncStalled', params);
  }
}

/**
 * Localizable budget-overrun descriptor; amounts stay raw interpolation data so
 * every channel renders them in its own locale. `notificationMessage()` marks
 * `spent`/`target` as money (§6.16) for the in-app renderer.
 */
function budgetExceededMessage(event: BudgetExceededEvent): NotificationMessage {
  return notificationMessage('budgetExceeded', {
    category: event.categoryName,
    target: event.amount,
    spent: event.spent,
    currency: event.currency,
  });
}

/** Localizable dividend-event descriptor, with/without the optional payout. */
function dividendEventMessage(event: DividendEventNotice): NotificationMessage {
  const params = { symbol: event.symbol, date: event.exDate.slice(0, 10) };
  return event.amount != null && event.currency
    ? notificationMessage('dividendEventWithAmount', {
        ...params,
        amount: event.amount,
        currency: event.currency,
      })
    : notificationMessage('dividendEvent', params);
}

/** Localizable newly-published item descriptor (#438). */
function followPublishedMessage(event: FollowPublishedEvent): NotificationMessage {
  const params = { actor: event.actorUsername, item: event.itemName };
  switch (event.itemKind) {
    case 'portfolio':
      return notificationMessage('followPublishedPortfolio', params);
    case 'watchlist':
      return notificationMessage('followPublishedWatchlist', params);
    case 'conglomerate':
      return notificationMessage('followPublishedConglomerate', params);
    case 'idea':
      return notificationMessage('followPublishedIdea', params);
  }
}

/** Localizable friend-activity descriptor. */
function friendActivityMessage(event: FriendActivityEvent): NotificationMessage {
  const params = { actor: event.actorUsername, symbol: event.assetSymbol };
  switch (event.activity) {
    case 'buy':
      return notificationMessage('friendActivityBuy', params);
    case 'sell':
      return notificationMessage('friendActivitySell', params);
    case 'watchlist_add':
      return notificationMessage('friendActivityWatchlistAdd', params);
  }
}

/** Localizable feedback status copy without leaking enum tokens into DE text. */
function feedbackStatusMessage(event: FeedbackStatusChangedEvent): NotificationMessage {
  switch (event.status) {
    case 'new':
      return notificationMessage('feedbackStatusNew');
    case 'triaged':
      return notificationMessage('feedbackStatusTriaged');
    case 'working_on_it':
      return notificationMessage('feedbackStatusWorkingOnIt');
    case 'saved_as_future_idea':
      return notificationMessage('feedbackStatusSavedAsFutureIdea');
    case 'declined':
      return notificationMessage('feedbackStatusDeclined');
    case 'shipped':
      return notificationMessage('feedbackStatusShipped');
  }
}

/** Localizable standing-order failure descriptor (#1118/#1138). */
function standingOrderSkippedMessage(event: StandingOrderSkippedEvent): NotificationMessage {
  const named = Boolean(event.orderLabel);
  const params = {
    period: event.periodKey,
    ...(event.orderLabel ? { order: event.orderLabel } : {}),
  };
  switch (event.outcome) {
    case 'deferred':
      return notificationMessage(
        named ? 'standingOrderDeferredNamed' : 'standingOrderDeferredUnnamed',
        params,
      );
    case 'dropped':
      if ((event.droppedCount ?? 1) > 1) {
        return notificationMessage(
          named ? 'standingOrderDroppedManyNamed' : 'standingOrderDroppedManyUnnamed',
          { ...params, count: event.droppedCount ?? 1 },
        );
      }
      return notificationMessage(
        named ? 'standingOrderDroppedNamed' : 'standingOrderDroppedUnnamed',
        params,
      );
    case 'booking_failed':
      return notificationMessage(
        named ? 'standingOrderBookingFailedNamed' : 'standingOrderBookingFailedUnnamed',
        params,
      );
  }
}

export interface NotificationDispatcherDeps {
  /** Publishes the ephemeral `notification.created` bell push (§4.5). */
  bus: Pick<EventBus, 'publish'>;
  repo: NotificationRepository;
  /** Recipient lookup: email address, locale, global mute. */
  users: Pick<UserRepository, 'findById'>;
  /** Email channel (§6.10). Omit to disable email fan-out (e.g. in-app-only tests). */
  email?: EmailService;
  /** Resolves `alert.triggered` display context (§14). Omit to ignore alert events. */
  resolveAlert?: AlertContextResolver;
  /** Phone-push channel; null/omitted = not configured (#368). */
  fcm?: FcmChannel | null;
  /** Browser-push channel; null/omitted = not configured (#368/#350). */
  webPush?: WebPushChannel | null;
  /** Telegram channel; null/omitted = bot token unset (V4-P10). */
  telegram?: TelegramChannel | null;
  /** Discord channel; always built when webhooks storage is wired. Deliveries no-op for a user with no saved webhook (V4-P10). */
  discord?: DiscordChannel | null;
  /**
   * Per-user link state for the two channels the V5-P0 kill-switch can
   * deactivate (#1795): does this recipient have the linked chat / saved
   * webhook the switch promises to preserve? Consulted ONLY when the channel
   * itself is null (i.e. the deployment deactivated it) — a live deployment
   * never pays for it. It is what separates "this user genuinely loses a
   * delivery" from "the default matrix routes a channel this user never set
   * up", and only the former may defer an event. Omit/null ⇒ no recipient is
   * treated as linked, so the pre-#1795 marker behaviour stands.
   */
  deactivatedLinks?: {
    telegram(userId: string): Promise<boolean>;
    discord(userId: string): Promise<boolean>;
  } | null;
  /** Active-view presence (#368). Omit to disable suppression (never suppresses). */
  presence?: PresenceStore;
  /**
   * Digest cadence + queue (V5-P3). Governs the OUTBOUND channels only
   * (email/push/webpush): a `daily`/`weekly` type is written to the in-app bell
   * instantly as always, but its outbound copies are deferred into the digest
   * queue instead of sent now. Omit/null ⇒ every type resolves to `instant` and
   * the fan-out is byte-identical to the pre-digest behaviour.
   */
  digest?: {
    cadenceFor(userId: string, type: string): Promise<NotificationCadence>;
    enqueue(item: EnqueueDigestItemInput): Promise<void>;
  } | null;
  /**
   * Quiet hours (§13.5 V5-P3). When the recipient is inside their quiet-hours
   * window and the event is NOT in the urgent-bypass class
   * ({@link isUrgentNotification}), an INSTANT-cadence outbound
   * notification is deferred into the deferral store instead of sent now, and
   * delivered at window end by the deferred-delivery job. The in-app bell is
   * NEVER affected (it already landed above). Digest-cadence items keep deferring
   * into the digest queue regardless — their quiet-hours handling is at delivery
   * time. Omit/null ⇒ quiet hours never defer (byte-identical pre-V5-P3 fan-out);
   * the recipient's window/timezone are read from the recipient row itself.
   */
  quietHours?: {
    enqueueDeferred(item: EnqueueDeferredItemInput): Promise<void>;
  } | null;
  /** Injectable clock (tests) for the quiet-hours + period decision. */
  now?: () => Date;
  logger?: Logger;
}

export interface NotificationDispatcher {
  /**
   * Deliver a single event through the matrix: dedupe, write the inbox row /
   * marker, fan out to the enabled channels. Safe under at-least-once
   * redelivery. Throws only when even the dedupe marker could not be written
   * (so the durable queue retries); channel failures never propagate.
   */
  dispatch(event: DispatchableEvent): Promise<void>;
}

export function createNotificationDispatcher(
  deps: NotificationDispatcherDeps,
): NotificationDispatcher {
  const {
    bus,
    repo,
    users,
    email,
    resolveAlert,
    fcm,
    webPush,
    telegram,
    discord,
    deactivatedLinks,
    presence,
    digest,
    quietHours,
    logger,
  } = deps;
  const now = deps.now ?? (() => new Date());

  // V5-P0 kill-switch signal (#1795). The counter carries the volume; the log
  // carries the discovery, once per (channel, outcome) per process so a
  // deactivated deployment gets an operator-visible line without a log flood.
  const warnedDeactivated = new Set<string>();
  function recordDeactivatedSkip(
    channel: DeactivatableChannel,
    outcome: 'dropped' | 'deferred',
    type: string,
  ): void {
    notificationChannelSkippedTotal.inc({ channel, outcome });
    const key = `${channel}:${outcome}`;
    if (warnedDeactivated.has(key)) return;
    warnedDeactivated.add(key);
    logger?.warn(
      { channel, outcome, type },
      outcome === 'deferred'
        ? `${channel} is deactivated (BT_TELEGRAM_DISCORD_ENABLED) and was this notification's only routed channel: nothing delivered, nothing recorded — it stays deliverable after an env flip`
        : `${channel} is deactivated (BT_TELEGRAM_DISCORD_ENABLED): fan-out skipped for a user who still routes notifications to it`,
    );
  }

  /**
   * Does the recipient hold the link/webhook a deactivated channel preserves?
   * A probe failure answers `false` — the conservative direction, since it
   * keeps the pre-#1795 marker behaviour rather than inventing a deferral.
   */
  async function hasPreservedLink(channel: DeactivatableChannel, userId: string): Promise<boolean> {
    if (!deactivatedLinks) return false;
    try {
      return channel === 'telegram'
        ? await deactivatedLinks.telegram(userId)
        : await deactivatedLinks.discord(userId);
    } catch (err) {
      logger?.warn({ err, channel }, 'deactivated channel link probe failed');
      return false;
    }
  }

  /** Build the event's locale-neutral message + routing payload. */
  async function render(event: DispatchableEvent): Promise<RenderedNotification | null> {
    const eventKey = eventKeyFor(event);
    switch (event.type) {
      case 'friend.request':
        return {
          eventKey,
          message: notificationMessage('friendRequest', { actor: event.actorUsername }),
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            requestId: event.requestId,
          },
          data: { requestId: event.requestId },
        };
      case 'friend.accepted':
        return {
          eventKey,
          message: notificationMessage('friendAccepted', { actor: event.actorUsername }),
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            requestId: event.requestId,
          },
          data: { requestId: event.requestId },
        };
      case 'portfolio.shared':
        return {
          eventKey,
          message: notificationMessage('portfolioShared', { actor: event.actorUsername }),
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            portfolioId: event.portfolioId,
          },
          data: { portfolioId: event.portfolioId },
        };
      case 'watchlist.shared':
        return {
          eventKey,
          message: notificationMessage('watchlistShared', { actor: event.actorUsername }),
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            watchlistId: event.watchlistId,
          },
          data: { watchlistId: event.watchlistId },
        };
      case 'conglomerate.shared':
        return {
          eventKey,
          message: notificationMessage('conglomerateShared', { actor: event.actorUsername }),
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            conglomerateId: event.conglomerateId,
          },
          data: { conglomerateId: event.conglomerateId },
        };
      case 'friend.activity':
        return {
          eventKey,
          message: friendActivityMessage(event),
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            itemKind: event.itemKind,
            itemId: event.itemId,
            activity: event.activity,
            assetSymbol: event.assetSymbol,
          },
          // `username` (public-profile slug) mirrors `follow.published` so the
          // deep link lands on the actor's profile on both web and FCM (V4-P0c).
          data: {
            itemKind: event.itemKind,
            itemId: event.itemId,
            username: event.actorUsername,
          },
        };
      case 'follow.published': {
        return {
          eventKey,
          message: followPublishedMessage(event),
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            itemKind: event.itemKind,
            itemId: event.itemId,
            itemName: event.itemName,
          },
          // The public-profile slug (`username`) drives the deep link — a
          // newly-public item lives on the followed user's public profile.
          data: {
            itemKind: event.itemKind,
            itemId: event.itemId,
            username: event.actorUsername,
          },
        };
      }
      case 'follow.alert.created':
      case 'follow.alert.fired': {
        // Same dispatch-time context resolution as `alert.triggered`: the alert
        // vanished (or alerts aren't wired here) → nothing to render, no row.
        if (!resolveAlert) return null;
        const context = await resolveAlert(event.alertId);
        if (!context) return null;
        const created = event.type === 'follow.alert.created';
        return {
          eventKey,
          message: followAlertNotificationMessage(
            created ? 'created' : 'fired',
            event.actorUsername,
            {
              kind: context.kind,
              symbol: context.symbol,
              threshold: context.threshold,
              currency: context.currency,
            },
          ),
          payload: {
            eventKey,
            actorId: event.actorId,
            actorUsername: event.actorUsername,
            alertId: event.alertId,
            assetId: event.assetId,
            kind: context.kind,
          },
          data: { alertId: event.alertId, assetId: event.assetId },
          alertSymbol: context.symbol,
        };
      }
      case 'account.temp_password':
        return {
          eventKey,
          message: notificationMessage('accountTempPassword'),
          payload: { eventKey },
          data: {},
        };
      case 'account.data_export':
        return {
          eventKey,
          message: notificationMessage('accountDataExport'),
          payload: { eventKey },
          data: {},
        };
      case 'alert.triggered': {
        if (!resolveAlert) return null;
        const context = await resolveAlert(event.alertId);
        if (!context) return null;
        return {
          eventKey,
          message: alertNotificationMessage({
            kind: context.kind,
            symbol: context.symbol,
            threshold: context.threshold,
            currency: context.currency,
          }),
          payload: {
            eventKey,
            alertId: event.alertId,
            assetId: event.assetId,
            kind: context.kind,
          },
          data: { alertId: event.alertId, assetId: event.assetId },
          alertSymbol: context.symbol,
        };
      }
      case 'earnings.reminder': {
        const dateLabel = event.earningsDate.slice(0, 10);
        return {
          eventKey,
          message: notificationMessage(
            event.estimated ? 'earningsReminderEstimated' : 'earningsReminderConfirmed',
            { symbol: event.symbol, name: event.name, date: dateLabel },
          ),
          payload: {
            eventKey,
            assetId: event.assetId,
            symbol: event.symbol,
            earningsDate: event.earningsDate,
            estimated: event.estimated,
          },
          // Deep-links to the asset page (its earnings block) on web + push.
          data: { assetId: event.assetId },
        };
      }
      case 'chat.message':
        return {
          eventKey,
          message: event.bodyPreview
            ? notificationMessage('chatMessagePreview', {
                sender: event.senderUsername,
                preview: event.bodyPreview,
              })
            : event.hasChip
              ? notificationMessage('chatMessageSharedItem', { sender: event.senderUsername })
              : notificationMessage('chatMessagePlain', { sender: event.senderUsername }),
          payload: {
            eventKey,
            conversationId: event.conversationId,
            messageId: event.messageId,
            senderId: event.senderId,
            senderUsername: event.senderUsername,
          },
          data: { conversationId: event.conversationId, messageId: event.messageId },
        };
      case 'feedback.status_changed':
        return {
          eventKey,
          message: feedbackStatusMessage(event),
          payload: {
            eventKey,
            feedbackId: event.feedbackId,
            status: event.status,
            lastStatusChangeAt: event.lastStatusChangeAt,
          },
          data: {
            feedbackId: event.feedbackId,
            status: event.status,
            lastStatusChangeAt: event.lastStatusChangeAt,
          },
        };
      case 'feedback.reply_created':
        return {
          eventKey,
          message: notificationMessage('feedbackReplyCreated'),
          payload: {
            eventKey,
            feedbackId: event.feedbackId,
            messageId: event.messageId,
          },
          data: { feedbackId: event.feedbackId, messageId: event.messageId },
        };
      case 'comment.created': {
        return {
          eventKey,
          message: notificationMessage('commentCreated', {
            actor: event.actorUsername,
            item: event.itemName,
          }),
          payload: {
            eventKey,
            commentId: event.commentId,
            itemKind: event.itemKind,
            itemId: event.itemId,
            itemName: event.itemName,
            actorUsername: event.actorUsername,
          },
          // Deep-links to the item's thread on the owner's My items surface —
          // the ONE place the owner moderates from (§13.5 V5-P8). The comment id
          // rides along so a native client can scroll straight to it.
          data: {
            itemKind: event.itemKind,
            itemId: event.itemId,
            commentId: event.commentId,
          },
        };
      }
      case 'dividend.event': {
        return {
          eventKey,
          message: dividendEventMessage(event),
          payload: {
            eventKey,
            assetId: event.assetId,
            symbol: event.symbol,
            exDate: event.exDate,
            payDate: event.payDate,
          },
          data: { assetId: event.assetId },
        };
      }
      case 'budget.exceeded': {
        return {
          eventKey,
          message: budgetExceededMessage(event),
          payload: {
            eventKey,
            budgetId: event.budgetId,
            categoryId: event.categoryId,
            period: event.period,
            amount: event.amount,
            spent: event.spent,
            currency: event.currency,
          },
          // Deep-links to the expenses budgets surface on web + push.
          data: { categoryId: event.categoryId, period: event.period },
        };
      }
      case 'standing_order.skipped': {
        return {
          eventKey,
          message: standingOrderSkippedMessage(event),
          payload: {
            eventKey,
            standingOrderId: event.standingOrderId,
            periodKey: event.periodKey,
            outcome: event.outcome,
            ...(event.droppedCount === undefined ? {} : { droppedCount: event.droppedCount }),
          },
          // The order id lands on the exact Forecast row; period/outcome let a
          // native client preserve context when it opens that order.
          data: {
            standingOrderId: event.standingOrderId,
            periodKey: event.periodKey,
            outcome: event.outcome,
            ...(event.droppedCount === undefined
              ? {}
              : { droppedCount: String(event.droppedCount) }),
          },
        };
      }
      case 'mirror.invite':
      case 'mirror.member_joined':
      case 'mirror.member_left':
      case 'mirror.member_removed':
      case 'mirror.removed':
      case 'mirror.ownership_transferred':
      case 'mirror.chain_dissolved':
      case 'mirror.sync_stalled': {
        return {
          eventKey,
          message: mirrorMessage(event),
          payload: {
            eventKey,
            chainId: event.chainId,
            chainName: event.chainName,
            actorUsername: event.actorUsername,
            // The invite id for the Social request list deep link; the target
            // member id / stall watermark otherwise (design §11).
            refId: event.refId,
          },
          // Deep-links to the chain (its member sheet) on web + push; an invite
          // also carries its id so the push can open the Social request entry.
          data:
            event.type === 'mirror.invite'
              ? { chainId: event.chainId, inviteId: event.refId }
              : { chainId: event.chainId },
        };
      }
    }
  }

  /**
   * The surface an event belongs to for presence suppression. v1: only chat —
   * extend here to generalize ("actively viewing it → don't notify").
   */
  function presenceTarget(event: DispatchableEvent): { surface: 'chat'; id: string } | null {
    if (event.type === 'chat.message') return { surface: 'chat', id: event.conversationId };
    return null;
  }

  /**
   * Send the event's email in the recipient's stored locale (§13.3 V3-P1).
   * `account.temp_password` deliberately has NO dispatcher email: the
   * transactional mail carrying the credential is sent directly at the source
   * (never through the queue) and would only be duplicated here.
   */
  async function sendEmail(
    event: DispatchableEvent,
    rendered: LocalizedNotification,
    recipient: { id: string; email: string; locale: string },
  ): Promise<void> {
    if (!email) return;
    const { email: to, id: userId, locale } = recipient;
    switch (event.type) {
      case 'friend.request':
        await email.sendFriendRequest({ to, userId, actorUsername: event.actorUsername, locale });
        return;
      case 'friend.accepted':
        await email.sendFriendAccepted({ to, userId, actorUsername: event.actorUsername, locale });
        return;
      case 'portfolio.shared':
        await email.sendPortfolioShared({ to, userId, actorUsername: event.actorUsername, locale });
        return;
      case 'watchlist.shared':
        await email.sendWatchlistShared({ to, userId, actorUsername: event.actorUsername, locale });
        return;
      case 'conglomerate.shared':
        await email.sendConglomerateShared({
          to,
          userId,
          actorUsername: event.actorUsername,
          locale,
        });
        return;
      case 'friend.activity':
        await email.sendFriendActivity({ to, userId, body: rendered.body, locale });
        return;
      case 'follow.published':
        // The rendered body already names the actor + item; the email reuses it
        // verbatim in the recipient's locale (#438).
        await email.sendFollowPublished({ to, userId, body: rendered.body, locale });
        return;
      case 'follow.alert.created':
        await email.sendFollowAlertCreated({ to, userId, body: rendered.body, locale });
        return;
      case 'follow.alert.fired':
        await email.sendFollowAlertFired({ to, userId, body: rendered.body, locale });
        return;
      case 'alert.triggered':
        await email.sendAlertTriggered({
          to,
          userId,
          symbol: rendered.alertSymbol ?? '',
          body: rendered.body,
          locale,
        });
        return;
      case 'earnings.reminder':
        await email.sendEarningsReminder({
          to,
          userId,
          symbol: event.symbol,
          name: event.name,
          earningsDate: event.earningsDate,
          estimated: event.estimated,
          locale,
        });
        return;
      case 'chat.message':
        // Deliberately no message content (privacy) — just that one is waiting.
        await email.sendChatMessage({ to, userId, actorUsername: event.senderUsername, locale });
        return;
      case 'feedback.status_changed':
      case 'feedback.reply_created':
        await email.sendFeedbackNotification({
          to,
          userId,
          title: rendered.title,
          body: rendered.body,
          locale,
        });
        return;
      case 'account.temp_password':
        return;
      case 'account.data_export':
        // No dispatcher email: the export-ready notice is in-app / push only
        // (the download is gated by a token the requester already holds, so an
        // email would carry no actionable link). Mirrors account.temp_password.
        return;
      case 'comment.created':
        // Names the commenter + the item, never the comment body: the owner
        // reads the text in the thread, and an email is a channel the audience
        // never chose (§13.5 V5-P8). Email is OFF for this type by the
        // lean-email default — this only sends when the owner opted in.
        await email.sendCommentCreated({
          to,
          userId,
          actorUsername: event.actorUsername,
          itemName: event.itemName,
          locale,
        });
        return;
      case 'dividend.event':
        // The rendered body already names the asset + ex-date; the email reuses
        // it verbatim in the recipient's locale (V5-P5).
        await email.sendDividendEvent({ to, userId, body: rendered.body, locale });
        return;
      case 'budget.exceeded':
        // In-app / push only (its email cell is locked in the settings grid): a
        // budget alert is a lightweight nudge and the dashboards are the system
        // of record — no localized budget email template ships (V5-P9, issue 3/3).
        return;
      case 'standing_order.skipped':
        await email.sendStandingOrderSkipped({
          to,
          userId,
          standingOrderId: event.standingOrderId,
          orderLabel: event.orderLabel,
          periodKey: event.periodKey,
          outcome: event.outcome,
          droppedCount: event.droppedCount,
          locale,
        });
        return;
      case 'mirror.invite':
      case 'mirror.member_joined':
      case 'mirror.member_left':
      case 'mirror.member_removed':
      case 'mirror.removed':
      case 'mirror.ownership_transferred':
      case 'mirror.chain_dissolved':
      case 'mirror.sync_stalled':
        // Fully localized from the `mirror` copy block (§13.5 V5-P7): the type's
        // suffix IS the email variant (`mirror.member_joined` → `member_joined`).
        await email.sendMirrorNotification({
          to,
          userId,
          variant: event.type.slice('mirror.'.length) as MirrorEmailVariant,
          chainName: event.chainName,
          actorUsername: event.actorUsername,
          locale,
        });
        return;
    }
  }

  async function dispatch(event: DispatchableEvent): Promise<void> {
    const rendered = await render(event);
    if (!rendered) return;

    const recipient = await users.findById(event.userId);
    if (!recipient) return;

    // Server channels need delivered text, while the payload descriptor lets a
    // current client re-render the inbox in its active locale. Persisting this
    // localized pair too keeps older/mobile clients correct and is the fallback
    // for historical clients that do not understand `payload.message` (#1138).
    const localized: LocalizedNotification = {
      ...rendered,
      ...renderNotificationMessage(rendered.message, recipient.locale),
    };

    // At-least-once delivery: the (user, eventKey) row — visible or hidden — is
    // the durable dedupe marker for EVERY channel (§6.10, #368).
    if (await repo.existsForEventKey(event.userId, rendered.eventKey)) return;

    const muted = recipient.notificationsMuted;
    const routing: TypeRouting = await repo.routingFor(event.userId, event.type);

    // V5-P0 kill-switch (#1795): channels this event is routed to that the
    // deployment cannot deliver on AND where the recipient holds the link the
    // switch promises to preserve — i.e. a delivery genuinely lost, not merely
    // the default matrix routing a channel this user never set up. When no
    // destination survives, return before the insert below: writing the dedupe
    // marker here is what used to consume the event forever, invisibly, and
    // reduced the promised env-flip restore to a restore of the link row alone.
    const deactivatedRouted: DeactivatableChannel[] = [];
    if (routing.telegram && !telegram && (await hasPreservedLink('telegram', event.userId))) {
      deactivatedRouted.push('telegram');
    }
    if (routing.discord && !discord && (await hasPreservedLink('discord', event.userId))) {
      deactivatedRouted.push('discord');
    }
    const hasLiveDestination =
      routing.inapp ||
      (routing.email && Boolean(email) && Boolean(recipient.email)) ||
      (routing.push && Boolean(fcm)) ||
      (routing.webpush && Boolean(webPush)) ||
      (routing.telegram && Boolean(telegram)) ||
      (routing.discord && Boolean(discord));
    if (!muted && !hasLiveDestination && deactivatedRouted.length > 0) {
      for (const channel of deactivatedRouted) {
        recordDeactivatedSkip(channel, 'deferred', event.type);
      }
      return;
    }

    // Presence suppression (#368): never on stale data — the store's TTL bounds
    // it. Errors fail open (deliver rather than swallow) and log.
    let suppressedByPresence = false;
    const target = presenceTarget(event);
    if (!muted && target && presence) {
      try {
        suppressedByPresence = await presence.isPresent(event.userId, target.surface, target.id);
      } catch (err) {
        logger?.warn({ err, type: event.type }, 'presence check failed; delivering normally');
      }
    }

    // The inbox row doubles as the dedupe marker, so ONE row is always written:
    //  - routed + live                → visible, unread, bell push
    //  - routed + presence-suppressed → visible, already read (it's on their screen)
    //  - in-app off / muted           → hidden marker, already read — presence
    //    never resurrects a channel the user routed off.
    const visible = !muted && routing.inapp;
    const alreadyRead = muted || suppressedByPresence || !routing.inapp;
    const notificationId = await repo.insert({
      userId: event.userId,
      type: event.type,
      title: localized.title,
      body: localized.body,
      payload: { ...rendered.payload, message: rendered.message },
      hidden: !visible,
      readAt: alreadyRead ? new Date() : null,
    });
    // Insert lost the (user, eventKey) unique race — a concurrent dispatch of
    // the same event (second worker replica) already wrote the marker and is
    // handling the fan-out.
    if (!notificationId) return;

    if (visible && !alreadyRead) {
      // Ephemeral bell push (§4.5) — best-effort; the SPA poll catches up.
      try {
        await bus.publish({
          type: 'notification.created',
          userId: event.userId,
          notificationId,
          occurredAt: new Date().toISOString(),
        });
      } catch (err) {
        logger?.warn({ err, notificationId }, 'notification.created publish failed');
      }
    }

    if (muted || suppressedByPresence) return;

    // The urgent-bypass class (§16 2026-07-18), resolved through the canonical
    // `isUrgentNotification` so the class is encoded exactly once. It outranks
    // BOTH deferral mechanisms (#1590): a `weekly` cadence on
    // `account.temp_password` must not sit in a queue for seven days any more
    // than a quiet-hours window may hold it overnight — the §16 class is
    // "delivered instantly", full stop.
    const urgent = isUrgentNotification({ type: event.type });

    // Outbound delivery cadence (V5-P3). `instant` (default, always for the
    // urgent class, and always when no digest wiring is present) delivers now —
    // byte-identical to the pre-digest fan-out below; `daily`/`weekly` defer the
    // outbound channels into the digest queue instead. The in-app row above
    // already landed instantly regardless: the bell is the record a digest
    // summarizes.
    const cadence: NotificationCadence =
      digest && !urgent ? await digest.cadenceFor(event.userId, event.type) : 'instant';
    // Non-null only when the outbound channels defer (daily/weekly) AND a digest
    // sink is wired; a single UTC period stamp per dispatch keeps every channel's
    // row in the same group (computed per user so quiet-hours can align later).
    const deferredCadence: DigestCadence | null =
      digest && (cadence === 'daily' || cadence === 'weekly') ? cadence : null;
    // The period stamp is computed in the recipient's timezone (V5-P3 quiet
    // hours) so a daily/weekly digest buckets by the user's LOCAL day; a user
    // with no timezone resolves to UTC — byte-identical to the pre-quiet-hours
    // stamp.
    const period = deferredCadence
      ? digestPeriodKey(deferredCadence, now(), recipient.timezone ?? null)
      : null;

    // Quiet hours (V5-P3): an INSTANT outbound notification fired inside the
    // recipient's window is deferred to window end — UNLESS it is in the urgent-
    // bypass class resolved above. Digest-cadence items keep deferring into the
    // digest queue above; quiet hours handles them at delivery time. So this only
    // ever fires when the item is NOT already a digest deferral.
    let quietDeferUntil: Date | null = null;
    if (quietHours && !urgent && deferredCadence === null) {
      const cfg = quietHoursConfigForUser(recipient);
      const nowDate = now();
      if (isInQuietHours(cfg, nowDate)) quietDeferUntil = quietHoursWindowEnd(cfg, nowDate);
    }

    // Channel fan-out past the marker is best-effort: each channel isolates its
    // own failure (§6.10 email philosophy) so one bad transport never blocks
    // the others — and never re-throws into the queue (the marker exists; a
    // retry would no-op anyway).
    if (routing.email && email && recipient.email) {
      // The per-type e-mail rules the instant path applies below, resolved BEFORE
      // either deferral branch enqueues (#1816): `null` = this type ships no
      // e-mail, so it ships none deferred either. `data` rides along so the
      // deferred send can deep-link to the notification's own target instead of
      // the app root.
      const deferrable = deferredEmailContent(event, localized, recipient.locale);
      if (digest && deferredCadence && period) {
        if (deferrable) {
          try {
            await digest.enqueue({
              userId: event.userId,
              type: event.type,
              channel: 'email',
              cadence: deferredCadence,
              period,
              title: deferrable.title,
              body: deferrable.body,
              data: rendered.data,
            });
          } catch (err) {
            logger?.warn({ err, type: event.type }, 'digest email enqueue failed');
          }
        }
      } else if (quietHours && quietDeferUntil) {
        if (deferrable) {
          try {
            await quietHours.enqueueDeferred({
              userId: event.userId,
              type: event.type,
              channel: 'email',
              title: deferrable.title,
              body: deferrable.body,
              data: rendered.data,
              deliverAfter: quietDeferUntil,
            });
          } catch (err) {
            logger?.warn({ err, type: event.type }, 'quiet-hours email defer failed');
          }
        }
      } else {
        try {
          await sendEmail(event, localized, {
            id: recipient.id,
            email: recipient.email,
            locale: recipient.locale,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'notification email fan-out failed');
        }
      }
    }

    const pushMessage: PushMessage = {
      type: event.type,
      title: localized.title,
      body: localized.body,
      data: rendered.data,
    };
    if (routing.push && fcm) {
      if (digest && deferredCadence && period) {
        try {
          await digest.enqueue({
            userId: event.userId,
            type: event.type,
            channel: 'push',
            cadence: deferredCadence,
            period,
            title: localized.title,
            body: localized.body,
            data: rendered.data,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'digest push enqueue failed');
        }
      } else if (quietHours && quietDeferUntil) {
        try {
          await quietHours.enqueueDeferred({
            userId: event.userId,
            type: event.type,
            channel: 'push',
            title: localized.title,
            body: localized.body,
            data: rendered.data,
            deliverAfter: quietDeferUntil,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'quiet-hours push defer failed');
        }
      } else {
        try {
          await fcm.deliver(event.userId, pushMessage);
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'FCM fan-out failed');
        }
      }
    }
    if (routing.webpush && webPush) {
      if (digest && deferredCadence && period) {
        try {
          await digest.enqueue({
            userId: event.userId,
            type: event.type,
            channel: 'webpush',
            cadence: deferredCadence,
            period,
            title: localized.title,
            body: localized.body,
            data: rendered.data,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'digest web-push enqueue failed');
        }
      } else if (quietHours && quietDeferUntil) {
        try {
          await quietHours.enqueueDeferred({
            userId: event.userId,
            type: event.type,
            channel: 'webpush',
            title: localized.title,
            body: localized.body,
            data: rendered.data,
            deliverAfter: quietDeferUntil,
          });
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'quiet-hours web-push defer failed');
        }
      } else {
        try {
          await webPush.deliver(event.userId, pushMessage);
        } catch (err) {
          logger?.warn({ err, type: event.type }, 'web-push fan-out failed');
        }
      }
    }
    // Telegram/Discord (globally deactivated) stay on the instant path — cadence
    // governs email/push/webpush only (V5-P3 scope).
    if (routing.telegram && telegram) {
      try {
        await telegram.deliver(event.userId, pushMessage);
      } catch (err) {
        // Secret-safe: the channel already sanitizes its own errors, but re-log
        // through the redactor here too (Pino serializes the `err` object).
        logger?.warn({ err, type: event.type }, 'telegram fan-out failed');
      }
    } else if (deactivatedRouted.includes('telegram')) {
      // The recipient is linked and routes this type here, but the channel is
      // not built in this deployment. The event did reach a live channel (else
      // the early return above fired), so this is a per-channel loss — still
      // worth an operator-visible signal (#1795).
      recordDeactivatedSkip('telegram', 'dropped', event.type);
    }
    if (routing.discord && discord) {
      try {
        await discord.deliver(event.userId, pushMessage);
      } catch (err) {
        logger?.warn({ err, type: event.type }, 'discord fan-out failed');
      }
    } else if (deactivatedRouted.includes('discord')) {
      recordDeactivatedSkip('discord', 'dropped', event.type);
    }
  }

  return { dispatch };
}
