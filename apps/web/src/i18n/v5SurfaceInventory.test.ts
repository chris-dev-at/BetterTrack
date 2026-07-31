/**
 * Completeness here is derived, not asserted.
 *
 * The suite enumerates the universe itself — every non-test `.tsx` module under
 * `src/user/`, `src/admin/` and `src/ui/` read from disk, and every path in the
 * two `<Route>` registries parsed out of their TSX — and then requires each one
 * to be classified: inventoried as a V5 surface, or exempted with a reason in
 * `v5SurfaceInventory.ts`. A module or route nobody remembered is a named
 * failure rather than a silent gap, which is what a second hand-written list
 * could never deliver. The predicate deciding which side a module falls on is
 * written down in that file's header.
 *
 * EXPECTED_V5_COMPONENTS / EXPECTED_V5_ROUTES below are no longer the
 * completeness device; they survive only as anti-shrinkage baselines, so that
 * deleting a reviewed row fails loudly instead of quietly narrowing the audit.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { LOCALES, localizedMessage, type MessageNode } from './registry';
import {
  LEGACY_LITERAL_COPY,
  NON_SURFACE_ROUTE_ELEMENTS,
  NON_V5_ROUTES,
  NON_V5_SURFACES,
  SURFACE_UNIVERSE_ROOTS,
  V5_SURFACE_INVENTORY,
} from './v5SurfaceInventory';

const SRC_ROOT = resolve(process.cwd(), 'src');

/** The two route registries, with the base path each one is mounted at. */
const ROUTE_REGISTRIES = [
  { path: 'user/UserApp.tsx', base: '' },
  { path: 'admin/AdminApp.tsx', base: '/admin' },
] as const;

function baseline(value: string): string[] {
  return value.trim().split('\n').sort();
}

/**
 * Anti-shrinkage baseline for the reviewed component set. This is deliberately
 * NOT the completeness check — that is `classifies every user-facing module`
 * below, which reads the universe off disk. Keeping this list separate means
 * dropping a row from the inventory fails here as well.
 */
const EXPECTED_V5_COMPONENTS = baseline(`
admin/AdminApp.tsx
admin/components/AdminLayout.tsx
admin/pages/AccountDefaultsPage.tsx
admin/pages/AiSettingsPage.tsx
admin/pages/ApiKeysPage.tsx
admin/pages/FeatureFlagsPage.tsx
admin/pages/HealthPage.tsx
admin/pages/MonitoringPage.tsx
admin/pages/OAuthAppsPage.tsx
admin/pages/ProblemsPage.tsx
admin/pages/SecuritySettingsPage.tsx
admin/pages/UsageAnalyticsPage.tsx
ui/MoneyText.tsx
ui/ScopePicker.tsx
ui/MarketStateBadge.tsx
ui/charts/AllocationDonut.tsx
ui/charts/PriceChart.tsx
user/AuthContext.tsx
user/UserApp.tsx
user/assets/AssetDetailPage.tsx
user/assets/AssetsSection.tsx
user/assets/NewsDigestPage.tsx
user/assets/capabilityTags.tsx
user/assets/newsFeed.tsx
user/auth/LoginPage.tsx
user/auth/RegisterPage.tsx
user/components/AssetSearchBox.tsx
user/components/AudiencePicker.tsx
user/components/Avatar.tsx
user/components/CmdKPalette.tsx
user/components/NotificationBell.tsx
user/components/OriginShell.tsx
user/components/TransactionDialog.tsx
user/components/profileIcons.tsx
user/control/ControlCenterOverlay.tsx
user/control/panels/AccountPanel.tsx
user/control/panels/ApiKeysPanel.tsx
user/control/panels/AuthorizedAppsPanel.tsx
user/control/panels/ConnectionsPanel.tsx
user/control/panels/DefaultsPanel.tsx
user/control/panels/NotificationLogPanel.tsx
user/control/panels/NotificationsPanel.tsx
user/control/panels/OAuthAppsPanel.tsx
user/control/panels/PrivacyPanel.tsx
user/control/panels/ProfilePanel.tsx
user/control/panels/SignInPanel.tsx
user/control/panels/WebhooksPanel.tsx
user/control/panels/taxModeList.tsx
user/expenses/BudgetDialog.tsx
user/expenses/BudgetsPage.tsx
user/expenses/CategoriesPage.tsx
user/expenses/CategoryDialog.tsx
user/expenses/DashboardPage.tsx
user/expenses/ImportPage.tsx
user/expenses/RuleDialog.tsx
user/expenses/RulesPage.tsx
user/expenses/TransactionDialog.tsx
user/expenses/TransactionsPage.tsx
user/forecast/ForecastPage.tsx
user/forecast/ProjectionSection.tsx
user/forecast/StandingOrderDialog.tsx
user/forecast/StandingOrdersSection.tsx
user/home/HomePage.tsx
user/oauth/ConsentPage.tsx
user/parked/ParkedPage.tsx
user/portfolio/CashDialog.tsx
user/portfolio/CashSourceDialog.tsx
user/portfolio/CashSourcesPage.tsx
user/portfolio/CustomInvestmentDialog.tsx
user/portfolio/ImportPage.tsx
user/portfolio/MirrorchainPanel.tsx
user/portfolio/PortfolioPage.tsx
user/portfolio/PortfolioSection.tsx
user/portfolio/PortfolioSettingsPage.tsx
user/portfolio/PortfolioStoreProvider.tsx
user/portfolio/PortfolioSwitcher.tsx
user/portfolio/PortfolioTaxSection.tsx
user/portfolio/PortfolioWorkspace.tsx
user/portfolio/SetBalanceDialog.tsx
user/portfolio/SourceBadge.tsx
user/portfolio/TaxReportPage.tsx
user/portfolio/TaxReportPrintPage.tsx
user/portfolio/TransferDialog.tsx
user/portfolio/ValuePointEditor.tsx
user/portfolio/analytics/AiInsightsPanel.tsx
user/portfolio/analytics/AnalyticsPage.tsx
user/portfolio/analytics/CompareControl.tsx
user/portfolio/analytics/ContributionTable.tsx
user/portfolio/wizard/PortfolioWizard.tsx
user/settings/taxModePicker.tsx
user/social/ChatPage.tsx
user/social/CommentThread.tsx
user/social/FriendGroupsSection.tsx
user/social/FriendsPage.tsx
user/social/MySharedItemsPage.tsx
user/social/PublicProfileViewPage.tsx
user/social/PublicSharePage.tsx
user/social/SharedConglomeratePage.tsx
user/social/SharedIdeaPage.tsx
user/social/SharedPortfolioPage.tsx
user/social/SharedWatchlistPage.tsx
user/social/chatSurface.tsx
user/vault/VaultRuntimeProvider.tsx
user/vault/engine/VaultMoneyEngineProvider.tsx
user/vault/ui/ParanoidEnableWizard.tsx
user/vault/ui/ParanoidSurfaceGate.tsx
user/vault/ui/VaultSyncChip.tsx
user/vault/ui/VaultUnlockGate.tsx
user/workboard/BudgetCalculator.tsx
user/workboard/ComparisonPage.tsx
user/workboard/ConglomerateBuilderPage.tsx
user/workboard/ConglomerateDetailPage.tsx
user/workboard/ConglomeratesListPage.tsx
user/workboard/IdeaWorkboardPage.tsx
user/workboard/IdeasListPage.tsx
user/workboard/NlBuilderPanel.tsx
user/workboard/WatchlistsPage.tsx
user/workboard/WorkboardPage.tsx
user/workboard/WorkboardSection.tsx
`);

const EXPECTED_V5_ROUTES = baseline(`
/
/admin/account-defaults
/admin/ai
/admin/api-keys
/admin/feature-flags
/admin/health
/admin/monitoring
/admin/oauth-apps
/admin/problems
/admin/security
/admin/usage-analytics
/assets/:id
/assets/custom-assets
/assets/news
/assets/watchlists
/control/:panel?
/control/account
/control/api
/control/authorized-apps
/control/connections
/control/defaults
/control/notification-log
/control/notifications
/control/oauth-apps
/control/privacy
/control/profile
/control/webhooks
/login
/oauth/authorize
/people
/people/chat
/people/shared
/people/shared/:portfolioId
/people/shared/conglomerates/:id
/people/shared/ideas/:ideaId
/people/shared/watchlists/:watchlistId
/portfolio
/portfolio/activity
/portfolio/analysis
/portfolio/cash-flow
/portfolio/cash-flow/accounts
/portfolio/cash-flow/budgets
/portfolio/cash-flow/categories
/portfolio/cash-flow/import
/portfolio/cash-flow/rules
/portfolio/cash-flow/transactions
/portfolio/import
/portfolio/settings
/portfolio/tax
/portfolio/tax/print
/register
/s/:token
/u/:username
/workbench
/workbench/blueprints
/workbench/blueprints/:id
/workbench/blueprints/:id/edit
/workbench/blueprints/new
/workbench/calculators
/workbench/compare
/workbench/forecasts
/workbench/ideas
/workbench/ideas/:ideaId
`);

const EXPECTED_V5_PHASES = [
  'P0',
  'P0b',
  'P0c',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P6b',
  'P7',
  'P8',
  'P9',
  'P10',
  'P12',
  'P13',
  'P13c',
].sort();

/**
 * The Control Center is one route (`/control/:panel?`) whose panels are
 * addressable deep links; the inventory names the panels, the registry names
 * the parameterized route.
 */
const CONTROL_PANEL_ROUTE = '/control/:panel?';
const CONTROL_PANEL_DEEP_LINK = /^\/control\/[a-z-]+$/;

function messageNode(root: MessageNode, path: string): string | MessageNode | undefined {
  let value: string | MessageNode | undefined = root;
  for (const segment of path.split('.')) {
    if (!value || typeof value === 'string') return undefined;
    value = value[segment];
  }
  return value;
}

function flattenStrings(
  node: string | MessageNode,
  prefix: string,
  output: Array<[string, string]> = [],
): Array<[string, string]> {
  if (typeof node === 'string') {
    output.push([prefix, node]);
    return output;
  }
  for (const [key, value] of Object.entries(node)) {
    flattenStrings(value, `${prefix}.${key}`, output);
  }
  return output;
}

/** Every non-test TSX module under the universe roots, as `src`-relative paths. */
function universeModules(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
        found.push(relative(SRC_ROOT, absolute).split(sep).join('/'));
      }
    }
  };
  for (const root of SURFACE_UNIVERSE_ROOTS) walk(resolve(SRC_ROOT, root));
  return found.sort();
}

function parseTsx(relativePath: string): ts.SourceFile {
  const absolutePath = resolve(SRC_ROOT, relativePath);
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

const USER_FACING_ATTRIBUTES = new Set([
  'alt',
  'aria-label',
  'ariaLabel',
  'description',
  'label',
  'placeholder',
  'subtitle',
  'title',
]);
const ALLOWED_TECHNICAL_VALUES = new Set(['http://localhost:11434', 'llama3.1:8b']);

/** Literal user-facing strings rendered by a TSX module, as `path:line "text"`. */
function literalCopy(relativePath: string): string[] {
  const sourceFile = parseTsx(relativePath);
  const findings: string[] = [];

  const record = (node: ts.Node, value: string) => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (
      !/[A-Za-zÄÖÜäöüß]{2}/.test(normalized) ||
      /^&[a-z]+;$/.test(normalized) ||
      ALLOWED_TECHNICAL_VALUES.has(normalized)
    ) {
      return;
    }
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    findings.push(`${relativePath}:${line} ${JSON.stringify(normalized)}`);
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) record(node, node.getText(sourceFile));
    if (
      ts.isJsxAttribute(node) &&
      USER_FACING_ATTRIBUTES.has(node.name.getText(sourceFile)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      record(node, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

interface RegisteredRoute {
  path: string;
  element: string | null;
  source: string;
  line: number;
}

/**
 * Resolves the full path of every `<Route>` in a registry by accumulating
 * parent segments, and records the component each one renders. Layout routes
 * (no `path`) contribute nothing of their own; `index` routes take the parent's
 * path, which is how `/portfolio` and `/assets` are registered.
 */
function registeredRoutes(relativePath: string, base: string): RegisteredRoute[] {
  const sourceFile = parseTsx(relativePath);
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

  const renderedComponent = (opening: ts.JsxOpeningLikeElement): string | null => {
    const element = attribute(opening, 'element');
    if (!element?.initializer || !ts.isJsxExpression(element.initializer)) return null;
    const expression = element.initializer.expression;
    if (!expression) return null;
    let name: string | null = null;
    const find = (node: ts.Node) => {
      if (name) return;
      const opened = openingOf(node);
      if (opened) {
        name = opened.tagName.getText(sourceFile);
        return;
      }
      ts.forEachChild(node, find);
    };
    find(expression);
    return name;
  };

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
        routes.push({
          path: childPrefix,
          element: renderedComponent(opening),
          source: relativePath,
          line,
        });
      } else if (attribute(opening, 'index')) {
        routes.push({
          path: prefix || '/',
          element: renderedComponent(opening),
          source: relativePath,
          line,
        });
      }
    }
    ts.forEachChild(node, (child) => visit(child, childPrefix));
  };

  visit(sourceFile, base);
  return routes;
}

describe('V5-P14 surface traceability inventory', () => {
  test('classifies every user-facing module as a V5 surface or a reasoned exemption', () => {
    const universe = universeModules();
    const inventoried = new Set<string>(
      V5_SURFACE_INVENTORY.flatMap((surface) => surface.components),
    );
    const exempt = new Set<string>(NON_V5_SURFACES.map((exemption) => exemption.path));

    // The universe is big enough that an empty walk would pass everything.
    expect(universe.length).toBeGreaterThan(150);
    expect(NON_V5_SURFACES).toHaveLength(exempt.size);

    const unclassified = universe.filter((path) => !inventoried.has(path) && !exempt.has(path));
    expect(
      unclassified,
      `Unclassified user-facing modules. Apply the predicate in v5SurfaceInventory.ts: add each to V5_SURFACE_INVENTORY, or to NON_V5_SURFACES with its reason.\n${unclassified.join('\n')}`,
    ).toEqual([]);

    const bothSides = universe.filter((path) => inventoried.has(path) && exempt.has(path));
    expect(
      bothSides,
      `Classified as both a V5 surface and an exemption:\n${bothSides.join('\n')}`,
    ).toEqual([]);

    const onDisk = new Set(universe);
    const stale = [...inventoried, ...exempt].filter((path) => !onDisk.has(path)).sort();
    expect(stale, `Classified but no longer on disk:\n${stale.join('\n')}`).toEqual([]);

    const unreasoned = NON_V5_SURFACES.filter((exemption) => exemption.note.trim().length === 0);
    expect(unreasoned, 'Every exemption must carry a reason.').toEqual([]);
  });

  test('proves every no-user-copy exemption renders no copy of its own', () => {
    const offenders: string[] = [];
    for (const exemption of NON_V5_SURFACES) {
      if (exemption.reason !== 'no-user-copy') continue;
      const source = readFileSync(resolve(SRC_ROOT, exemption.path), 'utf8');
      if (/\buseT\b|\buseI18n\b|\blocalizedMessage\b/.test(source)) {
        offenders.push(`${exemption.path} resolves translations, so it does render copy`);
      }
      offenders.push(...literalCopy(exemption.path));
    }
    expect(
      offenders,
      `no-user-copy exemptions that do render copy:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  test('classifies every registered route as a V5 route or a reasoned exemption', () => {
    const registered = ROUTE_REGISTRIES.flatMap((registry) =>
      registeredRoutes(registry.path, registry.base),
    );
    // Guards against a parser change silently reducing the registry to nothing.
    expect(registered.length).toBeGreaterThan(100);

    const inventoried = new Set<string>(V5_SURFACE_INVENTORY.flatMap((surface) => surface.routes));
    const exempt = new Set<string>(NON_V5_ROUTES.map((exemption) => exemption.path));
    expect(NON_V5_ROUTES).toHaveLength(exempt.size);

    const unclassified = [
      ...new Set(
        registered
          .filter(
            (route) => !(route.element && Object.hasOwn(NON_SURFACE_ROUTE_ELEMENTS, route.element)),
          )
          .filter((route) => !inventoried.has(route.path) && !exempt.has(route.path))
          .map((route) => `${route.source}:${route.line} ${route.path}`),
      ),
    ].sort();
    expect(
      unclassified,
      `Registered routes that are in neither the inventory nor NON_V5_ROUTES:\n${unclassified.join('\n')}`,
    ).toEqual([]);

    const registeredPaths = new Set(registered.map((route) => route.path));
    const staleExemptions = NON_V5_ROUTES.map((exemption) => exemption.path)
      .filter((path) => !registeredPaths.has(path))
      .sort();
    expect(
      staleExemptions,
      `Exempted routes that are no longer registered:\n${staleExemptions.join('\n')}`,
    ).toEqual([]);

    const unregistered = [...inventoried]
      .filter(
        (path) =>
          !registeredPaths.has(path) &&
          !(registeredPaths.has(CONTROL_PANEL_ROUTE) && CONTROL_PANEL_DEEP_LINK.test(path)),
      )
      .sort();
    expect(
      unregistered,
      `Inventoried routes that no registry declares (a removed surface?):\n${unregistered.join('\n')}`,
    ).toEqual([]);
  });

  test('locks every V5 phase, route, and component into the reviewed inventory', () => {
    const components = V5_SURFACE_INVENTORY.flatMap((surface) => surface.components);
    const routes = [...new Set(V5_SURFACE_INVENTORY.flatMap((surface) => surface.routes))].sort();
    const phases = [...new Set(V5_SURFACE_INVENTORY.flatMap((surface) => surface.phases))].sort();

    expect(components).toHaveLength(new Set(components).size);
    expect([...components].sort()).toEqual(EXPECTED_V5_COMPONENTS);
    expect(routes).toEqual(EXPECTED_V5_ROUTES);
    expect(phases).toEqual(EXPECTED_V5_PHASES);
  });

  test('keeps every reviewed component, test, catalog root, and state outcome concrete', () => {
    for (const surface of V5_SURFACE_INVENTORY) {
      expect(surface.copyReview, `${surface.id}: copy review`).not.toHaveLength(0);

      for (const relativePath of [...surface.components, ...surface.tests]) {
        expect(existsSync(resolve(SRC_ROOT, relativePath)), `${surface.id}: ${relativePath}`).toBe(
          true,
        );
      }

      for (const root of surface.copyRoots) {
        for (const locale of Object.values(LOCALES)) {
          const node = messageNode(locale.messages, root);
          expect(node, `${surface.id}: ${locale.code}.${root}`).toBeDefined();
          expect(
            flattenStrings(node!, root),
            `${surface.id}: ${locale.code}.${root}`,
          ).not.toHaveLength(0);
        }
      }

      for (const [state, review] of Object.entries(surface.states)) {
        expect(
          ['covered', 'not-applicable', 'hidden-by-design'],
          `${surface.id}: ${state}`,
        ).toContain(review.status);
        expect(review.evidence, `${surface.id}: ${state} evidence`).not.toHaveLength(0);
      }
    }
  });

  test('contains no literal user-facing copy outside the frozen legacy debt', () => {
    const universe = universeModules();
    const introduced: string[] = [];
    const overBudget: string[] = [];

    for (const relativePath of universe) {
      const findings = literalCopy(relativePath);
      const budget = LEGACY_LITERAL_COPY[relativePath] ?? 0;
      if (findings.length <= budget) continue;
      const report = `${relativePath}: ${findings.length} literal(s), budget ${budget}\n${findings.join('\n')}`;
      if (relativePath in LEGACY_LITERAL_COPY) overBudget.push(report);
      else introduced.push(report);
    }

    expect(
      introduced,
      `Hardcoded user-facing copy. Localize it, or — only for a pre-V5 surface #739 must leave alone — record it in LEGACY_LITERAL_COPY.\n${introduced.join('\n')}`,
    ).toEqual([]);
    expect(
      overBudget,
      `Legacy literal-copy debt grew; the budget may only shrink.\n${overBudget.join('\n')}`,
    ).toEqual([]);

    const onDisk = new Set(universe);
    const staleDebt = Object.keys(LEGACY_LITERAL_COPY)
      .filter((path) => !onDisk.has(path))
      .sort();
    expect(
      staleDebt,
      `Legacy debt recorded for a module that no longer exists:\n${staleDebt.join('\n')}`,
    ).toEqual([]);
  });
});

test('V5 German copy keeps informal address and consistent Blueprint terminology', () => {
  const reviewedRoots = [...new Set(V5_SURFACE_INVENTORY.flatMap((surface) => surface.copyRoots))];
  const reviewedGerman = reviewedRoots.flatMap((root) => {
    const node = messageNode(LOCALES.de.messages, root);
    return node ? flattenStrings(node, root) : [];
  });

  const malformedBlueprints = reviewedGerman.filter(([, value]) =>
    /\b(?:Dieses|diesem|ein|einem|eines|Neues|Unbenanntes|Das|ins|gespeichertes) Blueprints\b/.test(
      value,
    ),
  );
  const formalInstructions = reviewedGerman.filter(([, value]) =>
    /\b(?:Bitte (?:laden|versuchen|wählen|geben|klicken) Sie|Wählen Sie|Geben Sie|Klicken Sie|Versuchen Sie)\b/i.test(
      value,
    ),
  );
  const workboard = messageNode(LOCALES.de.messages, 'workboard');

  expect(malformedBlueprints).toEqual([]);
  expect(formalInstructions).toEqual([]);
  expect(
    flattenStrings(workboard!, 'workboard').filter(([, value]) => /Konglomerat/.test(value)),
  ).toEqual([]);
  expect(localizedMessage('de', 'assets.detail.previousClose')).toBe('Vortagesschluss');
  expect(localizedMessage('de', 'workboard.builder.nameAriaLabel')).toBe('Blueprint-Name');
  expect(localizedMessage('de', 'social.groups.subtitle')).toBe(
    'Benannte Freundeskreise, mit denen du Inhalte auf einmal teilen kannst.',
  );
  expect(localizedMessage('de', 'social.shared.watchlistTitle')).toBe('{{name}} von {{owner}}');
  expect(localizedMessage('de', 'admin.accountDefaults.title')).toBe('Kontovorgaben');
  expect(localizedMessage('de', 'admin.oauthApps.title')).toBe('OAuth-Apps');
  expect(localizedMessage('de', 'admin.apiKeys.title')).toBe('API-Schlüssel');
});
