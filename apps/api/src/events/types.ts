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

/** The discriminated union of every domain event (§9). */
export type DomainEvent =
  | AlertTriggeredEvent
  | NotificationCreatedEvent
  | QuoteUpdatedEvent
  | ConglomerateUpdatedEvent
  | PortfolioChangedEvent;

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
] as const satisfies readonly DomainEventType[];
