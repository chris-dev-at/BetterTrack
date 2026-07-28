import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../../app';
import { ALL_QUEUE_NAMES } from '../../../jobs';
import { buildRouteTable } from '../../../scripts/checkOpenapiCoverage';
import { createTestApp } from '../../../testing/createTestApp';
import {
  isParanoidSurfaceClassified,
  PARANOID_ACCOUNT_CONTEXT_SOURCE,
  PARANOID_JOB_REGISTRY_SOURCE,
  PARANOID_KNOWN_GAPS,
  PARANOID_ROUTE_TABLE_SOURCE,
  paranoidSurfaceClassifications,
  type ParanoidRouteSurface,
  type ParanoidServiceSurface,
  type ParanoidSurface,
} from '../paranoidEnforcement';

const API_PREFIX = '/api/v1';

function surfaceName(surface: ParanoidSurface): string {
  const source = `${surface.source.file}#${surface.source.symbol}`;
  if (surface.kind === 'route') return `${source} (${surface.method} ${surface.path})`;
  if (surface.kind === 'service') return `${source} (ctx.${surface.service}.${surface.method})`;
  if (surface.kind === 'job') return `${source} (job ${surface.name})`;
  return source;
}

/**
 * The production mounted route table comes from `createApp` itself, not from a
 * mirrored route list in this test. A new `app.use`/router endpoint therefore
 * becomes a candidate as soon as the existing OpenAPI coverage walker sees it.
 */
function mountedRouteSurfaces(
  routes: readonly { method: string; path: string }[] = buildRouteTable(),
  source = PARANOID_ROUTE_TABLE_SOURCE,
): ParanoidRouteSurface[] {
  return routes
    .filter((route) => route.path.startsWith(API_PREFIX))
    .map((route) => ({
      kind: 'route' as const,
      source,
      method: route.method,
      path: route.path.slice(API_PREFIX.length) || '/',
    }));
}

/**
 * Every callable object exposed by the real account context is an account
 * service entry point for this sweep. This intentionally includes operational
 * helpers (Redis, logging, health, etc.): their explicit exemptions prevent a
 * future context addition from becoming an invisible default-open surface.
 */
function accountContextServiceSurfaces(context: object): ParanoidServiceSurface[] {
  const surfaces: ParanoidServiceSurface[] = [];
  for (const [service, value] of Object.entries(context)) {
    if (!value || typeof value !== 'object') continue;
    const methods = Object.keys(value as Record<string, unknown>).filter(
      (method) => typeof (value as Record<string, unknown>)[method] === 'function',
    );
    for (const method of methods) {
      surfaces.push({
        kind: 'service',
        source: {
          ...PARANOID_ACCOUNT_CONTEXT_SOURCE,
          symbol: `${PARANOID_ACCOUNT_CONTEXT_SOURCE.symbol}.${service}.${method}`,
        },
        service,
        method,
      });
    }
  }
  return surfaces;
}

function registeredJobSurfaces(): ParanoidSurface[] {
  return ALL_QUEUE_NAMES.map((name) => ({
    kind: 'job' as const,
    source: PARANOID_JOB_REGISTRY_SOURCE,
    name,
  }));
}

/** The diagnostic is intentionally stable enough for CI and reviewers to act on. */
function classificationProblems(surfaces: readonly ParanoidSurface[]): string[] {
  const problems: string[] = [];
  for (const surface of surfaces) {
    const classifications = paranoidSurfaceClassifications(surface);
    if (classifications.length === 0) {
      problems.push(`${surfaceName(surface)} is unclassified`);
      continue;
    }
    if (classifications.length > 1) {
      problems.push(`${surfaceName(surface)} has overlapping classifications`);
      continue;
    }
    const classification = classifications[0]!;
    if (classification.disposition === 'exempt' && classification.reason.trim().length === 0) {
      problems.push(`${surfaceName(surface)} is exempt without a documented reason`);
    }
  }
  return problems;
}

describe('paranoid enforcement completeness', () => {
  let contextSurfaces: ParanoidServiceSurface[] = [];

  beforeAll(async () => {
    const harness = await createTestApp();
    contextSurfaces = accountContextServiceSurfaces(harness.ctx);
  });

  it('classifies every mounted route, account-context service entry point, and registered job', () => {
    const surfaces = [...mountedRouteSurfaces(), ...contextSurfaces, ...registeredJobSurfaces()];

    expect(surfaces.length).toBeGreaterThan(0);
    expect(classificationProblems(surfaces)).toEqual([]);
    expect(surfaces.every(isParanoidSurfaceClassified)).toBe(true);
  });

  it('names a newly mounted direct application route when no classification exists', () => {
    // This direct app.get fixture is absent from the app.use mount list. It
    // proves the walker sees a newly added direct endpoint rather than relying
    // on a hand-authored route-table entry in this test.
    const fixturePath = '/paranoid-enforcement-fixture';
    const throwawayRoute = mountedRouteSurfaces(
      buildRouteTable((ctx) => {
        const app = createApp(ctx);
        app.get(`${API_PREFIX}${fixturePath}`, (_request, response) => {
          response.sendStatus(204);
        });
        return app;
      }),
      {
        file: 'apps/api/src/services/account/__tests__/paranoidEnforcementCompleteness.test.ts',
        symbol: 'throwawayParanoidRouteFixture',
      },
    ).find((route) => route.method === 'GET' && route.path === fixturePath);

    expect(throwawayRoute).toBeDefined();
    expect(classificationProblems([throwawayRoute!])).toEqual([
      'apps/api/src/services/account/__tests__/paranoidEnforcementCompleteness.test.ts#throwawayParanoidRouteFixture (GET /paranoid-enforcement-fixture) is unclassified',
    ]);
  });

  it('keeps each #884 review finding as an individually tracked temporary exemption', () => {
    expect(PARANOID_KNOWN_GAPS).toHaveLength(4);
    for (const gap of PARANOID_KNOWN_GAPS) {
      const classifications = paranoidSurfaceClassifications(gap.surface);
      expect(classifications, gap.label).toHaveLength(1);
      expect(classifications[0]).toMatchObject({
        disposition: 'exempt',
        knownGapIssue: 884,
        knownGapId: gap.id,
      });
      expect(
        classifications[0]?.disposition === 'exempt' && classifications[0].reason,
      ).toBeTruthy();
    }
  });
});
