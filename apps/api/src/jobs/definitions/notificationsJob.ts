import {
  isDispatchableEvent,
  type NotificationDispatcher,
} from '../../services/notifications/notificationDispatcher';
import { QUEUE_NAMES, type JobDefinition } from '../types';

/**
 * `notifications.dispatch` — the durable delivery leg of the central
 * notification pipeline (#368; the queue name + payload were pre-planned in
 * `jobs/types.ts` since §9 and are wired here). Every source's
 * {@link import('../../services/notifications/notificationCenter').NotificationCenter}
 * enqueues `{ event }`; this job hands it to the ONE dispatcher, which resolves
 * the recipient's matrix and fans out (inbox / email / FCM / web-push).
 *
 * Durability semantics (#367's hard requirement): BullMQ persists the job in
 * Redis, so an event produced while no worker (or a mid-deploy worker) is
 * running is processed as soon as one returns — delayed, never lost. The
 * default 3-attempt/exponential-backoff retry covers transient dispatch
 * failures; the dispatcher's (user, eventKey) row marker makes every retry
 * idempotent, so at-least-once delivery can never double-notify.
 */
export interface NotificationsDispatchJobDeps {
  dispatcher: NotificationDispatcher;
}

export function createNotificationsDispatchJob(
  deps: NotificationsDispatchJobDeps,
): JobDefinition<'notifications.dispatch'> {
  return {
    name: QUEUE_NAMES.notificationsDispatch,
    async handler(job) {
      const { event } = job.data;
      // The payload is typed as any DomainEvent; only notification-bearing
      // events dispatch — anything else (a stray ephemeral event) is a no-op.
      if (!isDispatchableEvent(event)) return;
      await deps.dispatcher.dispatch(event);
    },
  };
}
