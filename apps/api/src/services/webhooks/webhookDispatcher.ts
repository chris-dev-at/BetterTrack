import {
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '@bettertrack/contracts';

import type {
  WebhookDeliveryRepository,
  WebhookSubscriptionRepository,
} from '../../data/repositories/webhookRepository';
import type { DomainEvent } from '../../events';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';
import { decryptSecret } from '../crypto/secretBox';

import { buildWebhookPayload, signWebhookPayload } from './webhookSigner';

/**
 * Webhook delivery core (§13.5 V5-P10). Given one delivery job — a stable
 * delivery id, the target subscription and the raw domain event — it decrypts
 * the subscription's secret, HMAC-signs the payload, POSTs it through the
 * transport, records the outcome in the bounded log, and maintains the
 * consecutive-failure streak that auto-disables a dead receiver.
 *
 * Retry model: one `deliver` call is ONE attempt. On a non-final failed attempt
 * it returns `retry` and the BullMQ job throws so the queue re-runs it with
 * backoff (`jobs/options.ts`). On the FINAL attempt's failure (or immediately
 * under test, where `maxAttempts` is 1) it records a `failed` row and bumps the
 * streak; crossing {@link WEBHOOK_AUTO_DISABLE_THRESHOLD} auto-disables. All log
 * bookkeeping is idempotent on the delivery id, so a redelivered terminal job
 * never double-counts.
 */

export interface WebhookTransportResult {
  /** True for a 2xx response. */
  ok: boolean;
  /** The receiver's HTTP status; null on a network/timeout error. */
  status: number | null;
  /** A short failure reason (never the response body). */
  error?: string;
}

export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface WebhookTransport {
  send(request: WebhookTransportRequest): Promise<WebhookTransportResult>;
}

/** The job payload one delivery carries. */
export interface WebhookDeliveryJob {
  subscriptionId: string;
  /** Stable across BullMQ retries → the receiver dedupe key + the log row id. */
  deliveryId: string;
  event: DomainEvent;
}

export type WebhookDeliveryOutcome = 'delivered' | 'retry' | 'failed' | 'disabled' | 'skipped';

export interface WebhookDeliveryResult {
  outcome: WebhookDeliveryOutcome;
  status: number | null;
  error?: string;
}

export interface WebhookAttemptContext {
  /** 1-based attempt number for this delivery. */
  attempt: number;
  /** Total attempts allowed before the failure is terminal. */
  maxAttempts: number;
}

export interface WebhookDispatcherDeps {
  subscriptions: WebhookSubscriptionRepository;
  deliveries: WebhookDeliveryRepository;
  transport: WebhookTransport;
  /** 32-byte secretBox key (shared with TOTP/Discord). */
  encryptionKey: Buffer;
  /** Only `record` is used — auto-disable writes one audit row. */
  audit: Pick<AuditService, 'record'>;
  logger: Logger;
  /** Consecutive failures before auto-disable. Defaults to the contract constant. */
  autoDisableThreshold?: number;
  /** Injectable clock (tests) — drives the signature timestamp + row stamps. */
  now?: () => number;
}

export interface WebhookDispatcher {
  deliver(job: WebhookDeliveryJob, ctx: WebhookAttemptContext): Promise<WebhookDeliveryResult>;
}

const DELIVERY_USER_AGENT = 'BetterTrack-Webhooks/1';
const MAX_ERROR_LEN = 200;

/** Never persist receiver-provided text — keep failure reasons short + structural. */
function shortReason(status: number | null, error: string | undefined): string {
  if (status !== null) return `HTTP ${status}`;
  return (error ?? 'delivery failed').slice(0, MAX_ERROR_LEN);
}

export function createWebhookDispatcher(deps: WebhookDispatcherDeps): WebhookDispatcher {
  const {
    subscriptions,
    deliveries,
    transport,
    encryptionKey,
    audit,
    logger,
    autoDisableThreshold = WEBHOOK_AUTO_DISABLE_THRESHOLD,
    now = Date.now,
  } = deps;

  return {
    async deliver(job, { attempt, maxAttempts }) {
      const sub = await subscriptions.findById(job.subscriptionId);
      // Deleted or disabled (incl. auto-disabled by a prior delivery) → drop.
      if (!sub || !sub.enabled) return { outcome: 'skipped', status: null };

      const { body } = buildWebhookPayload(job.deliveryId, job.event);
      const timestamp = String(Math.floor(now() / 1000));

      let secret: string;
      try {
        secret = decryptSecret(sub.secretEncrypted, encryptionKey);
      } catch (err) {
        // A secret that won't decrypt (rotated/corrupt key) is unrecoverable —
        // no point retrying. Record a terminal failure and stop.
        logger.error({ subscriptionId: sub.id, err }, 'webhook secret decrypt failed');
        await deliveries.record({
          id: job.deliveryId,
          subscriptionId: sub.id,
          eventType: job.event.type,
          status: 'failed',
          responseStatus: null,
          attempts: attempt,
          error: 'secret unavailable',
        });
        return { outcome: 'failed', status: null, error: 'secret unavailable' };
      }

      const signature = signWebhookPayload(secret, timestamp, body);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': DELIVERY_USER_AGENT,
        [WEBHOOK_EVENT_HEADER]: job.event.type,
        [WEBHOOK_DELIVERY_HEADER]: job.deliveryId,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_SIGNATURE_HEADER]: signature,
      };

      let result: WebhookTransportResult;
      try {
        result = await transport.send({ url: sub.url, headers, body });
      } catch (err) {
        result = { ok: false, status: null, error: err instanceof Error ? err.message : 'error' };
      }

      if (result.ok) {
        const inserted = await deliveries.record({
          id: job.deliveryId,
          subscriptionId: sub.id,
          eventType: job.event.type,
          status: 'success',
          responseStatus: result.status,
          attempts: attempt,
          error: null,
        });
        if (inserted) await subscriptions.recordSuccess(sub.id, new Date(now()));
        return { outcome: 'delivered', status: result.status };
      }

      // A failed attempt that still has retries left → let BullMQ back off.
      if (attempt < maxAttempts) {
        return { outcome: 'retry', status: result.status, error: result.error };
      }

      // Terminal failure: record it and advance the auto-disable streak once.
      const reason = shortReason(result.status, result.error);
      const inserted = await deliveries.record({
        id: job.deliveryId,
        subscriptionId: sub.id,
        eventType: job.event.type,
        status: 'failed',
        responseStatus: result.status,
        attempts: attempt,
        error: reason,
      });

      let disabled = false;
      if (inserted) {
        const failures = await subscriptions.incrementFailure(sub.id, new Date(now()));
        if (failures >= autoDisableThreshold) {
          await subscriptions.disable(sub.id, 'auto', new Date(now()));
          disabled = true;
          logger.warn(
            { subscriptionId: sub.id, failures },
            'webhook subscription auto-disabled after consecutive failures',
          );
          await audit.record({
            actorId: sub.userId,
            action: AuditAction.WebhookAutoDisabled,
            targetType: 'webhook_subscription',
            targetId: sub.id,
            ip: null,
            meta: { failures },
          });
        }
      }

      return { outcome: disabled ? 'disabled' : 'failed', status: result.status, error: reason };
    },
  };
}

/**
 * The production transport: a single `fetch` POST bounded by a timeout. A non-2xx
 * response or any thrown error is a failure the caller counts toward retries.
 */
export function createFetchWebhookTransport(timeoutMs = 10_000): WebhookTransport {
  return {
    async send({ url, headers, body }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
          redirect: 'manual',
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        return {
          ok: false,
          status: null,
          error: err instanceof Error ? err.message : 'network error',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
