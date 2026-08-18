import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  expect,
  request as newRequestContext,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import ts from 'typescript';

import { newAdminRequestContext } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { expectUserShellReady } from './support/flows';
import { provisionUser, provisionUserInContext } from './support/users';

type GateLocale = 'en' | 'de';

const VIEWPORT_PROFILES = [
  {
    label: 'EN phone 390px',
    locale: 'en',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
  },
  {
    label: 'DE phone 390px',
    locale: 'de',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
  },
  {
    // #1047's previously ungated rail-hidden/topbar-not-wrapped breakpoint band.
    label: 'EN mid-band 600px',
    locale: 'en',
    viewport: { width: 600, height: 900 },
    deviceScaleFactor: 2,
  },
  {
    label: 'DE mid-band 600px',
    locale: 'de',
    viewport: { width: 600, height: 900 },
    deviceScaleFactor: 2,
  },
] as const satisfies readonly {
  label: string;
  locale: GateLocale;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
}[];

const LOCALE_STORAGE_KEY = 'bettertrack.locale';
const USER_APP_SOURCE = 'apps/web/src/user/UserApp.tsx';
const USER_OVERLAY_SOURCE_ROOT = 'apps/web/src/user';
const CONTROL_CENTER_SOURCE = 'apps/web/src/user/control/ControlCenterOverlay.tsx';
const CONTROL_PANEL_MATCHER_SOURCE = 'apps/web/src/user/control/matchControlPanel.ts';
const OVERLAY_PRIMITIVE_SOURCES = new Set(['apps/web/src/user/components/Dialog.tsx']);

const LONG_TRANSACTION_NOTE =
  'Populated mobile overflow holding row with a deliberately long transaction annotation';
const LONG_CASH_NOTE =
  'Populated mobile overflow cash movement with a deliberately long merchant and reference label';
const LONG_CASH_SOURCE_NAME =
  'Mobile overflow secondary cash source with a deliberately long banking label';
const LONG_TAG_NAME = 'Long mobile overflow classification label for household spending'.slice(
  0,
  60,
);
const LONG_API_KEY_NAME =
  'Mobile overflow API key with a deliberately long governance label for responsive rows'.slice(
    0,
    80,
  );
const LONG_WEBHOOK_DESCRIPTION =
  'Mobile overflow webhook with a deliberately long descriptive label that must remain contained in every responsive settings row';
const LONG_WEBHOOK_URL = `https://example.com/mobile-overflow/${'deeply-nested-segment/'.repeat(
  20,
)}delivery-endpoint`;
// The exhaustive inventory generates hundreds of trace snapshots. Recycle the
// renderer between bounded batches so a single page does not accumulate every
// route's React/Vite state and crash before the later Control Center surfaces.
const ROUTE_PAGE_BATCH_SIZE = 24;

/** Public, non-token routes that are meaningful without a session. */
const ANONYMOUS_CORE_ROUTES = ['/login', '/register', '/forgot-password'] as const;

/**
 * Canonical authenticated surfaces. Dynamic entries are resolved to real
 * seeded entities below; every other entry is its own concrete URL.
 */
const AUTHENTICATED_CORE_ROUTES = [
  '/',
  '/account/delete',
  '/welcome',
  '/workbench/blueprints/new',
  '/workbench/blueprints/:id/edit',
  '/chat-window',
  '/portfolio',
  '/portfolio/activity',
  '/portfolio/cash',
  '/portfolio/cash/movements',
  '/portfolio/cash/budgets',
  '/portfolio/cash/labels',
  '/portfolio/cash/accounts',
  '/portfolio/cash/import',
  '/portfolio/analysis',
  '/portfolio/tax',
  '/portfolio/import',
  '/portfolio/plan',
  '/portfolio/automate',
  '/portfolio/files',
  '/portfolio/people',
  '/portfolio/settings',
  '/portfolio/events',
  '/portfolio/structure',
  '/portfolio/health',
  '/portfolio/private-markets',
  '/portfolio/rebalance',
  '/workbench',
  '/workbench/studio',
  '/workbench/forecasts',
  '/workbench/blueprints',
  '/workbench/blueprints/:id',
  '/workbench/backtests',
  '/workbench/compare',
  '/workbench/ideas',
  '/workbench/ideas/:ideaId',
  '/workbench/calculators',
  '/workbench/alerts',
  '/assets',
  '/assets/search',
  '/assets/watchlists',
  '/assets/watchlists/:watchlistId',
  '/assets/custom-assets',
  '/assets/news',
  '/assets/discover',
  '/assets/events',
  '/assets/screener',
  '/assets/:id',
  '/people',
  '/people/following',
  '/people/chat',
  '/people/shared',
  '/people/teams',
  '/people/approvals',
  '/ask',
  '/review',
  '/vault/how-it-works',
  '/control/data',
  '/developer',
  '/developer/mcp',
  '/developer/logs',
  '/developer/oauth-apps',
] as const;

/**
 * Addressable settings overlays, source-checked against CONTROL_GROUPS and
 * PANEL_ALIASES. Legacy aliases remain working URLs, so they are measured too.
 */
const CONTROL_CORE_ROUTES = [
  '/control',
  '/control/account',
  '/control/appearance',
  '/control/profile',
  '/control/sign-in',
  '/control/sessions',
  '/control/defaults',
  '/control/notifications',
  '/control/notification-log',
  '/control/feedback',
  '/control/privacy',
  '/control/connections',
  '/control/api',
  '/control/oauth-apps',
  '/control/authorized-apps',
  '/control/webhooks',
  '/control/delete-account',
  '/control/security',
  '/control/portfolio-defaults',
  '/control/api-keys',
  '/control/taxes',
] as const;

interface RouteExclusion {
  path: string;
  justification: string;
}

const LEGACY_REDIRECTS = [
  '/portfolio/custom-assets',
  '/portfolio/cash/tags',
  '/portfolio/cash/rules',
  '/portfolio/cash/transactions',
  '/portfolio/cash/categories',
  '/portfolio/cash-flow/*',
  '/portfolio/transactions',
  '/portfolio/analytics',
  '/assets/stocks',
  '/assets/etfs',
  '/assets/crypto',
  '/assets/commodities',
  '/assets/custom',
  '/people/profile',
  '/developer/webhooks',
  '/settings',
  '/settings/account',
  '/settings/notifications',
  '/settings/security',
  '/settings/profile',
  '/settings/taxes',
  '/settings/connections',
  '/settings/api',
  '/settings/imports',
  '/settings/backups',
  '/settings/*',
  '/portfolios',
  '/workboard',
  '/workboard/watchlist',
  '/workboard/alerts',
  '/workboard/backtests',
  '/workboard/calculators',
  '/workboard/comparisons',
  '/workboard/conglomerates/*',
  '/workboard/ideas/*',
  '/forecast',
  '/expenses/*',
  '/social',
  '/social/friends',
  '/social/chat/*',
  '/social/my-shared',
  '/social/shared-with-me/*',
  '/social/ideas',
  '/social/profile',
  '/following',
] as const;

const ROUTE_EXCLUSIONS: readonly RouteExclusion[] = [
  ...LEGACY_REDIRECTS.map((path) => ({
    path,
    justification: 'Legacy redirect; its canonical destination is covered by this gate.',
  })),
  ...['/reset/:token', '/invite/:token', '/s/:token', '/u/:username'].map((path) => ({
    path,
    justification: 'Token or identity-specific public state is owned by its dedicated e2e flow.',
  })),
  {
    path: '/oauth/authorize',
    justification: 'A valid OAuth client and PKCE request are owned by oauth-consent.spec.ts.',
  },
  {
    path: '/portfolio/tax/print',
    justification:
      'Print-to-PDF document targets paper dimensions, not the interactive app viewport.',
  },
  ...['/chat-window/c/:conversationId', '/chat-window/:userId'].map((path) => ({
    path,
    justification: 'Deep-link variant shares the covered base ChatWindowPage layout.',
  })),
  ...['/people/chat/c/:conversationId', '/people/chat/:userId'].map((path) => ({
    path,
    justification:
      'Deep-link variant shares ChatPage, covered here and with a real chat in the happy path.',
  })),
  ...[
    '/people/shared/conglomerates/:id',
    '/people/shared/watchlists/:watchlistId',
    '/people/shared/ideas/:ideaId',
    '/people/shared/:portfolioId',
  ].map((path) => ({
    path,
    justification:
      'Audience-bound detail requires a second account; the covered shared index owns its shell.',
  })),
  {
    path: '/*',
    justification: 'Wildcard not-found handling is not a product destination.',
  },
];

interface RegisteredRoute {
  path: string;
  line: number;
}

function parseTsx(relativePath: string): ts.SourceFile {
  const absolutePath = resolve(process.cwd(), relativePath);
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    // A plain `.ts` registry must not be parsed as TSX: there, `<T>(x) => x`
    // reads as JSX and silently truncates the declarations after it.
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function sourceFilesUnder(relativeDirectory: string): string[] {
  return readdirSync(resolve(process.cwd(), relativeDirectory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) return sourceFilesUnder(path);
      return entry.isFile() && path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : [];
    },
  );
}

/**
 * Find user components that render an overlay primitive or a content-owned
 * popover. Shared `Dialog`/`ODialog` implementations are infrastructure; every
 * user component that invokes one is discovered separately. This turns the
 * explicit scenario/exclusion table below into a completeness gate instead of
 * a list that can silently become stale when a new overlay component lands.
 */
function registeredOverlaySurfaceSources(): string[] {
  return sourceFilesUnder(USER_OVERLAY_SOURCE_ROOT)
    .filter((relativePath) => {
      if (OVERLAY_PRIMITIVE_SOURCES.has(relativePath)) return false;
      const sourceFile = parseTsx(relativePath);
      let rendersOverlay = false;
      const visit = (node: ts.Node) => {
        if (rendersOverlay) return;
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'createPortal'
        ) {
          rendersOverlay = true;
          return;
        }
        const opening = ts.isJsxElement(node)
          ? node.openingElement
          : ts.isJsxSelfClosingElement(node)
            ? node
            : undefined;
        if (opening) {
          const tag = opening.tagName.getText(sourceFile);
          if (tag === 'Dialog' || tag === 'ODialog' || tag === 'Drawer') {
            rendersOverlay = true;
            return;
          }
          const className = opening.attributes.properties.find(
            (property): property is ts.JsxAttribute =>
              ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'className',
          );
          if (className?.getText(sourceFile).includes('bt-popover')) {
            rendersOverlay = true;
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return rendersOverlay;
    })
    .sort();
}

/** Find a top-level `const <name> = …` initializer in a parsed source file. */
function findRegistry(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node.initializer;
    }
    if (found === undefined) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Derive full route paths from nested React Router declarations. This mirrors
 * the V5 surface-inventory gate: layouts contribute a prefix, index routes use
 * their parent, and a source addition is discovered without editing this test.
 */
function registeredUserRoutes(): RegisteredRoute[] {
  const sourceFile = parseTsx(USER_APP_SOURCE);
  const routes: RegisteredRoute[] = [];

  const openingOf = (node: ts.Node) =>
    ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;

  const attribute = (opening: ts.JsxOpeningLikeElement, name: string) =>
    opening.attributes.properties.find(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) && property.name.getText(sourceFile) === name,
    );

  const visit = (node: ts.Node, prefix: string) => {
    let childPrefix = prefix;
    const opening = openingOf(node);
    if (opening && opening.tagName.getText(sourceFile) === 'Route') {
      const pathAttribute = attribute(opening, 'path');
      const segment =
        pathAttribute?.initializer && ts.isStringLiteral(pathAttribute.initializer)
          ? pathAttribute.initializer.text
          : undefined;
      const line = sourceFile.getLineAndCharacterOfPosition(opening.getStart(sourceFile)).line + 1;
      if (segment !== undefined) {
        childPrefix = `${prefix}/${segment}`.replace(/\/+/g, '/');
        routes.push({ path: childPrefix, line });
      } else if (attribute(opening, 'index')) {
        routes.push({ path: prefix || '/', line });
      }
    }
    ts.forEachChild(node, (child) => visit(child, childPrefix));
  };

  visit(sourceFile, '');
  return routes;
}

/**
 * Discover every canonical and legacy Control Center URL from its registries.
 *
 * The two registries deliberately live in different modules: `CONTROL_GROUPS`
 * ships inside the lazy overlay chunk, while `PANEL_ALIASES` sits beside the
 * matcher so the shell can resolve a panel id before that chunk exists. Each is
 * parsed where it actually lives, and a registry that goes missing fails loudly
 * here instead of quietly shrinking the inventory into a green run.
 */
function registeredControlRoutes(): string[] {
  const overlaySource = parseTsx(CONTROL_CENTER_SOURCE);
  const matcherSource = parseTsx(CONTROL_PANEL_MATCHER_SOURCE);
  const groups = findRegistry(overlaySource, 'CONTROL_GROUPS');
  const aliases = findRegistry(matcherSource, 'PANEL_ALIASES');

  expect(
    groups !== undefined,
    `CONTROL_GROUPS must stay parseable in ${CONTROL_CENTER_SOURCE}.`,
  ).toBeTruthy();
  expect(
    aliases !== undefined && ts.isObjectLiteralExpression(aliases),
    `PANEL_ALIASES must stay a parseable object literal in ${CONTROL_PANEL_MATCHER_SOURCE}.`,
  ).toBeTruthy();

  const ids: string[] = [];
  const findIds = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(overlaySource) === 'id' &&
      ts.isStringLiteral(node.initializer)
    ) {
      ids.push(node.initializer.text);
    }
    ts.forEachChild(node, findIds);
  };
  if (groups) findIds(groups);

  const aliasIds =
    aliases && ts.isObjectLiteralExpression(aliases)
      ? aliases.properties.flatMap((property) => {
          if (!ts.isPropertyAssignment(property)) return [];
          if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
            return [property.name.text];
          }
          return [];
        })
      : [];

  // Anti-shrinkage: an empty parse of either registry must not read as "no
  // routes to classify".
  expect(ids.length, 'The Control Center group registry must not parse empty.').toBeGreaterThan(0);
  expect(aliasIds.length, 'The panel alias registry must not parse empty.').toBeGreaterThan(0);

  return [
    '/control',
    ...ids.map((id) => `/control/${id}`),
    ...aliasIds.map((id) => `/control/${id}`),
  ];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertCompleteRouteInventory(): void {
  const registered = registeredUserRoutes();
  const registeredPaths = unique(registered.map((route) => route.path));
  const coveredPaths = unique([...ANONYMOUS_CORE_ROUTES, ...AUTHENTICATED_CORE_ROUTES]);
  const excludedPaths = ROUTE_EXCLUSIONS.map((exclusion) => exclusion.path);
  const covered = new Set(coveredPaths);
  const excluded = new Set(excludedPaths);

  // Parser and inventory anti-shrinkage: neither an empty parse nor duplicate
  // classifications may make a missing route look green.
  expect(registeredPaths.length).toBeGreaterThan(100);
  expect(coveredPaths).toHaveLength(
    ANONYMOUS_CORE_ROUTES.length + AUTHENTICATED_CORE_ROUTES.length,
  );
  expect(excluded.size).toBe(excludedPaths.length);

  const invalidJustifications = ROUTE_EXCLUSIONS.filter(
    ({ justification }) => justification.trim() === '' || /[\r\n]/.test(justification),
  ).map(({ path }) => path);
  expect(invalidJustifications, 'Every route exclusion needs a one-line justification.').toEqual(
    [],
  );

  const unclassified = registered
    .filter(({ path }) => !covered.has(path) && !excluded.has(path))
    .map(({ path, line }) => `${USER_APP_SOURCE}:${line} ${path}`);
  expect(
    unique(unclassified),
    'New UserApp routes must be covered by the mobile viewport matrix or explicitly excluded with a justification.',
  ).toEqual([]);

  const registeredSet = new Set(registeredPaths);
  expect(
    [...coveredPaths, ...excludedPaths].filter((path) => !registeredSet.has(path)),
    'Stale mobile route classifications no longer exist in UserApp.',
  ).toEqual([]);
  expect(
    coveredPaths.filter((path) => excluded.has(path)),
    'A route cannot be both covered and excluded.',
  ).toEqual([]);

  expect(unique(registeredControlRoutes()).sort()).toEqual([...CONTROL_CORE_ROUTES].sort());

  const coreRoutes = new Set<string>([...AUTHENTICATED_CORE_ROUTES, ...CONTROL_CORE_ROUTES]);
  expect(
    POPULATED_ROUTE_EXPECTATIONS.filter(
      ({ route, justification }) => !coreRoutes.has(route) || justification.trim() === '',
    ),
    'Every populated-state sentinel must name a covered route and explain the state it proves.',
  ).toEqual([]);
  expect(
    OVERLAY_SCENARIOS.filter(
      ({ route, sources, justification }) =>
        !coreRoutes.has(route) ||
        sources.length === 0 ||
        justification.trim() === '' ||
        /[\r\n]/.test(justification),
    ),
    'Every overlay scenario must name sources, a covered route and a one-line content-specific justification.',
  ).toEqual([]);
  expect(new Set(OVERLAY_SCENARIOS.map(({ label }) => label)).size).toBe(OVERLAY_SCENARIOS.length);
  expect(new Set(OVERLAY_EXCLUSIONS.map(({ surface }) => surface)).size).toBe(
    OVERLAY_EXCLUSIONS.length,
  );
  expect(
    OVERLAY_EXCLUSIONS.filter(
      ({ surface, sources, routes, justification }) =>
        surface.trim() === '' ||
        sources.length === 0 ||
        routes.length === 0 ||
        routes.some((route) => !coreRoutes.has(route)) ||
        justification.trim() === '' ||
        /[\r\n]/.test(justification),
    ),
    'Every omitted overlay surface must name sources, covered routes and a one-line state-specific justification.',
  ).toEqual([]);

  const registeredOverlaySources = registeredOverlaySurfaceSources();
  const classifiedOverlaySources = unique([
    ...OVERLAY_SCENARIOS.flatMap(({ sources }) => sources),
    ...OVERLAY_EXCLUSIONS.flatMap(({ sources }) => sources),
  ]).sort();
  expect(
    classifiedOverlaySources,
    'Every source-derived user overlay component must have a measured scenario or a component-and-route exclusion; stale classifications must also be removed.',
  ).toEqual(registeredOverlaySources);
}

interface RouteFixtures {
  assetId: string;
  conglomerateId: string;
  friendUsername: string;
  ideaId: string;
  portfolioId: string;
  watchlistId: string;
}

async function responseJson<T>(response: APIResponse, context: string): Promise<T> {
  const text = await response.text();
  expect(response.ok(), `${context}: ${response.status()} ${text}`).toBeTruthy();
  return JSON.parse(text) as T;
}

async function createRouteFixtures(
  api: APIRequestContext,
  senderApi: APIRequestContext,
  ownerUsername: string,
  friendUsername: string,
): Promise<RouteFixtures> {
  const search = await responseJson<{ results: Array<{ id: string; symbol: string }> }>(
    await api.get(`${API_BASE_URL}/api/v1/search`, { params: { q: 'Apple' } }),
    'searching for the mobile route asset',
  );
  const apple = search.results.find((result) => result.symbol === 'AAPL');
  expect(apple, 'The seeded catalog must contain AAPL.').toBeTruthy();

  const headers = { 'X-Requested-With': 'BetterTrack' };
  const portfolios = await responseJson<{ portfolios: Array<{ id: string }> }>(
    await api.get(`${API_BASE_URL}/api/v1/portfolios`),
    'reading the populated mobile route portfolio',
  );
  const portfolioId = portfolios.portfolios[0]?.id;
  expect(portfolioId, 'A provisioned account must have a default portfolio.').toBeTruthy();

  await responseJson<Record<string, unknown>>(
    await api.post(`${API_BASE_URL}/api/v1/portfolios/${portfolioId!}/transactions`, {
      headers,
      data: {
        assetId: apple!.id,
        side: 'buy',
        quantity: 8,
        price: 125.5,
        fee: 4.95,
        executedAt: new Date(Date.now() - 86_400_000).toISOString(),
        note: LONG_TRANSACTION_NOTE,
      },
    }),
    'creating the populated holding row',
  );
  await responseJson<Record<string, unknown>>(
    await api.post(`${API_BASE_URL}/api/v1/portfolios/${portfolioId!}/cash/deposit`, {
      headers,
      data: { amountEur: 8_500, note: LONG_CASH_NOTE },
    }),
    'creating the populated cash deposit',
  );
  await responseJson<Record<string, unknown>>(
    await api.post(`${API_BASE_URL}/api/v1/portfolios/${portfolioId!}/cash/withdraw`, {
      headers,
      data: {
        amountEur: 312.45,
        note: `${LONG_CASH_NOTE} — second populated ledger row`,
      },
    }),
    'creating the populated cash withdrawal',
  );
  await responseJson<Record<string, unknown>>(
    await api.post(`${API_BASE_URL}/api/v1/portfolios/${portfolioId!}/cash/sources`, {
      headers,
      data: { name: LONG_CASH_SOURCE_NAME, type: 'bank' },
    }),
    'creating the populated secondary cash source',
  );
  await responseJson<Record<string, unknown>>(
    await api.post(`${API_BASE_URL}/api/v1/cash/tags`, {
      headers,
      data: { name: LONG_TAG_NAME, color: '#7c3aed' },
    }),
    'creating the long cash label',
  );
  await responseJson<Record<string, unknown>>(
    await api.post(`${API_BASE_URL}/api/v1/settings/api-keys`, {
      headers,
      data: { name: LONG_API_KEY_NAME, scopes: ['market:read'] },
    }),
    'creating the long API-key row',
  );
  await responseJson<Record<string, unknown>>(
    await api.post(`${API_BASE_URL}/api/v1/settings/webhooks`, {
      headers,
      data: {
        url: LONG_WEBHOOK_URL,
        description: LONG_WEBHOOK_DESCRIPTION,
        // This subscription exists only to paint a long responsive row. The
        // fixture never requests an account export, so the worker cannot turn
        // its public display URL into an outbound delivery or retry chain.
        eventTypes: ['account.data_export'],
      },
    }),
    'creating the long webhook row',
  );

  // A real friend request gives the owner both a long-username social row and
  // an actual notification row. Accept it after observing the incoming request
  // so the same account also has a populated chat friend picker.
  await responseJson<Record<string, unknown>>(
    await senderApi.post(`${API_BASE_URL}/api/v1/social/requests`, {
      headers,
      data: { identifier: ownerUsername },
    }),
    'creating the populated friend request notification',
  );
  const requests = await responseJson<{
    incoming: Array<{ id: string; user: { username: string } }>;
  }>(
    await api.get(`${API_BASE_URL}/api/v1/social/requests`),
    'reading the populated incoming friend request',
  );
  const incoming = requests.incoming.find((request) => request.user.username === friendUsername);
  expect(incoming, 'The long-username friend request must be visible to the owner.').toBeTruthy();

  await expect
    .poll(
      async () => {
        const response = await api.get(`${API_BASE_URL}/api/v1/notifications`, {
          params: { view: 'active', limit: 50 },
        });
        if (!response.ok()) return false;
        const body = (await response.json()) as {
          items: Array<{ title: string; body: string }>;
        };
        return body.items.some((item) => `${item.title} ${item.body}`.includes(friendUsername));
      },
      {
        message: 'the populated account should receive its friend-request notification row',
        timeout: 30_000,
      },
    )
    .toBe(true);
  await responseJson<Record<string, unknown>>(
    await api.post(`${API_BASE_URL}/api/v1/social/requests/${incoming!.id}/accept`, { headers }),
    'accepting the populated friend row',
  );

  const conglomerate = await responseJson<{ id: string }>(
    await api.post(`${API_BASE_URL}/api/v1/conglomerates`, {
      headers,
      data: { name: `Mobile route basket ${Date.now().toString(36)}` },
    }),
    'creating the mobile route conglomerate',
  );
  const watchlist = await responseJson<{ id: string }>(
    await api.post(`${API_BASE_URL}/api/v1/workboard/watchlists`, {
      headers,
      data: { name: `Mobile route watchlist ${Date.now().toString(36)}` },
    }),
    'creating the mobile route watchlist',
  );
  await responseJson<unknown>(
    await api.post(`${API_BASE_URL}/api/v1/workboard`, {
      headers,
      data: { assetId: apple!.id, watchlistId: watchlist.id },
    }),
    'populating the mobile route watchlist',
  );
  const idea = await responseJson<{ idea: { id: string } }>(
    await api.post(`${API_BASE_URL}/api/v1/ideas`, {
      headers,
      data: {
        name: 'Mobile route idea',
        thesis: 'Responsive route fixture.',
        state: {
          source: { kind: 'adhoc', positions: [{ assetId: apple!.id, weight: 100 }] },
          range: '1Y',
          benchmark: null,
          mode: 'clip',
          rebalance: 'none',
        },
      },
    }),
    'creating the mobile route idea',
  );

  // Test-integrity assertions: this fixture is intentionally not a fresh/empty
  // account. These API reads fail before the viewport sweep if any seed seam
  // drifts, instead of silently turning the route assertions into empty states.
  const [portfolio, cash, cashSources, tags, webhooks, notifications] = await Promise.all([
    responseJson<{ holdings: Array<{ asset: { id: string } }> }>(
      await api.get(`${API_BASE_URL}/api/v1/portfolios/${portfolioId!}`),
      'checking the populated holding state',
    ),
    responseJson<{ movements: unknown[] }>(
      await api.get(`${API_BASE_URL}/api/v1/portfolios/${portfolioId!}/cash`),
      'checking the populated cash state',
    ),
    responseJson<{ sources: Array<{ name: string }> }>(
      await api.get(`${API_BASE_URL}/api/v1/portfolios/${portfolioId!}/cash/sources`),
      'checking the populated cash-source state',
    ),
    responseJson<{ tags: Array<{ name: string }> }>(
      await api.get(`${API_BASE_URL}/api/v1/cash/tags`),
      'checking the populated tag state',
    ),
    responseJson<{ subscriptions: Array<{ url: string }> }>(
      await api.get(`${API_BASE_URL}/api/v1/settings/webhooks`),
      'checking the populated webhook state',
    ),
    responseJson<{ items: unknown[] }>(
      await api.get(`${API_BASE_URL}/api/v1/notifications`, {
        params: { view: 'active', limit: 50 },
      }),
      'checking the populated notification state',
    ),
  ]);
  expect(portfolio.holdings.some((holding) => holding.asset.id === apple!.id)).toBe(true);
  expect(cash.movements.length).toBeGreaterThanOrEqual(2);
  expect(cashSources.sources.some((source) => source.name === LONG_CASH_SOURCE_NAME)).toBe(true);
  expect(tags.tags.some((tag) => tag.name === LONG_TAG_NAME)).toBe(true);
  expect(webhooks.subscriptions.some((subscription) => subscription.url === LONG_WEBHOOK_URL)).toBe(
    true,
  );
  expect(notifications.items.length).toBeGreaterThan(0);

  return {
    assetId: apple!.id,
    conglomerateId: conglomerate.id,
    friendUsername,
    ideaId: idea.idea.id,
    portfolioId: portfolioId!,
    watchlistId: watchlist.id,
  };
}

function concreteRoute(route: string, fixtures: RouteFixtures): string {
  if (route === '/assets/:id') return `/assets/${fixtures.assetId}`;
  if (route === '/assets/watchlists/:watchlistId') {
    return `/assets/watchlists/${fixtures.watchlistId}`;
  }
  if (route === '/workbench/blueprints/:id') {
    return `/workbench/blueprints/${fixtures.conglomerateId}`;
  }
  if (route === '/workbench/blueprints/:id/edit') {
    return `/workbench/blueprints/${fixtures.conglomerateId}/edit`;
  }
  if (route === '/workbench/ideas/:ideaId') return `/workbench/ideas/${fixtures.ideaId}`;
  return route;
}

interface PopulatedRouteExpectation {
  route: string;
  sentinel: (fixtures: RouteFixtures) => string;
  justification: string;
}

/**
 * The populated-state proof is intentionally tied to the routes where each
 * long/row-shaped fixture should paint. Other routes still run against this
 * same account; these sentinels prevent their key data surfaces from quietly
 * falling back to an empty state.
 */
const POPULATED_ROUTE_EXPECTATIONS: readonly PopulatedRouteExpectation[] = [
  {
    route: '/portfolio',
    sentinel: () => 'AAPL',
    justification: 'The portfolio overview must render the seeded holding.',
  },
  {
    route: '/portfolio',
    sentinel: () => LONG_TRANSACTION_NOTE,
    justification: 'The expanded holding ledger must render the long transaction annotation.',
  },
  {
    route: '/portfolio/cash/movements',
    sentinel: () => LONG_CASH_NOTE,
    justification: 'The cash ledger must render populated movement rows and their long note.',
  },
  {
    route: '/portfolio/cash/labels',
    sentinel: () => LONG_TAG_NAME,
    justification: 'The labels setup surface must render the maximum-length user tag.',
  },
  {
    route: '/portfolio/cash/accounts',
    sentinel: () => LONG_CASH_SOURCE_NAME,
    justification:
      'The cash-source surface must render a second, long-named source and the full transfer form must have two choices.',
  },
  {
    route: '/assets/watchlists/:watchlistId',
    sentinel: () => 'AAPL',
    justification: 'The watchlist detail must render its seeded asset row.',
  },
  {
    route: '/people',
    sentinel: (fixtures) => fixtures.friendUsername,
    justification: 'The people surface must render the accepted long-username friend row.',
  },
  {
    route: '/control/notification-log',
    sentinel: (fixtures) => fixtures.friendUsername,
    justification: 'The notification log must render the real friend-request row.',
  },
  {
    route: '/control/api-keys',
    sentinel: () => LONG_API_KEY_NAME,
    justification: 'The API-key panel must render a populated long-name governance row.',
  },
  {
    route: '/control/webhooks',
    sentinel: () => LONG_WEBHOOK_URL,
    justification: 'The webhook panel must render the deliberately long payload URL.',
  },
];

type OverlayAction =
  | { kind: 'preopened' }
  | { kind: 'keyboard'; shortcut: string }
  | { kind: 'click'; selector: string; position?: 'first' | 'last' }
  | { kind: 'click-sequence'; selectors: readonly string[] };

interface OverlayScenario {
  label: string;
  sources: readonly string[];
  route: string;
  query?: string;
  action: OverlayAction;
  expectedSelector: string;
  sentinel?: (fixtures: RouteFixtures) => string;
  justification: string;
}

interface OverlayExclusion {
  surface: string;
  sources: readonly string[];
  routes: readonly string[];
  justification: string;
}

/**
 * Open-overlay inventory. Each scenario names the source component whose real
 * content it opens; shell menus/popovers, custom dialogs, product-specific
 * sheets, the Home drawer and the nested Control Center confirmation all run
 * in every locale/width profile.
 */
const OVERLAY_SCENARIOS: readonly OverlayScenario[] = [
  {
    label: 'global command dialog',
    sources: ['apps/web/src/user/components/CmdKPalette.tsx'],
    route: '/',
    action: { kind: 'keyboard', shortcut: 'Control+k' },
    expectedSelector: '.bt-palette',
    justification: 'Covers the custom command-palette dialog rather than the shared Dialog shell.',
  },
  {
    label: 'Home widget drawer',
    sources: ['apps/web/src/user/home/AddWidgetDrawer.tsx'],
    route: '/',
    action: {
      kind: 'click-sequence',
      selectors: [
        '#main-content .bt-page-head__actions .bt-btn',
        '#main-content .bt-page-head__actions .bt-btn',
      ],
    },
    expectedSelector: '.bt-drawer',
    justification: 'Covers the fixed Home drawer and its independently scrolling catalog body.',
  },
  {
    label: 'portfolio wizard sheet',
    sources: [
      'apps/web/src/user/portfolio/PortfolioSwitcher.tsx',
      'apps/web/src/user/portfolio/wizard/PortfolioWizard.tsx',
    ],
    route: '/portfolio',
    query: '?create=1',
    action: { kind: 'preopened' },
    expectedSelector: '.bt-dialog__panel',
    justification: 'Covers a query-opened wizard in the shared phone-sheet shell.',
  },
  {
    label: 'new transaction sheet',
    sources: ['apps/web/src/user/components/TransactionDialog.tsx'],
    route: '/portfolio',
    query: '?create=trade',
    action: { kind: 'preopened' },
    expectedSelector: '.bt-dialog__panel',
    justification:
      'Covers the portfolio create flow and its content-specific asset, side, price, fee, cash-source, date and note controls.',
  },
  {
    label: 'record-cash sheet',
    sources: ['apps/web/src/user/portfolio/cashflow/RecordCashDialog.tsx'],
    route: '/portfolio/cash',
    action: { kind: 'click', selector: '#main-content .bt-recordpair__half--in' },
    expectedSelector: '.bt-dialog__panel',
    justification: 'Covers the primary populated money-entry sheet.',
  },
  {
    label: 'cash-budget sheet',
    sources: ['apps/web/src/user/portfolio/cashflow/CashBudgetDialog.tsx'],
    route: '/portfolio/cash/budgets',
    action: { kind: 'click', selector: '[data-testid="cash-budget-create-trigger"]' },
    expectedSelector: '.bt-dialog__panel',
    sentinel: () => LONG_TAG_NAME,
    justification:
      'Covers the budget-specific tag, amount, period and recurrence controls against the maximum-length tag fixture.',
  },
  {
    label: 'standing-order sheet',
    sources: ['apps/web/src/user/forecast/StandingOrderDialog.tsx'],
    route: '/workbench/forecasts',
    action: { kind: 'click', selector: '[data-testid="standing-order-create-trigger"]' },
    expectedSelector: '.bt-dialog__panel',
    justification:
      'Covers the standing-order-specific kind, portfolio, schedule, amount and date controls.',
  },
  {
    label: 'cash-transfer sheet',
    sources: ['apps/web/src/user/portfolio/TransferDialog.tsx'],
    route: '/portfolio/cash/accounts',
    query: '?create=transfer',
    action: { kind: 'preopened' },
    expectedSelector: '.bt-dialog__panel',
    sentinel: () => LONG_CASH_SOURCE_NAME,
    justification:
      'Covers the full two-source transfer form using the deliberately long secondary source name.',
  },
  {
    label: 'price-alert sheet',
    sources: ['apps/web/src/user/components/AlertDialog.tsx'],
    route: '/workbench/alerts',
    action: { kind: 'click', selector: '#main-content .bt-alerts-page .bt-btn--primary' },
    expectedSelector: '.bt-dialog__panel',
    justification: 'Covers a Workbench sheet with an embedded asset picker.',
  },
  {
    label: 'new-chat sheet',
    sources: ['apps/web/src/user/social/chatSurface.tsx'],
    route: '/people/chat',
    action: { kind: 'click', selector: '[data-testid="new-chat-trigger"]' },
    expectedSelector: '.bt-dialog__panel',
    sentinel: (fixtures) => fixtures.friendUsername,
    justification: 'Covers a social sheet populated with the long-username friend.',
  },
  {
    label: 'nested Control Center confirmation',
    sources: [
      'apps/web/src/user/control/ControlCenterOverlay.tsx',
      'apps/web/src/user/control/panels/NotificationLogPanel.tsx',
    ],
    route: '/control/notification-log',
    action: {
      kind: 'click',
      selector: '[data-testid="notification-delete-all-trigger"]',
    },
    expectedSelector: '.bt-dialog__panel',
    justification: 'Covers a Dialog portalled above the already-open Control Center dialog.',
  },
  {
    label: 'global create menu',
    sources: ['apps/web/src/user/components/OriginShell.tsx'],
    route: '/portfolio',
    action: {
      kind: 'click',
      selector: '[data-testid="global-create-trigger"]',
    },
    expectedSelector: '.bt-topbar__actions .bt-popover[role="menu"]',
    justification: 'Covers the persistent create menu at both compact-shell widths.',
  },
  {
    label: 'notification popover',
    sources: ['apps/web/src/user/components/NotificationBell.tsx'],
    route: '/portfolio',
    action: {
      kind: 'click',
      selector: '[data-testid="notification-bell-trigger"]',
    },
    expectedSelector: '#bt-notifications-popover',
    sentinel: (fixtures) => fixtures.friendUsername,
    justification: 'Covers a populated shell popover whose trigger deliberately has no menu role.',
  },
  {
    label: 'account menu',
    sources: ['apps/web/src/user/components/OriginShell.tsx'],
    route: '/portfolio',
    action: { kind: 'click', selector: '[data-testid="topbar-account-trigger"]' },
    expectedSelector: '.bt-topbar__actions .bt-popover[role="menu"]',
    justification: 'Covers the long username/email inside the persistent account menu.',
  },
  {
    label: 'asset watchlist menu',
    sources: ['apps/web/src/user/assets/AssetDetailPage.tsx'],
    route: '/assets/:id',
    action: {
      kind: 'click',
      selector: '#main-content button[aria-haspopup="menu"]',
      position: 'first',
    },
    expectedSelector: '#main-content [role="menu"]',
    justification: 'Covers a content-owned menu rather than only repeated shell chrome.',
  },
];

/**
 * Content/state variants that are deliberately not opened by this matrix.
 *
 * These are component-and-route classifications, not family-level prose: the
 * source-derived check below requires every current user overlay renderer to
 * appear in a measured scenario or here. That keeps a new content-specific
 * dialog/popover from hiding behind an already-measured shared shell.
 */
const OVERLAY_EXCLUSIONS: readonly OverlayExclusion[] = [
  {
    surface: 'AssetSearchBox result action popovers',
    sources: ['apps/web/src/user/components/AssetSearchBox.tsx'],
    routes: [
      '/',
      '/portfolio',
      '/portfolio/analysis',
      '/workbench/forecasts',
      '/workbench/blueprints/new',
      '/workbench/blueprints/:id/edit',
      '/workbench/backtests',
      '/workbench/alerts',
      '/assets/search',
      '/assets/watchlists/:watchlistId',
    ],
    justification:
      'Its watchlist and blueprint menus require an async selected-result state plus destination-specific data; those mutations are owned by search, builder and watchlist e2e flows.',
  },
  {
    surface: 'AudiencePicker share, widening-confirmation and friend-group dialogs',
    sources: ['apps/web/src/user/components/AudiencePicker.tsx'],
    routes: [
      '/workbench',
      '/workbench/blueprints/:id',
      '/workbench/ideas',
      '/assets/watchlists',
      '/people/shared',
    ],
    justification:
      'Each variant requires audience-owned item state and can widen privacy; sharing and audience-confirmation e2e flows own those writes.',
  },
  {
    surface: 'API-key one-time token dialog',
    sources: ['apps/web/src/user/control/panels/ApiKeysPanel.tsx'],
    routes: ['/control/api-keys'],
    justification:
      'Opening it requires creating a credential and acknowledging a non-dismissible plaintext token; bearer-scopes e2e owns that secret lifecycle.',
  },
  {
    surface: 'OAuth-app one-time credentials dialog',
    sources: ['apps/web/src/user/control/panels/OAuthAppsPanel.tsx'],
    routes: ['/control/oauth-apps'],
    justification:
      'Opening it requires registering a client and acknowledging its one-time secret; OAuth e2e owns that credential lifecycle.',
  },
  {
    surface: 'Webhook one-time secret dialog',
    sources: ['apps/web/src/user/control/panels/WebhooksPanel.tsx'],
    routes: ['/control/webhooks'],
    justification:
      'Opening it requires creating a live subscription and acknowledging its non-dismissible secret; webhook e2e owns that lifecycle.',
  },
  {
    surface: 'Home widget action popovers',
    sources: ['apps/web/src/user/home/WidgetFrame.tsx'],
    routes: ['/'],
    justification:
      'Menu contents depend on each configurable widget kind and layout state; the widget-builder e2e flow owns that state matrix.',
  },
  {
    surface: 'VaultSyncChip status dialog',
    sources: ['apps/web/src/user/vault/ui/VaultSyncChip.tsx'],
    routes: ['/'],
    justification:
      'The chip exists only after entering and unlocking paranoid mode with a configured data home; paranoid Drive round-trip e2e owns that state.',
  },
  {
    surface: 'create-vault wizard',
    sources: ['apps/web/src/user/vault/v2/ui/CreateVaultWizard.tsx'],
    routes: ['/portfolio/settings'],
    justification:
      'Its four steps mint twelve recovery words shown exactly once and create a real vault server-side; vault v2 e2e owns that key ceremony.',
  },
  {
    surface: 'move-into-vault dialog',
    sources: ['apps/web/src/user/vault/v2/ui/MoveIntoVaultDialog.tsx'],
    routes: ['/portfolio/settings'],
    justification:
      'It refuses to start without an unlocked target vault and irreversibly purges the portfolio server-side inside the join transaction; vault v2 e2e owns it.',
  },
  {
    surface: 'move-out-of-vault dialog',
    sources: ['apps/web/src/user/vault/v2/ui/MoveOutOfVaultDialog.tsx'],
    routes: ['/portfolio/settings'],
    justification:
      'It requires an already vaulted portfolio and makes it server-readable again under a persisted restore id; vault v2 leave e2e owns that receipt.',
  },
  {
    surface: 'vault QR import dialog',
    sources: ['apps/web/src/user/vault/v2/ui/VaultQrImportDialog.tsx'],
    routes: ['/portfolio/settings'],
    justification:
      'The receiving half of the QR handoff is not mounted by any route yet, and its scan/paste path needs a second device; vault v2 e2e owns it.',
  },
  {
    surface: 'vault QR share dialog',
    sources: ['apps/web/src/user/vault/v2/ui/VaultQrShareDialog.tsx'],
    routes: ['/portfolio/settings'],
    justification:
      'It requires an unlocked vault plus a server-verified account password and the whole handoff expires after 120 seconds; vault v2 e2e owns that window.',
  },
  {
    surface: 'vault unlock dialog',
    sources: ['apps/web/src/user/vault/v2/ui/VaultUnlockDialog.tsx'],
    routes: ['/portfolio/settings'],
    justification:
      'It only appears for a locked vault and takes either the device-wrapped passphrase or the twelve words; vault v2 unlock e2e owns that state.',
  },
  {
    surface: 'portfolio-switcher selection popover',
    sources: ['apps/web/src/user/portfolio/PortfolioSwitcher.tsx'],
    routes: ['/portfolio'],
    justification:
      'The list variant needs multiple portfolios; this matrix measures the same component’s new-portfolio wizard while portfolio lifecycle e2e owns switching state.',
  },
  {
    surface: 'transaction edit and sell variants',
    sources: ['apps/web/src/user/components/TransactionDialog.tsx'],
    routes: ['/portfolio'],
    justification:
      'They require selecting a mutable ledger row and add only held-quantity/delete state to the measured full create form; transaction e2e owns those writes.',
  },
  {
    surface: 'record-cash edit variant and alternate entry points',
    sources: ['apps/web/src/user/portfolio/cashflow/RecordCashDialog.tsx'],
    routes: ['/portfolio/cash/movements'],
    justification:
      'The measured create form is the same component; edit mode requires selecting and potentially mutating a seeded ledger row.',
  },
  {
    surface: 'cash-budget edit variant',
    sources: ['apps/web/src/user/portfolio/cashflow/CashBudgetDialog.tsx'],
    routes: ['/portfolio/cash/budgets'],
    justification:
      'It is the measured create component with its existing tag locked and requires creating a budget row first.',
  },
  {
    surface: 'standing-order edit variant',
    sources: ['apps/web/src/user/forecast/StandingOrderDialog.tsx'],
    routes: ['/workbench/forecasts'],
    justification:
      'It is the measured create component with kind and schedule identity locked and requires creating an order row first.',
  },
  {
    surface: 'asset-detail price-alert entry point',
    sources: ['apps/web/src/user/components/AlertDialog.tsx'],
    routes: ['/assets/:id'],
    justification:
      'It renders the same measured AlertDialog with the asset preselected; alert behavior is covered by the dedicated alert e2e flow.',
  },
  {
    surface: 'chat share-item sheet',
    sources: ['apps/web/src/user/social/chatSurface.tsx'],
    routes: ['/people/chat', '/chat-window'],
    justification:
      'It requires a live conversation and a shareable item; chat e2e owns that state while this matrix measures the same source’s populated new-chat sheet.',
  },
  {
    surface: 'portfolio cash deposit and withdrawal dialog',
    sources: ['apps/web/src/user/portfolio/CashDialog.tsx'],
    routes: ['/portfolio', '/portfolio/cash/accounts'],
    justification:
      'These balance-ledger writes target a selected cash source; cash-flow e2e owns the source and solvency variants.',
  },
  {
    surface: 'cash-source create and rename dialog',
    sources: ['apps/web/src/user/portfolio/CashSourceDialog.tsx'],
    routes: ['/portfolio/cash/accounts'],
    justification:
      'Both variants mutate the source list used by the measured transfer fixture; cash-source e2e owns those lifecycle writes.',
  },
  {
    surface: 'custom-investment create dialog',
    sources: ['apps/web/src/user/portfolio/CustomInvestmentDialog.tsx'],
    routes: ['/portfolio'],
    justification:
      'The form creates an off-market asset and holding; custom-asset e2e owns that compound write and category state.',
  },
  {
    surface: 'MIRRORCHAIN create, convert, invite, member, rename and succession dialogs',
    sources: ['apps/web/src/user/portfolio/MirrorchainPanel.tsx'],
    routes: ['/portfolio', '/portfolio/settings', '/portfolio/cash/accounts'],
    justification:
      'Every variant requires multi-user chain ownership state and can change privacy or membership; mirrorchain lifecycle e2e owns those flows.',
  },
  {
    surface: 'portfolio archive and delete dialogs',
    sources: ['apps/web/src/user/portfolio/PortfolioSettingsPage.tsx'],
    routes: ['/portfolio/settings'],
    justification:
      'Both are destructive lifecycle confirmations against the populated default portfolio; portfolio lifecycle e2e owns them.',
  },
  {
    surface: 'set-cash-balance dialog',
    sources: ['apps/web/src/user/portfolio/SetBalanceDialog.tsx'],
    routes: ['/portfolio/cash/accounts'],
    justification:
      'It writes a reconciliation movement to a selected source; cash-source e2e owns the resulting balance history.',
  },
  {
    surface: 'tax-year unlock dialog',
    sources: ['apps/web/src/user/portfolio/TaxReportPage.tsx'],
    routes: ['/portfolio/tax'],
    justification:
      'It only opens for a year that has locked after year end, and confirming re-authenticates with the account password; tax-lock e2e owns that ritual.',
  },
  {
    surface: 'manual value-point editor',
    sources: ['apps/web/src/user/portfolio/ValuePointEditor.tsx'],
    routes: ['/portfolio'],
    justification:
      'It only appears for an off-market holding, which this market-asset fixture deliberately does not create.',
  },
  {
    surface: 'cash-movement tag editor',
    sources: ['apps/web/src/user/portfolio/cashflow/CashMovementTagsDialog.tsx'],
    routes: ['/portfolio/cash/movements'],
    justification:
      'Opening it selects a concrete ledger row and saving mutates its classifications; cash-flow e2e owns that row state.',
  },
  {
    surface: 'cash auto-categorization rule dialog',
    sources: ['apps/web/src/user/portfolio/cashflow/CashRuleDialog.tsx'],
    routes: ['/portfolio/cash/labels'],
    justification:
      'The form writes a rule tied to an existing tag; cash-rule e2e owns matching and mutation state.',
  },
  {
    surface: 'cash-tag create and edit dialog',
    sources: ['apps/web/src/user/portfolio/cashflow/CashTagDialog.tsx'],
    routes: ['/portfolio/cash/labels'],
    justification:
      'Both variants mutate the maximum-length tag fixture used by the measured budget dialog; cash-tag e2e owns those writes.',
  },
  {
    surface: 'friend-group delete dialog',
    sources: ['apps/web/src/user/social/FriendGroupsSection.tsx'],
    routes: ['/people'],
    justification:
      'The dialog requires a persisted audience group and deletes privacy-bound membership state; social-groups e2e owns it.',
  },
  {
    surface: 'remove-friend dialog',
    sources: ['apps/web/src/user/social/FriendsPage.tsx'],
    routes: ['/people'],
    justification:
      'It would destroy the accepted friend fixture needed by later chat and notification scenarios; friendship e2e owns removal.',
  },
  {
    surface: 'shared-alert confirmation dialog',
    sources: ['apps/web/src/user/social/MySharedItemsPage.tsx'],
    routes: ['/people/shared'],
    justification:
      'It requires a shared item with alert-sharing state and changes notification recipients; sharing e2e owns that mutation.',
  },
  {
    surface: 'blueprint delete dialog',
    sources: ['apps/web/src/user/workboard/ConglomerateDetailPage.tsx'],
    routes: ['/workbench/blueprints/:id'],
    justification:
      'It would delete the seeded blueprint used by the route sweep; blueprint lifecycle e2e owns deletion.',
  },
  {
    surface: 'idea edit dialog',
    sources: ['apps/web/src/user/workboard/IdeaWorkboardPage.tsx'],
    routes: ['/workbench/ideas/:ideaId'],
    justification:
      'It mutates the seeded idea’s name, thesis and state; ideas e2e owns that lifecycle.',
  },
  {
    surface: 'idea delete dialog',
    sources: ['apps/web/src/user/workboard/IdeasListPage.tsx'],
    routes: ['/workbench/ideas'],
    justification:
      'It would delete the seeded idea needed by the detail-route sweep; ideas e2e owns deletion.',
  },
  {
    surface: 'save-as-idea dialog',
    sources: ['apps/web/src/user/workboard/SaveIdeaDialog.tsx'],
    routes: ['/workbench/blueprints/new', '/workbench/blueprints/:id/edit', '/workbench/backtests'],
    justification:
      'It requires a valid 100%-weighted draft or completed backtest result; builder and backtest e2e own those prerequisite states.',
  },
  {
    surface: 'watchlist rename dialog',
    sources: ['apps/web/src/user/workboard/WatchlistsPage.tsx'],
    routes: ['/assets/watchlists'],
    justification:
      'It mutates the seeded non-default watchlist used by the detail-route sweep; watchlist e2e owns rename and delete lifecycle.',
  },
];

const SHELLLESS_AUTH_ROUTES = new Set([
  '/account/delete',
  '/welcome',
  '/workbench/blueprints/new',
  '/workbench/blueprints/:id/edit',
  '/chat-window',
]);

function isControlPanelRoute(route: string): boolean {
  return route === '/control' || (route.startsWith('/control/') && route !== '/control/data');
}

async function settleRoute(page: Page, declaredRoute: string, target: string): Promise<void> {
  await page.goto(target);

  if (isControlPanelRoute(declaredRoute)) {
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 20_000 });
  } else if (
    !ANONYMOUS_CORE_ROUTES.includes(declaredRoute as (typeof ANONYMOUS_CORE_ROUTES)[number]) &&
    !SHELLLESS_AUTH_ROUTES.has(declaredRoute)
  ) {
    await expectUserShellReady(page);
  } else {
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 20_000 });
  }

  await waitForSettledPaint(page);

  const expectedPath = new URL(target, page.url()).pathname;
  expect(
    new URL(page.url()).pathname,
    `${declaredRoute} redirected instead of being measured`,
  ).toBe(expectedPath);
}

/** Measure resolved content rather than initial placeholders or font fallback. */
async function waitForSettledPaint(page: Page): Promise<void> {
  await expect(page.locator('.bt-skeleton')).toHaveCount(0, { timeout: 30_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
    );
  });
}

/**
 * Wait for the measured overlay's entrance motion to reach its final box.
 *
 * Two animation frames settle layout and fonts, but they do not finish the
 * 320ms drawer animation. Measuring that drawer while its `translate` is still
 * active reports the intentionally off-canvas intermediate position as page
 * overflow. Limit the wait to the overlay itself: other page animations may be
 * long-running and are unrelated to the region whose bounds we assert below.
 */
async function waitForSettledOverlay(overlay: Locator): Promise<void> {
  await overlay.evaluate(async (element) => {
    const finiteAnimations = element.getAnimations().filter((animation) => {
      const iterations = animation.effect?.getTiming().iterations;
      return iterations === undefined || Number.isFinite(iterations);
    });
    await Promise.all(
      finiteAnimations.map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function expectPopulatedRouteState(
  page: Page,
  declaredRoute: string,
  fixtures: RouteFixtures,
): Promise<void> {
  if (declaredRoute === '/portfolio') {
    const holdingToggle = page.getByTestId(`holding-transactions-toggle-${fixtures.assetId}`);
    await expect(holdingToggle).toBeVisible({ timeout: 20_000 });
    if ((await holdingToggle.getAttribute('aria-expanded')) !== 'true') await holdingToggle.click();
  }

  for (const expectation of POPULATED_ROUTE_EXPECTATIONS.filter(
    ({ route }) => route === declaredRoute,
  )) {
    await expect(
      page.locator('body'),
      `${declaredRoute} did not paint its populated-state sentinel: ${expectation.justification}`,
    ).toContainText(expectation.sentinel(fixtures), { timeout: 20_000 });
  }
}

const OVERLAY_REGION_SELECTOR = [
  '.bt-cc__panel',
  '.bt-dialog-layer',
  '.bt-dialog',
  '.bt-dialog__panel',
  '.bt-drawer',
  '.bt-palette',
  '.bt-popover',
  '[role="menu"]',
  '[role="listbox"]',
].join(', ');

async function expectNoPageOverflow(
  page: Page,
  declaredRoute: string,
  viewportWidth: number,
  requireOverlay = isControlPanelRoute(declaredRoute),
): Promise<void> {
  const layout = await page.evaluate((configuredViewportWidth) => {
    // window.innerWidth and the configured emulation width can diverge from
    // the document's layout viewport under mobile page scaling. Comparing the
    // root's scrollWidth with its clientWidth is the browser's actual
    // horizontal-scroll test.
    const layoutViewportWidth = document.documentElement.clientWidth;
    const rootStyle = getComputedStyle(document.documentElement);
    const bottomBar = document.querySelector<HTMLElement>('.bt-bottombar');
    const bottomBarStyle = bottomBar ? getComputedStyle(bottomBar) : null;
    const wideContainers = [...document.body.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.scrollWidth > layoutViewportWidth)
      .slice(0, 12)
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${
            element.classList.length > 0 ? `.${[...element.classList].slice(0, 2).join('.')}` : ''
          }`,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowX: style.overflowX,
          minWidth: style.minWidth,
        };
      });
    const suspects = [...document.body.querySelectorAll<HTMLElement>('*')]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${
            element.classList.length > 0 ? `.${[...element.classList].slice(0, 2).join('.')}` : ''
          }`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
        };
      })
      .filter(
        ({ left, right, width }) =>
          width > 0 &&
          left < layoutViewportWidth &&
          (right > layoutViewportWidth || width > layoutViewportWidth),
      )
      .slice(0, 8);

    return {
      scrollWidth: document.documentElement.scrollWidth,
      layoutViewportWidth,
      suspects,
      diagnostics: {
        configuredViewportWidth,
        innerWidth: window.innerWidth,
        visualViewportWidth: window.visualViewport?.width ?? null,
        visualViewportScale: window.visualViewport?.scale ?? null,
        devicePixelRatio: window.devicePixelRatio,
        rootZoom: rootStyle.zoom,
        rootZoomVariable: rootStyle.getPropertyValue('--bt-zoom').trim(),
        bottomBar: bottomBarStyle
          ? {
              width: bottomBarStyle.width,
              maxWidth: bottomBarStyle.maxWidth,
              gridAutoColumns: bottomBarStyle.gridAutoColumns,
            }
          : null,
        wideContainers,
      },
    };
  }, viewportWidth);

  expect(
    layout.scrollWidth,
    `${declaredRoute} scrolls horizontally (${layout.scrollWidth}px > ${layout.layoutViewportWidth}px layout viewport; ${viewportWidth}px configured). Suspects: ${JSON.stringify(layout.suspects)}. Diagnostics: ${JSON.stringify(layout.diagnostics)}`,
  ).toBeLessThanOrEqual(layout.layoutViewportWidth);

  // Fixed/portalled overlays can be clipped by the viewport without increasing
  // document.scrollWidth. Measure every visible panel/menu plus its horizontal
  // content scrollers against its OWN clientWidth. This is what catches an
  // unwrapped 600px child inside a 390px dialog.
  const overlayLayout = await page.locator(OVERLAY_REGION_SELECTOR).evaluateAll((elements) => {
    const visible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const describe = (element: HTMLElement) => {
      const role = element.getAttribute('role');
      const label = element.getAttribute('aria-label');
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${
        role ? `[role=${role}]` : ''
      }${label ? `[aria-label=${label.slice(0, 40)}]` : ''}${
        element.classList.length > 0 ? `.${[...element.classList].slice(0, 2).join('.')}` : ''
      }`;
    };
    const measure = (element: HTMLElement, suffix = '', childScroller = false) => {
      const rect = element.getBoundingClientRect();
      return {
        region: `${describe(element)}${suffix}`,
        classNames: [...element.classList],
        childScroller,
        clientWidth: element.clientWidth,
        left: rect.left,
        renderedWidth: rect.width,
        right: rect.right,
        scrollWidth: element.scrollWidth,
      };
    };

    return elements.flatMap((candidate) => {
      const element = candidate as HTMLElement;
      if (!visible(element)) return [];
      const childScrollers = [
        ...element.querySelectorAll<HTMLElement>(
          '.bt-cc__content, .bt-dialog__body, .bt-drawer__body, .bt-palette__body',
        ),
      ].filter(visible);
      return [
        measure(element),
        ...childScrollers.map((child, index) =>
          measure(child, ` child-scroller-${index + 1}`, true),
        ),
      ];
    });
  });

  if (requireOverlay) {
    expect(
      overlayLayout.length,
      `${declaredRoute} was expected to render an open overlay region`,
    ).toBeGreaterThan(0);
  }
  if (isControlPanelRoute(declaredRoute)) {
    expect(
      overlayLayout.some(
        ({ childScroller, classNames }) => childScroller && classNames.includes('bt-cc__content'),
      ),
      `${declaredRoute} must expose the Control Center content scroller to the overflow measurement`,
    ).toBe(true);
  }

  for (const measurement of overlayLayout) {
    expect(
      measurement.scrollWidth,
      `${declaredRoute} ${measurement.region} scrolls internally (${measurement.scrollWidth}px > ${measurement.clientWidth}px)`,
    ).toBeLessThanOrEqual(measurement.clientWidth);
    expect(
      measurement.renderedWidth,
      `${declaredRoute} ${measurement.region} is wider than the ${layout.layoutViewportWidth}px layout viewport (${viewportWidth}px configured)`,
    ).toBeLessThanOrEqual(layout.layoutViewportWidth + 0.5);
    expect(
      measurement.left,
      `${declaredRoute} ${measurement.region} extends left of the viewport`,
    ).toBeGreaterThanOrEqual(-0.5);
    expect(
      measurement.right,
      `${declaredRoute} ${measurement.region} extends right of the ${layout.layoutViewportWidth}px layout viewport (${viewportWidth}px configured)`,
    ).toBeLessThanOrEqual(layout.layoutViewportWidth + 0.5);
  }
}

async function setStoredLocale(page: Page, locale: GateLocale): Promise<void> {
  if (!page.url().startsWith('http')) await page.goto('/login');
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: LOCALE_STORAGE_KEY,
    value: locale,
  });
}

async function setAuthenticatedLocale(
  api: APIRequestContext,
  page: Page,
  locale: GateLocale,
): Promise<void> {
  await responseJson<Record<string, unknown>>(
    await api.patch(`${API_BASE_URL}/api/v1/settings/account`, {
      headers: { 'X-Requested-With': 'BetterTrack' },
      data: { locale },
    }),
    `setting the populated account locale to ${locale}`,
  );
  // LocaleSync treats the account setting as authoritative after sign-in. Keep
  // local storage aligned as well, then reload so both I18nProvider and /me
  // start this matrix profile in the requested language.
  await setStoredLocale(page, locale);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', locale, { timeout: 20_000 });
}

async function exerciseOverlayScenario(
  page: Page,
  scenario: OverlayScenario,
  fixtures: RouteFixtures,
  viewportWidth: number,
): Promise<void> {
  const target = `${concreteRoute(scenario.route, fixtures)}${scenario.query ?? ''}`;
  await settleRoute(page, scenario.route, target);

  if (scenario.action.kind === 'keyboard') {
    await page.keyboard.press(scenario.action.shortcut);
  } else if (scenario.action.kind === 'click') {
    const matches = page.locator(scenario.action.selector);
    const trigger = scenario.action.position === 'last' ? matches.last() : matches.first();
    await expect(
      trigger,
      `${scenario.label} trigger not found: ${scenario.action.selector}`,
    ).toBeVisible({ timeout: 20_000 });
    await trigger.click();
  } else if (scenario.action.kind === 'click-sequence') {
    for (const selector of scenario.action.selectors) {
      const trigger = page.locator(selector).first();
      await expect(trigger, `${scenario.label} trigger not found: ${selector}`).toBeVisible({
        timeout: 20_000,
      });
      await trigger.click();
    }
  }

  const overlay = page.locator(scenario.expectedSelector).last();
  await expect(overlay, `${scenario.label} did not open`).toBeVisible({ timeout: 20_000 });
  if (scenario.sentinel) {
    await expect(
      overlay,
      `${scenario.label} did not render its populated-state sentinel`,
    ).toContainText(scenario.sentinel(fixtures), { timeout: 20_000 });
  }
  await waitForSettledOverlay(overlay);
  await waitForSettledPaint(page);
  await expectNoPageOverflow(page, `${scenario.route} — ${scenario.label}`, viewportWidth, true);
  await page.keyboard.press('Escape');
  await expect(overlay, `${scenario.label} did not close with Escape`).toBeHidden({
    timeout: 10_000,
  });
}

test('mobile route inventory classifies every UserApp destination', () => {
  assertCompleteRouteInventory();
});

for (const profile of VIEWPORT_PROFILES) {
  test.describe(profile.label, () => {
    test.use({
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
      hasTouch: true,
      isMobile: true,
    });

    test('mobile overflow gate fits every core route and open overlay', async ({
      browser,
      context,
    }) => {
      test.setTimeout(900_000);

      const anonymousPage = await context.newPage();
      expect(anonymousPage.viewportSize()).toEqual(profile.viewport);
      await setStoredLocale(anonymousPage, profile.locale);
      for (const route of ANONYMOUS_CORE_ROUTES) {
        await test.step(`anonymous ${route}`, async () => {
          await settleRoute(anonymousPage, route, route);
          expect(await anonymousPage.locator('html').getAttribute('lang')).toBe(profile.locale);
          await expectNoPageOverflow(anonymousPage, route, profile.viewport.width);
        });
      }
      // Invite acceptance uses stable English accessible names. Restore EN for
      // provisioning, then switch the authenticated app to this profile below.
      await setStoredLocale(anonymousPage, 'en');
      await anonymousPage.close();

      const apiRequest = await newAdminRequestContext(newRequestContext);
      const owner = await provisionUserInContext(
        context,
        apiRequest,
        'mobile-overflow-populated-account-with-long-username',
      );
      const friend = await provisionUser(
        browser,
        apiRequest,
        'mobile-overflow-notification-sender-with-long-username',
      );
      expect(owner.username).toHaveLength(40);
      expect(friend.username).toHaveLength(40);
      const fixtures = await createRouteFixtures(
        owner.context.request,
        friend.context.request,
        owner.username,
        friend.username,
      );
      await friend.context.close();
      await apiRequest.dispose();
      await setAuthenticatedLocale(owner.context.request, owner.page, profile.locale);

      const populatedRoutes = [...AUTHENTICATED_CORE_ROUTES, ...CONTROL_CORE_ROUTES];
      for (const [routeIndex, route] of populatedRoutes.entries()) {
        if (routeIndex > 0 && routeIndex % ROUTE_PAGE_BATCH_SIZE === 0) {
          await owner.page.close();
          owner.page = await owner.context.newPage();
        }
        await test.step(`populated ${route}`, async () => {
          const target = concreteRoute(route, fixtures);
          await settleRoute(owner.page, route, target);
          expect(await owner.page.locator('html').getAttribute('lang')).toBe(profile.locale);
          await expectPopulatedRouteState(owner.page, route, fixtures);
          await expectNoPageOverflow(owner.page, route, profile.viewport.width);
        });
      }

      await owner.page.close();
      owner.page = await owner.context.newPage();
      for (const scenario of OVERLAY_SCENARIOS) {
        await test.step(`open overlay: ${scenario.label}`, async () => {
          await exerciseOverlayScenario(owner.page, scenario, fixtures, profile.viewport.width);
        });
      }
    });
  });
}
