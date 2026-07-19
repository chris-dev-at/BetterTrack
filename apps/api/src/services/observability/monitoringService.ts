import type {
  MonitoringExternalAccess,
  MonitoringReachability,
  MonitoringStatusResponse,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { AppSettingsRepository } from '../../data/repositories/appSettingsRepository';
import type { Logger } from '../../logger';
import { AuditAction, type AuditService } from '../audit/auditService';

/**
 * Admin monitoring / diagnostics service (PROJECTPLAN.md §13.5 V5-P2 arc (a),
 * owner directive 2026-07-19).
 *
 * Backs the admin Diagnostics panel and enforces the external-exposure gate for
 * the admin-proxied Grafana reverse proxy. It:
 *  - probes Grafana + Prometheus reachability server-side (short timeout, fails
 *    soft) so the panel can degrade to "configured ✓ / not reachable ✗";
 *  - resolves the external-access posture — a three-part gate that is `effective`
 *    ONLY when the deploy enabled it AND a usable Grafana admin password is set
 *    AND the runtime kill-switch is on;
 *  - owns the runtime kill-switch (an `app_settings` boolean, default on) so an
 *    admin can cut external reach with no redeploy.
 *
 * Prometheus is probed but NEVER proxied or surfaced with a client-reachable URL
 * — Grafana (which has a login, and here sits behind admin auth) is the only
 * externally reachable surface.
 */

/** `app_settings` key for the runtime external-access kill-switch. Default: on. */
export const MONITORING_EXTERNAL_ACCESS_KEY = 'monitoring_external_access_enabled';

/** The kill-switch is on unless an admin has explicitly stored `false`. */
export const DEFAULT_EXTERNAL_ACCESS_RUNTIME_ON = true;

/** Reachability probe timeout — short, so a down stack never stalls the panel. */
export const MONITORING_PROBE_TIMEOUT_MS = 2500;

export interface MonitoringServiceDeps {
  config: AppConfig;
  repo: AppSettingsRepository;
  audit: AuditService;
  logger: Logger;
  /** Injectable fetch (reachability probe + tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Probe timeout override (tests). */
  probeTimeoutMs?: number;
}

export interface MonitoringActor {
  id: string;
  ip?: string | null;
}

export interface MonitoringService {
  status(): Promise<MonitoringStatusResponse>;
  /** The single gate the Grafana proxy enforces per request. */
  externalAccessEffective(): Promise<boolean>;
  setExternalAccessRuntime(
    enabled: boolean,
    actor: MonitoringActor,
  ): Promise<MonitoringStatusResponse>;
}

export function createMonitoringService(deps: MonitoringServiceDeps): MonitoringService {
  const { config, repo, audit, logger } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const probeTimeoutMs = deps.probeTimeoutMs ?? MONITORING_PROBE_TIMEOUT_MS;
  const obs = config.observability;

  /** Read the runtime kill-switch row (unset ⇒ the default-on state). */
  async function readRuntime(): Promise<{
    on: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
  }> {
    const row = await repo.get(MONITORING_EXTERNAL_ACCESS_KEY);
    if (typeof row?.value !== 'boolean') {
      return { on: DEFAULT_EXTERNAL_ACCESS_RUNTIME_ON, updatedAt: null, updatedBy: null };
    }
    return {
      on: row.value,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      updatedBy: row.updatedBy ?? null,
    };
  }

  function resolveExternalAccess(runtime: {
    on: boolean;
    updatedAt: string | null;
    updatedBy: string | null;
  }): MonitoringExternalAccess {
    const deployEnabled = obs.externalAccessEnabled;
    const passwordSet = obs.grafanaPasswordSet;
    const killSwitchOn = runtime.on;
    return {
      deployEnabled,
      passwordSet,
      killSwitchOn,
      // The gate: EVERY condition must hold. Missing password or a flipped
      // kill-switch or a deploy that never opted in ⇒ external reach refused.
      effective: deployEnabled && passwordSet && killSwitchOn,
      updatedAt: runtime.updatedAt,
      updatedBy: runtime.updatedBy,
    };
  }

  /** Probe one service's health path; never throws — a failure is `reachable:false`. */
  async function probe(baseUrl: string, healthPath: string): Promise<MonitoringReachability> {
    try {
      const res = await fetchImpl(`${baseUrl}${healthPath}`, {
        method: 'GET',
        signal: AbortSignal.timeout(probeTimeoutMs),
        redirect: 'manual',
      });
      // Grafana `/api/health` and Prometheus `/-/healthy` both answer 200 when up.
      // A 3xx (login redirect) still proves the server is answering, so treat any
      // <500 as reachable; only a 5xx or a thrown network error is "down".
      if (res.status >= 500) return { reachable: false, detail: `http ${res.status}` };
      return { reachable: true, detail: null };
    } catch (err) {
      const detail =
        err instanceof Error ? (err.name === 'TimeoutError' ? 'timeout' : err.name) : 'error';
      return { reachable: false, detail };
    }
  }

  async function status(): Promise<MonitoringStatusResponse> {
    const runtime = await readRuntime();
    const [grafana, prometheus] = await Promise.all([
      probe(obs.grafanaInternalUrl, '/api/health'),
      probe(obs.prometheusInternalUrl, '/-/healthy'),
    ]);
    return {
      grafana: { configured: true, reachable: grafana.reachable, detail: grafana.detail },
      prometheus: {
        configured: true,
        reachable: prometheus.reachable,
        detail: prometheus.detail,
      },
      externalAccess: resolveExternalAccess(runtime),
      externalUrl: obs.grafanaPublicUrl ?? null,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  async function externalAccessEffective(): Promise<boolean> {
    // Cheap deploy-level gates first: skip the DB read when the deploy never
    // opted in or the password is unset (the common, safe-default case).
    if (!obs.externalAccessEnabled || !obs.grafanaPasswordSet) return false;
    return (await readRuntime()).on;
  }

  async function setExternalAccessRuntime(
    enabled: boolean,
    actor: MonitoringActor,
  ): Promise<MonitoringStatusResponse> {
    await repo.upsert(MONITORING_EXTERNAL_ACCESS_KEY, enabled, actor.id);
    await audit.record({
      actorId: actor.id,
      action: AuditAction.MonitoringExternalAccessChanged,
      targetType: 'monitoring',
      ip: actor.ip ?? null,
      meta: { enabled },
    });
    logger.info({ enabled }, 'monitoring external-access kill-switch updated');
    return status();
  }

  return { status, externalAccessEffective, setExternalAccessRuntime };
}
