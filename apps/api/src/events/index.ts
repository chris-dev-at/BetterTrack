/**
 * Public surface of the typed domain event bus (PROJECTPLAN.md §9, §4.5).
 * Producers and consumers import only from here.
 */
export type {
  DomainEvent,
  DomainEventType,
  DomainEventOf,
  AlertTriggeredEvent,
  NotificationCreatedEvent,
  QuoteUpdatedEvent,
  ConglomerateUpdatedEvent,
  PortfolioChangedEvent,
  FriendRequestEvent,
  FriendAcceptedEvent,
  PortfolioSharedEvent,
  WatchlistSharedEvent,
  ConglomerateSharedEvent,
  FriendActivityEvent,
  FollowPublishedEvent,
  FollowAlertCreatedEvent,
  FollowAlertFiredEvent,
  AccountTempPasswordEvent,
  AccountDataExportEvent,
  ChatMessageEvent,
} from './types';
export { DOMAIN_EVENT_TYPES } from './types';
export {
  createEventBus,
  channelForType,
  typeForChannel,
  EVENT_CHANNEL_PREFIX,
  type EventBus,
  type EventHandler,
  type Unsubscribe,
  type CreateEventBusDeps,
} from './bus';
