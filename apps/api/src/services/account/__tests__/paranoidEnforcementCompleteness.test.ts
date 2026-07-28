import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../../app';
import { ALL_QUEUE_NAMES } from '../../../jobs';
import { buildRouteTable } from '../../../scripts/checkOpenapiCoverage';
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
const API_TSCONFIG_PATH = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url));
const APP_CONTEXT_PATH = fileURLToPath(new URL('../../../http/context.ts', import.meta.url));

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
 * Every callable member exposed by the production AppContext contract is an
 * account service entry point for this sweep. This intentionally includes
 * operational helpers (Redis, logging, health, etc.): their explicit
 * exemptions prevent a future context addition from becoming an invisible
 * default-open surface.
 *
 * The type checker is deliberate. `createTestApp()` has `queues: null`, and
 * runtime own-key inspection misses class/prototype methods, either of which
 * would let a production entry point escape the completeness gate.
 */
function accountContextServiceSurfaces(): ParanoidServiceSurface[] {
  const parsedConfig = ts.getParsedCommandLineOfConfigFile(
    API_TSCONFIG_PATH,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(
          `Unable to read the API TypeScript config for paranoid surface discovery: ${ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            '\n',
          )}`,
        );
      },
    },
  );
  if (!parsedConfig) {
    throw new Error('Unable to read the API TypeScript config for paranoid surface discovery.');
  }

  const program = ts.createProgram({
    rootNames: [APP_CONTEXT_PATH],
    options: parsedConfig.options,
  });
  const checker = program.getTypeChecker();
  const contextSource = program.getSourceFile(APP_CONTEXT_PATH);
  if (!contextSource) {
    throw new Error('Unable to load AppContext for paranoid surface discovery.');
  }

  const moduleSymbol = checker.getSymbolAtLocation(contextSource);
  const contextSymbol = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.getName() === 'AppContext')
    : undefined;
  if (!contextSymbol) {
    throw new Error('Unable to resolve AppContext for paranoid surface discovery.');
  }

  const contextType = checker.getDeclaredTypeOfSymbol(contextSymbol);
  const surfaces: ParanoidServiceSurface[] = [];
  for (const serviceSymbol of checker.getPropertiesOfType(contextType)) {
    const service = serviceSymbol.getName();
    const serviceDeclaration = serviceSymbol.valueDeclaration ?? contextSource;
    const serviceType = checker.getNonNullableType(
      checker.getTypeOfSymbolAtLocation(serviceSymbol, serviceDeclaration),
    );
    if ((serviceType.flags & ts.TypeFlags.Any) !== 0) {
      throw new Error(
        `AppContext.${service} is typed as any; paranoid surface discovery must use a callable production type.`,
      );
    }

    for (const methodSymbol of checker.getPropertiesOfType(serviceType)) {
      const methodDeclaration = methodSymbol.valueDeclaration ?? contextSource;
      const methodType = checker.getNonNullableType(
        checker.getTypeOfSymbolAtLocation(methodSymbol, methodDeclaration),
      );
      if (methodType.getCallSignatures().length === 0) continue;

      const method = methodSymbol.getName();
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
  return surfaces.sort(
    (left, right) =>
      left.service.localeCompare(right.service) || left.method.localeCompare(right.method),
  );
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

  beforeAll(() => {
    contextSurfaces = accountContextServiceSurfaces();
  });

  it('classifies every mounted route, account-context service entry point, and registered job', () => {
    const surfaces = [...mountedRouteSurfaces(), ...contextSurfaces, ...registeredJobSurfaces()];

    expect(surfaces.length).toBeGreaterThan(0);
    expect(classificationProblems(surfaces)).toEqual([]);
    expect(surfaces.every(isParanoidSurfaceClassified)).toBe(true);
  });

  it('discovers nullable and prototype-declared context methods from the production contract', () => {
    // QueueRegistry is intentionally null in createTestApp(), while Redis
    // methods are class-declared. Both must remain candidates in this gate.
    expect(contextSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: 'queues', method: 'get' }),
        expect.objectContaining({ service: 'queues', method: 'enqueue' }),
        expect.objectContaining({ service: 'queues', method: 'close' }),
        expect.objectContaining({ service: 'redis', method: 'connect' }),
      ]),
    );
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
