import express from 'express';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app';
import {
  assertBearerModulePolicyCoverage,
  buildRouteTable,
  checkCoverage,
  findBearerModulePolicyCoverage,
  findPhantomRoutes,
  findUndocumentedRoutes,
} from '../scripts/checkOpenapiCoverage';
import { getOpenApiDocument } from '../http/openapi';

/**
 * P9 — CI coverage gate (PROJECTPLAN.md §6.13, §12): asserts the checker both
 * passes on the real, fully-documented route surface and actually catches (and
 * names) a route that isn't in the spec, so the gate can't rot into a no-op.
 */
describe('checkOpenapiCoverage', () => {
  it('passes for the current, fully-documented route surface', () => {
    const result = checkCoverage();

    expect(result.missing).toEqual([]);
    expect(result.phantom).toEqual([]);
    expect(result.bearerModules.ok).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.mountedCount).toBeGreaterThan(0);
    expect(result.documentedCount).toBeGreaterThan(0);
  });

  it('classifies the real mounted API module set exactly in both directions', () => {
    const coverage = findBearerModulePolicyCoverage(buildRouteTable());

    expect(coverage.unclassified).toEqual([]);
    expect(coverage.unmountedPolicies).toEqual([]);
    expect(coverage.duplicatePolicies).toEqual([]);
    expect(coverage.invalidPolicyPrefixes).toEqual([]);
    expect(coverage.mounted).toContain('/api/v1/settings/webhooks');
    expect(coverage.mounted).toContain('/api/v1/vaults');
    expect(coverage.classified).toEqual(coverage.mounted);
    expect(coverage.ok).toBe(true);
  });

  it('names a newly mounted API module that has no bearer classification', () => {
    const fixturePath = '/api/v1/bearer-policy-fixture';
    const routes = buildRouteTable((ctx) => {
      const app = createApp(ctx);
      const router = express.Router();
      router.get('/probe', (_request, response) => response.sendStatus(204));
      app.use(fixturePath, router);
      return app;
    });

    expect(() => assertBearerModulePolicyCoverage(routes)).toThrow(fixturePath);
  });

  it('names a nested application mount that only inherits its parent bearer policy', () => {
    const fixturePath = '/api/v1/settings/foo';
    const routes = buildRouteTable((ctx) => {
      const app = createApp(ctx);
      const router = express.Router();
      router.get('/probe', (_request, response) => response.sendStatus(204));
      app.use(fixturePath, router);
      return app;
    });

    expect(() => assertBearerModulePolicyCoverage(routes)).toThrowError(
      new Error(
        [
          'Bearer module policy coverage failed.',
          'Mounted API modules without an explicit bearer classification:',
          `  - ${fixturePath}`,
        ].join('\n'),
      ),
    );
  });

  it('classifies a nested application mount with an explicitly remapped scope pair', () => {
    const fixturePath = '/api/v1/settings/notifications';
    const routes = buildRouteTable((ctx) => {
      const app = createApp(ctx);
      const router = express.Router();
      router.get('/probe', (_request, response) => response.sendStatus(204));
      app.use(fixturePath, router);
      return app;
    });

    const coverage = findBearerModulePolicyCoverage(routes);

    expect(coverage.classified).toContain(fixturePath);
    expect(coverage.unclassified).not.toContain(fixturePath);
    expect(coverage.ok).toBe(true);
  });

  it('reports a non-top-level policy prefix with the fail-closed diagnostic', () => {
    expect(() =>
      assertBearerModulePolicyCoverage(
        [],
        [
          {
            prefix: '/settings/notifications',
            kind: 'scope',
            read: 'notifications:read',
            write: 'notifications:write',
          },
        ],
      ),
    ).toThrowError(
      new Error(
        [
          'Bearer module policy coverage failed.',
          'Bearer module classifications must remain single-segment top-level prefixes:',
          '  - /api/v1/settings/notifications',
        ].join('\n'),
      ),
    );
  });

  it('reports a mounted route with no matching operation in the spec', () => {
    const doc = getOpenApiDocument();
    const routes = [
      ...buildRouteTable(),
      { kind: 'route' as const, method: 'GET', path: '/totally/not/documented' },
    ];

    const missing = findUndocumentedRoutes(routes, doc as never);

    expect(missing).toEqual(['GET /totally/not/documented']);
  });

  it('reports a real route once its spec entry is removed', () => {
    const doc = getOpenApiDocument();
    const withoutWorkboard = {
      ...doc,
      paths: Object.fromEntries(
        Object.entries(doc.paths).filter(([path]) => path !== '/workboard'),
      ),
    };
    const routes = buildRouteTable();

    const missing = findUndocumentedRoutes(routes, withoutWorkboard as never);

    expect(missing).toEqual(
      expect.arrayContaining(['GET /api/v1/workboard', 'POST /api/v1/workboard']),
    );
  });

  it('reports a documented route with no matching mounted route (phantom endpoint)', () => {
    const doc = getOpenApiDocument();
    const withPhantom = {
      ...doc,
      paths: {
        ...doc.paths,
        '/totally/not/mounted': { get: {} },
      },
    };
    const routes = buildRouteTable();

    const phantom = findPhantomRoutes(routes, withPhantom as never);

    expect(phantom).toEqual(['GET /api/v1/totally/not/mounted']);
  });

  it('does not flag a real route as phantom', () => {
    const doc = getOpenApiDocument();
    const routes = buildRouteTable();

    const phantom = findPhantomRoutes(routes, doc as never);

    expect(phantom).toEqual([]);
  });
});
