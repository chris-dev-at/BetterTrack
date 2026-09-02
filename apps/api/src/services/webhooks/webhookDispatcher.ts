import {
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_AUTO_DISABLE_WINDOW_MS,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_DELIVERY_REFUSED_ERROR,
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
import {
  WEBHOOK_RECEIVER_URL_POLICY,
  assertSafeOutboundUrl,
  isOutboundPolicyRefusal,
  type OutboundUrlResolver,
} from '../security/outboundUrlGuard';

import { buildWebhookPayload, signWebhookPayload } from './webhookSigner';

/**
 * Webhook delivery core (§13.5 V5-P10). Given one delivery job — a stable
 * delivery id, the target subscription and the raw domain event — it decrypts
 * the subscription's secret, HMAC-signs the payload, POSTs it through the
 * transport, records the outcome in the bounded log, and maintains the
 * consecutive-failure streak that auto-disables a dead receiver.
 *
 * Egress policy: the target is user-supplied, so every attempt re-runs the
 * outbound guard under {@link WEBHOOK_RECEIVER_URL_POLICY} before anything is
 * signed or sent. A refused destination is terminal and logged without a
 * `responseStatus`; see the comment in `deliver`.
 *
 * Retry model: one `deliver` call is ONE attempt. On a non-final failed attempt
 * it returns `retry` and the BullMQ job throws so the queue re-runs it with
 * backoff (`jobs/options.ts`). On the FINAL attempt's failure (or immediately
 * under test, where `maxAttempts` is 1) it records a `failed` row and bumps the
 * streak; crossing {@link WEBHOOK_AUTO_DISABLE_THRESHOLD} auto-disables. All log
 * bookkeeping is idempotent on the delivery id, so a redelivered terminal job
 * never double-counts.
 *
 * Auto-disable is WINDOWED: the threshold counts only failures inside
 * {@link WEBHOOK_AUTO_DISABLE_WINDOW_MS} of the streak's first failure, and a
 * failure arriving after that window starts a fresh streak instead of extending
 * a stale one. A lifetime tally cannot distinguish a dead receiver from a
 * healthy one that has blipped N times over months, and the streak has no other
 * way to decay: only a success or a manual re-enable clears it.
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
  /** Window those failures must fall inside. Defaults to the contract constant. */
  autoDisableWindowMs?: number;
  /** DNS seam for the per-attempt outbound guard (tests); defaults to the system resolver. */
  dnsResolver?: OutboundUrlResolver;
  /** Injectable clock (tests) — drives the signature timestamp + row stamps. */
  now?: () => number;
}

export interface WebhookDispatcher {
  deliver(job: WebhookDeliveryJob, ctx: WebhookAttemptContext): Promise<WebhookDeliveryResult>;
}

const DELIVERY_USER_AGENT = 'BetterTrack-Webhooks/1';
const MAX_ERROR_LEN = 200;
/** Pre-send failure: the destination could not be resolved for this attempt. */
const UNRESOLVED_DESTINATION_ERROR = 'destination unresolved';

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
    autoDisableWindowMs = WEBHOOK_AUTO_DISABLE_WINDOW_MS,
    dnsResolver,
    now = Date.now,
  } = deps;

  async function recordTerminalFailure(input: {
    subscriptionId: string;
    userId: string;
    deliveryId: string;
    eventType: string;
    attempts: number;
    responseStatus: number | null;
    error: string;
  }): Promise<boolean> {
    const inserted = await deliveries.record({
      id: input.deliveryId,
      subscriptionId: input.subscriptionId,
      eventType: input.eventType,
      status: 'failed',
      responseStatus: input.responseStatus,
      attempts: input.attempts,
      error: input.error,
    });
    if (!inserted) return false;

    const at = new Date(now());
    // Windowed: the repository restarts the streak when the previous one is
    // older than `autoDisableWindowMs`, so `failures` is the count inside the
    // current window — never a lifetime total.
    const failures = await subscriptions.incrementFailure(
      input.subscriptionId,
      at,
      autoDisableWindowMs,
    );
    if (failures < autoDisableThreshold) return false;

    await subscriptions.disable(input.subscriptionId, 'auto', at);
    logger.warn(
      { subscriptionId: input.subscriptionId, failures, windowMs: autoDisableWindowMs },
      'webhook subscription auto-disabled after consecutive failures in the window',
    );
    await audit.record({
      actorId: input.userId,
      action: AuditAction.WebhookAutoDisabled,
      targetType: 'webhook_subscription',
      targetId: input.subscriptionId,
      ip: null,
      meta: { failures, windowMs: autoDisableWindowMs },
    });
    return true;
  }

  /** Retry-or-terminal decision for one failed attempt (transport or pre-send). */
  async function concludeFailure(input: {
    subscriptionId: string;
    userId: string;
    deliveryId: string;
    eventType: string;
    attempt: number;
    maxAttempts: number;
    status: number | null;
    error?: string;
  }): Promise<WebhookDeliveryResult> {
    // A failed attempt that still has retries left → let BullMQ back off.
    if (input.attempt < input.maxAttempts) {
      return { outcome: 'retry', status: input.status, error: input.error };
    }
    // Terminal failure: record it and advance the auto-disable streak once.
    const reason = shortReason(input.status, input.error);
    const disabled = await recordTerminalFailure({
      subscriptionId: input.subscriptionId,
      userId: input.userId,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      attempts: input.attempt,
      responseStatus: input.status,
      error: reason,
    });
    return { outcome: disabled ? 'disabled' : 'failed', status: input.status, error: reason };
  }

  return {
    async deliver(job, { attempt, maxAttempts }) {
      const sub = await subscriptions.findById(job.subscriptionId);
      // Deleted or disabled (incl. auto-disabled by a prior delivery) → drop.
      if (!sub || !sub.enabled) return { outcome: 'skipped', status: null };

      // SSRF guard (§8 "Outbound safety", §13.5 V5-P10). The destination is
      // user-supplied, so it is re-resolved and re-checked on EVERY attempt: a
      // hostname that was public when the subscription was created can point at
      // loopback by now (DNS rebinding). Nothing is signed or sent before this
      // passes. Residual: the transport resolves once more when it connects —
      // that window is why the guard runs per attempt rather than once.
      try {
        await assertSafeOutboundUrl(sub.url, {
          ...WEBHOOK_RECEIVER_URL_POLICY,
          resolver: dnsResolver,
        });
      } catch (err) {
        if (isOutboundPolicyRefusal(err)) {
          // A refused destination cannot become deliverable by retrying, and
          // retrying is what would turn the delivery log into an internal port
          // scanner. Terminal on the spot, and never with a `responseStatus` —
          // open and closed internal ports are indistinguishable in the log.
          logger.warn(
            { subscriptionId: sub.id, reason: err.reason },
            'webhook destination refused by the outbound guard',
          );
          const disabled = await recordTerminalFailure({
            subscriptionId: sub.id,
            userId: sub.userId,
            deliveryId: job.deliveryId,
            eventType: job.event.type,
            attempts: attempt,
            responseStatus: null,
            error: WEBHOOK_DELIVERY_REFUSED_ERROR,
          });
          return {
            outcome: disabled ? 'disabled' : 'failed',
            status: null,
            error: WEBHOOK_DELIVERY_REFUSED_ERROR,
          };
        }
        // Merely unresolvable right now (DNS error or empty answer): a network
        // condition, not a policy refusal — same handling as a failed attempt.
        return concludeFailure({
          subscriptionId: sub.id,
          userId: sub.userId,
          deliveryId: job.deliveryId,
          eventType: job.event.type,
          attempt,
          maxAttempts,
          status: null,
          error: UNRESOLVED_DESTINATION_ERROR,
        });
      }

      const { body } = buildWebhookPayload(job.deliveryId, job.event);
      const timestamp = String(Math.floor(now() / 1000));

      let secret: string;
      try {
        secret = decryptSecret(sub.secretEncrypted, encryptionKey);
      } catch (err) {
        // A secret that won't decrypt (rotated/corrupt key) is unrecoverable —
        // no point retrying. Record a terminal failure and count it toward the
        // same auto-disable circuit as a terminal transport failure.
        logger.error({ subscriptionId: sub.id, err }, 'webhook secret decrypt failed');
        const disabled = await recordTerminalFailure({
          subscriptionId: sub.id,
          userId: sub.userId,
          deliveryId: job.deliveryId,
          eventType: job.event.type,
          attempts: attempt,
          responseStatus: null,
          error: 'secret unavailable',
        });
        return {
          outcome: disabled ? 'disabled' : 'failed',
          status: null,
          error: 'secret unavailable',
        };
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

      return concludeFailure({
        subscriptionId: sub.id,
        userId: sub.userId,
        deliveryId: job.deliveryId,
        eventType: job.event.type,
        attempt,
        maxAttempts,
        status: result.status,
        error: result.error,
      });
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
