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
  | AccountTempPasswordEvent
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
  'account.temp_password',
  'chat.message',
] as const satisfies readonly DomainEventType[];
