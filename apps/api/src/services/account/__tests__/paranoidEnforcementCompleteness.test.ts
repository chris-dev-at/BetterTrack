import { fileURLToPath } from 'node:url';

import { Router, type RequestHandler } from 'express';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  API_KEY_SCOPES,
  PARANOID_CLIENT_ROUTE_DECISIONS,
  type ParanoidServerRouteReference,
} from '@bettertrack/contracts';

import { createApp } from '../../../app';
import { JOB_REGISTRATION_DESCRIPTORS, type JobRegistrationDescriptor } from '../../../jobs';
import { buildRouteTable, type MountedSurface } from '../../../scripts/checkOpenapiCoverage';
import {
  isParanoidSurfaceClassified,
  PARANOID_ACCOUNT_CONTEXT_SOURCE,
  PARANOID_ALL_METHODS_ROUTE_METHOD,
  PARANOID_DIRECT_SERVICE_CALL,
  PARANOID_KILL_REGISTRY,
  PARANOID_KNOWN_GAPS,
  PARANOID_OPAQUE_MOUNT_METHOD,
  PARANOID_ROUTE_TABLE_SOURCE,
  paranoidSurfaceClassifications,
  type ParanoidJobSurface,
  type ParanoidRouteSurface,
  type ParanoidServiceSurface,
  type ParanoidSurface,
} from '../paranoidEnforcement';

const API_PREFIX = '/api/v1';
const API_TSCONFIG_PATH = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url));
const APP_CONTEXT_PATH = fileURLToPath(new URL('../../../http/context.ts', import.meta.url));
const COMPLETENESS_TEST_PATH = fileURLToPath(import.meta.url);
const COMPLETENESS_TEST_SOURCE =
  'apps/api/src/services/account/__tests__/paranoidEnforcementCompleteness.test.ts';

export interface CallableAppContextFixture {
  directEntryPoint: (userId: string) => Promise<void>;
}

function surfaceName(surface: ParanoidSurface): string {
  const source = `${surface.source.file}#${surface.source.symbol}`;
  if (surface.kind === 'route') return `${source} (${surface.method} ${surface.path})`;
  if (surface.kind === 'service') {
    const entryPoint =
      surface.method === PARANOID_DIRECT_SERVICE_CALL
        ? `ctx.${surface.service}()`
        : `ctx.${surface.service}.${surface.method}`;
    return `${source} (${entryPoint})`;
  }
  if (surface.kind === 'job') return `${source} (job ${surface.name})`;
  return source;
}

/**
 * The production mounted route table comes from `createApp` itself, not from a
 * mirrored route list in this test. A new `app.use`/router endpoint therefore
 * becomes a candidate as soon as the existing OpenAPI coverage walker sees it.
 * API endpoints retain the inventory's API-relative paths; origin-root routes
 * remain root-relative so public endpoints cannot disappear behind a prefix
 * filter.
 */
function mountedRouteSurfaces(
  routes: readonly MountedSurface[] = buildRouteTable(),
  source = PARANOID_ROUTE_TABLE_SOURCE,
): ParanoidRouteSurface[] {
  return routes.map((route) => {
    const path = route.path.startsWith(API_PREFIX)
      ? route.path.slice(API_PREFIX.length) || '/'
      : route.path;
    if (route.kind === 'route') {
      return {
        kind: 'route' as const,
        source,
        method: route.method,
        path,
      };
    }
    if (route.kind === 'all-methods-route') {
      return {
        kind: 'route' as const,
        source,
        method: PARANOID_ALL_METHODS_ROUTE_METHOD,
        path,
      };
    }
    return {
      kind: 'route' as const,
      source: {
        ...source,
        symbol: `${source.symbol}.${route.handler}[${route.occurrence}]@${route.path}`,
      },
      method: PARANOID_OPAQUE_MOUNT_METHOD,
      path,
    };
  });
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
function accountContextServiceSurfaces({
  contextPath = APP_CONTEXT_PATH,
  contextExport = 'AppContext',
  source = PARANOID_ACCOUNT_CONTEXT_SOURCE,
}: {
  readonly contextPath?: string;
  readonly contextExport?: string;
  readonly source?: ParanoidServiceSurface['source'];
} = {}): ParanoidServiceSurface[] {
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
    rootNames: [contextPath],
    options: parsedConfig.options,
  });
  const checker = program.getTypeChecker();
  const contextSource = program.getSourceFile(contextPath);
  if (!contextSource) {
    throw new Error(`Unable to load ${contextExport} for paranoid surface discovery.`);
  }

  const moduleSymbol = checker.getSymbolAtLocation(contextSource);
  const contextSymbol = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.getName() === contextExport)
    : undefined;
  if (!contextSymbol) {
    throw new Error(`Unable to resolve ${contextExport} for paranoid surface discovery.`);
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
        `${contextExport}.${service} is typed as any; paranoid surface discovery must use a callable production type.`,
      );
    }

    if (serviceType.getCallSignatures().length > 0) {
      surfaces.push({
        kind: 'service',
        source: {
          ...source,
          symbol: `${source.symbol}.${service}`,
        },
        service,
        method: PARANOID_DIRECT_SERVICE_CALL,
      });
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
          ...source,
          symbol: `${source.symbol}.${service}.${method}`,
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

function registeredJobSurfaces(
  registrations: readonly JobRegistrationDescriptor[] = JOB_REGISTRATION_DESCRIPTORS,
): ParanoidJobSurface[] {
  return registrations.map((registration) => ({
    kind: 'job' as const,
    source: registration.source,
    name: registration.name,
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

function registryRouteReference(
  capability: (typeof PARANOID_KILL_REGISTRY)[number]['capability'],
  rule: (typeof PARANOID_KILL_REGISTRY)[number]['routes'][number],
): ParanoidServerRouteReference {
  const matcherCount =
    Number(rule.exact !== undefined) +
    Number(rule.prefix !== undefined) +
    Number(rule.pattern !== undefined);
  if (matcherCount !== 1) {
    throw new Error(
      `Paranoid kill-registry route ${capability} must declare exactly one matcher for the client-gate decision matrix.`,
    );
  }

  const common = {
    capability,
    ...(rule.method === undefined ? {} : { method: rule.method }),
    ...(rule.source === undefined ? {} : { source: rule.source }),
  };
  if (rule.exact !== undefined) return { ...common, match: 'exact', path: rule.exact };
  if (rule.prefix !== undefined) return { ...common, match: 'prefix', path: rule.prefix };

  const pattern = rule.pattern!;
  return {
    ...common,
    match: 'pattern',
    // RegExp.source escapes `/` for literal notation; contract references do
    // not need that representation-only escape.
    path: pattern.source.replaceAll('\\/', '/'),
    ...(pattern.flags.length === 0 ? {} : { flags: pattern.flags }),
  };
}

function serverRouteReferenceKey(reference: ParanoidServerRouteReference): string {
  return JSON.stringify([
    reference.capability,
    reference.method ?? null,
    reference.match,
    reference.path,
    reference.flags ?? null,
    reference.source?.file ?? null,
    reference.source?.symbol ?? null,
  ]);
}

function serverRouteReferenceLabel(reference: ParanoidServerRouteReference): string {
  const source = reference.source ? ` at ${reference.source.file}#${reference.source.symbol}` : '';
  const flags = reference.flags ? `/${reference.flags}` : '';
  return `${reference.capability}:${reference.method ?? '*'} ${reference.match} ${reference.path}${flags}${source}`;
}

function countRouteReferences(
  references: readonly ParanoidServerRouteReference[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const reference of references) {
    const key = serverRouteReferenceKey(reference);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function clientGateDecisionProblems(): string[] {
  const registryReferences = PARANOID_KILL_REGISTRY.flatMap((entry) =>
    entry.routes.map((route) => registryRouteReference(entry.capability, route)),
  );
  const decisionReferences = PARANOID_CLIENT_ROUTE_DECISIONS.flatMap(
    (decision) => decision.serverRoutes,
  );
  const registryCounts = countRouteReferences(registryReferences);
  const decisionCounts = countRouteReferences(decisionReferences);
  const referencesByKey = new Map(
    [...registryReferences, ...decisionReferences].map((reference) => [
      serverRouteReferenceKey(reference),
      reference,
    ]),
  );

  const problems: string[] = [];
  for (const key of [...referencesByKey.keys()].sort()) {
    const registryCount = registryCounts.get(key) ?? 0;
    const decisionCount = decisionCounts.get(key) ?? 0;
    const label = serverRouteReferenceLabel(referencesByKey.get(key)!);
    if (registryCount === 0) {
      problems.push(`${label} has a stale client-gate decision but no kill-registry route`);
    } else if (decisionCount === 0) {
      problems.push(`${label} has no client-gate mapping decision`);
    } else if (registryCount !== decisionCount) {
      problems.push(
        `${label} occurs ${registryCount} time(s) in the kill registry and ${decisionCount} time(s) in client-gate decisions`,
      );
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

  it('names only contract API-key scopes in the paranoid kill registry', () => {
    const contractScopes = new Set<string>(API_KEY_SCOPES);
    const unknownScopes = PARANOID_KILL_REGISTRY.flatMap((entry) =>
      entry.scopes
        .filter((scope) => !contractScopes.has(scope))
        .map((scope) => `${entry.capability}:${scope}`),
    );

    expect(unknownScopes).toEqual([]);
  });

  it('maps every killed server route to exactly one shared client-gate decision', () => {
    expect(clientGateDecisionProblems()).toEqual([]);
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

  it('discovers a directly callable context field as its own entry point', () => {
    const directSurface = accountContextServiceSurfaces({
      contextPath: COMPLETENESS_TEST_PATH,
      contextExport: 'CallableAppContextFixture',
      source: {
        file: COMPLETENESS_TEST_SOURCE,
        symbol: 'CallableAppContextFixture',
      },
    }).find((surface) => surface.service === 'directEntryPoint');

    expect(directSurface).toMatchObject({
      service: 'directEntryPoint',
      method: PARANOID_DIRECT_SERVICE_CALL,
      source: {
        file: COMPLETENESS_TEST_SOURCE,
        symbol: 'CallableAppContextFixture.directEntryPoint',
      },
    });
    expect(classificationProblems([directSurface!])).toEqual([
      `${COMPLETENESS_TEST_SOURCE}#CallableAppContextFixture.directEntryPoint (ctx.directEntryPoint()) is unclassified`,
    ]);
  });

  it('keeps origin-root public documentation routes as explicit exemptions', () => {
    const documentationRoutes = mountedRouteSurfaces().filter(
      (route) =>
        route.method === 'GET' && (route.path === '/docs' || route.path === '/openapi.json'),
    );

    expect(documentationRoutes).toHaveLength(2);
    expect(classificationProblems(documentationRoutes)).toEqual([]);
  });

  it('names a newly mounted origin-root application route when no classification exists', () => {
    // This direct app.get fixture is absent from the app.use mount list. It
    // proves the walker sees a newly added origin-root endpoint rather than
    // relying on a hand-authored route-table entry or an API-prefix filter.
    const fixturePath = '/paranoid-enforcement-fixture';
    const throwawayRoute = mountedRouteSurfaces(
      buildRouteTable((ctx) => {
        const app = createApp(ctx);
        app.get(fixturePath, (_request, response) => {
          response.sendStatus(204);
        });
        return app;
      }),
      {
        file: COMPLETENESS_TEST_SOURCE,
        symbol: 'throwawayParanoidRouteFixture',
      },
    ).find((route) => route.method === 'GET' && route.path === fixturePath);

    expect(throwawayRoute).toBeDefined();
    expect(classificationProblems([throwawayRoute!])).toEqual([
      `${COMPLETENESS_TEST_SOURCE}#throwawayParanoidRouteFixture (GET /paranoid-enforcement-fixture) is unclassified`,
    ]);
  });

  it('records every app.use handler position, including nested handler arrays', () => {
    const fixturePath = '/paranoid-enforcement-fixture';
    const throwawayRoutes = mountedRouteSurfaces(
      buildRouteTable((ctx) => {
        const app = createApp(ctx);
        const earlierTerminatingRequestHandler: RequestHandler = (_request, response) => {
          response.sendStatus(204);
        };
        const leafRequestHandler: RequestHandler = (_request, response) => {
          response.sendStatus(204);
        };
        app.use(fixturePath, earlierTerminatingRequestHandler, [leafRequestHandler]);
        return app;
      }),
      {
        file: COMPLETENESS_TEST_SOURCE,
        symbol: 'throwawayParanoidLeafMountFixture',
      },
    ).filter(
      (route) => route.method === PARANOID_OPAQUE_MOUNT_METHOD && route.path === fixturePath,
    );

    expect(throwawayRoutes).toHaveLength(2);
    expect(classificationProblems(throwawayRoutes)).toEqual([
      `${COMPLETENESS_TEST_SOURCE}#throwawayParanoidLeafMountFixture.earlierTerminatingRequestHandler[1]@/paranoid-enforcement-fixture (${PARANOID_OPAQUE_MOUNT_METHOD} /paranoid-enforcement-fixture) is unclassified`,
      `${COMPLETENESS_TEST_SOURCE}#throwawayParanoidLeafMountFixture.leafRequestHandler[1]@/paranoid-enforcement-fixture (${PARANOID_OPAQUE_MOUNT_METHOD} /paranoid-enforcement-fixture) is unclassified`,
    ]);
  });

  it('discovers an earlier app.use router and its router.use leaf', () => {
    const fixturePath = '/paranoid-router-leaf-fixture';
    const throwawayRoutes = mountedRouteSurfaces(
      buildRouteTable((ctx) => {
        const app = createApp(ctx);
        const router = Router();
        router.use(fixturePath, function routerLeafRequestHandler(_request, response) {
          response.sendStatus(204);
        });
        app.use(API_PREFIX, router, function trailingApiRootLeaf(_request, response) {
          response.sendStatus(204);
        });
        return app;
      }),
      {
        file: COMPLETENESS_TEST_SOURCE,
        symbol: 'throwawayParanoidRouterLeafFixture',
      },
    ).filter(
      (route) =>
        route.method === PARANOID_OPAQUE_MOUNT_METHOD &&
        (route.path === fixturePath || route.source.symbol.includes('trailingApiRootLeaf')),
    );

    expect(throwawayRoutes).toHaveLength(2);
    expect(classificationProblems(throwawayRoutes)).toEqual([
      `${COMPLETENESS_TEST_SOURCE}#throwawayParanoidRouterLeafFixture.routerLeafRequestHandler[1]@/api/v1/paranoid-router-leaf-fixture (${PARANOID_OPAQUE_MOUNT_METHOD} /paranoid-router-leaf-fixture) is unclassified`,
      `${COMPLETENESS_TEST_SOURCE}#throwawayParanoidRouterLeafFixture.trailingApiRootLeaf[1]@/api/v1 (${PARANOID_OPAQUE_MOUNT_METHOD} /) is unclassified`,
    ]);
  });

  it('discovers app.all and router.all as synthetic all-method surfaces', () => {
    const appFixturePath = '/paranoid-app-all-fixture';
    const routerFixturePath = '/paranoid-router-all-fixture';
    const throwawayRoutes = mountedRouteSurfaces(
      buildRouteTable((ctx) => {
        const app = createApp(ctx);
        const router = Router();
        router.all(routerFixturePath, (_request, response) => {
          response.sendStatus(204);
        });
        app.use(API_PREFIX, router);
        app.all(appFixturePath, (_request, response) => {
          response.sendStatus(204);
        });
        return app;
      }),
      {
        file: COMPLETENESS_TEST_SOURCE,
        symbol: 'throwawayParanoidAllMethodsFixture',
      },
    ).filter(
      (route) =>
        route.method === PARANOID_ALL_METHODS_ROUTE_METHOD &&
        (route.path === appFixturePath || route.path === routerFixturePath),
    );

    expect(throwawayRoutes).toHaveLength(2);
    expect(classificationProblems(throwawayRoutes)).toEqual([
      `${COMPLETENESS_TEST_SOURCE}#throwawayParanoidAllMethodsFixture (${PARANOID_ALL_METHODS_ROUTE_METHOD} /paranoid-router-all-fixture) is unclassified`,
      `${COMPLETENESS_TEST_SOURCE}#throwawayParanoidAllMethodsFixture (${PARANOID_ALL_METHODS_ROUTE_METHOD} /paranoid-app-all-fixture) is unclassified`,
    ]);
  });

  it('does not give a new opaque API-root leaf the cross-cutting middleware exemption', () => {
    const throwawayRoute = mountedRouteSurfaces(
      buildRouteTable((ctx) => {
        const app = createApp(ctx);
        app.use(API_PREFIX, function sensitiveApiRootLeaf(_request, response) {
          response.sendStatus(204);
        });
        return app;
      }),
    ).find(
      (route) =>
        route.method === PARANOID_OPAQUE_MOUNT_METHOD &&
        route.path === '/' &&
        route.source.symbol.includes('sensitiveApiRootLeaf'),
    );

    expect(throwawayRoute).toBeDefined();
    expect(classificationProblems([throwawayRoute!])).toEqual([
      `apps/api/src/app.ts#createApp.sensitiveApiRootLeaf[1]@/api/v1 (${PARANOID_OPAQUE_MOUNT_METHOD} /) is unclassified`,
    ]);
  });

  it('discovers production router-level Telegram and Discord leaf mounts', () => {
    const channelLeaves = mountedRouteSurfaces().filter(
      (route) =>
        route.method === PARANOID_OPAQUE_MOUNT_METHOD &&
        (route.path === '/settings/telegram' || route.path === '/settings/discord'),
    );

    expect(channelLeaves).toHaveLength(2);
    expect(classificationProblems(channelLeaves)).toEqual([]);
  });

  it('discovers the opaque Grafana proxy mount through the admin exemption', () => {
    const grafanaMount = mountedRouteSurfaces().find(
      (route) =>
        route.method === PARANOID_OPAQUE_MOUNT_METHOD &&
        route.path === '/admin/monitoring/grafana' &&
        route.source.symbol === 'createApp.grafanaProxy[1]@/api/v1/admin/monitoring/grafana',
    );

    expect(grafanaMount).toBeDefined();
    expect(paranoidSurfaceClassifications(grafanaMount!)).toEqual([
      {
        disposition: 'exempt',
        reason: 'Administrator routes are independently authorized operational surfaces.',
      },
    ]);
    expect(classificationProblems([grafanaMount!])).toEqual([]);
  });

  it('keeps a replacement job unclassified even when its queue name is already registered', () => {
    const throwawayRegistration = {
      key: 'throwawayRegisteredJobFixture',
      name: 'system.heartbeat',
      source: {
        file: COMPLETENESS_TEST_SOURCE,
        symbol: 'throwawayRegisteredJobFixture',
      },
    } satisfies JobRegistrationDescriptor;

    expect(
      JOB_REGISTRATION_DESCRIPTORS.some(
        (registration) => registration.name === throwawayRegistration.name,
      ),
    ).toBe(true);

    const surfaces = registeredJobSurfaces([
      ...JOB_REGISTRATION_DESCRIPTORS,
      throwawayRegistration,
    ]);
    expect(classificationProblems(surfaces)).toEqual([
      `${COMPLETENESS_TEST_SOURCE}#throwawayRegisteredJobFixture (job system.heartbeat) is unclassified`,
    ]);
  });

  it('tracks every remaining review finding as an individual temporary exemption', () => {
    // #884 closed all four findings this inventory was seeded with, so the list
    // is empty. The shape assertion stays: a future gap must still name its
    // issue and carry its own reason rather than becoming an implicit exemption.
    expect(PARANOID_KNOWN_GAPS).toHaveLength(0);
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
