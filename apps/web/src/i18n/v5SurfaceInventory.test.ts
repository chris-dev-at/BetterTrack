import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { LOCALES, localizedMessage, type MessageNode } from './registry';
import { V5_SURFACE_INVENTORY } from './v5SurfaceInventory';

const SRC_ROOT = resolve(process.cwd(), 'src');

function baseline(value: string): string[] {
  return value.trim().split('\n').sort();
}

/**
 * Frozen V5 component baseline, assembled from the P0–P13 phase history and
 * the shared shell surfaces those changes pass through. Keeping this separate
 * from the inventory is deliberate: deleting a row from the inventory must
 * fail loudly instead of quietly narrowing the audit.
 */
const EXPECTED_V5_COMPONENTS = baseline(`
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

describe('V5-P14 surface traceability inventory', () => {
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

  test('contains no literal user-facing copy in an inventoried TSX surface', () => {
    const userFacingAttributes = new Set([
      'alt',
      'aria-label',
      'ariaLabel',
      'description',
      'label',
      'placeholder',
      'subtitle',
      'title',
    ]);
    const allowedTechnicalValues = new Set(['http://localhost:11434', 'llama3.1:8b']);
    const findings: string[] = [];

    for (const relativePath of EXPECTED_V5_COMPONENTS) {
      const absolutePath = resolve(SRC_ROOT, relativePath);
      const source = readFileSync(absolutePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        absolutePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );

      const record = (node: ts.Node, value: string) => {
        const normalized = value.replace(/\s+/g, ' ').trim();
        if (
          !/[A-Za-zÄÖÜäöüß]{2}/.test(normalized) ||
          /^&[a-z]+;$/.test(normalized) ||
          allowedTechnicalValues.has(normalized)
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
          userFacingAttributes.has(node.name.getText(sourceFile)) &&
          node.initializer &&
          ts.isStringLiteral(node.initializer)
        ) {
          record(node, node.initializer.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(findings, `literal UI copy:\n${findings.join('\n')}`).toEqual([]);
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
