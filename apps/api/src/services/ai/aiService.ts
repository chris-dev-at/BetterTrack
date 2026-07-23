import type {
  AiCapabilityResponse,
  AiSettingsResponse,
  AiTestConnectionResponse,
  AiTestRequest,
  AiTestRequestResponse,
  UpdateAiSettingsRequest,
} from '@bettertrack/contracts';

import type { Logger } from '../../logger';
import type { AiSettings, AppSettingsService } from '../appSettings/appSettingsService';
import { AuditAction, type AuditService } from '../audit/auditService';
import type { FeatureFlagService } from '../featureFlags/featureFlagService';
import type { AiDailyCap } from './dailyCap';
import { AiProviderError, AiUnavailableError } from './errors';
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
}

export interface AiService {
  /** User-facing: is AI available for this user + how much daily budget is left. */
  capability(userId: string): Promise<AiCapabilityResponse>;
  /**
   * The guarded completion path (consumed by 2/2): availability + feature-flag
   * check, cap enforcement, provider resolution + call. Throws the typed
   * `AiUnavailableError` / `AiCapExceededError` / `AiProviderError`.
   */
  complete(userId: string, request: AiCompletionRequest): Promise<AiCompletionResult>;
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

/** Short, non-sensitive detail for a failed diagnostic (mirrors the health probe). */
function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    return err.message || err.name || 'error';
  }
  return 'error';
}

export function createAiService(deps: AiServiceDeps): AiService {
  const { appSettings, registry, cap, featureFlags, audit, logger } = deps;

  /**
   * The `ai` feature flag (already in the registry as "AI insights & assistant").
   * Folding it into availability lets an admin hide AI without unconfiguring it,
   * and aligns this read with the `requireFeature('ai')` route gate 2/2 adds.
   */
  async function featureEnabled(): Promise<boolean> {
    return featureFlags.isEnabled('ai');
  }

  function serialize(settings: AiSettings): AiSettingsResponse {
    return {
      endpoint: settings.endpoint,
      model: settings.model,
      dailyCap: settings.dailyCap,
      configured: settings.configured,
      updatedAt: settings.updatedAt ? settings.updatedAt.toISOString() : null,
      updatedBy: settings.updatedBy,
    };
  }

  async function capability(userId: string): Promise<AiCapabilityResponse> {
    const settings = await appSettings.getAiSettings();
    const available = settings.configured && (await featureEnabled());
    const used = available ? await cap.usage(userId) : 0;
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
    if (!settings.configured || !(await featureEnabled())) throw new AiUnavailableError();
    const provider = await registry.resolve();
    if (!provider) throw new AiUnavailableError();

    // Enforce the daily cap BEFORE spending a (slow, local) generation. A failed
    // provider call refunds the unit so a broken endpoint never burns quota.
    await cap.consume(userId, settings.dailyCap);
    try {
      return await provider.complete(request);
    } catch (err) {
      await cap.refund(userId).catch(() => undefined);
      // Already-typed unavailability propagates as-is; anything else is a
      // provider failure (timeout, non-2xx, bad payload) → typed 502.
      if (err instanceof AiUnavailableError) throw err;
      logger.warn({ err }, 'ai completion failed');
      throw new AiProviderError();
    }
  }

  async function getSettings(): Promise<AiSettingsResponse> {
    return serialize(await appSettings.getAiSettings());
  }

  async function updateSettings(
    input: UpdateAiSettingsRequest,
    actor: AiServiceActor,
  ): Promise<AiSettingsResponse> {
    const next = await appSettings.updateAiSettings(input, actor.id);
    // Endpoint/model/cap are non-secret, so recording them makes the change
    // fully auditable (unlike a cloud token, which this product never stores).
    await audit.record({
      actorId: actor.id,
      action: AuditAction.AiSettingsUpdated,
      targetType: 'ai_settings',
      ip: actor.ip ?? null,
      meta: {
        endpoint: input.endpoint,
        model: input.model,
        dailyCap: input.dailyCap,
      },
    });
    return serialize(next);
  }

  async function testConnection(endpoint?: string): Promise<AiTestConnectionResponse> {
    const settings = await appSettings.getAiSettings();
    const target = endpoint ?? settings.endpoint;
    if (!target) return { ok: false, models: [], error: 'no endpoint' };
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
      logger.warn({ err, endpoint }, 'ai test request failed');
      return {
        ok: false,
        model,
        reply: null,
        latencyMs: Date.now() - startedAt,
        error: errorDetail(err),
      };
    }
  }

  return { capability, complete, getSettings, updateSettings, testConnection, testRequest };
}
