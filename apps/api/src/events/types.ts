/**
 * Typed domain events (PROJECTPLAN.md §9, §4.5).
 *
 * Services and jobs publish these on a Redis pub/sub bus; consumers — the
 * realtime gateway (→ socket rooms) and the notification dispatcher — subscribe.
 * Producers and consumers depend only on this typed surface, never on the raw
 * Redis channel layout, so a new consumer (mobile push, webhooks) is a new
 * subscriber rather than a producer rewrite.
 *
 * The union is exactly the five events enumerated in §9. Each payload carries
 * the identifiers the gateway needs to route the event to the right room
 * (§4.5: `user:{id}`, `asset:{id}`, `conglomerate:{id}`), plus an `occurredAt`
 * ISO timestamp stamped by the producer for ordering/debugging.
 */

/** `alert.triggered` → pushed to the owning user's room. */
export interface AlertTriggeredEvent {
  type: 'alert.triggered';
  userId: string;
  alertId: string;
  assetId: string;
  occurredAt: string;
}

/** `notification.created` → surfaces as `notification.new` in the user's room. */
export interface NotificationCreatedEvent {
  type: 'notification.created';
  userId: string;
  notificationId: string;
  occurredAt: string;
}

/** `quote.updated` → pushed to the asset's room whenever its cached quote refreshes. */
export interface QuoteUpdatedEvent {
  type: 'quote.updated';
  assetId: string;
  occurredAt: string;
}

/** `conglomerate.updated` → pushed to the conglomerate's room so viewers refetch live. */
export interface ConglomerateUpdatedEvent {
  type: 'conglomerate.updated';
  conglomerateId: string;
  occurredAt: string;
}

/** `portfolio.changed` → pushed to the owning user's room. */
export interface PortfolioChangedEvent {
  type: 'portfolio.changed';
  userId: string;
  portfolioId: string;
  occurredAt: string;
}

/**
 * `friend.request` → someone sent the recipient a friend request (§6.10 V1
 * notification type). `userId` is the **recipient** (the addressee); `actorId`
 * /`actorUsername` identify the sender so a consumer can render "Bob sent you a
 * friend request" without a follow-up lookup.
 */
export interface FriendRequestEvent {
  type: 'friend.request';
  /** Recipient — the user the request was addressed to. */
  userId: string;
  /** Actor — the user who sent the request. */
  actorId: string;
  actorUsername: string;
  requestId: string;
  occurredAt: string;
}

/**
 * `friend.accepted` → a pending request the recipient sent was accepted (§6.10).
 * `userId` is the **recipient** (the original requester); `actorId`
 * /`actorUsername` identify the user who accepted.
 */
export interface FriendAcceptedEvent {
  type: 'friend.accepted';
  /** Recipient — the original requester, now notified their request was accepted. */
  userId: string;
  /** Actor — the user who accepted the request. */
  actorId: string;
  actorUsername: string;
  requestId: string;
  occurredAt: string;
}

/**
 * `portfolio.shared` → a portfolio's visibility transitioned to `friends`, so it
 * is now visible to the owner's friends (§6.10). Emitted once per current friend;
 * `userId` is that **recipient** friend, `actorId`/`actorUsername` the owner.
 */
export interface PortfolioSharedEvent {
  type: 'portfolio.shared';
  /** Recipient — a friend the portfolio was just shared with. */
  userId: string;
  /** Actor — the portfolio owner who set visibility to `friends`. */
  actorId: string;
  actorUsername: string;
  portfolioId: string;
  occurredAt: string;
}

/**
 * `watchlist.shared` → a watchlist's audience now includes the recipient
 * (#368; mirrors {@link PortfolioSharedEvent} for the V3-P5 audience model).
 */
export interface WatchlistSharedEvent {
  type: 'watchlist.shared';
  /** Recipient — a friend the watchlist was just shared with. */
  userId: string;
  actorId: string;
  actorUsername: string;
  watchlistId: string;
  occurredAt: string;
}

/** `conglomerate.shared` → same as {@link WatchlistSharedEvent} for conglomerates. */
export interface ConglomerateSharedEvent {
  type: 'conglomerate.shared';
  /** Recipient — a friend the conglomerate was just shared with. */
  userId: string;
  actorId: string;
  actorUsername: string;
  conglomerateId: string;
  occurredAt: string;
}

/**
 * `friend.activity` → a friend acted on a shared item the recipient FOLLOWS
 * (#368; the V3-P6 per-shared-item activity toggle is the opt-in). Emitted once
 * per opted-in viewer whose access to the item is still live at emit time — the
 * producer re-checks the audience layer, so a revoked share never leaks
 * activity. `refId` identifies the underlying action (transaction id /
 * watchlist add) for the per-recipient dedupe key.
 */
export interface FriendActivityEvent {
  type: 'friend.activity';
  /** Recipient — an opted-in viewer of the shared item. */
  userId: string;
  /** Actor — the friend who bought/sold/added. */
  actorId: string;
  actorUsername: string;
  itemKind: 'portfolio' | 'watchlist';
  itemId: string;
  activity: 'buy' | 'sell' | 'watchlist_add';
  assetSymbol: string;
  refId: string;
  occurredAt: string;
}

/**
 * `follow.published` → an item owned by a user the recipient FOLLOWS (#438)
 * became newly visible to them: created/switched to `public_link`, or shared
 * their way. `userId` is the **recipient** follower; `actorId`/`actorUsername`
 * identify the followed owner (also the public-profile slug the notification
 * deep-links to). Emitted once per newly-exposed follower by the audience layer,
 * which suppresses any follower who simultaneously receives a direct `*.shared`
 * notice for the same item (the anti-noise "no doubles" rule). `itemName` renders
 * the news without a follow-up lookup.
 */
export interface FollowPublishedEvent {
  type: 'follow.published';
  /** Recipient — a follower who newly gained visibility of the item. */
  userId: string;
  /** Actor — the followed user who published/exposed the item. */
  actorId: string;
  actorUsername: string;
  itemKind: 'portfolio' | 'watchlist' | 'conglomerate' | 'idea';
  itemId: string;
  itemName: string;
  occurredAt: string;
}

/**
 * `follow.alert.created` → a user the recipient FOLLOWS created a new price
 * alert, and the recipient opted into created-alert news for that person
 * (`user_follows.notify_on_alert_create`, #455). Emitted once per opted-in
 * follower, only while the owner's `alerts_visible_to_followers` opt-in is on
 * (the fan-out query joins the flag at emission time — losing visibility
 * silently stops the news). Notify-only: nothing is copied into the
 * recipient's own alert list. The alert's display context (asset + rule) is
 * resolved at dispatch time like `alert.triggered`.
 */
export interface FollowAlertCreatedEvent {
  type: 'follow.alert.created';
  /** Recipient — a follower who opted into created-alert news. */
  userId: string;
  /** Actor — the followed user who created the alert. */
  actorId: string;
  actorUsername: string;
  alertId: string;
  assetId: string;
  occurredAt: string;
}

/**
 * `follow.alert.fired` → a price alert of a user the recipient FOLLOWS fired,
 * and the recipient opted into fired-alert news for that person
 * (`user_follows.notify_on_alert_fire`, #455). Same visibility gating and
 * dispatch-time context resolution as {@link FollowAlertCreatedEvent}; emitted
 * IN ADDITION TO the owner's own `alert.triggered` (recipients are disjoint —
 * a self-follow is impossible — so the owner is never doubled).
 */
export interface FollowAlertFiredEvent {
  type: 'follow.alert.fired';
  /** Recipient — a follower who opted into fired-alert news. */
  userId: string;
  /** Actor — the followed user whose alert fired. */
  actorId: string;
  actorUsername: string;
  alertId: string;
  assetId: string;
  occurredAt: string;
}

/**
 * `account.temp_password` → an admin reset the recipient's password (#368).
 * The credential itself NEVER rides this event (it would persist in the queue);
 * the transactional email with the temp password is sent directly at the
 * source. This event only feeds the informational inbox/push notice.
 */
export interface AccountTempPasswordEvent {
  type: 'account.temp_password';
  /** Recipient — the user whose password was reset. */
  userId: string;
  occurredAt: string;
}

/**
 * `account.data_export` → the recipient's requested data export finished
 * building and is ready to download (§13.4 V4-P6a, #494). Purely the
 * informational inbox/push notice — it carries NO download token (the requester
 * already holds it from the request response), so no secret rides the durable
 * queue or lands in the inbox row. Deep-links to Settings → Account.
 */
export interface AccountDataExportEvent {
  type: 'account.data_export';
  /** Recipient — the user whose export is ready. */
  userId: string;
  occurredAt: string;
}

/**
 * `earnings.reminder` → a held/watched asset's earnings report is coming up
 * inside the reminder lead window (§13.5 V5-P5 arc b). Purely informational and
 * OPT-IN (default off on every channel); `userId` is the recipient who holds or
 * watches the asset. Deduped per (user, asset, report date) by the dispatcher's
 * eventKey and a scan-side Redis lock, so a daily re-scan across the multi-day
 * window never re-notifies. All display strings (symbol/name/date) ride the
 * event so the dispatcher renders without a second lookup.
 */
export interface EarningsReminderEvent {
  type: 'earnings.reminder';
  /** Recipient — the user who holds or watches the asset. */
  userId: string;
  assetId: string;
  symbol: string;
  name: string;
  /** The upcoming earnings report date (ISO-8601). */
  earningsDate: string;
  /** Whether the report date is an estimate rather than a confirmed date. */
  estimated: boolean;
  occurredAt: string;
}

/**
 * `chat.message` → a friend sent the recipient a chat message (§13.3 V3-P8).
 * `userId` is the **recipient**; `senderId`/`senderUsername` identify the sender.
 * Two independent subscribers consume it: the realtime gateway pushes it to the
 * recipient's `user:{id}` room (always — the message lands in the thread), and
 * the notification dispatcher fans it through the per-type × channel matrix (so a
 * muted `chat.message` produces no bell/email while the push still fires). The
 * `bodyPreview`/`hasChip` render the notification without a second lookup; the
 * push itself carries neither, so the recipient's thread refetch re-resolves the
 * chip through the enforcement layer.
 */
export interface ChatMessageEvent {
  type: 'chat.message';
  /** Recipient — the other participant, who receives the message. */
  userId: string;
  /** Actor — the sender. */
  senderId: string;
  senderUsername: string;
  conversationId: string;
  messageId: string;
  /** A short text preview for the notification body; null for a chip-only message. */
  bodyPreview: string | null;
  /** Whether the message carries a share chip (drives "shared an item" copy). */
  hasChip: boolean;
  occurredAt: string;
}

/** The discriminated union of every domain event (§9). */
export type DomainEvent =
  | AlertTriggeredEvent
  | NotificationCreatedEvent
  | QuoteUpdatedEvent
  | ConglomerateUpdatedEvent
  | PortfolioChangedEvent
  | FriendRequestEvent
  | FriendAcceptedEvent
  | PortfolioSharedEvent
  | WatchlistSharedEvent
  | ConglomerateSharedEvent
  | FriendActivityEvent
  | FollowPublishedEvent
  | FollowAlertCreatedEvent
  | FollowAlertFiredEvent
  | AccountTempPasswordEvent
  | AccountDataExportEvent
  | EarningsReminderEvent
  | ChatMessageEvent;

/** The `type` discriminant of {@link DomainEvent}. */
export type DomainEventType = DomainEvent['type'];

/** Narrow {@link DomainEvent} to the variant with discriminant `T`. */
export type DomainEventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;

/** Every domain event type, useful for exhaustive iteration in tests/consumers. */
export const DOMAIN_EVENT_TYPES = [
  'alert.triggered',
  'notification.created',
  'quote.updated',
  'conglomerate.updated',
  'portfolio.changed',
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
  'earnings.reminder',
  'chat.message',
] as const satisfies readonly DomainEventType[];
