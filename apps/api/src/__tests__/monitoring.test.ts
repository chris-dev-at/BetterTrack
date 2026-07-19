import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { monitoringStatusResponseSchema } from '@bettertrack/contracts';

import type { AppConfig } from '../config/env';
import type { AppSettingRow } from '../data/schema';
import type { AppSettingsRepository } from '../data/repositories/appSettingsRepository';
import { createGrafanaProxyMiddleware } from '../http/grafanaProxy';
import type { AppContext } from '../http/context';
import type { Logger } from '../logger';
import type { AuditService } from '../services/audit/auditService';
import {
  DEFAULT_EXTERNAL_ACCESS_RUNTIME_ON,
  MONITORING_EXTERNAL_ACCESS_KEY,
  createMonitoringService,
} from '../services/observability/monitoringService';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => noopLogger,
} as unknown as Logger;

/** In-memory `app_settings` store (only get/upsert/getAll are exercised). */
function makeRepo(initial: Record<string, unknown> = {}): AppSettingsRepository {
  const store = new Map<string, AppSettingRow>();
  for (const [key, value] of Object.entries(initial)) {
    store.set(key, {
      key,
      value,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedBy: null,
    });
  }
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async getAll() {
      return [...store.values()];
    },
    async upsert(key, value, updatedBy) {
      const row: AppSettingRow = {
        key,
        value,
        updatedAt: new Date('2026-02-02T00:00:00.000Z'),
        updatedBy,
      };
      store.set(key, row);
      return row;
    },
  };
}

function makeConfig(obs: Partial<AppConfig['observability']> = {}): AppConfig {
  return {
    corsOrigins: ['https://admin.example', 'https://web.example'],
    observability: {
      grafanaInternalUrl: 'http://grafana:3000',
      prometheusInternalUrl: 'http://prometheus:9090',
      externalAccessEnabled: false,
      grafanaPasswordSet: false,
      grafanaPublicUrl: undefined,
      ...obs,
    },
  } as unknown as AppConfig;
}

const okFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;

function makeAudit(): { service: AuditService; records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    service: {
      record: async (input) => {
        records.push(input);
      },
    } as AuditService,
  };
}

describe('monitoring service — external-access gate (§13.5 V5-P2 arc (a))', () => {
  it('is safe by default: no deploy opt-in, no password ⇒ never effective', async () => {
    const svc = createMonitoringService({
      config: makeConfig(),
      repo: makeRepo(),
      audit: makeAudit().service,
      logger: noopLogger,
      fetchImpl: okFetch,
    });
    expect(await svc.externalAccessEffective()).toBe(false);
    const status = await svc.status();
    expect(status.externalAccess).toMatchObject({
      deployEnabled: false,
      passwordSet: false,
      killSwitchOn: DEFAULT_EXTERNAL_ACCESS_RUNTIME_ON,
      effective: false,
    });
  });

  it('is effective ONLY when deploy + password + runtime kill-switch all permit', async () => {
    const base = { audit: makeAudit().service, logger: noopLogger, fetchImpl: okFetch };

    // Deploy on but password unset — refused (never admin/admin on a public door).
    expect(
      await createMonitoringService({
        ...base,
        repo: makeRepo(),
        config: makeConfig({ externalAccessEnabled: true, grafanaPasswordSet: false }),
      }).externalAccessEffective(),
    ).toBe(false);

    // Password set but deploy never opted in — refused.
    expect(
      await createMonitoringService({
        ...base,
        repo: makeRepo(),
        config: makeConfig({ externalAccessEnabled: false, grafanaPasswordSet: true }),
      }).externalAccessEffective(),
    ).toBe(false);

    // Both set — effective (runtime kill-switch defaults on).
    expect(
      await createMonitoringService({
        ...base,
        repo: makeRepo(),
        config: makeConfig({ externalAccessEnabled: true, grafanaPasswordSet: true }),
      }).externalAccessEffective(),
    ).toBe(true);

    // Both set but the runtime kill-switch is flipped off — refused.
    expect(
      await createMonitoringService({
        ...base,
        repo: makeRepo({ [MONITORING_EXTERNAL_ACCESS_KEY]: false }),
        config: makeConfig({ externalAccessEnabled: true, grafanaPasswordSet: true }),
      }).externalAccessEffective(),
    ).toBe(false);
  });

  it('flips the runtime kill-switch, persists it, and audit-logs the change', async () => {
    const repo = makeRepo();
    const audit = makeAudit();
    const svc = createMonitoringService({
      config: makeConfig({ externalAccessEnabled: true, grafanaPasswordSet: true }),
      repo,
      audit: audit.service,
      logger: noopLogger,
      fetchImpl: okFetch,
    });

    expect(await svc.externalAccessEffective()).toBe(true);

    const status = await svc.setExternalAccessRuntime(false, { id: 'admin-1', ip: '10.0.0.1' });
    expect(status.externalAccess.killSwitchOn).toBe(false);
    expect(status.externalAccess.effective).toBe(false);
    expect(status.externalAccess.updatedAt).not.toBeNull();

    // Persisted: a fresh read now returns the off state.
    expect(await svc.externalAccessEffective()).toBe(false);
    expect(await repo.get(MONITORING_EXTERNAL_ACCESS_KEY)).toMatchObject({ value: false });
    expect(audit.records).toEqual([
      expect.objectContaining({
        action: 'monitoring.external_access_changed',
        actorId: 'admin-1',
        meta: { enabled: false },
      }),
    ]);
  });
});

describe('monitoring service — reachability probe (fails soft)', () => {
  it('reports reachable when the health probe answers < 500', async () => {
    const svc = createMonitoringService({
      config: makeConfig(),
      repo: makeRepo(),
      audit: makeAudit().service,
      logger: noopLogger,
      fetchImpl: okFetch,
    });
    const status = await svc.status();
    expect(status.grafana.reachable).toBe(true);
    expect(status.prometheus.reachable).toBe(true);
    // The response validates against the shared contract shape.
    expect(() => monitoringStatusResponseSchema.parse(status)).not.toThrow();
  });

  it('reports not-reachable on a 5xx or a thrown network error', async () => {
    const svc5xx = createMonitoringService({
      config: makeConfig(),
      repo: makeRepo(),
      audit: makeAudit().service,
      logger: noopLogger,
      fetchImpl: (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
    });
    const s5xx = await svc5xx.status();
    expect(s5xx.grafana).toMatchObject({ reachable: false, detail: 'http 503' });

    const svcThrow = createMonitoringService({
      config: makeConfig(),
      repo: makeRepo(),
      audit: makeAudit().service,
      logger: noopLogger,
      fetchImpl: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    });
    const sThrow = await svcThrow.status();
    expect(sThrow.grafana.reachable).toBe(false);
    expect(sThrow.prometheus.reachable).toBe(false);
  });
});

describe('grafana proxy middleware — gate + header rewrite', () => {
  function proxyApp(opts: { effective: boolean; fetchImpl: typeof fetch }) {
    const fetchSpy = vi.fn(opts.fetchImpl);
    const ctx = {
      config: makeConfig(),
      logger: noopLogger,
      monitoring: {
        externalAccessEffective: async () => opts.effective,
      },
    } as unknown as AppContext;
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/admin/monitoring/grafana',
      createGrafanaProxyMiddleware(ctx, fetchSpy as unknown as typeof fetch),
    );
    return { app, fetchSpy };
  }

  it('refuses with a clean 404 and never calls upstream when not effective', async () => {
    const { app, fetchSpy } = proxyApp({ effective: false, fetchImpl: okFetch });
    const res = await request(app).get('/api/v1/admin/monitoring/grafana/d/abc');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MONITORING_NOT_EXPOSED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards, strips the framing + encoding headers, and scopes frame-ancestors', async () => {
    const upstream = (async () =>
      new Response('grafana-dashboard', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'x-frame-options': 'DENY',
          'content-encoding': 'gzip',
        },
      })) as unknown as typeof fetch;
    const { app } = proxyApp({ effective: true, fetchImpl: upstream });
    const res = await request(app).get('/api/v1/admin/monitoring/grafana/');
    expect(res.status).toBe(200);
    expect(res.text).toBe('grafana-dashboard');
    expect(res.headers['content-type']).toContain('text/html');
    // Grafana's / helmet's framing blockers are replaced with a scoped CSP.
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain('frame-ancestors');
    expect(res.headers['content-security-policy']).toContain('https://admin.example');
  });

  it('degrades to 502 when Grafana is unreachable', async () => {
    const { app } = proxyApp({
      effective: true,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const res = await request(app).get('/api/v1/admin/monitoring/grafana/');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('MONITORING_UPSTREAM_UNAVAILABLE');
  });
});

describe('admin monitoring routes + proxy (wired through the app)', () => {
  let harness: TestHarness;

  afterEach(() => {
    // PGlite / ioredis-mock torn down by the harness lifecycle.
  });

  describe('default deploy (external access off)', () => {
    beforeEach(async () => {
      harness = await createTestApp({
        // Point the probe at a refused port so it fails instantly + deterministically.
        env: {
          BT_GRAFANA_INTERNAL_URL: 'http://127.0.0.1:1',
          BT_PROMETHEUS_INTERNAL_URL: 'http://127.0.0.1:1',
        },
      });
    });

    it('404s the status + proxy to anonymous callers (no leak)', async () => {
      expect((await request(harness.app).get('/api/v1/admin/monitoring/status')).status).toBe(404);
      expect((await request(harness.app).get('/api/v1/admin/monitoring/grafana/')).status).toBe(
        404,
      );
    });

    it('serves status to an admin and reports external access NOT effective', async () => {
      const admin = await harness.seedAdmin();
      const agent = await harness.loginAdmin(admin);
      const res = await agent.get('/api/v1/admin/monitoring/status');
      expect(res.status).toBe(200);
      const parsed = monitoringStatusResponseSchema.parse(res.body);
      expect(parsed.externalAccess.effective).toBe(false);
      expect(parsed.externalAccess.deployEnabled).toBe(false);
      // Probe of the refused port fails soft.
      expect(parsed.grafana.reachable).toBe(false);
    });

    it('404s the proxy for an authenticated admin while not exposed', async () => {
      const admin = await harness.seedAdmin();
      const agent = await harness.loginAdmin(admin);
      const res = await agent.get('/api/v1/admin/monitoring/grafana/d/abc');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MONITORING_NOT_EXPOSED');
    });
  });

  describe('external access opted in (deploy + password set)', () => {
    beforeEach(async () => {
      harness = await createTestApp({
        env: {
          BT_OBS_EXTERNAL_ACCESS: 'true',
          BT_GRAFANA_ADMIN_PASSWORD: 'grafana-strong-secret-9',
          BT_GRAFANA_INTERNAL_URL: 'http://127.0.0.1:1',
          BT_PROMETHEUS_INTERNAL_URL: 'http://127.0.0.1:1',
        },
      });
    });

    it('reports external access effective, and the runtime kill-switch turns it off', async () => {
      const admin = await harness.seedAdmin();
      const agent = await harness.loginAdmin(admin);

      const before = monitoringStatusResponseSchema.parse(
        (await agent.get('/api/v1/admin/monitoring/status')).body,
      );
      expect(before.externalAccess.effective).toBe(true);

      // The exposed proxy reaches for the (refused) upstream ⇒ 502, not 404.
      expect((await agent.get('/api/v1/admin/monitoring/grafana/')).status).toBe(502);

      // Flip the runtime kill-switch off — no redeploy.
      const patched = await agent
        .patch('/api/v1/admin/monitoring/external-access')
        .set(...XRW)
        .send({ enabled: false });
      expect(patched.status).toBe(200);
      expect(patched.body.externalAccess.effective).toBe(false);

      // The proxy now refuses again on the very next request.
      expect((await agent.get('/api/v1/admin/monitoring/grafana/')).status).toBe(404);
    });
  });
});
