import { pathToFileURL } from 'node:url';

import express, { type Application } from 'express';
import type { Redis } from 'ioredis';

import { createApp } from '../app';
import { loadConfig } from '../config/env';
import type { AppContext } from '../http/context';
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
  method: string;
  path: string;
}

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
  mountedCount: number;
  documentedCount: number;
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
    auth: inertService('auth'),
    google: inertService('google'),
    twoFactor: inertService('twoFactor'),
    adminTwoFactor: inertService('adminTwoFactor'),
    admin: inertService('admin'),
    apiKeys: inertService('apiKeys'),
    oauth: inertService('oauth'),
    workboard: inertService('workboard'),
    marketData: inertService('marketData'),
    assets: inertService('assets'),
    search: inertService('search'),
    portfolio: inertService('portfolio'),
    tax: inertService('tax'),
    customAssets: inertService('customAssets'),
    conglomerate: inertService('conglomerate'),
    backtest: inertService('backtest'),
    ideas: inertService('ideas'),
    analytics: inertService('analytics'),
    social: inertService('social'),
    chat: inertService('chat'),
    notifications: inertService('notifications'),
    notificationSettings: inertService('notificationSettings'),
    telegramSetup: inertService('telegramSetup'),
    discordSetup: inertService('discordSetup'),
    accountSettings: inertService('accountSettings'),
    accountDeletion: inertService('accountDeletion'),
    dataExport: inertService('dataExport'),
    alerts: inertService('alerts'),
    announcements: inertService('announcements'),
    notificationDispatcher: inertService('notificationDispatcher'),
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
  };
}

function collectRouterRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stack: any[],
  base: string,
  out: MountedRoute[],
): void {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter(
        (method) => layer.route.methods[method] && method !== '_all',
      );
      // A router's own root route (`router.get('/', ...)`) contributes a bare
      // `/` segment; appended to its mount prefix that would leave a spurious
      // trailing slash no path in the spec ever has (e.g. `/workboard/`
      // instead of `/workboard`).
      const suffix = layer.route.path === '/' ? '' : layer.route.path;
      for (const method of methods) {
        out.push({ method: method.toUpperCase(), path: toOpenApiPath(base + suffix) });
      }
    } else if (layer.handle?.stack) {
      // None of app.ts's routers mount a further sub-router today — every
      // group is registered directly on `app`. If that ever changes, this
      // needs to learn the nested mount path the same way `buildRouteTable`
      // does below, so it fails loudly instead of silently under-counting.
      throw new Error(
        `checkOpenapiCoverage: found a router nested under "${base}" — extend ` +
          'collectRouterRoutes to reconstruct its mount path before trusting this report.',
      );
    }
  }
}

/**
 * Builds the real app while recording every `app.use(path, handler)` call it
 * makes, then walks each mounted router's own stack (where `route.path` is
 * always the literal string passed to `.get`/`.post`/etc.) to recover the
 * full route table.
 */
export function buildRouteTable(): MountedRoute[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mounts: { prefix: string; handler: any }[] = [];
  const originalUse = express.application.use;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (express.application as any).use = function patchedUse(this: Application, ...args: any[]) {
      const [first, ...rest] = args;
      const usesExplicitPath = typeof first === 'string';
      mounts.push({
        prefix: usesExplicitPath ? first : '',
        handler: usesExplicitPath ? rest[rest.length - 1] : first,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalUse as any).apply(this, args);
    };
    createApp(buildInertContext());
  } finally {
    express.application.use = originalUse;
  }

  const routes: MountedRoute[] = [];
  for (const { prefix, handler } of mounts) {
    if (handler?.stack && Array.isArray(handler.stack)) {
      collectRouterRoutes(handler.stack, prefix, routes);
    }
  }
  return routes;
}

/** Mounted routes with no matching operation in the OpenAPI document, as `"METHOD /path"`. */
export function findUndocumentedRoutes(
  routes: readonly MountedRoute[],
  doc: OpenApiDocumentLike,
): string[] {
  const missing: string[] = [];
  for (const route of routes) {
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
  routes: readonly MountedRoute[],
  doc: OpenApiDocumentLike,
): string[] {
  const mounted = new Set(routes.map((route) => `${route.method} ${route.path}`));
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

  return {
    ok: missing.length === 0 && phantom.length === 0,
    missing,
    phantom,
    mountedCount: mounted.length,
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
    process.exitCode = 1;
    return;
  }
  console.log(
    `OpenAPI coverage OK — ${result.mountedCount} mounted routes all documented ` +
      `(${result.documentedCount} paths in the spec).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
