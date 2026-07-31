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
  V5_ASYNC_READ_EXEMPTIONS,
  V5_ASYNC_STATE_DEBT,
  V5_ASYNC_STATE_DEBT_CEILING,
  V5_SURFACE_INVENTORY,
  type V5AsyncReadExemption,
  type V5AsyncReadState,
  type V5AsyncStateDebt,
  type V5SurfaceReview,
} from './v5SurfaceInventory';
import { matchControlPanel } from '../user/control/ControlCenterOverlay';

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
user/portfolio/cashflow/CashflowChart.tsx
user/portfolio/cashflow/MonthPicker.tsx
user/portfolio/cashflow/RecordCashButton.tsx
user/portfolio/cashflow/RecordCashDialog.tsx
user/portfolio/cashflow/SectionHead.tsx
user/portfolio/cashflow/TagChip.tsx
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

const ASYNC_READ_HOOKS = new Set([
  'useActivePortfolio',
  'useAiCapability',
  'useInfiniteQuery',
  'usePortfoliosQuery',
  'useQuery',
  'useResource',
  'useWatchlistMembership',
]);

const ASYNC_STATE_PROPERTIES: Record<V5AsyncReadState, ReadonlySet<string>> = {
  loading: new Set([
    'isFetching',
    'isInitialLoading',
    'isLoading',
    'isPending',
    'isRefetching',
    'loading',
  ]),
  error: new Set(['error', 'isError', 'isLoadingError', 'isRefetchError']),
};

const ASYNC_READ_STATES = ['loading', 'error'] as const satisfies readonly V5AsyncReadState[];

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
  resultName?: string;
  directProperties: readonly {
    property: string;
    localName: string | null;
    localStart: number;
  }[];
}

interface RawAsyncRead {
  component: string;
  hook: string;
  line: number;
  readBase: string;
  binding: ReadBinding;
  scope: ts.Node;
}

function asyncHookName(node: ts.CallExpression): string | null {
  if (!ts.isIdentifier(node.expression)) return null;
  return ASYNC_READ_HOOKS.has(node.expression.text) ? node.expression.text : null;
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
      return { label: parent.name.text, resultName: parent.name.text, directProperties: [] };
    }
    if (ts.isObjectBindingPattern(parent.name)) {
      const properties = parent.name.elements.map((element) => ({
        property: (element.propertyName ?? element.name).getText(sourceFile),
        localName: ts.isIdentifier(element.name) ? element.name.text : null,
        localStart: element.name.getStart(sourceFile),
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
  seenBindings: Set<string>,
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
      const key = `${parent.name.text}\0${parent.name.getStart()}`;
      if (seenBindings.has(key)) return false;
      seenBindings.add(key);
      return bindingIsRendered(scope, parent.name.text, parent.name.getStart(), seenBindings);
    }
    if (isFunctionScope(parent) && parent !== scope) return false;
    current = parent;
  }
  return false;
}

function bindingIsRendered(
  scope: ts.Node,
  localName: string | null,
  localStart: number,
  seenBindings = new Set<string>(),
): boolean {
  if (localName === null) return false;
  let rendered = false;
  const visit = (node: ts.Node): void => {
    if (rendered) return;
    if (
      ts.isIdentifier(node) &&
      node.text === localName &&
      node.getStart() !== localStart &&
      isIdentifierUse(node) &&
      stateReferenceIsRendered(node, scope, seenBindings)
    ) {
      rendered = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return rendered;
}

function propertyStateObservations(raw: RawAsyncRead): ReadonlySet<V5AsyncReadState> {
  const observed = new Set<V5AsyncReadState>();

  const observePropertiesOf = (resultName: string) => {
    const recordProperty = (property: string, reference: ts.Node) => {
      const state = stateForProperty(property);
      if (state && stateReferenceIsRendered(reference, raw.scope, new Set())) observed.add(state);
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === resultName
      ) {
        recordProperty(node.name.text, node);
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === resultName &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression)
      ) {
        recordProperty(node.argumentExpression.text, node);
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === resultName &&
        ts.isObjectBindingPattern(node.name)
      ) {
        for (const element of node.name.elements) {
          if (
            bindingIsRendered(
              raw.scope,
              ts.isIdentifier(element.name) ? element.name.text : null,
              element.name.getStart(),
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
    if (state && bindingIsRendered(raw.scope, property.localName, property.localStart)) {
      observed.add(state);
    }
    if (property.localName) observePropertiesOf(property.localName);
  }
  if (!raw.binding.resultName) return observed;
  observePropertiesOf(raw.binding.resultName);
  return observed;
}

function rawAsyncReads(relativePath: string, sourceText?: string): RawAsyncRead[] {
  const sourceFile = parseTsx(relativePath, sourceText);
  const reads: RawAsyncRead[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const hook = asyncHookName(node);
      if (hook) {
        const scope = readScope(node, sourceFile);
        const binding = readBinding(node, sourceFile);
        reads.push({
          component: relativePath,
          hook,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          readBase: `${scope.name}.${binding.label}`,
          binding,
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
      observed: propertyStateObservations(raw),
    };
  });
}

function analyzeAsyncReadStates(
  components: readonly string[],
  exemptions: readonly V5AsyncReadExemption[],
  sourceTextByComponent: Readonly<Record<string, string>> = {},
): AsyncReadGateResult {
  const reads = components.flatMap((component) =>
    nameAsyncReads(rawAsyncReads(component, sourceTextByComponent[component])),
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

function conditionBindingControlsRenderedJsx(
  scope: ts.Node,
  localName: string,
  localStart: number,
  seenBindings: Set<string>,
): boolean {
  let rendered = false;
  const visit = (node: ts.Node): void => {
    if (rendered) return;
    if (
      ts.isIdentifier(node) &&
      node.text === localName &&
      node.getStart() !== localStart &&
      isIdentifierUse(node) &&
      conditionControlsRenderedJsx(node, scope, seenBindings)
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
  seenBindings = new Set<string>(),
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
      const key = `${parent.name.text}\0${parent.name.getStart()}`;
      if (seenBindings.has(key)) return false;
      seenBindings.add(key);
      return conditionBindingControlsRenderedJsx(
        scope,
        parent.name.text,
        parent.name.getStart(),
        seenBindings,
      );
    }
    if (isFunctionScope(parent) && parent !== scope) return false;
    current = parent;
  }
  return false;
}

function hasEmptyStateSignal(relativePath: string, sourceText?: string): boolean {
  const sourceFile = parseTsx(relativePath, sourceText);
  let found = false;
  const isLength = (node: ts.Node) =>
    ts.isPropertyAccessExpression(node) && node.name.text === 'length';
  const isZero = (node: ts.Node) => ts.isNumericLiteral(node) && Number(node.text) === 0;
  const reachesRenderedJsx = (node: ts.Node) =>
    stateReferenceIsRendered(node, readScope(node, sourceFile).node, new Set());
  const controlsRenderedJsx = (node: ts.Node) =>
    conditionControlsRenderedJsx(node, readScope(node, sourceFile).node);
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

    console.info(
      `V5 async-state debt (${result.offenders.length} of ${result.reads.length} read sites):\n${report}`,
    );

    expect(
      result.reads.length,
      'The async-hook walk unexpectedly found too few reads; update the established wrapper list rather than silently shrinking the gate.',
    ).toBeGreaterThan(100);

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
      `ProjectionSection must remain visible in the worklist until all five read errors are handled.\n${report}`,
    ).toHaveLength(5);

    const reviewedSurfaces: readonly V5SurfaceReview[] = V5_SURFACE_INVENTORY;
    const coveredClaimFindings = reviewedSurfaces.flatMap((surface) =>
      coveredStateClaimFindings(surface, result),
    );
    expect(
      coveredClaimFindings,
      `Mechanically covered state claims do not match component code:\n${coveredClaimFindings.join('\n')}`,
    ).toEqual([]);
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
