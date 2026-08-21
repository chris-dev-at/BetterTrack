import { METHODS } from 'node:http';
import { pathToFileURL } from 'node:url';

import express, { type Application } from 'express';
import type { Redis } from 'ioredis';

import { createApp } from '../app';
import { loadConfig } from '../config/env';
import type { AppContext } from '../http/context';
import {
  MODULE_POLICIES,
  resolveBearerPolicyClassification,
  type BearerModulePolicy,
  type ResolvedBearerPolicyClassification,
} from '../http/middleware/bearerAuth';
import { getOpenApiDocument } from '../http/openapi';
import { createLogger } from '../logger';

/**
 * CI coverage gate (PROJECTPLAN.md §6.13, §12): every route mounted in
 * `app.ts` must be represented in the generated OpenAPI document (#183), so
 * `/docs` can never silently drift from the implementation. Deterministic and
 * network-free — it builds the real Express app (with an inert context that
 * throws if any service is touched outside a request) and reads the mount
 * table straight off `express.application.use`, since Express 5's Router only
 * retains a route's *literal* path (`layer.route.path`) and not the literal
 * prefix a sub-router was mounted at (that's reconstructed lazily, per
 * request, from a compiled regexp closure).
 */

export interface MountedRoute {
  readonly kind: 'route';
  method: string;
  path: string;
  /** Literal top-level `app.use` path that owns this surface, when present. */
  readonly applicationMountPath?: string;
}

/**
 * An `app.all`/`router.all` route. OpenAPI has no single all-method operation,
 * so the documentation comparison ignores this synthetic surface while the
 * paranoid completeness inventory still requires an explicit classification.
 */
export interface AllMethodsMountedRoute {
  readonly kind: 'all-methods-route';
  readonly path: string;
  /** Literal top-level `app.use` path that owns this surface, when present. */
  readonly applicationMountPath?: string;
}

/**
 * An `app.use`/`router.use` mount whose handler is not an inspectable Express
 * router. It may consume any method or descendant path, so it cannot be
 * represented as a finite OpenAPI operation. The paranoid completeness sweep
 * still consumes this identity; OpenAPI comparison deliberately does not.
 */
export interface OpaqueMountedSurface {
  readonly kind: 'opaque-mount';
  readonly path: string;
  readonly handler: string;
  /** One-based occurrence among handlers with the same mounted path and name. */
  readonly occurrence: number;
  /** Literal top-level `app.use` path that owns this surface, when present. */
  readonly applicationMountPath?: string;
}

export type MountedSurface = MountedRoute | AllMethodsMountedRoute | OpaqueMountedSurface;

interface PathItemLike {
  [method: string]: unknown;
}

interface OpenApiDocumentLike {
  paths: Record<string, PathItemLike | undefined>;
}

export interface CoverageResult {
  ok: boolean;
  /** `"METHOD /path"` entries mounted but absent from the OpenAPI document. */
  missing: string[];
  /** `"METHOD /path"` entries documented but not actually mounted (phantom endpoints). */
  phantom: string[];
  bearerModules: BearerModulePolicyCoverage;
  mountedCount: number;
  documentedCount: number;
}

export interface BearerModulePolicyCoverage {
  ok: boolean;
  /** Top-level API modules and direct nested application mounts discovered from Express. */
  mounted: string[];
  /** Mounts with a top-level row, a closed parent, or a distinct nested admission boundary. */
  classified: string[];
  /** Nested mounts that silently inherit a bearer-capable parent without a distinct boundary. */
  unclassified: string[];
  /** Bearer policies whose module is no longer mounted. */
  unmountedPolicies: string[];
  /** Repeated policy prefixes, which would make resolver order significant. */
  duplicatePolicies: string[];
  /** Policy prefixes that violate the required single-segment top-level shape. */
  invalidPolicyPrefixes: string[];
}

/**
 * Routes that document themselves — `/openapi.json` serves this exact
 * document and `/docs` renders it, so neither needs (or could sensibly carry)
 * its own entry in `paths`.
 */
const SELF_DOCUMENTING = new Set(['GET /docs', 'GET /openapi.json']);

const API_PREFIX = '/api/v1';

/** The HTTP methods a path item's operations can be keyed by (per {@link EndpointDef}). */
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const EXPRESS_HTTP_METHODS = METHODS.map((method) => method.toLowerCase());

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** A throwing stand-in for a service the HTTP layer must never touch while wiring routes. */
function inertService<T>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop): never {
        throw new Error(
          `checkOpenapiCoverage: ctx.${name}.${String(prop)} was accessed while building the ` +
            'route table. Route factories must stay side-effect free at mount time (parse → ' +
            'service → respond happens per-request), so this checker never boots real services.',
        );
      },
    },
  ) as T;
}

/** An `AppContext` sufficient to register every router without touching real infrastructure. */
function buildInertContext(): AppContext {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://checkOpenapiCoverage',
    REDIS_URL: 'redis://checkOpenapiCoverage',
    SESSION_SECRET: 'checkOpenapiCoverage-inert-session-secret-0000000000',
  });

  return {
    config,
    redis: {} as Redis,
    logger: createLogger(config),
    events: inertService('events'),
    paranoidGuard: inertService('paranoidGuard'),
    vaultedPortfolioGuard: inertService('vaultedPortfolioGuard'),
    auth: inertService('auth'),
    google: inertService('google'),
    twoFactor: inertService('twoFactor'),
    passkeys: inertService('passkeys'),
    adminTwoFactor: inertService('adminTwoFactor'),
    admin: inertService('admin'),
    apiKeys: inertService('apiKeys'),
    oauth: inertService('oauth'),
    feedback: inertService('feedback'),
    workboard: inertService('workboard'),
    marketData: inertService('marketData'),
    assets: inertService('assets'),
    marketIntel: inertService('marketIntel'),
    portfolioMarketIntel: inertService('portfolioMarketIntel'),
    search: inertService('search'),
    portfolio: inertService('portfolio'),
    snapshots: inertService('snapshots'),
    tax: inertService('tax'),
    mirror: inertService('mirror'),
    customAssets: inertService('customAssets'),
    conglomerate: inertService('conglomerate'),
    backtest: inertService('backtest'),
    ideas: inertService('ideas'),
    imports: inertService('imports'),
    standingOrders: inertService('standingOrders'),
    expenses: inertService('expenses'),
    expenseImports: inertService('expenseImports'),
    expenseBudgets: inertService('expenseBudgets'),
    cashTags: inertService('cashTags'),
    cashBudgets: inertService('cashBudgets'),
    paranoidVault: inertService('paranoidVault'),
    vaults: inertService('vaults'),
    reauth: inertService('reauth'),
    paranoidTransitions: inertService('paranoidTransitions'),
    webhooks: inertService('webhooks'),
    webhookBridge: inertService('webhookBridge'),
    analytics: inertService('analytics'),
    social: inertService('social'),
    comments: inertService('comments'),
    chat: inertService('chat'),
    notifications: inertService('notifications'),
    notificationSettings: inertService('notificationSettings'),
    telegramSetup: inertService('telegramSetup'),
    discordSetup: inertService('discordSetup'),
    accountSettings: inertService('accountSettings'),
    homeLayout: inertService('homeLayout'),
    widgetLayouts: inertService('widgetLayouts'),
    accountDeletion: inertService('accountDeletion'),
    dataExport: inertService('dataExport'),
    alerts: inertService('alerts'),
    announcements: inertService('announcements'),
    notificationDispatcher: inertService('notificationDispatcher'),
    digestService: inertService('digestService'),
    notify: inertService('notify'),
    presence: inertService('presence'),
    realtime: inertService('realtime'),
    liveMode: inertService('liveMode'),
    idempotency: inertService('idempotency'),
    // No live queue registry: the bull-board mount serves its inert 503 branch,
    // so no queue instance is touched while building the route table.
    queues: null,
    observability: {
      enabled: false,
      captureException() {},
      async flush() {
        return true;
      },
      async close() {
        return true;
      },
    },
    health: inertService('health'),
    readiness: inertService('readiness'),
    problems: inertService('problems'),
    monitoring: inertService('monitoring'),
    usageAnalytics: inertService('usageAnalytics'),
    featureFlags: inertService('featureFlags'),
    ai: inertService('ai'),
    aiFeatures: inertService('aiFeatures'),
  };
}

interface RecordedUseMount {
  readonly paths: readonly string[];
}

function literalPaths(value: unknown, registration: string): readonly string[] {
  const paths = Array.isArray(value) ? value : [value];
  if (paths.length === 0 || !paths.every((path): path is string => typeof path === 'string')) {
    throw new Error(
      `checkOpenapiCoverage: ${registration} uses a non-literal path; extend the route-table ` +
        'walker before trusting this report.',
    );
  }
  return paths;
}

function useMountPaths(args: readonly unknown[]): readonly string[] {
  let candidate = args[0];
  while (Array.isArray(candidate) && candidate.length > 0) candidate = candidate[0];
  return typeof candidate === 'function' ? ['/'] : literalPaths(args[0], 'router.use');
}

function joinMountedPath(base: string, suffix: string): string {
  const normalizedBase = base === '/' ? '' : base.replace(/\/+$/, '');
  const normalizedSuffix = suffix === '/' ? '' : suffix.replace(/^\/?/, '/');
  return toOpenApiPath(normalizedBase + normalizedSuffix || '/');
}

function handlerName(handler: unknown): string {
  return typeof handler === 'function' && handler.name.length > 0 ? handler.name : '<anonymous>';
}

function collectRouterRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stack: any[],
  base: string,
  out: MountedSurface[],
  recordedUseMounts: WeakMap<object, RecordedUseMount>,
  opaqueOccurrences: Map<string, number>,
  applicationMountPath?: string,
): void {
  for (const layer of stack) {
    if (layer.route) {
      const routePaths = literalPaths(layer.route.path, 'app/router route');
      const methods = Object.keys(layer.route.methods).filter(
        (method) => layer.route.methods[method] && method !== '_all',
      );
      const handlesAllMethods =
        layer.route.methods._all === true ||
        EXPRESS_HTTP_METHODS.every((method) => layer.route.methods[method] === true);

      for (const path of routePaths) {
        const mountedPath = joinMountedPath(base, path);
        if (handlesAllMethods) {
          out.push({
            kind: 'all-methods-route',
            path: mountedPath,
            ...(applicationMountPath === undefined ? {} : { applicationMountPath }),
          });
          continue;
        }
        for (const method of methods) {
          out.push({
            kind: 'route',
            method: method.toUpperCase(),
            path: mountedPath,
            ...(applicationMountPath === undefined ? {} : { applicationMountPath }),
          });
        }
      }
      continue;
    }

    const mount =
      layer && typeof layer === 'object' ? recordedUseMounts.get(layer as object) : undefined;
    if (!mount) {
      throw new Error(
        `checkOpenapiCoverage: found an unrecorded router layer "${handlerName(
          layer?.handle,
        )}" under "${base || '/'}"; extend the route-table walker before trusting this report.`,
      );
    }

    for (const path of mount.paths) {
      const mountedPath = joinMountedPath(base, path);
      const owningApplicationMountPath = base === '' ? mountedPath : applicationMountPath;
      if (layer.handle?.stack && Array.isArray(layer.handle.stack)) {
        collectRouterRoutes(
          layer.handle.stack,
          mountedPath,
          out,
          recordedUseMounts,
          opaqueOccurrences,
          owningApplicationMountPath,
        );
      } else {
        const handler = handlerName(layer.handle);
        const occurrenceKey = `${mountedPath}\0${handler}`;
        const occurrence = (opaqueOccurrences.get(occurrenceKey) ?? 0) + 1;
        opaqueOccurrences.set(occurrenceKey, occurrence);
        out.push({
          kind: 'opaque-mount',
          path: mountedPath,
          handler,
          occurrence,
          ...(owningApplicationMountPath === undefined
            ? {}
            : { applicationMountPath: owningApplicationMountPath }),
        });
      }
    }
  }
}

/**
 * Express keeps literal `use` paths only in matcher closures. Record the exact
 * path on each layer as production registers it so nested routers, leaf
 * middleware, every handler position, and nested handler arrays all remain
 * mechanically discoverable.
 */
function routerUseOwner(): { use: (...args: unknown[]) => unknown } {
  let owner: object | null = Object.getPrototypeOf(express.Router());
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'use')) {
    owner = Object.getPrototypeOf(owner);
  }
  if (!owner || typeof (owner as { use?: unknown }).use !== 'function') {
    throw new Error(
      'checkOpenapiCoverage: could not inspect the Express Router.use implementation; ' +
        'extend the route-table walker before trusting this report.',
    );
  }
  return owner as { use: (...args: unknown[]) => unknown };
}

/**
 * Builds the real app while recording every layer created by
 * `app.use`/`router.use`, then walks the application's actual router stack.
 * Direct routes retain their literal `route.path`; use layers get their literal
 * mount path from the registration record above. The optional factory keeps
 * the production path fixed to `createApp`, while allowing focused tests to
 * prove that every supported Express registration shape reaches the inventory.
 */
export function buildRouteTable(
  appFactory: (ctx: AppContext) => Application = createApp,
): MountedSurface[] {
  const recordedUseMounts = new WeakMap<object, RecordedUseMount>();
  const useOwner = routerUseOwner();
  const originalUse = useOwner.use;
  let app: Application | undefined;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useOwner.use = function patchedUse(this: { stack?: unknown }, ...args: any[]) {
      const paths = useMountPaths(args);
      const before = Array.isArray(this.stack) ? this.stack.length : -1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (originalUse as any).apply(this, args);
      if (!Array.isArray(this.stack) || before < 0) {
        throw new Error(
          'checkOpenapiCoverage: Router.use did not expose a stack; extend the route-table ' +
            'walker before trusting this report.',
        );
      }
      const layers = this.stack.slice(before);
      if (layers.length === 0) {
        throw new Error(
          'checkOpenapiCoverage: Router.use added no inspectable layers; extend the route-table ' +
            'walker before trusting this report.',
        );
      }
      for (const layer of layers) {
        if (!layer || typeof layer !== 'object') {
          throw new Error(
            'checkOpenapiCoverage: Router.use added a non-object layer; extend the route-table ' +
              'walker before trusting this report.',
          );
        }
        recordedUseMounts.set(layer, { paths });
      }
      return result;
    };
    app = appFactory(buildInertContext());
  } finally {
    useOwner.use = originalUse;
  }

  if (!app) {
    throw new Error('checkOpenapiCoverage: application factory did not return an Express app.');
  }

  // Express does not expose the application's stack in its public TypeScript
  // surface. Fail closed if that implementation detail changes.
  const router = (app as unknown as { router?: { stack?: unknown } }).router;
  if (!Array.isArray(router?.stack)) {
    throw new Error(
      'checkOpenapiCoverage: could not inspect the application router stack; extend the ' +
        'route-table walker before trusting this report.',
    );
  }

  const surfaces: MountedSurface[] = [];
  collectRouterRoutes(router.stack, '', surfaces, recordedUseMounts, new Map());
  return surfaces;
}

/**
 * API module mounts derived from the real route wiring. Every mounted surface
 * kind contributes its top-level module. Direct application mounts below that
 * module also retain their exact `app.use` path, so a new
 * `/api/v1/<module>/<submodule>` mount cannot disappear into its parent row.
 * Router-level sub-mounts such as `settingsRouter.use('/foo', ...)` stay inside
 * the parent's policy by design; only application-level mounts are classified.
 */
export function mountedApiModulePaths(surfaces: readonly MountedSurface[]): string[] {
  const modulePrefix = `${API_PREFIX}/`;
  return sortedUnique(
    surfaces.flatMap((surface) => {
      if (!surface.path.startsWith(modulePrefix)) return [];
      const segment = surface.path.slice(modulePrefix.length).split('/', 1)[0];
      if (!segment) return [];

      const paths = [`${modulePrefix}${segment}`];
      const applicationMountPath = surface.applicationMountPath;
      if (
        applicationMountPath?.startsWith(modulePrefix) &&
        applicationMountPath.slice(modulePrefix.length).split('/').filter(Boolean).length > 1
      ) {
        paths.push(applicationMountPath);
      }
      return paths;
    }),
  );
}

function isTopLevelApiModulePath(path: string): boolean {
  const modulePrefix = `${API_PREFIX}/`;
  return (
    path.startsWith(modulePrefix) &&
    path.slice(modulePrefix.length).split('/').filter(Boolean).length === 1
  );
}

/**
 * `MODULE_POLICIES` deliberately remains a single-segment table so
 * `unmountedPolicies` stays a symmetric top-level mount check. A direct nested
 * `app.use` is classified when its parent rejects bearer credentials or when
 * runtime bearer admission differs from its parent. A same-admission sub-router
 * below a bearer-capable parent belongs inside that parent router instead of
 * silently inheriting through application wiring.
 */
function nestedMountIsBearerClassified(path: string): boolean {
  const modulePrefix = `${API_PREFIX}/`;
  const relativePath = path.slice(API_PREFIX.length);
  const parentSegment = path.slice(modulePrefix.length).split('/', 1)[0];
  if (!parentSegment) return false;
  const parentPath = `/${parentSegment}`;
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const policies = methods.map((method) => ({
    parent: resolveBearerPolicyClassification(parentPath, method),
    nested: resolveBearerPolicyClassification(relativePath, method),
  }));
  const parentAcceptsBearer = policies.some(({ parent }) => policyAcceptsBearer(parent));

  if (!parentAcceptsBearer) return true;

  return policies.some(({ parent, nested }) => !samePolicyClassification(parent, nested));
}

function policyAcceptsBearer(policy: ResolvedBearerPolicyClassification): boolean {
  return policy.kind === 'allow' || policy.kind === 'scope';
}

function samePolicyClassification(
  left: ResolvedBearerPolicyClassification,
  right: ResolvedBearerPolicyClassification,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== 'scope' || right.kind !== 'scope') return true;
  return left.read === right.read && left.write === right.write;
}

/** Compare actual API module wiring with the sole runtime bearer policy table. */
export function findBearerModulePolicyCoverage(
  surfaces: readonly MountedSurface[],
  policies: readonly BearerModulePolicy[] = MODULE_POLICIES,
): BearerModulePolicyCoverage {
  const mounted = mountedApiModulePaths(surfaces);
  const policyPaths = policies.map((policy) => `${API_PREFIX}${policy.prefix}`);
  const invalidPolicyPrefixes = sortedUnique(
    policyPaths.filter((path) => !isTopLevelApiModulePath(path)),
  );
  const topLevelPolicyPaths = policyPaths.filter(isTopLevelApiModulePath);
  const explicitlyClassifiedNestedMounts = mounted.filter(
    (path) => !isTopLevelApiModulePath(path) && nestedMountIsBearerClassified(path),
  );
  const classified = sortedUnique([...topLevelPolicyPaths, ...explicitlyClassifiedNestedMounts]);
  const mountedSet = new Set(mounted);
  const classifiedSet = new Set(classified);
  const unclassified = mounted.filter((path) => !classifiedSet.has(path));
  const unmountedPolicies = sortedUnique(
    topLevelPolicyPaths.filter((path) => !mountedSet.has(path)),
  );
  const duplicatePolicies = duplicates(policyPaths);

  return {
    ok:
      unclassified.length === 0 &&
      unmountedPolicies.length === 0 &&
      duplicatePolicies.length === 0 &&
      invalidPolicyPrefixes.length === 0,
    mounted,
    classified,
    unclassified,
    unmountedPolicies,
    duplicatePolicies,
    invalidPolicyPrefixes,
  };
}

function bearerModulePolicyCoverageMessage(coverage: BearerModulePolicyCoverage): string {
  const problems = ['Bearer module policy coverage failed.'];
  if (coverage.unclassified.length > 0) {
    problems.push(
      'Mounted API modules without an explicit bearer classification:',
      ...coverage.unclassified.map((path) => `  - ${path}`),
    );
  }
  if (coverage.unmountedPolicies.length > 0) {
    problems.push(
      'Bearer classifications without a mounted API module:',
      ...coverage.unmountedPolicies.map((path) => `  - ${path}`),
    );
  }
  if (coverage.duplicatePolicies.length > 0) {
    problems.push(
      'Duplicate bearer module classifications:',
      ...coverage.duplicatePolicies.map((path) => `  - ${path}`),
    );
  }
  if (coverage.invalidPolicyPrefixes.length > 0) {
    problems.push(
      'Bearer module classifications must remain single-segment top-level prefixes:',
      ...coverage.invalidPolicyPrefixes.map((path) => `  - ${path}`),
    );
  }
  return problems.join('\n');
}

/** Fail closed with mount-path diagnostics suitable for CI output. */
export function assertBearerModulePolicyCoverage(
  surfaces: readonly MountedSurface[],
  policies: readonly BearerModulePolicy[] = MODULE_POLICIES,
): void {
  const coverage = findBearerModulePolicyCoverage(surfaces, policies);
  if (!coverage.ok) throw new Error(bearerModulePolicyCoverageMessage(coverage));
}

/** Mounted routes with no matching operation in the OpenAPI document, as `"METHOD /path"`. */
export function findUndocumentedRoutes(
  surfaces: readonly MountedSurface[],
  doc: OpenApiDocumentLike,
): string[] {
  const missing: string[] = [];
  for (const route of surfaces) {
    if (route.kind !== 'route') continue;
    const key = `${route.method} ${route.path}`;
    if (SELF_DOCUMENTING.has(key)) continue;

    const relativePath = route.path.startsWith(API_PREFIX)
      ? route.path.slice(API_PREFIX.length) || '/'
      : route.path;
    const pathItem = doc.paths[relativePath];
    if (!pathItem || pathItem[route.method.toLowerCase()] === undefined) {
      missing.push(key);
    }
  }
  return missing;
}

/**
 * Documented operations with no matching mounted route, as `"METHOD /path"` —
 * a phantom endpoint that would render on `/docs` but 404 for real callers.
 */
export function findPhantomRoutes(
  surfaces: readonly MountedSurface[],
  doc: OpenApiDocumentLike,
): string[] {
  const mounted = new Set(
    surfaces
      .filter((surface): surface is MountedRoute => surface.kind === 'route')
      .map((route) => `${route.method} ${route.path}`),
  );
  const phantom: string[] = [];

  for (const [path, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem) continue;
    const fullPath = path === '/' ? API_PREFIX : API_PREFIX + path;
    for (const method of HTTP_METHODS) {
      if (pathItem[method] === undefined) continue;
      const key = `${method.toUpperCase()} ${fullPath}`;
      if (!mounted.has(key)) {
        phantom.push(key);
      }
    }
  }
  return phantom;
}

export function checkCoverage(): CoverageResult {
  const mounted = buildRouteTable();
  const doc = getOpenApiDocument() as unknown as OpenApiDocumentLike;
  const missing = findUndocumentedRoutes(mounted, doc);
  const phantom = findPhantomRoutes(mounted, doc);
  const bearerModules = findBearerModulePolicyCoverage(mounted);

  return {
    ok: missing.length === 0 && phantom.length === 0 && bearerModules.ok,
    missing,
    phantom,
    bearerModules,
    mountedCount: mounted.filter((surface) => surface.kind === 'route').length,
    documentedCount: Object.keys(doc.paths).length,
  };
}

function main(): void {
  const result = checkCoverage();
  if (!result.ok) {
    if (result.missing.length > 0) {
      console.error('OpenAPI coverage check failed — undocumented routes:');
      for (const route of result.missing) {
        console.error(`  - ${route}`);
      }
      console.error(
        `\n${result.missing.length} of ${result.mountedCount} mounted routes are missing from ` +
          'the OpenAPI document. Add each to the `endpoints` table in ' +
          'apps/api/src/http/openapi/document.ts.',
      );
    }
    if (result.phantom.length > 0) {
      console.error('OpenAPI coverage check failed — phantom (documented, unmounted) routes:');
      for (const route of result.phantom) {
        console.error(`  - ${route}`);
      }
      console.error(
        `\n${result.phantom.length} documented route(s) have no matching mounted route. Remove ` +
          'each from the `endpoints` table in apps/api/src/http/openapi/document.ts or mount it.',
      );
    }
    if (!result.bearerModules.ok) {
      console.error(bearerModulePolicyCoverageMessage(result.bearerModules));
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `OpenAPI coverage OK — ${result.mountedCount} mounted routes all documented ` +
      `(${result.documentedCount} paths in the spec); bearer policies cover all ` +
      `${result.bearerModules.mounted.length} API modules.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
