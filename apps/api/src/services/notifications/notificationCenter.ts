import type { Logger } from '../../logger';

import type { DispatchableEvent } from './notificationDispatcher';

/**
 * The ONE entry point any subsystem uses to emit a notification (#368). Social,
 * chat, alerts, portfolio activity, account flows — they all call
 * {@link NotificationCenter.emit} and never touch a channel, the matrix, or the
 * dispatcher directly. Adding a new notification later = defining its event +
 * emitting it here; no new plumbing.
 *
 * In production `emit` enqueues the event onto the durable
 * `notifications.dispatch` BullMQ queue (#367's hard requirement): the queue
 * survives process restarts and retries with backoff, so a fired alert whose
 * dispatcher is down/redeploying at publish time is DELAYED, never lost —
 * unlike the at-most-once pub/sub bus, which stays reserved for ephemeral
 * realtime fan-out. In tests the seam delivers straight into the dispatcher.
 *
 * Emitting is fire-and-forget for the caller: a queue hiccup logs an error but
 * never fails the user action that produced the event.
 */
export interface NotificationCenter {
  emit(event: DispatchableEvent): Promise<void>;
}

export interface CreateNotificationCenterDeps {
  /** Durable transport: enqueue the event for the dispatch job (prod) or
   *  deliver it directly (tests). */
  enqueue(event: DispatchableEvent): Promise<void>;
  logger?: Logger;
}

export function createNotificationCenter(deps: CreateNotificationCenterDeps): NotificationCenter {
  const { enqueue, logger } = deps;
  return {
    async emit(event: DispatchableEvent): Promise<void> {
      try {
        await enqueue(event);
      } catch (err) {
        // The producing action already committed; losing this emit is an
        // incident to log loudly, never an error to bubble into the request.
        logger?.error({ err, type: event.type }, 'notification emit failed');
      }
    },
  };
}
