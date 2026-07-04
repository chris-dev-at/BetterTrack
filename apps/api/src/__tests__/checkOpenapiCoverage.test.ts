import { describe, expect, it } from 'vitest';

import {
  buildRouteTable,
  checkCoverage,
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
    expect(result.ok).toBe(true);
    expect(result.mountedCount).toBeGreaterThan(0);
    expect(result.documentedCount).toBeGreaterThan(0);
  });

  it('reports a mounted route with no matching operation in the spec', () => {
    const doc = getOpenApiDocument();
    const routes = [...buildRouteTable(), { method: 'GET', path: '/totally/not/documented' }];

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
});
