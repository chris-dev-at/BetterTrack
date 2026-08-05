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
  DEFERRED_NON_V5_ASYNC_READ_SITE_BASELINE,
  DEFERRED_NON_V5_ASYNC_STATE_DEBT,
  DEFERRED_NON_V5_ASYNC_STATE_DEBT_CEILING,
  LEGACY_LITERAL_COPY,
  NON_SURFACE_ROUTE_ELEMENTS,
  NON_V5_ROUTES,
  NON_V5_SURFACES,
  SURFACE_UNIVERSE_ROOTS,
  V5_ASYNC_READ_EXEMPTIONS,
  V5_ASYNC_READ_SITE_BASELINE,
  V5_ASYNC_STATE_DEBT,
  V5_ASYNC_STATE_DEBT_CEILING,
  V5_NON_HOOK_ASYNC_BOUNDARY,
  V5_SURFACE_INVENTORY,
  type V5AsyncReadExemption,
  type V5AsyncReadState,
  type V5AsyncStateDebt,
  type V5SurfaceReview,
} from './v5SurfaceInventory';
import { matchControlPanel } from '../user/control/matchControlPanel';

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
admin/pages/ForcedPasswordChangePage.tsx
admin/pages/HealthPage.tsx
admin/pages/LoginPage.tsx
admin/pages/MonitoringPage.tsx
admin/pages/OAuthAppsPage.tsx
admin/pages/ProblemsPage.tsx
admin/pages/SecuritySettingsPage.tsx
admin/pages/SettingsPage.tsx
admin/pages/TwoFactorChallengePage.tsx
admin/pages/TwoFactorSetupPage.tsx
admin/pages/UsageAnalyticsPage.tsx
admin/pages/UsersPage.tsx
ui/MoneyText.tsx
ui/ScopePicker.tsx
ui/MarketStateBadge.tsx
ui/charts/AllocationDonut.tsx
ui/charts/LazyAllocationDonut.tsx
ui/charts/LazyPriceChart.tsx
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
user/control/panels/ParanoidAccountExport.tsx
user/control/panels/PrivacyPanel.tsx
user/control/panels/PrivacyVaultSection.tsx
user/control/panels/ProfilePanel.tsx
user/control/panels/SignInPanel.tsx
user/control/panels/WebhooksPanel.tsx
user/control/panels/taxModeList.tsx
user/forecast/ForecastPage.tsx
user/forecast/ProjectionChart.tsx
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
user/portfolio/ParanoidTaxReport.tsx
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
user/portfolio/cashflow/CashBudgetDialog.tsx
user/portfolio/cashflow/CashBudgetsPage.tsx
user/portfolio/cashflow/CashLabelsPage.tsx
user/portfolio/cashflow/CashMovementTagsDialog.tsx
user/portfolio/cashflow/CashMovementsPage.tsx
user/portfolio/cashflow/CashOverviewPage.tsx
user/portfolio/cashflow/CashRuleDialog.tsx
user/portfolio/cashflow/CashRulesPage.tsx
user/portfolio/cashflow/CashTagDialog.tsx
user/portfolio/cashflow/CashTagsPage.tsx
user/portfolio/cashflow/DisabledActionHint.tsx
user/portfolio/cashflow/CashflowChart.tsx
user/portfolio/cashflow/MonthPicker.tsx
user/portfolio/cashflow/RecordCashButton.tsx
user/portfolio/cashflow/RecordCashDialog.tsx
user/portfolio/cashflow/SectionHead.tsx
user/portfolio/cashflow/TagChip.tsx
user/portfolio/taxReportRows.tsx
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
user/vault/VaultAccountRoot.tsx
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
user/workboard/WatchlistDetailPage.tsx
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
/admin/login
/admin/monitoring
/admin/oauth-apps
/admin/problems
/admin/security
/admin/settings
/admin/usage-analytics
/admin/users
/assets/:id
/assets/custom-assets
/assets/news
/assets/watchlists
/assets/watchlists/:watchlistId
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
/portfolio/cash
/portfolio/cash/accounts
/portfolio/cash/budgets
/portfolio/cash/labels
/portfolio/cash/movements
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
  'P13b',
  'P13c',
].sort();

/**
 * The Control Center is an addressable overlay rather than a route element:
 * `UserShell` resolves `/control/:panel?` with `matchControlPanel` and keeps the
 * page behind it mounted. The inventory names the panel deep links, so the
 * route-completeness gate verifies them against that matcher as well as the two
 * ordinary `<Route>` registries.
 */
const CONTROL_PANEL_ROUTE = '/control/:panel?';
const CONTROL_PANEL_DEEP_LINK = /^\/control\/[a-z-]+$/;

function isAddressableControlSurface(path: string): boolean {
  if (path === CONTROL_PANEL_ROUTE) return matchControlPanel('/control') !== null;
  return CONTROL_PANEL_DEEP_LINK.test(path) && matchControlPanel(path) !== null;
}

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

function parseTsx(relativePath: string, sourceText?: string): ts.SourceFile {
  const absolutePath = resolve(SRC_ROOT, relativePath);
  return ts.createSourceFile(
    absolutePath,
    sourceText ?? readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function parseBoundTsx(
  relativePath: string,
  sourceText?: string,
): { sourceFile: ts.SourceFile; checker: ts.TypeChecker } {
  const absolutePath = resolve(SRC_ROOT, relativePath);
  const sourceFile = parseTsx(relativePath, sourceText);
  const options: ts.CompilerOptions = {
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options, true);
  const loadSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, ...args) =>
    resolve(fileName) === absolutePath ? sourceFile : loadSourceFile(fileName, ...args);
  const program = ts.createProgram([absolutePath], options, host);
  return {
    sourceFile: program.getSourceFile(absolutePath)!,
    checker: program.getTypeChecker(),
  };
}

/**
 * The ROOT read primitives — and the reason this seed is closed rather than
 * hand-kept.
 *
 * Transitive wrapper discovery below is only ever as complete as its roots, so
 * the roots are not allowed to be a list somebody has to remember to extend.
 * `reactQueryImportFindings` enumerates every value imported from
 * `@tanstack/react-query` anywhere under `src/` and requires each name to fall
 * into exactly one of the two sets here: an analyzed read primitive, or a
 * declared non-read carrying the reason it reads nothing. A future
 * `useSuspenseQuery` therefore fails this suite the day it is imported instead
 * of waiting for a reviewer to spot it.
 *
 * `useResource` (`admin/useResource.ts`) is the admin app's own read primitive
 * and is seeded alongside them; it has no external module to enumerate.
 */
const ANALYZED_REACT_QUERY_READS = new Set(['useInfiniteQuery', 'useQueries', 'useQuery']);

const DECLARED_NON_READ_REACT_QUERY_EXPORTS: Readonly<Record<string, string>> = {
  QueryClient: 'The cache instance itself; constructing it reads nothing.',
  QueryClientProvider: 'Context plumbing that hands the cache to the tree.',
  keepPreviousData:
    'A placeholder-data marker passed INTO an analyzed read; it never reads on its own.',
  useMutation:
    'A write. Mutation pending/error belongs to the acting control, not to a rendered read.',
  useQueryClient: 'A cache handle used for invalidation and imperative writes.',
};

const BASE_ASYNC_READ_HOOKS: ReadonlySet<string> = new Set([
  ...ANALYZED_REACT_QUERY_READS,
  'useResource',
]);

const REACT_QUERY_MODULE = '@tanstack/react-query';

/**
 * Every unclassified way into `@tanstack/react-query`, named with the file that
 * imports it. Namespace and default imports are findings in themselves: they
 * hide which entry points a module actually uses, so the seed could not be
 * proven complete against them.
 */
function reactQueryImportFindings(sourceTextByModule?: Readonly<Record<string, string>>): string[] {
  const modules = sourceTextByModule
    ? Object.entries(sourceTextByModule).map(([path, sourceText]) => parseTsx(path, sourceText))
    : sourceModules().map((path) => parseTsx(path));
  const findings: string[] = [];
  for (const sourceFile of modules) {
    const relativePath = relative(SRC_ROOT, sourceFile.fileName).split(sep).join('/');
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== REACT_QUERY_MODULE
      ) {
        continue;
      }
      const clause = statement.importClause;
      // `import type { … }` cannot call anything, so a type is never a read.
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) {
        findings.push(`${relativePath}: default import of ${REACT_QUERY_MODULE} hides its usage`);
      }
      const bindings = clause.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) {
        findings.push(`${relativePath}: namespace import of ${REACT_QUERY_MODULE} hides its usage`);
        continue;
      }
      for (const specifier of bindings.elements) {
        if (specifier.isTypeOnly) continue;
        const imported = (specifier.propertyName ?? specifier.name).text;
        if (
          ANALYZED_REACT_QUERY_READS.has(imported) ||
          Object.hasOwn(DECLARED_NON_READ_REACT_QUERY_EXPORTS, imported)
        ) {
          continue;
        }
        findings.push(
          `${relativePath}: unclassified ${REACT_QUERY_MODULE} import "${imported}" — add it to ANALYZED_REACT_QUERY_READS, or to DECLARED_NON_READ_REACT_QUERY_EXPORTS with the reason it reads nothing`,
        );
      }
    }
  }
  return findings.sort();
}

interface NamedHookBody {
  body: ts.ConciseBody;
  name: string;
}

function sourceModules(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.(?:test|spec)\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      ) {
        found.push(relative(SRC_ROOT, absolute).split(sep).join('/'));
      }
    }
  };
  walk(SRC_ROOT);
  return found.sort();
}

function namedHookBodies(sourceFile: ts.SourceFile): NamedHookBody[] {
  const hooks: NamedHookBody[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      /^use[A-Z]/.test(node.name.text)
    ) {
      hooks.push({ name: node.name.text, body: node.body });
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      /^use[A-Z]/.test(node.name.text)
    ) {
      hooks.push({ name: node.name.text, body: node.initializer.body });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hooks;
}

function bodyCallsHook(body: ts.ConciseBody, hookNames: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      hookNames.has(node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** Strips casts and parentheses off an expression, leaving the value itself. */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isSatisfiesExpression(expression)
    ? unwrapExpression(expression.expression)
    : expression;
}

/** Every expression a function body hands back, ignoring nested functions. */
function returnedExpressions(body: ts.ConciseBody): ts.Expression[] {
  if (!ts.isBlock(body)) return [unwrapExpression(body)];
  const returns: ts.Expression[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(unwrapExpression(node.expression));
      return;
    }
    if (isFunctionScope(node)) return;
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(body, collect);
  return returns;
}

/** The expression a hook hands back, when that is a single call it forwards. */
function forwardedCall(body: ts.ConciseBody): ts.CallExpression | null {
  const returns = returnedExpressions(body);
  const only = returns.length === 1 ? returns[0]! : null;
  return only && ts.isCallExpression(only) ? only : null;
}

/**
 * How a read's result is shaped, which decides where its state flags can be
 * observed:
 *
 *  - `record` — the `useQuery`/`useResource` shape: state lives in named
 *    properties of the returned object (`query.isPending`, `{ loading }`).
 *  - `list` — `useQueries` without `combine`: the result is an ARRAY of query
 *    results, so state is only ever read off an element, typically through a
 *    callback parameter (`results.some((result) => result.isLoading)`).
 *  - `combined` — `useQueries` with `combine`: the callback folds the array
 *    into a value of its own choosing. Which state each returned property
 *    carries is derived from that callback rather than from its NAME, so
 *    `{ loading: results.some((r) => r.isRefetching) }` carries nothing while
 *    `{ ready: results.every((r) => !r.isPending) }` carries loading.
 *
 * The name-vs-derivation split is deliberate: a `record` result is an
 * established API (react-query's own, or a reviewed wrapper's), whereas a
 * `combine` invents its property names inline at the read site — so trusting
 * those names would let any read certify itself by calling a field `loading`.
 */
type ReadResultShape =
  | { kind: 'record' }
  | { kind: 'list' }
  | { kind: 'combined'; states: ReadonlyMap<string, ReadonlySet<V5AsyncReadState>> };

const RECORD_SHAPE: ReadResultShape = { kind: 'record' };
const LIST_SHAPE: ReadResultShape = { kind: 'list' };

interface AsyncReadUniverse {
  hooks: ReadonlySet<string>;
  /** Non-`record` result shapes, by hook name. Absent means `record`. */
  shapes: ReadonlyMap<string, ReadResultShape>;
}

/**
 * Derive established query wrappers from their implementations. A new
 * `useSomething` hook that calls a known read hook is therefore part of the
 * gate without somebody remembering to append its name here — and a wrapper
 * that forwards a `useQueries` result forwards its shape too, so the caller is
 * analyzed as the array or combined object it actually receives.
 */
function discoverAsyncReadUniverse(
  sourceTextByModule?: Readonly<Record<string, string>>,
): AsyncReadUniverse {
  const entries: Array<[string, string | undefined]> = sourceTextByModule
    ? Object.entries(sourceTextByModule)
    : sourceModules().map((path) => [path, undefined]);
  const candidates = entries.flatMap(([path, sourceText]) =>
    namedHookBodies(parseTsx(path, sourceText)).map((hook) => ({ ...hook, path, sourceText })),
  );

  const hooks = new Set(BASE_ASYNC_READ_HOOKS);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (hooks.has(candidate.name) || !bodyCallsHook(candidate.body, hooks)) continue;
      hooks.add(candidate.name);
      changed = true;
    }
  }

  const shapes = new Map<string, ReadResultShape>();
  changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (!hooks.has(candidate.name) || shapes.has(candidate.name)) continue;
      const call = forwardedCall(candidate.body);
      if (!call || !ts.isIdentifier(call.expression)) continue;
      const callee = call.expression.text;
      if (callee === 'useQueries') {
        shapes.set(candidate.name, boundQueriesShape(candidate.path, candidate.sourceText, call));
        changed = true;
        continue;
      }
      const forwarded = shapes.get(callee);
      if (forwarded) {
        shapes.set(candidate.name, forwarded);
        changed = true;
      }
    }
  }
  return { hooks, shapes };
}

/**
 * Re-parse the wrapper's own module WITH a checker so the `combine` callback can
 * be read through binding symbols, and resolve the same call by position.
 */
function boundQueriesShape(
  relativePath: string,
  sourceText: string | undefined,
  call: ts.CallExpression,
): ReadResultShape {
  const { sourceFile, checker } = parseBoundTsx(relativePath, sourceText);
  let bound: ts.CallExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (bound) return;
    if (ts.isCallExpression(node) && node.getStart(sourceFile) === call.getStart()) {
      bound = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bound ? queriesResultShape(bound, checker) : LIST_SHAPE;
}

const NESTED_QUERY_RESULT_PROPERTIES: Readonly<Record<string, ReadonlySet<string>>> = {
  useActivePortfolio: new Set(['portfoliosQuery']),
};

/**
 * Flags that count as INITIAL pending/error handling.
 *
 * `isFetching` is in, deliberately: it is true during the very first fetch as
 * well, so a spinner bound to it does render while the read has no data.
 * `isRefetching` (`isFetching && !isPending`) and `isRefetchError` are out, and
 * stay out: a surface that renders only those has no first-load UI at all. One
 * mapping serves every shape — a `combine` cannot buy looser evidence than a
 * plain `useQuery` gets.
 */
const ASYNC_STATE_PROPERTIES: Record<V5AsyncReadState, ReadonlySet<string>> = {
  loading: new Set(['isFetching', 'isInitialLoading', 'isLoading', 'isPending', 'loading']),
  error: new Set(['error', 'isError', 'isLoadingError']),
};

const ASYNC_READ_STATES = ['loading', 'error'] as const satisfies readonly V5AsyncReadState[];

const ASYNC_READ_UNIVERSE = discoverAsyncReadUniverse();
const ASYNC_READ_HOOKS = ASYNC_READ_UNIVERSE.hooks;

interface AsyncReadSite {
  component: string;
  hook: string;
  line: number;
  read: string;
  observed: ReadonlySet<V5AsyncReadState>;
}

interface AsyncReadOffender extends Omit<AsyncReadSite, 'observed'> {
  states: readonly V5AsyncReadState[];
}

interface AsyncReadGateResult {
  reads: readonly AsyncReadSite[];
  offenders: readonly AsyncReadOffender[];
  invalidExemptions: readonly string[];
  staleExemptions: readonly string[];
}

interface ReadBinding {
  label: string;
  resultBinding?: ts.Identifier;
  directProperties: readonly {
    localBinding: ts.Identifier | null;
    property: string;
  }[];
}

interface RawAsyncRead {
  component: string;
  hook: string;
  line: number;
  readBase: string;
  binding: ReadBinding;
  shape: ReadResultShape;
  checker: ts.TypeChecker;
  scope: ts.Node;
}

function asyncHookName(node: ts.CallExpression, hookNames: ReadonlySet<string>): string | null {
  if (!ts.isIdentifier(node.expression)) return null;
  return hookNames.has(node.expression.text) ? node.expression.text : null;
}

function isFunctionScope(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionScopeName(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    if (node.name) return node.name.getText(sourceFile);
  }
  if (
    ts.isGetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name.getText(sourceFile);
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
  return '<anonymous>';
}

function readScope(node: ts.Node, sourceFile: ts.SourceFile): { name: string; node: ts.Node } {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionScope(current)) {
      return { name: functionScopeName(current, sourceFile), node: current };
    }
  }
  return { name: '<module>', node: sourceFile };
}

function unwrapParentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    (ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function readBinding(call: ts.CallExpression, sourceFile: ts.SourceFile): ReadBinding {
  const expression = unwrapParentExpression(call);
  const parent = expression.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === expression) {
    if (ts.isIdentifier(parent.name)) {
      return { label: parent.name.text, resultBinding: parent.name, directProperties: [] };
    }
    if (ts.isObjectBindingPattern(parent.name)) {
      const properties = parent.name.elements.map((element) => ({
        property: (element.propertyName ?? element.name).getText(sourceFile),
        localBinding: ts.isIdentifier(element.name) ? element.name : null,
      }));
      const dataBinding = parent.name.elements.find(
        (element) => (element.propertyName ?? element.name).getText(sourceFile) === 'data',
      );
      const label = dataBinding?.name.getText(sourceFile) ?? '$destructured';
      return { label, directProperties: properties };
    }
  }
  if (ts.isReturnStatement(parent) && parent.expression === expression) {
    return { label: '$return', directProperties: [] };
  }
  return { label: '$call', directProperties: [] };
}

function stateForProperty(property: string): V5AsyncReadState | null {
  for (const state of ASYNC_READ_STATES) {
    if (ASYNC_STATE_PROPERTIES[state].has(property)) return state;
  }
  return null;
}

function isIdentifierUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return true;
}

function containsJsx(node: ts.Node | undefined): boolean {
  if (!node) return false;
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(child) || ts.isJsxFragment(child) || ts.isJsxSelfClosingElement(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function stateReferenceIsRendered(
  node: ts.Node,
  scope: ts.Node,
  checker: ts.TypeChecker,
  seenBindings: Set<ts.Symbol>,
): boolean {
  let current = node;
  while (current !== scope && current.parent) {
    const parent = current.parent;
    if (ts.isJsxExpression(parent)) return true;
    if (ts.isIfStatement(parent) && parent.expression === current) {
      return containsJsx(parent.thenStatement) || containsJsx(parent.elseStatement);
    }
    if (
      (ts.isBinaryExpression(parent) || ts.isConditionalExpression(parent)) &&
      containsJsx(parent)
    ) {
      return true;
    }
    if (ts.isReturnStatement(parent)) return containsJsx(parent.expression);
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      if (!ts.isIdentifier(parent.name)) return false;
      const symbol = checker.getSymbolAtLocation(parent.name);
      if (!symbol || seenBindings.has(symbol)) return false;
      seenBindings.add(symbol);
      return bindingIsRendered(scope, parent.name, checker, seenBindings);
    }
    if (isFunctionScope(parent) && parent !== scope) return false;
    current = parent;
  }
  return false;
}

function bindingIsRendered(
  scope: ts.Node,
  binding: ts.Identifier | null,
  checker: ts.TypeChecker,
  seenBindings = new Set<ts.Symbol>(),
): boolean {
  if (binding === null) return false;
  const symbol = checker.getSymbolAtLocation(binding);
  if (!symbol) return false;
  let rendered = false;
  const visit = (node: ts.Node): void => {
    if (rendered) return;
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      checker.getSymbolAtLocation(node) === symbol &&
      isIdentifierUse(node) &&
      stateReferenceIsRendered(node, scope, checker, seenBindings)
    ) {
      rendered = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return rendered;
}

interface ElementBindings {
  /** Symbols bound to a whole query result — a callback's `result` parameter. */
  objects: ReadonlySet<ts.Symbol>;
  /** Symbols a destructured parameter binds straight to one flag. */
  flags: ReadonlyMap<ts.Symbol, V5AsyncReadState>;
}

/** What a callback over the results array binds: the element, or its flags. */
function callbackElementBindings(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): ElementBindings {
  const objects = new Set<ts.Symbol>();
  const flags = new Map<ts.Symbol, V5AsyncReadState>();
  for (const parameter of callback.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      const symbol = checker.getSymbolAtLocation(parameter.name);
      if (symbol) objects.add(symbol);
      continue;
    }
    if (!ts.isObjectBindingPattern(parameter.name)) continue;
    for (const element of parameter.name.elements) {
      const state = stateForProperty((element.propertyName ?? element.name).getText());
      const symbol = ts.isIdentifier(element.name)
        ? checker.getSymbolAtLocation(element.name)
        : undefined;
      if (state && symbol) flags.set(symbol, state);
    }
  }
  return { objects, flags };
}

/** Every state flag `node` reads off a query-result element, by binding symbol. */
function elementFlagStates(
  node: ts.Node,
  bindings: ElementBindings,
  checker: ts.TypeChecker,
): Set<V5AsyncReadState> {
  const states = new Set<V5AsyncReadState>();
  const visit = (child: ts.Node): void => {
    if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression)) {
      const symbol = checker.getSymbolAtLocation(child.expression);
      if (symbol && bindings.objects.has(symbol)) {
        const state = stateForProperty(child.name.text);
        if (state) states.add(state);
      }
    } else if (ts.isIdentifier(child) && isIdentifierUse(child)) {
      const symbol = checker.getSymbolAtLocation(child);
      const state = symbol ? bindings.flags.get(symbol) : undefined;
      if (state) states.add(state);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return states;
}

interface ElementObservation {
  /** The expression in the enclosing scope that carries the states outward. */
  anchor: ts.Node;
  states: ReadonlySet<V5AsyncReadState>;
}

/**
 * Every place `node` reads state off an ELEMENT of the results array — through a
 * callback invoked on it (`results.some((result) => result.isLoading)`) or
 * through indexed access (`results[0].isError`). The anchor is the expression
 * that carries those states back into the enclosing scope, which is what a
 * rendering check has to follow: the callback body is a nested function and
 * renders nothing itself.
 */
function arrayElementObservations(
  node: ts.Node,
  arraySymbol: ts.Symbol,
  checker: ts.TypeChecker,
): ElementObservation[] {
  const observations: ElementObservation[] = [];
  const isArray = (expression: ts.Expression) =>
    ts.isIdentifier(expression) && checker.getSymbolAtLocation(expression) === arraySymbol;
  const visit = (child: ts.Node): void => {
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      isArray(child.expression.expression)
    ) {
      for (const argument of child.arguments) {
        const callback = unwrapExpression(argument);
        if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) continue;
        const states = elementFlagStates(
          callback.body,
          callbackElementBindings(callback, checker),
          checker,
        );
        if (states.size > 0) observations.push({ anchor: child, states });
      }
    }
    if (
      ts.isPropertyAccessExpression(child) &&
      ts.isElementAccessExpression(child.expression) &&
      isArray(child.expression.expression)
    ) {
      const state = stateForProperty(child.name.text);
      if (state) observations.push({ anchor: child, states: new Set([state]) });
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return observations;
}

/**
 * The states a `combine` callback actually folds into each property it returns.
 * Derived from the callback body, never from the property NAME: a combine that
 * calls its property `loading` while folding only `isRefetching` carries
 * nothing, and one that calls it `ready` while folding `isPending` carries
 * loading.
 */
function combineReturnedStates(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): Map<string, ReadonlySet<V5AsyncReadState>> {
  // The combine parameter is the results ARRAY; the flags live one level down,
  // on the elements its own callbacks receive.
  const [parameter] = callback.parameters;
  if (!parameter || !ts.isIdentifier(parameter.name)) return new Map();
  const arraySymbol = checker.getSymbolAtLocation(parameter.name);
  if (!arraySymbol) return new Map();
  const carried = new Map<string, Set<V5AsyncReadState>>();
  for (const expression of returnedExpressions(callback.body)) {
    // A combine returning payloads (`results.map((r) => r.data)`) discards every
    // flag, so it carries nothing and the read reports as unobserved.
    if (!ts.isObjectLiteralExpression(expression)) continue;
    for (const property of expression.properties) {
      // Shorthand properties record nothing on purpose: the folded expression is
      // not in hand here, and an unobserved read fails loudly rather than
      // passing on a guess.
      if (!ts.isPropertyAssignment(property)) continue;
      const folded = new Set<V5AsyncReadState>();
      for (const observation of arrayElementObservations(
        property.initializer,
        arraySymbol,
        checker,
      )) {
        for (const state of observation.states) folded.add(state);
      }
      if (folded.size === 0) continue;
      const name = property.name.getText();
      const existing = carried.get(name) ?? new Set<V5AsyncReadState>();
      for (const state of folded) existing.add(state);
      carried.set(name, existing);
    }
  }
  return carried;
}

function queriesResultShape(call: ts.CallExpression, checker: ts.TypeChecker): ReadResultShape {
  const [options] = call.arguments;
  if (!options || !ts.isObjectLiteralExpression(options)) return LIST_SHAPE;
  const combine = options.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText() === 'combine',
  );
  if (!combine) return LIST_SHAPE;
  const callback = unwrapExpression(combine.initializer);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    // A combine passed by reference folds the results somewhere this walk cannot
    // read, so it carries nothing.
    return { kind: 'combined', states: new Map() };
  }
  return { kind: 'combined', states: combineReturnedStates(callback, checker) };
}

/**
 * `useQueries` without `combine`: the result is an array, so state is only ever
 * read off an ELEMENT — through a callback invoked on the array
 * (`results.some((result) => result.isLoading)`) or through indexed access
 * (`results[0].isError`). The rendering anchor is the call or access sitting in
 * the component's own scope; the callback body is a nested function and renders
 * nothing itself.
 */
function listStateObservations(raw: RawAsyncRead): Set<V5AsyncReadState> {
  const observed = new Set<V5AsyncReadState>();
  const binding = raw.binding.resultBinding;
  if (!binding) return observed;
  const arraySymbol = raw.checker.getSymbolAtLocation(binding);
  if (!arraySymbol) return observed;
  for (const observation of arrayElementObservations(raw.scope, arraySymbol, raw.checker)) {
    if (!stateReferenceIsRendered(observation.anchor, raw.scope, raw.checker, new Set())) continue;
    for (const state of observation.states) observed.add(state);
  }
  return observed;
}

/**
 * `useQueries` with `combine`: the caller sees the callback's own object, so a
 * property counts only for the states that callback folded into it, whatever it
 * happens to be named.
 */
function combinedStateObservations(
  raw: RawAsyncRead,
  carried: ReadonlyMap<string, ReadonlySet<V5AsyncReadState>>,
): Set<V5AsyncReadState> {
  const observed = new Set<V5AsyncReadState>();
  for (const property of raw.binding.directProperties) {
    const states = carried.get(property.property);
    if (states && bindingIsRendered(raw.scope, property.localBinding, raw.checker)) {
      for (const state of states) observed.add(state);
    }
  }
  const binding = raw.binding.resultBinding;
  if (!binding) return observed;
  const resultSymbol = raw.checker.getSymbolAtLocation(binding);
  if (!resultSymbol) return observed;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      raw.checker.getSymbolAtLocation(node.expression) === resultSymbol
    ) {
      const states = carried.get(node.name.text);
      if (states && stateReferenceIsRendered(node, raw.scope, raw.checker, new Set())) {
        for (const state of states) observed.add(state);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(raw.scope);
  return observed;
}

function stateObservations(raw: RawAsyncRead): ReadonlySet<V5AsyncReadState> {
  if (raw.shape.kind === 'list') return listStateObservations(raw);
  if (raw.shape.kind === 'combined') return combinedStateObservations(raw, raw.shape.states);
  return propertyStateObservations(raw);
}

function propertyStateObservations(raw: RawAsyncRead): ReadonlySet<V5AsyncReadState> {
  const observed = new Set<V5AsyncReadState>();

  const observePropertiesOf = (resultBinding: ts.Identifier) => {
    const resultSymbol = raw.checker.getSymbolAtLocation(resultBinding);
    if (!resultSymbol) return;
    const recordProperty = (property: string, reference: ts.Node) => {
      const state = stateForProperty(property);
      if (state && stateReferenceIsRendered(reference, raw.scope, raw.checker, new Set())) {
        observed.add(state);
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        raw.checker.getSymbolAtLocation(node.expression) === resultSymbol
      ) {
        recordProperty(node.name.text, node);
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        raw.checker.getSymbolAtLocation(node.expression) === resultSymbol &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression)
      ) {
        recordProperty(node.argumentExpression.text, node);
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        raw.checker.getSymbolAtLocation(node.initializer) === resultSymbol &&
        ts.isObjectBindingPattern(node.name)
      ) {
        for (const element of node.name.elements) {
          if (
            bindingIsRendered(
              raw.scope,
              ts.isIdentifier(element.name) ? element.name : null,
              raw.checker,
            )
          ) {
            const state = stateForProperty((element.propertyName ?? element.name).getText());
            if (state) observed.add(state);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(raw.scope);
  };

  for (const property of raw.binding.directProperties) {
    const state = stateForProperty(property.property);
    if (state && bindingIsRendered(raw.scope, property.localBinding, raw.checker)) {
      observed.add(state);
    }
    if (property.localBinding && NESTED_QUERY_RESULT_PROPERTIES[raw.hook]?.has(property.property)) {
      observePropertiesOf(property.localBinding);
    }
  }
  if (!raw.binding.resultBinding) return observed;
  observePropertiesOf(raw.binding.resultBinding);
  return observed;
}

function rawAsyncReads(
  relativePath: string,
  sourceText?: string,
  universe: AsyncReadUniverse = ASYNC_READ_UNIVERSE,
): RawAsyncRead[] {
  const { sourceFile, checker } = parseBoundTsx(relativePath, sourceText);
  const hookNames = universe.hooks;
  const localAsyncHooks = new Set(
    namedHookBodies(sourceFile)
      .map((hook) => hook.name)
      .filter((name) => hookNames.has(name) && !BASE_ASYNC_READ_HOOKS.has(name)),
  );
  const reads: RawAsyncRead[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const hook = asyncHookName(node, hookNames);
      if (hook && !localAsyncHooks.has(hook)) {
        const scope = readScope(node, sourceFile);
        const binding = readBinding(node, sourceFile);
        reads.push({
          component: relativePath,
          hook,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          readBase: `${scope.name}.${binding.label}`,
          binding,
          // One `useQueries` call is ONE read site, not one per query: the fan-out
          // is declarative and its states are observed (or not) exactly once, on
          // the single array or combined object the call hands back.
          shape:
            hook === 'useQueries'
              ? queriesResultShape(node, checker)
              : (universe.shapes.get(hook) ?? RECORD_SHAPE),
          checker,
          scope: scope.node,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reads;
}

function nameAsyncReads(rawReads: readonly RawAsyncRead[]): AsyncReadSite[] {
  const totals = new Map<string, number>();
  for (const read of rawReads) totals.set(read.readBase, (totals.get(read.readBase) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return rawReads.map((raw) => {
    const occurrence = (occurrences.get(raw.readBase) ?? 0) + 1;
    occurrences.set(raw.readBase, occurrence);
    return {
      component: raw.component,
      hook: raw.hook,
      line: raw.line,
      read: totals.get(raw.readBase) === 1 ? raw.readBase : `${raw.readBase}#${occurrence}`,
      observed: stateObservations(raw),
    };
  });
}

function analyzeAsyncReadStates(
  components: readonly string[],
  exemptions: readonly V5AsyncReadExemption[],
  sourceTextByComponent: Readonly<Record<string, string>> = {},
  universe: AsyncReadUniverse = ASYNC_READ_UNIVERSE,
): AsyncReadGateResult {
  const reads = components.flatMap((component) =>
    nameAsyncReads(rawAsyncReads(component, sourceTextByComponent[component], universe)),
  );
  const invalidExemptions: string[] = [];
  const exemptionKeys = new Set<string>();
  for (const exemption of exemptions) {
    const prefix = `${exemption.component} ${exemption.read}`;
    if (exemption.component.trim().length === 0 || exemption.read.trim().length === 0) {
      invalidExemptions.push(`${prefix}: component and read are required`);
    }
    if (exemption.states.length === 0) {
      invalidExemptions.push(`${prefix}: at least one state is required`);
    }
    if (exemption.reason.trim().length === 0) {
      invalidExemptions.push(`${prefix}: exemption reason is empty`);
    }
    if (exemption.delegatedTo !== undefined && exemption.delegatedTo.trim().length === 0) {
      invalidExemptions.push(`${prefix}: delegatedTo is empty`);
    }
    for (const state of exemption.states) {
      const key = `${exemption.component}\0${exemption.read}\0${state}`;
      if (exemptionKeys.has(key)) invalidExemptions.push(`${prefix}: duplicate ${state} exemption`);
      exemptionKeys.add(key);
    }
  }

  const validExemptionKeys = new Set(
    exemptions
      .filter(
        (exemption) =>
          exemption.component.trim().length > 0 &&
          exemption.read.trim().length > 0 &&
          exemption.states.length > 0 &&
          exemption.reason.trim().length > 0 &&
          (exemption.delegatedTo === undefined || exemption.delegatedTo.trim().length > 0),
      )
      .flatMap((exemption) =>
        exemption.states.map((state) => `${exemption.component}\0${exemption.read}\0${state}`),
      ),
  );
  const rawMissingKeys = new Set<string>();
  const offenders: AsyncReadOffender[] = [];
  for (const read of reads) {
    const missing = ASYNC_READ_STATES.filter((state) => !read.observed.has(state));
    for (const state of missing) rawMissingKeys.add(`${read.component}\0${read.read}\0${state}`);
    const unexempted = missing.filter(
      (state) => !validExemptionKeys.has(`${read.component}\0${read.read}\0${state}`),
    );
    if (unexempted.length > 0) {
      offenders.push({
        component: read.component,
        hook: read.hook,
        line: read.line,
        read: read.read,
        states: unexempted,
      });
    }
  }

  const staleExemptions = [...validExemptionKeys]
    .filter((key) => !rawMissingKeys.has(key))
    .map((key) => {
      const [component, read, state] = key.split('\0');
      return `${component} ${read}: stale ${state} exemption`;
    })
    .sort();
  return {
    reads,
    offenders,
    invalidExemptions: invalidExemptions.sort(),
    staleExemptions,
  };
}

function debtRows(offenders: readonly AsyncReadOffender[]): V5AsyncStateDebt[] {
  return offenders
    .map(({ component, read, states }) => ({ component, read, states }))
    .sort(compareComponentRead);
}

function formatAsyncReadOffenders(offenders: readonly AsyncReadOffender[]): string {
  if (offenders.length === 0) return '(none)';
  return [...offenders]
    .sort(compareComponentRead)
    .map(
      (offender) =>
        `${offender.component}:${offender.line} ${offender.read} (${offender.hook}) missing ${offender.states.join(' + ')}`,
    )
    .join('\n');
}

function compareComponentRead(
  left: Pick<AsyncReadSite, 'component' | 'read'>,
  right: Pick<AsyncReadSite, 'component' | 'read'>,
): number {
  if (left.component !== right.component) return left.component < right.component ? -1 : 1;
  if (left.read === right.read) return 0;
  return left.read < right.read ? -1 : 1;
}

/**
 * The declared analysis boundary — the third layer, enumerated rather than left
 * silent.
 *
 * Issue #1025 binds this gate to reads made through "`useQuery` / `useResource`
 * and the established wrappers". Inventoried surfaces also load asynchronously
 * through effects and external stores, and remediating those is explicitly
 * parent #739's job, so this suite builds NO state analysis for them and makes
 * no claim about their pending/error UI. What it refuses to do is let them sit
 * unnamed: every such site is enumerated off the same code the read gate parses,
 * must carry a written note in `V5_NON_HOOK_ASYNC_BOUNDARY`, and is printed
 * beside the offender list. A new effect-driven loader on an inventoried surface
 * is therefore a named failure here rather than the next reviewer's finding.
 */
const NON_HOOK_ASYNC_MECHANISMS = new Set(['useEffect', 'useSyncExternalStore']);

interface NonHookAsyncSite {
  component: string;
  site: string;
  line: number;
}

/** Does this effect body actually await or chain a promise? */
function bodyAwaitsPromise(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      ts.isAwaitExpression(child) ||
      (ts.isCallExpression(child) &&
        ts.isPropertyAccessExpression(child.expression) &&
        child.expression.name.text === 'then')
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function nonHookAsyncSites(relativePath: string, sourceText?: string): NonHookAsyncSite[] {
  const sourceFile = parseTsx(relativePath, sourceText);
  const found: Array<{ base: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      NON_HOOK_ASYNC_MECHANISMS.has(node.expression.text) &&
      (node.expression.text !== 'useEffect' ||
        (node.arguments[0] !== undefined && bodyAwaitsPromise(node.arguments[0])))
    ) {
      found.push({
        base: `${readScope(node, sourceFile).name}.${node.expression.text}`,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const totals = new Map<string, number>();
  for (const site of found) totals.set(site.base, (totals.get(site.base) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return found.map(({ base, line }) => {
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return {
      component: relativePath,
      site: totals.get(base) === 1 ? base : `${base}#${occurrence}`,
      line,
    };
  });
}

function formatNonHookAsyncSites(sites: readonly NonHookAsyncSite[]): string {
  if (sites.length === 0) return '(none)';
  return sites.map((site) => `${site.component}:${site.line} ${site.site}`).join('\n');
}

function conditionBindingControlsRenderedJsx(
  scope: ts.Node,
  binding: ts.Identifier,
  checker: ts.TypeChecker,
  seenBindings: Set<ts.Symbol>,
): boolean {
  const symbol = checker.getSymbolAtLocation(binding);
  if (!symbol) return false;
  let rendered = false;
  const visit = (node: ts.Node): void => {
    if (rendered) return;
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      checker.getSymbolAtLocation(node) === symbol &&
      isIdentifierUse(node) &&
      conditionControlsRenderedJsx(node, scope, checker, seenBindings)
    ) {
      rendered = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return rendered;
}

function conditionControlsRenderedJsx(
  node: ts.Node,
  scope: ts.Node,
  checker: ts.TypeChecker,
  seenBindings = new Set<ts.Symbol>(),
): boolean {
  let current = node;
  while (current !== scope && current.parent) {
    const parent = current.parent;
    if (ts.isJsxExpression(parent)) return false;
    if (ts.isIfStatement(parent) && parent.expression === current) {
      return containsJsx(parent.thenStatement) || containsJsx(parent.elseStatement);
    }
    if (ts.isConditionalExpression(parent) && parent.condition === current) {
      return containsJsx(parent.whenTrue) || containsJsx(parent.whenFalse);
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === current &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      containsJsx(parent)
    ) {
      return true;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      if (!ts.isIdentifier(parent.name)) return false;
      const symbol = checker.getSymbolAtLocation(parent.name);
      if (!symbol || seenBindings.has(symbol)) return false;
      seenBindings.add(symbol);
      return conditionBindingControlsRenderedJsx(scope, parent.name, checker, seenBindings);
    }
    if (isFunctionScope(parent) && parent !== scope) return false;
    current = parent;
  }
  return false;
}

function hasEmptyStateSignal(relativePath: string, sourceText?: string): boolean {
  const { sourceFile, checker } = parseBoundTsx(relativePath, sourceText);
  let found = false;
  const isLength = (node: ts.Node) =>
    ts.isPropertyAccessExpression(node) && node.name.text === 'length';
  const isZero = (node: ts.Node) => ts.isNumericLiteral(node) && Number(node.text) === 0;
  const reachesRenderedJsx = (node: ts.Node) =>
    stateReferenceIsRendered(node, readScope(node, sourceFile).node, checker, new Set());
  const controlsRenderedJsx = (node: ts.Node) =>
    conditionControlsRenderedJsx(node, readScope(node, sourceFile).node, checker);
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isJsxOpeningLikeElement(node) &&
      /(?:Empty|NoData)$/.test(node.tagName.getText()) &&
      reachesRenderedJsx(node)
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      /(?:^|\.)(?:empty|noData|noItems|noResults|none)(?:\.|$)/i.test(node.arguments[0].text) &&
      reachesRenderedJsx(node)
    ) {
      found = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      ((isLength(node.left) && isZero(node.right)) ||
        (isZero(node.left) && isLength(node.right))) &&
      controlsRenderedJsx(node)
    ) {
      found = true;
      return;
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      if (isLength(node.operand) && controlsRenderedJsx(node)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function coveredStateClaimFindings(
  surface: Pick<V5SurfaceReview, 'id' | 'components' | 'states'>,
  result: AsyncReadGateResult,
  emptyStateSignal: (component: string) => boolean = hasEmptyStateSignal,
): string[] {
  const findings: string[] = [];
  const surfaceComponents = new Set(surface.components);
  const surfaceReads = result.reads.filter((read) => surfaceComponents.has(read.component));

  for (const state of ASYNC_READ_STATES) {
    if (surface.states[state].status !== 'covered') continue;
    if (surfaceReads.length === 0) {
      findings.push(`${surface.id}: ${state} cannot claim covered without a located async read`);
      continue;
    }
    const uncovered = result.offenders.filter(
      (offender) => surfaceComponents.has(offender.component) && offender.states.includes(state),
    );
    if (uncovered.length > 0) {
      findings.push(
        `${surface.id}: ${state} claims covered, but these reads do not observe it:\n${formatAsyncReadOffenders(uncovered)}`,
      );
    }
  }

  if (surface.states.empty.status !== 'covered') return findings;
  const asyncComponents = [...new Set(surfaceReads.map((read) => read.component))];
  if (asyncComponents.length > 0) {
    const withoutEmptySignal = asyncComponents.filter((component) => !emptyStateSignal(component));
    if (withoutEmptySignal.length > 0) {
      findings.push(
        `${surface.id}: empty claims covered, but these async components have no AST-visible empty branch:\n${withoutEmptySignal.join('\n')}`,
      );
    }
  } else if (!surface.components.some((component) => emptyStateSignal(component))) {
    findings.push(
      `${surface.id}: empty claims covered, but its synchronous components have no AST-visible empty branch`,
    );
  }
  return findings;
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
const ALLOWED_TECHNICAL_VALUES = new Set([
  'http://localhost:11434',
  'llama3.1:8b',
  'myapp://callback',
  'web …',
  'web … · api …',
]);

/** Literal user-facing strings rendered by a TSX module, as `path:line "text"`. */
function literalCopy(relativePath: string, sourceText?: string): string[] {
  const sourceFile = parseTsx(relativePath, sourceText);
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

  const recordExpression = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      record(
        node,
        `${node.head.text}${node.templateSpans.map((span) => `…${span.literal.text}`).join('')}`,
      );
      return;
    }
    // Translation calls contain string-literal catalog keys; those are not
    // rendered copy. JSX nested inside an expression is visited normally by
    // the outer walk and must not be double-counted here.
    if (
      ts.isCallExpression(node) ||
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      return;
    }
    if (ts.isConditionalExpression(node)) {
      recordExpression(node.whenTrue);
      recordExpression(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        recordExpression(node.right);
      } else if (
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        recordExpression(node.left);
        recordExpression(node.right);
      }
      return;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      recordExpression(node.expression);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) recordExpression(element);
    }
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
    if (ts.isJsxExpression(node) && node.expression) {
      const parent = node.parent;
      if (
        (ts.isJsxAttribute(parent) &&
          USER_FACING_ATTRIBUTES.has(parent.name.getText(sourceFile))) ||
        ts.isJsxElement(parent) ||
        ts.isJsxFragment(parent)
      ) {
        recordExpression(node.expression);
      }
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

describe('V5 async-read state gate', () => {
  const fixturePath = 'synthetic-async-state-probe.tsx';

  test('accepts a read whose loading and error states are observed', () => {
    const result = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
          function Probe() {
            const query = useQuery({ queryKey: ['probe'], queryFn: loadProbe });
            if (query.isPending) return <Spinner />;
            if (query.isError) return <Retry onClick={() => query.refetch()} />;
            return <p>{query.data}</p>;
          }
        `,
    });

    expect(result.reads).toHaveLength(1);
    expect(result.offenders).toEqual([]);
  });

  test('reports an unobserved read with its component and read site', () => {
    const result = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
          function Probe() {
            const query = useQuery({ queryKey: ['probe'], queryFn: loadProbe });
            return <p>{query.data}</p>;
          }
        `,
    });

    expect(result.offenders).toMatchObject([
      {
        component: fixturePath,
        hook: 'useQuery',
        read: 'Probe.query',
        states: ['loading', 'error'],
      },
    ]);
    expect(formatAsyncReadOffenders(result.offenders)).toContain(
      `${fixturePath}:3 Probe.query (useQuery) missing loading + error`,
    );

    const unusedDestructure = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
          function Probe() {
            const { data, isLoading, isError } = useQuery({ queryKey: ['probe'], queryFn: loadProbe });
            return <p>{data}</p>;
          }
        `,
    });
    expect(unusedDestructure.offenders[0]).toMatchObject({
      read: 'Probe.data',
      states: ['loading', 'error'],
    });
  });

  test('locates established wrappers and observes a nested query result', () => {
    const result = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function ActiveProbe() {
          const { portfoliosQuery } = useActivePortfolio();
          if (portfoliosQuery.isLoading) return <Spinner />;
          if (portfoliosQuery.isError) return <Retry />;
          return <p>{portfoliosQuery.data?.portfolios.length}</p>;
        }
        function AiProbe() {
          const capability = useAiCapability();
          return <p>{capability.data?.available}</p>;
        }
        function WatchlistProbe() {
          const { watchedIds } = useWatchlistMembership();
          return <p>{watchedIds.size}</p>;
        }
      `,
    });

    expect(result.reads.map(({ hook, read }) => ({ hook, read }))).toEqual([
      { hook: 'useActivePortfolio', read: 'ActiveProbe.$destructured' },
      { hook: 'useAiCapability', read: 'AiProbe.capability' },
      { hook: 'useWatchlistMembership', read: 'WatchlistProbe.$destructured' },
    ]);
    expect(result.offenders.map(({ hook }) => hook)).toEqual([
      'useAiCapability',
      'useWatchlistMembership',
    ]);
  });

  test('derives established wrappers from their implementations', () => {
    expect(ASYNC_READ_HOOKS.has('useAssetSearch')).toBe(true);
    expect(ASYNC_READ_HOOKS.has('usePrivacyMode')).toBe(true);
    // The `useQueries` root reaches its real wrappers, thirty lines from the
    // `useQuery` one that was already discovered in the same file.
    expect(ASYNC_READ_HOOKS.has('usePortfolioSummaries')).toBe(true);
    expect(ASYNC_READ_HOOKS.has('useRollup')).toBe(true);

    const universe = discoverAsyncReadUniverse({
      'synthetic-wrapper.ts': `
        export function useSyntheticRead() {
          return useQuery({ queryKey: ['synthetic'], queryFn: loadSynthetic });
        }
      `,
    });
    const result = analyzeAsyncReadStates(
      [fixturePath],
      [],
      {
        [fixturePath]: `
          function Probe() {
            const synthetic = useSyntheticRead();
            return <p>{synthetic.data}</p>;
          }
        `,
      },
      universe,
    );

    expect(result.reads).toMatchObject([{ hook: 'useSyntheticRead', read: 'Probe.synthetic' }]);
    expect(result.offenders[0]?.states).toEqual(['loading', 'error']);
  });

  test('classifies every react-query entry point as an analyzed read or a declared non-read', () => {
    for (const name of ANALYZED_REACT_QUERY_READS) {
      expect(BASE_ASYNC_READ_HOOKS.has(name), `${name} is analyzed but not seeded`).toBe(true);
      expect(Object.hasOwn(DECLARED_NON_READ_REACT_QUERY_EXPORTS, name)).toBe(false);
    }
    for (const reason of Object.values(DECLARED_NON_READ_REACT_QUERY_EXPORTS)) {
      expect(reason.trim().length, 'Every declared non-read carries its reason.').toBeGreaterThan(
        0,
      );
    }

    const findings = reactQueryImportFindings();
    expect(
      findings,
      `Unclassified @tanstack/react-query entry points. Seeding is what makes wrapper discovery complete, so a new one must be classified before it can be used:\n${findings.join('\n')}`,
    ).toEqual([]);

    // A hook nobody has classified fails the day it lands, by name and by file.
    expect(
      reactQueryImportFindings({
        'synthetic-unclassified.ts': `
          import { useSuspenseQuery } from '@tanstack/react-query';
          export const useProbe = () => useSuspenseQuery({ queryKey: ['probe'] });
        `,
      }),
    ).toEqual([
      expect.stringContaining('unclassified @tanstack/react-query import "useSuspenseQuery"'),
    ]);
    expect(
      reactQueryImportFindings({
        'synthetic-namespace.ts': `import * as rq from '@tanstack/react-query';`,
      }),
    ).toEqual([expect.stringContaining('namespace import')]);
    // Types cannot fetch, so a type-only import is not an unclassified read.
    expect(
      reactQueryImportFindings({
        'synthetic-type-import.ts': `import type { UseQueryResult } from '@tanstack/react-query';`,
      }),
    ).toEqual([]);
  });

  test('analyzes useQueries through its array, payload and renamed-combine shapes', () => {
    const arrayShape = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function Probe({ ids }) {
          const results = useQueries({ queries: ids.map((id) => ({ queryKey: ['probe', id] })) });
          if (results.some((result) => result.isLoading)) return <Spinner />;
          if (results.some((result) => result.isError)) return <Retry />;
          return <p>{results.length}</p>;
        }
      `,
    });
    expect(arrayShape.reads).toMatchObject([{ hook: 'useQueries', read: 'Probe.results' }]);
    expect(arrayShape.offenders).toEqual([]);

    // The regression the reviewer asked for: an unobserved fan-out is an
    // offender, not an invisible read.
    const unobserved = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function Probe({ ids }) {
          const results = useQueries({ queries: ids.map((id) => ({ queryKey: ['probe', id] })) });
          return <p>{results.map((result) => result.data).join(', ')}</p>;
        }
      `,
    });
    expect(unobserved.offenders).toMatchObject([
      { hook: 'useQueries', read: 'Probe.results', states: ['loading', 'error'] },
    ]);

    // `combine` returning payloads only discards every flag.
    const payloadCombine = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function Probe({ ids }) {
          const quotes = useQueries({
            queries: ids.map((id) => ({ queryKey: ['probe', id] })),
            combine: (results) => results.map((result) => result.data?.quote ?? null),
          });
          return <p>{quotes.length}</p>;
        }
      `,
    });
    expect(payloadCombine.offenders[0]?.states).toEqual(['loading', 'error']);

    // A renamed combine property counts for what it folds, not what it is called.
    const renamedCombine = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function Probe({ ids }) {
          const combined = useQueries({
            queries: ids.map((id) => ({ queryKey: ['probe', id] })),
            combine: (results) => ({
              series: results.map((result) => result.data),
              busy: results.some((result) => result.isLoading || result.isFetching),
              broken: results.some(({ isError }) => isError),
            }),
          });
          if (combined.busy) return <Spinner />;
          if (combined.broken) return <Retry />;
          return <p>{combined.series.length}</p>;
        }
      `,
    });
    expect(renamedCombine.offenders).toEqual([]);
  });

  test('follows the useQueries array shape through an established wrapper', () => {
    // `usePortfolioSummaries` (user/home/homeData.ts) forwards a `useQueries`
    // result, thirty lines from the `usePortfoliosQuery` that was already in the
    // ledger. Discovery has to reach it AND carry its array shape to the caller.
    const source = (body: string) => `
      function Probe({ portfolios }) {
        const results = usePortfolioSummaries(portfolios);
        ${body}
      }
    `;
    const unobserved = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: source('return <p>{results.length}</p>;'),
    });
    expect(unobserved.reads).toMatchObject([
      { hook: 'usePortfolioSummaries', read: 'Probe.results' },
    ]);
    expect(unobserved.offenders[0]?.states).toEqual(['loading', 'error']);

    const observed = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: source(`
        if (results.some((result) => result.isPending)) return <Spinner />;
        if (results.some(({ isError }) => isError)) return <Retry />;
        return <p>{results.length}</p>;
      `),
    });
    expect(observed.offenders).toEqual([]);
  });

  test('does not let a combine launder a refetch-only flag into initial coverage', () => {
    const result = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function Probe({ ids }) {
          const combined = useQueries({
            queries: ids.map((id) => ({ queryKey: ['probe', id] })),
            combine: (results) => ({
              loading: results.some((result) => result.isRefetching),
              error: results.some((result) => result.isRefetchError),
            }),
          });
          if (combined.loading) return <Spinner />;
          if (combined.error) return <Retry />;
          return <p>{ids.length}</p>;
        }
      `,
    });

    expect(result.offenders[0]?.states).toEqual(['loading', 'error']);
  });

  test('does not mistake response payload fields or shadowed locals for query state', () => {
    const payloadField = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function Probe() {
          const { data } = useQuery({ queryKey: ['probe'], queryFn: loadProbe });
          return <p>{data?.error}</p>;
        }
      `,
    });
    expect(payloadField.offenders[0]?.states).toEqual(['loading', 'error']);

    const shadowedBinding = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function Probe() {
          const query = useQuery({ queryKey: ['probe'], queryFn: loadProbe });
          function Shadowed() {
            const query = { isPending: true, isError: true };
            return query.isPending || query.isError ? <Spinner /> : null;
          }
          return <><Shadowed /><p>{query.data}</p></>;
        }
      `,
    });
    expect(shadowedBinding.offenders[0]?.states).toEqual(['loading', 'error']);
  });

  test('does not accept refetch-only flags as initial loading or error handling', () => {
    const result = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function Probe() {
          const query = useQuery({ queryKey: ['probe'], queryFn: loadProbe });
          if (query.isRefetching) return <Spinner />;
          if (query.isRefetchError) return <Retry />;
          return <p>{query.data}</p>;
        }
      `,
    });

    expect(result.offenders[0]?.states).toEqual(['loading', 'error']);
  });

  test('binds covered loading and error claims to analyzed reads', () => {
    const coveredSurface = {
      id: 'synthetic-covered-surface',
      components: [fixturePath],
      states: {
        loading: { status: 'covered', evidence: 'Fixture renders pending state.' },
        empty: { status: 'not-applicable', evidence: 'Fixture has no collection.' },
        error: { status: 'covered', evidence: 'Fixture renders error state.' },
      },
    } satisfies Pick<V5SurfaceReview, 'id' | 'components' | 'states'>;
    const coveredResult = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function Probe() {
          const query = useQuery({ queryKey: ['probe'], queryFn: loadProbe });
          if (query.isPending) return <Spinner />;
          if (query.isError) return <Retry />;
          return <p>{query.data}</p>;
        }
      `,
    });
    expect(coveredStateClaimFindings(coveredSurface, coveredResult)).toEqual([]);

    const missingError = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: `
        function Probe() {
          const query = useQuery({ queryKey: ['probe'], queryFn: loadProbe });
          if (query.isPending) return <Spinner />;
          return <p>{query.data}</p>;
        }
      `,
    });
    expect(coveredStateClaimFindings(coveredSurface, missingError)).toEqual([
      expect.stringContaining('error claims covered'),
    ]);
  });

  test('requires an empty predicate to control JSX and supports synchronous surfaces', () => {
    const detachedSignal = `
      function Probe({ items }) {
        recordMetric('probe.empty');
        return <Rows items={items} data-empty={items.length === 0} />;
      }
    `;
    expect(hasEmptyStateSignal(fixturePath, detachedSignal)).toBe(false);

    const renderedSignal = `
      function Probe({ items }) {
        const empty = items.length === 0;
        return empty ? <p>No rows</p> : <Rows items={items} />;
      }
    `;
    expect(hasEmptyStateSignal(fixturePath, renderedSignal)).toBe(true);

    const synchronousSurface = {
      id: 'synthetic-synchronous-surface',
      components: [fixturePath],
      states: {
        loading: { status: 'not-applicable', evidence: 'No async read.' },
        empty: { status: 'covered', evidence: 'The local collection renders an empty branch.' },
        error: { status: 'not-applicable', evidence: 'No async read.' },
      },
    } satisfies Pick<V5SurfaceReview, 'id' | 'components' | 'states'>;
    const synchronousResult = analyzeAsyncReadStates([fixturePath], [], {
      [fixturePath]: renderedSignal,
    });
    expect(
      coveredStateClaimFindings(synchronousSurface, synchronousResult, (component) =>
        hasEmptyStateSignal(component, renderedSignal),
      ),
    ).toEqual([]);
  });

  test('accepts a per-read exemption only when it records a reason', () => {
    const source = `
      function Probe() {
        const query = useQuery({ queryKey: ['probe'], queryFn: loadProbe });
        return <p>{query.data}</p>;
      }
    `;
    const reasoned: V5AsyncReadExemption = {
      component: fixturePath,
      read: 'Probe.query',
      states: ['loading', 'error'],
      reason: 'The named parent owns both states for this read.',
      delegatedTo: 'ProbeParent',
    };
    const exempted = analyzeAsyncReadStates([fixturePath], [reasoned], { [fixturePath]: source });
    expect(exempted.invalidExemptions).toEqual([]);
    expect(exempted.offenders).toEqual([]);

    const unreasoned = analyzeAsyncReadStates([fixturePath], [{ ...reasoned, reason: '' }], {
      [fixturePath]: source,
    });
    expect(unreasoned.invalidExemptions).toEqual([
      `${fixturePath} Probe.query: exemption reason is empty`,
    ]);
    expect(unreasoned.offenders).toHaveLength(1);
  });
});

describe('V5-P14 surface traceability inventory', () => {
  test('the literal-copy gate sees JSX expression and template literals, but not catalog keys', () => {
    const findings = literalCopy(
      'synthetic-copy-probe.tsx',
      "const Probe = ({ name }) => <><p>{true ? 'Visible choice' : t('copy.key')}</p><input aria-label={`Select ${name}`} /><p>{t('other.key')}</p></>;",
    );

    expect(findings.some((finding) => finding.includes('Visible choice'))).toBe(true);
    expect(findings.some((finding) => finding.includes('Select …'))).toBe(true);
    expect(findings.some((finding) => finding.includes('copy.key'))).toBe(false);
    expect(findings.some((finding) => finding.includes('other.key'))).toBe(false);
  });

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
      .filter((path) => !registeredPaths.has(path) && !isAddressableControlSurface(path))
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
          ['covered', 'unverified', 'not-applicable', 'hidden-by-design'],
          `${surface.id}: ${state}`,
        ).toContain(review.status);
        expect(review.evidence, `${surface.id}: ${state} evidence`).not.toHaveLength(0);
      }
    }
  });

  test('verifies async-state claims against component code and freezes the existing debt', () => {
    const components = V5_SURFACE_INVENTORY.flatMap((surface) => surface.components);
    const result = analyzeAsyncReadStates(components, V5_ASYNC_READ_EXEMPTIONS);
    const report = formatAsyncReadOffenders(result.offenders);
    const boundary = components.flatMap((component) => nonHookAsyncSites(component));

    console.info(
      `V5 async-state debt (${result.offenders.length} of ${result.reads.length} read sites):\n${report}\n\n` +
        `Outside this gate by scope (#1025: "useQuery / useResource and the established wrappers") — ` +
        `${boundary.length} effect-driven or external-store loaders on inventoried surfaces, remediation owned by #739:\n` +
        formatNonHookAsyncSites(boundary),
    );

    expect(
      result.reads.length,
      'The source-derived async-read universe changed; review every added or removed site and update the exact baseline.',
    ).toBe(V5_ASYNC_READ_SITE_BASELINE);

    expect(
      result.invalidExemptions,
      `Invalid V5 async-read exemptions:\n${result.invalidExemptions.join('\n')}`,
    ).toEqual([]);
    expect(
      result.staleExemptions,
      `Async-read exemptions whose state is now observed or whose read disappeared; remove them:\n${result.staleExemptions.join('\n')}`,
    ).toEqual([]);

    const actualDebt = debtRows(result.offenders);
    const expectedDebt = Object.entries(V5_ASYNC_STATE_DEBT)
      .flatMap(([component, reads]) =>
        Object.entries(reads).map(([read, states]) => ({ component, read, states })),
      )
      .sort(compareComponentRead);
    expect(
      {
        readSites: expectedDebt.length,
        stateGaps: expectedDebt.reduce((total, row) => total + row.states.length, 0),
      },
      'The V5 async-state debt ceiling is a downward-only ratchet. Lower it with remediation; never raise it for a new offender.',
    ).toEqual(V5_ASYNC_STATE_DEBT_CEILING);
    expect(
      actualDebt,
      `V5 async-state debt changed. New offenders are forbidden; remove fixed rows from V5_ASYNC_STATE_DEBT so the ledger only shrinks.\n\nFull current offender list:\n${report}`,
    ).toEqual(expectedDebt);

    const projectionReads = result.reads.filter(
      (read) => read.component === 'user/forecast/ProjectionSection.tsx',
    );
    const projectionErrors = result.offenders.filter(
      (offender) =>
        offender.component === 'user/forecast/ProjectionSection.tsx' &&
        offender.states.includes('error'),
    );
    expect(projectionReads, 'ProjectionSection async reads').toHaveLength(5);
    expect(
      projectionErrors,
      `ProjectionSection must keep all five read errors out of the worklist.\n${report}`,
    ).toHaveLength(0);

    const declaredBoundary = V5_NON_HOOK_ASYNC_BOUNDARY.map(
      (site) => `${site.component} ${site.site}`,
    );
    expect(
      V5_NON_HOOK_ASYNC_BOUNDARY.filter((site) => site.note.trim().length === 0),
      'Every declared boundary site records why the gate does not analyze it.',
    ).toEqual([]);
    expect(declaredBoundary).toHaveLength(new Set(declaredBoundary).size);
    expect(
      boundary.map((site) => `${site.component} ${site.site}`).sort(),
      `Effect-driven and external-store loaders on inventoried surfaces are outside this gate by scope, but never unnamed. Record each new one in V5_NON_HOOK_ASYNC_BOUNDARY with its note, and drop the ones that are gone.\n${formatNonHookAsyncSites(boundary)}`,
    ).toEqual([...declaredBoundary].sort());

    const reviewedSurfaces: readonly V5SurfaceReview[] = V5_SURFACE_INVENTORY;
    const coveredClaimFindings = reviewedSurfaces.flatMap((surface) =>
      coveredStateClaimFindings(surface, result),
    );
    expect(
      coveredClaimFindings,
      `Mechanically covered state claims do not match component code:\n${coveredClaimFindings.join('\n')}`,
    ).toEqual([]);
    // This gate parses every inventoried component and walks 179 async read
    // sites; on a shared CI runner it lands around 20s, which is exactly the
    // suite default. That made it fail on runner load rather than on a defect —
    // it took main red and blocked every open PR, including the remediation
    // work it exists to guard. An exhaustive AST sweep is the wrong thing to
    // hold to a wall clock, so give it room; a real regression still fails on
    // the assertions above, not on the timer.
  }, 180_000);

  test('keeps every deferred non-V5 async-state offender named and non-growing', () => {
    const components = NON_V5_SURFACES.map((surface) => surface.path);
    const result = analyzeAsyncReadStates(components, []);
    const report = formatAsyncReadOffenders(result.offenders);
    const actualDebt = debtRows(result.offenders);
    const expectedDebt = Object.entries(DEFERRED_NON_V5_ASYNC_STATE_DEBT)
      .flatMap(([component, reads]) =>
        Object.entries(reads).map(([read, states]) => ({ component, read, states })),
      )
      .sort(compareComponentRead);

    console.info(
      `Deferred non-V5 async-state debt (${result.offenders.length} of ${result.reads.length} read sites):\n${report}`,
    );

    expect(
      result.reads.length,
      'The deferred non-V5 async-read universe changed; review the source-derived ledger instead of silently narrowing it.',
    ).toBe(DEFERRED_NON_V5_ASYNC_READ_SITE_BASELINE);
    expect(
      {
        readSites: expectedDebt.length,
        stateGaps: expectedDebt.reduce((total, row) => total + row.states.length, 0),
      },
      'The deferred non-V5 debt ceiling may only shrink when v6 remediates a named offender.',
    ).toEqual(DEFERRED_NON_V5_ASYNC_STATE_DEBT_CEILING);
    expect(
      actualDebt,
      `Deferred non-V5 async-state debt changed. New offenders are forbidden; remove fixed rows when v6 pays them down.\n\nFull current offender list:\n${report}`,
    ).toEqual(expectedDebt);
    // Same exhaustive-AST-sweep budget as the gate above: this walk must fail on
    // a new offender, never on a loaded CI runner's clock.
  }, 180_000);

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
