import type {
  AiCapabilityResponse,
  AiSettingsResponse,
  AiTestConnectionResponse,
  AiTestRequest,
  AiTestRequestResponse,
  UpdateAiSettingsRequest,
} from '@bettertrack/contracts';

import { ApiError } from '../../errors';
import type { Logger } from '../../logger';
import type { AiSettings, AppSettingsService } from '../appSettings/appSettingsService';
import { AuditAction, type AuditService } from '../audit/auditService';
import { auditFieldDiff } from '../audit/auditRedaction';
import { userPrincipal } from '../featureFlags/featureFlagResolution';
import type { FeatureFlagService } from '../featureFlags/featureFlagService';
import { isOutboundPolicyRefusal, type OutboundUrlResolver } from '../security/outboundUrlGuard';
import type { AiDailyCap } from './dailyCap';
import {
  assertWritableLocalAiEndpoint,
  providerErrorDetail,
  redactEndpoint,
  resolveLocalAiEndpoint,
} from './endpointPolicy';
import { AiEndpointNotLocalError, AiProviderError, AiUnavailableError } from './errors';
import type { AiRegistry } from './registry';
import type { AiCompletionRequest, AiCompletionResult } from './types';

/**
 * The local-AI orchestration service (PROJECTPLAN.md §13.5 V5-P12, §16
 * 2026-07-22 — LOCAL AI ONLY). It stitches together the four pieces of the
 * provider layer: the app-settings config, the request-time provider registry,
 * the per-user daily cap, and the `ai` feature flag. Issue 2/2 (insights, NL
 * builder) is purely additive — it consumes {@link AiService.complete}, which is
 * already the full guarded path here.
 */

export interface AiServiceActor {
  id: string;
  ip?: string | null;
}

export interface AiServiceDeps {
  appSettings: Pick<AppSettingsService, 'getAiSettings' | 'updateAiSettings'>;
  registry: AiRegistry;
  cap: AiDailyCap;
  /** The existing `ai` kill-switch — folded into availability (never a token store). */
  featureFlags: Pick<FeatureFlagService, 'isEnabled'>;
  audit: AuditService;
  logger: Logger;
  /**
   * DNS resolver for the endpoint egress guard on the WRITE and PROBE paths
   * (§13.5 V5-P12, #1656). Defaults to the system resolver; a test injects a
   * stub so a rebinding hostname is deterministic and the suite stays offline.
   */
  resolver?: OutboundUrlResolver;
}

export interface AiService {
  /** User-facing: is AI available for this user + how much daily budget is left. */
  capability(userId: string): Promise<AiCapabilityResponse>;
  /**
   * The availability half of {@link AiService.complete}, callable on its own.
   *
   * A feature that does substantive work before it generates must run THIS
   * first, so an unconfigured install answers 503 `AI_UNAVAILABLE` rather than
   * some statement about the caller's data it had to read to produce (#1656
   * defect 5). Throws {@link AiUnavailableError}; costs no cap unit and makes no
   * network call.
   */
  assertAvailable(userId: string): Promise<void>;
  /**
   * The guarded completion path (consumed by 2/2): availability + feature-flag
   * check, cap enforcement, provider resolution + call. Throws the typed
   * `AiUnavailableError` / `AiCapExceededError` / `AiProviderError`.
   */
  complete(userId: string, request: AiCompletionRequest): Promise<AiCompletionResult>;
  /**
   * Hand back the cap unit a completed {@link AiService.complete} spent, when
   * the caller finds its output unusable.
   *
   * ONE unit per consumed unit: `complete` already refunds every path on which
   * it throws, so this is only ever correct after it RETURNED. Never throws —
   * a cap backend that is down must not turn a feature-level refusal into a
   * different error than the one the caller is about to raise.
   */
  refundCompletion(userId: string): Promise<void>;
  /** Admin: read the effective endpoint/model/cap (no secrets). */
  getSettings(): Promise<AiSettingsResponse>;
  /** Admin: set endpoint/model/cap (audit-logged; live on the next request). */
  updateSettings(
    input: UpdateAiSettingsRequest,
    actor: AiServiceActor,
  ): Promise<AiSettingsResponse>;
  /** Admin: probe an endpoint (candidate or stored) and list its models. */
  testConnection(endpoint?: string): Promise<AiTestConnectionResponse>;
  /**
   * Admin: send a real prompt to an endpoint/model and return the generated reply
   * plus its round-trip latency. A diagnostic — it deliberately does NOT go
   * through {@link AiService.complete}, so it never spends a user's daily cap.
   */
  testRequest(input: AiTestRequest): Promise<AiTestRequestResponse>;
}

/**
 * The three admin-settable AI fields, narrowed to the ones this request
 * addressed — so a save that only raises the daily cap records the cap, not the
 * endpoint it left alone (#1908 §4).
 */
function pickAiAudit(
  settings: Pick<AiSettings, 'endpoint' | 'model' | 'dailyCap'>,
  request: UpdateAiSettingsRequest,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  // `redactEndpoint`, not the raw value: `audit_log.meta` is durable for
  // `BT_AUDIT_RETENTION_DAYS` (400 by default) and reaches backups and exports,
  // so a credential smuggled in by a row written before the write path refused
  // userinfo must not be the thing this records. The HOST is kept — "the local
  // endpoint moved from A to B" is the fact the auditor needs (#1656 defect 2).
  if (request.endpoint !== undefined) picked.endpoint = redactEndpoint(settings.endpoint);
  if (request.model !== undefined) picked.model = settings.model;
  if (request.dailyCap !== undefined) picked.dailyCap = settings.dailyCap;
  return picked;
}

export function createAiService(deps: AiServiceDeps): AiService {
  const { appSettings, registry, cap, featureFlags, audit, logger } = deps;
  const guardDeps = deps.resolver ? { resolver: deps.resolver } : {};

  /**
   * Run a daily-cap operation, mapping an infrastructure failure to the typed
   * 503 (#1656 defect 5).
   *
   * The cap is a Redis counter, and `cap.consume` used to sit OUTSIDE the try —
   * so an ioredis error escaped as a plain `Error` and the error handler turned
   * it into a 500 INTERNAL, for a feature whose whole contract is that it goes
   * quiet when it cannot run. Typed errors the cap itself raises
   * (`AiCapExceededError` — any {@link ApiError}) are the answer, not the
   * failure, and pass straight through.
   *
   * Fail-CLOSED: a cap backend that cannot be read cannot prove the caller has
   * budget left, so nothing is generated. The alternative — generate anyway —
   * is an unmetered AI endpoint for the length of a Redis outage.
   */
  async function throughCap<T>(op: () => Promise<T>, what: string): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.warn({ err, op: what }, 'ai daily cap backend unavailable');
      throw new AiUnavailableError('AI is temporarily unavailable.');
    }
  }

  /**
   * The `ai` feature flag (already in the registry as "AI insights & assistant").
   * Folding it into availability lets an admin hide AI without unconfiguring it,
   * and aligns this read with the `requireFeature('ai')` route gate 2/2 adds.
   *
   * Resolved for the ASKING USER (#1910). Both callers already hold one, and
   * they must: `requireFeature('ai')` on the routes resolves per principal now,
   * so a capability read that answered globally would tell a user outside the
   * rollout that AI is available and then 404 them at the generation endpoint —
   * the flag equivalent of a dead link.
   */
  async function featureEnabled(userId: string): Promise<boolean> {
    return featureFlags.isEnabled('ai', userPrincipal(userId));
  }

  function serialize(settings: AiSettings): AiSettingsResponse {
    return {
      // Never the raw stored string: a row written before the write path refused
      // userinfo would otherwise hand `https://svc:s3cr3t@…` straight to the
      // admin SPA in cleartext (#1656 defect 2). A row that is not a URL at all
      // reads as unset rather than being echoed back unexamined.
      endpoint: redactEndpoint(settings.endpoint),
      model: settings.model,
      dailyCap: settings.dailyCap,
      configured: settings.configured,
      updatedAt: settings.updatedAt ? settings.updatedAt.toISOString() : null,
      updatedBy: settings.updatedBy,
    };
  }

  /**
   * Deliberately its own settings read rather than a value threaded into
   * {@link complete}: the two run at different moments (a feature calls this
   * first, then does its work, then generates), and `complete` must re-check
   * regardless because it is also called directly. The cost is one extra read of
   * the small `app_settings` KV table on a path that then spends seconds in a
   * local model.
   */
  async function assertAvailable(userId: string): Promise<void> {
    const settings = await appSettings.getAiSettings();
    if (!settings.configured || !(await featureEnabled(userId))) throw new AiUnavailableError();
  }

  async function capability(userId: string): Promise<AiCapabilityResponse> {
    const settings = await appSettings.getAiSettings();
    const available = settings.configured && (await featureEnabled(userId));
    const used = available ? await throughCap(() => cap.usage(userId), 'usage') : 0;
    return {
      available,
      model: available ? settings.model : null,
      dailyCap: settings.dailyCap,
      used,
      remaining: available ? Math.max(0, settings.dailyCap - used) : 0,
    };
  }

  async function complete(
    userId: string,
    request: AiCompletionRequest,
  ): Promise<AiCompletionResult> {
    const settings = await appSettings.getAiSettings();
    if (!settings.configured || !(await featureEnabled(userId))) throw new AiUnavailableError();
    const provider = await registry.resolve();
    if (!provider) throw new AiUnavailableError();

    // Enforce the daily cap BEFORE spending a (slow, local) generation. A failed
    // provider call refunds the unit so a broken endpoint never burns quota.
    await throughCap(() => cap.consume(userId, settings.dailyCap), 'consume');
    try {
      return await provider.complete(request);
    } catch (err) {
      // The ONE refund site for a unit this call spent — see `AiDailyCap.refund`
      // on why each consumed unit may have only one. Swallowed on purpose: a
      // failed refund must not replace the provider error the caller needs.
      await cap.refund(userId).catch(() => undefined);
      // Already-typed unavailability propagates as-is; anything else is a
      // provider failure (timeout, non-2xx, bad payload) → typed 502.
      if (err instanceof AiUnavailableError) throw err;
      // An endpoint the egress guard refuses is a CONFIGURATION state, not a
      // provider fault: a row stored before #1656 (or a hostname that has since
      // started resolving publicly) must take the feature quiet with the typed
      // 503 the contract already defines, never a 502 that reads as "the local
      // model is broken" and never an untyped 500. The admin sees the real
      // reason on the settings page's probe.
      if (isOutboundPolicyRefusal(err) || err instanceof AiEndpointNotLocalError) {
        logger.warn(
          { endpoint: redactEndpoint(settings.endpoint) },
          'ai completion refused: endpoint is not on the internal network',
        );
        throw new AiUnavailableError();
      }
      logger.warn({ detail: providerErrorDetail(err) }, 'ai completion failed');
      throw new AiProviderError();
    }
  }

  async function refundCompletion(userId: string): Promise<void> {
    await cap.refund(userId).catch((err: unknown) => {
      logger.warn({ err }, 'ai cap refund failed');
    });
  }

  /**
   * Vet a probe target. Raises {@link AiEndpointNotLocalError} when the guard
   * refuses it by POLICY — an admin may not aim a probe at the internet, at
   * cloud metadata, or at this deployment's own services, and a soft result for
   * one of those is still a scan result.
   *
   * Returns a soft failure DETAIL when the target merely could not be resolved
   * right now: that is an ordinary transport condition, the probe has always
   * reported it softly, and a 500 for "your DNS is down" helps nobody.
   */
  async function probeRefusal(target: string): Promise<string | null> {
    try {
      await resolveLocalAiEndpoint(target, guardDeps);
      return null;
    } catch (err) {
      if (err instanceof AiEndpointNotLocalError) throw err;
      return providerErrorDetail(err);
    }
  }

  async function getSettings(): Promise<AiSettingsResponse> {
    return serialize(await appSettings.getAiSettings());
  }

  async function updateSettings(
    input: UpdateAiSettingsRequest,
    actor: AiServiceActor,
  ): Promise<AiSettingsResponse> {
    // The egress guard BEFORE the write (#1656 defect 1): an endpoint outside
    // the internal network is refused with the typed 400 and never reaches the
    // store, so it can never be fetched, audited or rendered. The contracts
    // schema has already settled scheme + credentials + syntax; what only the
    // server can decide is where the host actually IS, which is why the address
    // policy lives in the shared outbound guard and is applied here.
    //
    // A host that cannot be classified right now is stored anyway (an admin
    // configuring the box before powering it on), and the fact is logged rather
    // than swallowed silently — the value is unusable until it resolves to
    // something local, because the fetch-time guard re-vets it every call.
    if (typeof input.endpoint === 'string') {
      const vetted = await assertWritableLocalAiEndpoint(input.endpoint, guardDeps);
      if (!vetted) {
        logger.warn(
          { endpoint: redactEndpoint(input.endpoint) },
          'ai endpoint stored without a resolved address; it stays refused until it resolves locally',
        );
      }
    }
    const previous = await appSettings.getAiSettings();
    const next = await appSettings.updateAiSettings(input, actor.id);
    // Endpoint/model/cap are non-secret, so recording them makes the change
    // fully auditable (unlike a cloud token, which this product never stores).
    // Now as a before/after pair over the keys the request addressed (#1908 §4):
    // "the local endpoint moved from A to B" is the fact an auditor needs, and
    // the previous value was the half that used to be missing. `auditService`
    // redacts secret-shaped keys on the way in regardless, so a field this form
    // grows later cannot carry a credential into the row (#1656).
    const changed = auditFieldDiff(pickAiAudit(previous, input), pickAiAudit(next, input)) ?? {
      before: {},
      after: {},
    };
    await audit.record({
      actorId: actor.id,
      action: AuditAction.AiSettingsUpdated,
      targetType: 'ai_settings',
      ip: actor.ip ?? null,
      meta: changed,
    });
    return serialize(next);
  }

  async function testConnection(endpoint?: string): Promise<AiTestConnectionResponse> {
    const settings = await appSettings.getAiSettings();
    const target = endpoint ?? settings.endpoint;
    if (!target) return { ok: false, models: [], error: 'no endpoint' };
    // Vet BEFORE probing, and raise rather than fail soft (#1656 defect 1): a
    // soft `{ ok: false, error }` for a refused target is still a scan result —
    // it reports whether that address answered. The typed 400 reports only that
    // the admin may not aim the probe there, which is the same answer for
    // `169.254.169.254` as for a bridge-internal `redis:6379`.
    //
    // Only a POLICY refusal raises. A host that simply cannot be resolved right
    // now is an ordinary transport failure and keeps the soft shape this probe
    // has always had — turning it into a 500 was the regression #1992's review
    // caught (blocker 1).
    const refusal = await probeRefusal(target);
    if (refusal) return { ok: false, models: [], error: refusal };
    // The model is irrelevant to a list-models probe; pass the effective one (or
    // empty) so the adapter is well-formed. Only the given endpoint is reached.
    const provider = registry.resolveFor(target, settings.model ?? '');
    const result = await provider.health();
    return { ok: result.ok, models: result.models, error: result.error };
  }

  async function testRequest(input: AiTestRequest): Promise<AiTestRequestResponse> {
    const settings = await appSettings.getAiSettings();
    const endpoint = input.endpoint ?? settings.endpoint;
    const model = input.model ?? settings.model;
    if (!endpoint)
      return { ok: false, model: null, reply: null, latencyMs: 0, error: 'no endpoint' };
    if (!model) return { ok: false, model: null, reply: null, latencyMs: 0, error: 'no model' };

    // Same refusal as test-connection: a generation probe reaches further than a
    // list-models probe, so it is vetted on the same terms before anything opens.
    const refusal = await probeRefusal(endpoint);
    if (refusal) {
      return { ok: false, model, reply: null, latencyMs: 0, error: refusal };
    }

    // Straight to the candidate provider — no cap consumption and no feature-flag
    // gate: this is the admin's way to verify a model (or trial an unsaved one)
    // and it must never eat into anybody's daily budget. Failures come back as a
    // soft result, like the health probe, so the page can render the reason.
    const provider = registry.resolveFor(endpoint, model);
    const startedAt = Date.now();
    try {
      const result = await provider.complete({ prompt: input.prompt });
      return {
        ok: true,
        model: result.model,
        reply: result.text,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (err) {
      // Redacted endpoint + a closed-set detail, never the raw error: the
      // message of a failed `fetch` can carry the request URL, credentials and
      // all, and a `res.json()` SyntaxError carries a slice of the target's body
      // (#1656 defects 2 + 3).
      const detail = providerErrorDetail(err);
      logger.warn({ detail, endpoint: redactEndpoint(endpoint) }, 'ai test request failed');
      return {
        ok: false,
        model,
        reply: null,
        latencyMs: Date.now() - startedAt,
        error: detail,
      };
    }
  }

  return {
    assertAvailable,
    capability,
    complete,
    refundCompletion,
    getSettings,
    updateSettings,
    testConnection,
    testRequest,
  };
}
