import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import {
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_DELIVERY_HTTP_ERROR,
  WEBHOOK_DELIVERY_NETWORK_ERROR,
  WEBHOOK_DELIVERY_REFUSED_ERROR,
  WEBHOOK_DELIVERY_SECRET_ERROR,
  WEBHOOK_DELIVERY_TIMEOUT_ERROR,
  WEBHOOK_DELIVERY_UNRESOLVED_ERROR,
  WEBHOOK_DELIVERY_UNSUBSCRIBED_ERROR,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type WebhookDeliveryError,
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
  createPinnedAgent,
  isOutboundPolicyRefusal,
  resolveSafeOutboundUrl,
  type OutboundUrlResolver,
  type ResolvedOutboundUrl,
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
 * `responseStatus`; see the comment in `deliver`. The vetted addresses travel
 * with the request as {@link WebhookTransportRequest.target} and the transport
 * pins them into the socket, so the connect cannot resolve the hostname a
 * second time and land somewhere else (DNS rebinding).
 *
 * Retry model: one `deliver` call is ONE attempt. On a non-final failed attempt
 * it returns `retry` and the BullMQ job throws so the queue re-runs it with
 * backoff (`jobs/options.ts`). On the FINAL attempt's failure (or immediately
 * under test, where `maxAttempts` is 1) it records a `failed` row and bumps the
 * streak; crossing {@link WEBHOOK_AUTO_DISABLE_THRESHOLD} auto-disables. All log
 * bookkeeping is idempotent on the delivery id, so a redelivered terminal job
 * never double-counts.
 *
 * A receiver-side status that says "never send me this again"
 * ({@link WEBHOOK_PERMANENT_RESPONSE_STATUSES}) short-circuits that ladder: it
 * is terminal on the attempt it arrives, because five signed POSTs per event ×
 * up to the 20 subscriptions a user may hold is a lot of noise for an
 * answer that cannot change, and the operator's "my endpoint is gone" signal
 * should surface on the first event rather than the fifth. It is still recorded
 * as a failure with its status, so the auto-disable streak is unaffected.
 */

export interface WebhookTransportResult {
  /** True for a 2xx response. */
  ok: boolean;
  /** The receiver's HTTP status; null on a network/timeout error. */
  status: number | null;
  /**
   * A STRUCTURAL failure reason — never the response body, and never the
   * socket's own message: `err.message` carries the address, the port, the errno
   * and, on a TLS mismatch, the certificate's alternate names. The dispatcher
   * maps whatever arrives here onto {@link WebhookDeliveryError} before anything
   * is persisted, so a transport that leaks text still cannot reach the log.
   */
  error?: string;
}

export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /**
   * The destination as the guard vetted it for THIS attempt: the parsed URL plus
   * the addresses that passed the policy. A transport that opens a real socket
   * must connect to one of these addresses (see
   * {@link createPinnedWebhookTransport}) rather than resolving `url` again.
   */
  target: ResolvedOutboundUrl;
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
  /** Always one of the logged constants — the raw transport text stops at `shortReason`. */
  error?: WebhookDeliveryError;
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
  /** DNS seam for the per-attempt outbound guard (tests); defaults to the system resolver. */
  dnsResolver?: OutboundUrlResolver;
  /** Injectable clock (tests) — drives the signature timestamp + row stamps. */
  now?: () => number;
}

export interface WebhookDispatcher {
  deliver(job: WebhookDeliveryJob, ctx: WebhookAttemptContext): Promise<WebhookDeliveryResult>;
}

const DELIVERY_USER_AGENT = 'BetterTrack-Webhooks/1';

/**
 * Receiver answers that mean "this delivery will never be accepted": a malformed
 * or unauthorized request, a route that is gone, an entity the receiver rejects.
 * Retrying them changes nothing, so they end the ladder on the attempt they
 * arrive.
 *
 * Deliberately an allowlist, not "every 4xx": `408 Request Timeout`, `429 Too
 * Many Requests` and anything unlisted (incl. every 5xx) stay retryable, because
 * those DO change with time — a rate-limited or overloaded receiver is exactly
 * what the backoff ladder exists for.
 */
export const WEBHOOK_PERMANENT_RESPONSE_STATUSES: readonly number[] = [
  400, // Bad Request — the body will be identical on every retry
  401, // Unauthorized — the signature scheme is not going to change mid-ladder
  403, // Forbidden
  404, // Not Found — the receiver route does not exist
  410, // Gone — the receiver route was deleted
  422, // Unprocessable Entity — the receiver rejects this payload
];

const PERMANENT_STATUSES = new Set(WEBHOOK_PERMANENT_RESPONSE_STATUSES);

/** True when `status` is a receiver refusal that retrying cannot fix. */
export function isPermanentWebhookStatus(status: number | null): boolean {
  return status !== null && PERMANENT_STATUSES.has(status);
}

/**
 * Map one failed attempt onto the closed set of logged reasons
 * ({@link WEBHOOK_DELIVERY_ERRORS}). NOTHING the receiver or the socket produced
 * is passed through — not the response body, not `err.message`, not the status
 * text.
 *
 * The status itself still rides along in `responseStatus`, because a receiver
 * that answered HTTP is the subscriber's own endpoint telling them what it
 * thinks of the payload. Everything that did NOT answer HTTP collapses into one
 * value: a refused connection, a reset, a failed TLS handshake and a receiver
 * that never answered are indistinguishable in the log, so a destination the
 * guard allows cannot be probed through the delivery log — the same property the
 * guard-refused branch in `deliver` guarantees.
 *
 * Two residues are known and accepted, both inherent to allowing LAN receivers
 * at all (which the product contract does):
 *  - a destination that ANSWERS HTTP is still distinguishable from one that does
 *    not, and its status is logged — that is the diagnostic the feature exists
 *    for, and gutting it would leave the subscriber unable to see their own
 *    receiver returning 401;
 *  - `deliveries[].createdAt` leaks coarse timing, so a filtered port (full
 *    transport deadline) reads differently from a refused one (immediate).
 * Neither is narrowed further here; both are recorded so the next reader does
 * not mistake the collapse above for a complete non-probe guarantee.
 */
function shortReason(status: number | null, error: string | undefined): WebhookDeliveryError {
  if (status !== null) return WEBHOOK_DELIVERY_HTTP_ERROR;
  // The one pre-send condition worth telling apart: nothing was dialled at all,
  // so it says nothing about what is listening anywhere.
  if (error === WEBHOOK_DELIVERY_UNRESOLVED_ERROR) return WEBHOOK_DELIVERY_UNRESOLVED_ERROR;
  return WEBHOOK_DELIVERY_NETWORK_ERROR;
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
    error: WebhookDeliveryError;
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
    const failures = await subscriptions.incrementFailure(input.subscriptionId, at);
    if (failures < autoDisableThreshold) return false;

    await subscriptions.disable(input.subscriptionId, 'auto', at);
    logger.warn(
      { subscriptionId: input.subscriptionId, failures },
      'webhook subscription auto-disabled after consecutive failures',
    );
    await audit.record({
      actorId: input.userId,
      action: AuditAction.WebhookAutoDisabled,
      targetType: 'webhook_subscription',
      targetId: input.subscriptionId,
      ip: null,
      meta: { failures },
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
    // Canonical before ANY of it travels on — a retry result is logged by the
    // job and its message must not carry socket text either.
    const reason = shortReason(input.status, input.error);
    // A failed attempt that still has retries left → let BullMQ back off. A
    // permanent receiver refusal has nothing to wait for, so it skips straight
    // to the terminal branch and spends ONE attempt instead of the full ladder.
    if (input.attempt < input.maxAttempts && !isPermanentWebhookStatus(input.status)) {
      return { outcome: 'retry', status: input.status, error: reason };
    }
    // Terminal failure: record it and advance the auto-disable streak once.
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

      // The subscribed set is authoritative at SEND, not only at fan-out. The
      // queue is not instantaneous — which is precisely why `enabled` and the
      // destination URL are re-checked here — so a user who PATCHes an event
      // type off must not have queued deliveries POST it to the endpoint they
      // just revoked it from. Recorded so the drop is explainable in the log,
      // but never counted against the auto-disable streak: the receiver did
      // nothing wrong, the owner changed their mind.
      if (!sub.eventTypes.includes(job.event.type)) {
        logger.info(
          { subscriptionId: sub.id, type: job.event.type },
          'webhook delivery dropped: event type no longer subscribed',
        );
        await deliveries.record({
          id: job.deliveryId,
          subscriptionId: sub.id,
          eventType: job.event.type,
          status: 'failed',
          responseStatus: null,
          attempts: attempt,
          error: WEBHOOK_DELIVERY_UNSUBSCRIBED_ERROR,
        });
        return {
          outcome: 'skipped',
          status: null,
          error: WEBHOOK_DELIVERY_UNSUBSCRIBED_ERROR,
        };
      }

      // SSRF guard (§8 "Outbound safety", §13.5 V5-P10). The destination is
      // user-supplied, so it is re-resolved and re-checked on EVERY attempt: a
      // hostname that was public when the subscription was created can point at
      // loopback by now (DNS rebinding). Nothing is signed or sent before this
      // passes. The resolution happens exactly ONCE per attempt and its vetted
      // addresses are handed to the transport, which pins them into the socket
      // — a second lookup at connect time cannot substitute another address.
      let target: ResolvedOutboundUrl;
      try {
        target = await resolveSafeOutboundUrl(sub.url, {
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
          error: WEBHOOK_DELIVERY_UNRESOLVED_ERROR,
        });
      }

      // Fail-closed: an event with no declared per-type disclosure is never
      // serialized to a receiver. The bridge only enqueues catalog types, so a
      // miss here means a stale job from a since-removed type.
      const built = buildWebhookPayload(job.deliveryId, job.event);
      if (!built) {
        logger.warn(
          { subscriptionId: sub.id, type: job.event.type },
          'webhook delivery skipped: event type has no payload allowlist',
        );
        return { outcome: 'skipped', status: null };
      }
      const { body } = built;
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
          error: WEBHOOK_DELIVERY_SECRET_ERROR,
        });
        return {
          outcome: disabled ? 'disabled' : 'failed',
          status: null,
          error: WEBHOOK_DELIVERY_SECRET_ERROR,
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
        result = await transport.send({ url: sub.url, headers, body, target });
      } catch (err) {
        // The detail belongs in the operator's log, never in the subscriber's.
        logger.warn({ subscriptionId: sub.id, err }, 'webhook transport failed');
        result = { ok: false, status: null, error: WEBHOOK_DELIVERY_NETWORK_ERROR };
      }

      if (result.ok) {
        // Upsert, not insert-or-drop: a replayed delivery reuses its
        // deterministic id, so a 200 that arrives after a `failed` row was
        // written must flip that row rather than vanish — otherwise the log
        // permanently reports a delivered event as failed. Unlike the failure
        // path (whose `incrementFailure` is not idempotent) both writes here
        // are, so neither is gated on "did we insert".
        await deliveries.recordDelivered({
          id: job.deliveryId,
          subscriptionId: sub.id,
          eventType: job.event.type,
          responseStatus: result.status,
          attempts: attempt,
        });
        await subscriptions.recordSuccess(sub.id, new Date(now()));
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
 * The production transport: a single POST bounded by a timeout. A non-2xx
 * response or any thrown error is a failure the caller counts toward retries.
 *
 * It deliberately does NOT use `fetch`: `fetch` resolves the hostname itself at
 * connect time, which would discard the guard's vetted answer and re-open the
 * DNS-rebinding window the per-attempt guard exists to close. Instead the
 * request runs over a single-use agent pinned to exactly the addresses the guard
 * approved for this attempt ({@link createPinnedAgent}) — for `https:` and, per
 * {@link WEBHOOK_RECEIVER_URL_POLICY}, plain `http:` receivers alike. Redirects
 * are never followed (a 3xx is just a non-2xx failure), so a receiver cannot
 * bounce the signed POST to an unvetted destination either. The response body is
 * drained and never read.
 */
export function createPinnedWebhookTransport(timeoutMs = 10_000): WebhookTransport {
  return {
    async send({ headers, body, target }) {
      const agent = createPinnedAgent(target);
      const payload = Buffer.from(body, 'utf8');
      const send = target.url.protocol === 'http:' ? httpRequest : httpsRequest;
      try {
        return await new Promise<WebhookTransportResult>((resolve) => {
          // One shared cell so the deadline can be cleared by whichever of the
          // response, the error or the timeout itself settles the attempt first.
          const attempt: { settled: boolean; timer?: ReturnType<typeof setTimeout> } = {
            settled: false,
          };
          const finish = (result: WebhookTransportResult): void => {
            if (attempt.settled) return;
            attempt.settled = true;
            if (attempt.timer !== undefined) clearTimeout(attempt.timer);
            resolve(result);
          };

          const req = send(target.url, {
            method: 'POST',
            agent,
            headers: { ...headers, 'content-length': String(payload.byteLength) },
          });
          attempt.timer = setTimeout(() => {
            req.destroy(new Error(WEBHOOK_DELIVERY_TIMEOUT_ERROR));
            finish({ ok: false, status: null, error: WEBHOOK_DELIVERY_TIMEOUT_ERROR });
          }, timeoutMs);

          req.on('response', (res) => {
            const status = res.statusCode ?? null;
            const ok = status !== null && status >= 200 && status < 300;
            res.resume(); // never read the receiver's body
            res.on('end', () => finish({ ok, status }));
            res.on('error', () => finish({ ok, status }));
          });
          // Structural, never `err.message`: ECONNREFUSED names the address and
          // port it dialled, and a TLS mismatch names the certificate's hosts.
          req.on('error', () =>
            finish({ ok: false, status: null, error: WEBHOOK_DELIVERY_NETWORK_ERROR }),
          );
          req.end(payload);
        });
      } finally {
        agent.destroy();
      }
    },
  };
}
