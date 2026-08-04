import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  expect,
  request as newRequestContext,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import ts from 'typescript';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { expectUserShellReady } from './support/flows';
import { provisionUserInContext } from './support/users';

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
});

const VIEWPORT_WIDTH = 390;
const USER_APP_SOURCE = 'apps/web/src/user/UserApp.tsx';
const CONTROL_CENTER_SOURCE = 'apps/web/src/user/control/ControlCenterOverlay.tsx';

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
  '/assets/custom-assets',
  '/assets/news',
  '/assets/discover',
  '/assets/events',
  '/assets/screener',
  '/assets/:id',
  '/people',
  '/people/chat',
  '/people/shared',
  '/people/teams',
  '/people/approvals',
  '/ask',
  '/review',
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
  '/control/profile',
  '/control/sign-in',
  '/control/sessions',
  '/control/defaults',
  '/control/notifications',
  '/control/notification-log',
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
  '/people/following',
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
    ts.ScriptKind.TSX,
  );
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

/** Discover every canonical and legacy Control Center URL from its registries. */
function registeredControlRoutes(): string[] {
  const sourceFile = parseTsx(CONTROL_CENTER_SOURCE);
  let groups: ts.Expression | undefined;
  let aliases: ts.Expression | undefined;

  const findRegistries = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'CONTROL_GROUPS') groups = node.initializer;
      if (node.name.text === 'PANEL_ALIASES') aliases = node.initializer;
    }
    if (!groups || !aliases) ts.forEachChild(node, findRegistries);
  };
  findRegistries(sourceFile);

  const ids: string[] = [];
  const findIds = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sourceFile) === 'id' &&
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
    'New UserApp routes must be covered at 390px or explicitly excluded with a justification.',
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
}

interface RouteFixtures {
  assetId: string;
  conglomerateId: string;
  ideaId: string;
}

async function responseJson<T>(response: APIResponse, context: string): Promise<T> {
  const text = await response.text();
  expect(response.ok(), `${context}: ${response.status()} ${text}`).toBeTruthy();
  return JSON.parse(text) as T;
}

async function createRouteFixtures(api: APIRequestContext): Promise<RouteFixtures> {
  const search = await responseJson<{ results: Array<{ id: string; symbol: string }> }>(
    await api.get(`${API_BASE_URL}/api/v1/search`, { params: { q: 'Apple' } }),
    'searching for the mobile route asset',
  );
  const apple = search.results.find((result) => result.symbol === 'AAPL');
  expect(apple, 'The seeded catalog must contain AAPL.').toBeTruthy();

  const headers = { 'X-Requested-With': 'BetterTrack' };
  const conglomerate = await responseJson<{ id: string }>(
    await api.post(`${API_BASE_URL}/api/v1/conglomerates`, {
      headers,
      data: { name: `Mobile route basket ${Date.now().toString(36)}` },
    }),
    'creating the mobile route conglomerate',
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

  return { assetId: apple!.id, conglomerateId: conglomerate.id, ideaId: idea.idea.id };
}

function concreteRoute(route: string, fixtures: RouteFixtures): string {
  if (route === '/assets/:id') return `/assets/${fixtures.assetId}`;
  if (route === '/workbench/blueprints/:id') {
    return `/workbench/blueprints/${fixtures.conglomerateId}`;
  }
  if (route === '/workbench/blueprints/:id/edit') {
    return `/workbench/blueprints/${fixtures.conglomerateId}/edit`;
  }
  if (route === '/workbench/ideas/:ideaId') return `/workbench/ideas/${fixtures.ideaId}`;
  return route;
}

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

  // Measure the resolved page rather than its initial placeholders. Fonts and
  // two paint frames close the remaining layout gap without a timing sleep.
  await expect(page.locator('.bt-skeleton')).toHaveCount(0, { timeout: 30_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
    );
  });

  expect(
    new URL(page.url()).pathname,
    `${declaredRoute} redirected instead of being measured`,
  ).toBe(target);
}

async function expectNoPageOverflow(page: Page, declaredRoute: string): Promise<void> {
  const layout = await page.evaluate((viewportWidth) => {
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
          width > 0 && left < viewportWidth && (right > viewportWidth || width > viewportWidth),
      )
      .slice(0, 8);

    return {
      scrollWidth: document.documentElement.scrollWidth,
      suspects,
    };
  }, VIEWPORT_WIDTH);

  expect(
    layout.scrollWidth,
    `${declaredRoute} scrolls horizontally (${layout.scrollWidth}px > ${VIEWPORT_WIDTH}px). Suspects: ${JSON.stringify(layout.suspects)}`,
  ).toBeLessThanOrEqual(VIEWPORT_WIDTH);

  if (!isControlPanelRoute(declaredRoute)) return;

  // The Control Center is fixed over Home, so its clipped overflow cannot
  // increase the document scrollWidth. Measure both the popup and its own
  // scroller so a wide panel child still turns this gate red.
  const controlLayout = await page.locator('.bt-cc__panel').evaluate((panel) => {
    const content = panel.querySelector<HTMLElement>('.bt-cc__content');
    if (content === null) return null;

    const measure = (element: HTMLElement) => ({
      clientWidth: element.clientWidth,
      renderedWidth: element.getBoundingClientRect().width,
      scrollWidth: element.scrollWidth,
    });

    return { content: measure(content), panel: measure(panel as HTMLElement) };
  });

  expect(controlLayout, `${declaredRoute} did not render the Control Center layout`).not.toBeNull();
  if (controlLayout === null) return;

  for (const [region, measurement] of Object.entries(controlLayout)) {
    expect(
      measurement.scrollWidth,
      `${declaredRoute} ${region} scrolls horizontally (${measurement.scrollWidth}px > ${measurement.clientWidth}px)`,
    ).toBeLessThanOrEqual(measurement.clientWidth);
    expect(
      measurement.renderedWidth,
      `${declaredRoute} ${region} is wider than the ${VIEWPORT_WIDTH}px viewport`,
    ).toBeLessThanOrEqual(VIEWPORT_WIDTH);
  }
}

test('mobile route inventory classifies every UserApp destination', () => {
  assertCompleteRouteInventory();
});

test('mobile overflow gate fits every core route', async ({ context }) => {
  test.setTimeout(600_000);

  const anonymousPage = await context.newPage();
  expect(anonymousPage.viewportSize()).toEqual({ width: VIEWPORT_WIDTH, height: 844 });
  for (const route of ANONYMOUS_CORE_ROUTES) {
    await test.step(route, async () => {
      await settleRoute(anonymousPage, route, route);
      await expectNoPageOverflow(anonymousPage, route);
    });
  }
  await anonymousPage.close();

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUserInContext(context, apiRequest, 'mobile-routes');
  await apiRequest.dispose();
  const fixtures = await createRouteFixtures(owner.context.request);

  for (const route of [...AUTHENTICATED_CORE_ROUTES, ...CONTROL_CORE_ROUTES]) {
    await test.step(route, async () => {
      const target = concreteRoute(route, fixtures);
      await settleRoute(owner.page, route, target);
      await expectNoPageOverflow(owner.page, route);
    });
  }
});
