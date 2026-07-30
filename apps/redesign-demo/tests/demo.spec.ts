import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('bt-demo-test-ready')) {
      Object.keys(window.localStorage)
        .filter((key) => key.startsWith('bt-demo-'))
        .forEach((key) => window.localStorage.removeItem(key));
      window.localStorage.removeItem('bettertrack-origin-first-run-v1');
      window.localStorage.setItem('bt-demo-theme', JSON.stringify('dark'));
      window.sessionStorage.setItem('bt-demo-test-ready', 'true');
    }
  });
  await page.goto('/');
});

test('the connected suite supports its core portfolio workflow', async ({ page }) => {
  await expect(page.locator('.wealth-card--detailed')).toBeVisible();

  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await expect(page.getByRole('button', { name: /personal wealth/i }).first()).toBeVisible();

  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await expect(
    page.locator('.portfolio-tabs').getByRole('button', { name: 'Overview' }),
  ).toHaveAttribute('aria-current', 'page');

  for (const tab of [
    'Activity',
    'Holdings',
    'Cash flow',
    'Analysis',
    'Tax',
    'Plan',
    'Automate',
    'Files',
    'People',
    'Overview',
  ]) {
    const tabButton = page
      .locator('.portfolio-tabs')
      .getByRole('button', { name: new RegExp(`^${tab}`) });
    await tabButton.click();
    await expect(tabButton).toHaveClass(/is-active/);
  }

  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /workbench/i })
    .click();
  await expect(page.getByRole('heading', { name: 'Workbench', exact: true })).toBeVisible();
  const contribution = page.locator('input[type="range"]');
  await contribution.fill('500');
  await expect(page.getByText('€500', { exact: true })).toBeVisible();
  for (const tab of ['Forecasts', 'Blueprints', 'Backtests', 'Compare', 'Ideas', 'Calculators']) {
    const tabButton = page.locator('.workbench-tabs').getByRole('button', { name: tab });
    await tabButton.click();
    await expect(tabButton).toHaveClass(/is-active/);
    await expect(page.locator('.workbench-secondary')).toBeVisible();
  }
  const alertsTab = page.locator('.workbench-tabs').getByRole('button', { name: 'Alerts' });
  await alertsTab.click();
  await expect(alertsTab).toHaveClass(/is-active/);
  await expect(
    page.getByRole('heading', { name: 'Conditions worth your attention' }),
  ).toBeVisible();
  await page.locator('.workbench-tabs').getByRole('button', { name: 'Studio' }).click();
  await page.getByRole('button', { name: /review to apply/i }).click();
  await expect(page.getByRole('dialog', { name: 'Review scenario' })).toBeVisible();
  await page.getByRole('button', { name: /keep editing/i }).click();

  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /assets/i })
    .click();
  await expect(page.getByRole('heading', { name: 'Assets', exact: true })).toBeVisible();
  for (const tab of ['Watchlists', 'Discover', 'Screener', 'News', 'Calendar']) {
    const tabButton = page.locator('.asset-tabs').getByRole('button', { name: tab });
    await tabButton.click();
    await expect(tabButton).toHaveClass(/is-active/);
    await expect(page.locator('.asset-secondary')).toBeVisible();
  }
  await page.locator('.asset-tabs').getByRole('button', { name: 'Overview' }).click();
  await page.locator('.market-list > button').filter({ hasText: 'Microsoft' }).click();
  await expect(page.locator('.asset-detail-header')).toContainText('MSFT · NASDAQ');

  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /people/i })
    .click();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  for (const tab of ['Clients', 'Teams', 'Shared with me', 'Updates']) {
    const tabButton = page
      .locator('.people-tabs')
      .getByRole('button', { name: new RegExp(`^${tab}`) });
    await tabButton.click();
    await expect(tabButton).toHaveClass(/is-active/);
    await expect(page.locator('.people-secondary')).toBeVisible();
  }

  await page
    .locator('.page-intro__actions')
    .getByRole('button', { name: 'Invite', exact: true })
    .click();
  const inviteDialog = page.getByRole('dialog', { name: 'Invite a collaborator' });
  await inviteDialog.getByLabel('Collaborator email address').fill('new.member@example.com');
  await inviteDialog.getByLabel('Collaborator role').selectOption('Editor');
  await inviteDialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.locator('.toast')).toContainText('new.member@example.com');
  await expect(page.locator('.pending-collaborator')).toContainText('Editor access');
});

test('creation, connection, and AI proposal flows behave like a real product', async ({ page }) => {
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: 'Create' });
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel('Name').fill('Quarterly tax payment');
  await createDialog.locator('.amount-field input').fill('425');
  await createDialog.getByRole('button', { name: 'Add expense' }).click();
  await expect(page.getByText('Quarterly tax payment', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('added to the portfolio activity');

  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Files', exact: true }).click();
  await page.locator('.od-drive-bar').getByRole('button', { name: 'Connect' }).click();
  const connections = page.getByRole('dialog', { name: 'Connections' });
  await connections.locator('.ocn-connection-row').filter({ hasText: 'Google Drive' }).click();
  await connections.locator('.ocn-action-menu > button').click();
  await connections.getByRole('button', { name: 'Reauthorize connection' }).click();
  await expect(connections.getByRole('status')).toContainText('Provider reauthorized');
  await connections.getByRole('button', { name: 'Close connections' }).click();
  await expect(page.getByText(/google drive document source/i)).toBeVisible();

  await page.keyboard.press('Control+j');
  const assistant = page.getByRole('dialog', { name: 'Ask BetterTrack' });
  await expect(assistant).toBeVisible();
  await assistant.getByRole('button', { name: /what if i invest €200 monthly/i }).click();
  await expect(assistant.getByText(/€33,000–€39,000/)).toBeVisible();
  await assistant.getByRole('button', { name: /prepare a €200 monthly automation/i }).click();
  await expect(assistant.getByText(/action proposal · not applied/i)).toBeVisible();
  await expect(assistant.getByRole('button', { name: /review permissions/i })).toBeVisible();
});

test('auth, onboarding, settings, sharing, advisor, and admin surfaces are reachable', async ({
  page,
}) => {
  const openModes = async () => {
    await page.locator('.account-button').click();
    return page.getByRole('dialog', { name: 'Preview modes' });
  };

  let modes = await openModes();
  await modes.getByRole('button', { name: /onboarding/i }).click();
  await expect(page.getByRole('heading', { name: /welcome to bettertrack/i })).toBeVisible();
  await page.getByRole('button', { name: 'Exit setup' }).click();

  modes = await openModes();
  await modes.getByRole('button', { name: /authentication/i }).click();
  await page.getByRole('button', { name: 'Google' }).click();
  await page.getByRole('button', { name: /alex morgan/i }).click();
  await page.getByRole('button', { name: /verify and continue/i }).click();
  await expect(page.locator('.wealth-card--detailed')).toBeVisible();

  modes = await openModes();
  await modes.getByRole('button', { name: /settings/i }).click();
  await expect(page.getByRole('heading', { name: 'Account & security' })).toBeVisible();
  for (const section of [
    'Account',
    'Authentication',
    'Sessions',
    'Privacy & AI',
    'Data & Export',
    'Danger',
  ]) {
    await page
      .getByRole('navigation', { name: 'Account settings' })
      .getByRole('button', { name: new RegExp(`^${section}\\b`, 'i') })
      .click();
  }
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  modes = await openModes();
  await modes.getByRole('button', { name: /public share/i }).click();
  await expect(page.getByRole('heading', { name: 'Global Core' })).toBeVisible();
  await page.getByRole('button', { name: '3M' }).click();
  await page
    .getByRole('button', { name: /back to suite/i })
    .last()
    .click();

  modes = await openModes();
  await modes.getByRole('button', { name: /advisor/i }).click();
  await expect(page.getByRole('heading', { name: /your book of business/i })).toBeVisible();
  await page
    .getByRole('button', { name: /back to suite/i })
    .last()
    .click();

  modes = await openModes();
  await modes.getByRole('button', { name: /admin/i }).click();
  await expect(page.getByRole('heading', { name: /system overview/i })).toBeVisible();
  await page.getByRole('button', { name: /integrations/i }).click();
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
});

test('the Design Lab switches and remembers every complete visual system', async ({ page }) => {
  for (const direction of ['Ledger', 'Signal', 'Atelier', 'Prism', 'Northstar', 'Origin']) {
    await page.locator('.account-button').click();
    await page
      .getByRole('dialog', { name: 'Preview modes' })
      .getByRole('button', { name: new RegExp(`^${direction}:`, 'i') })
      .click();
    await expect
      .poll(() => page.locator('html').getAttribute('data-direction'))
      .toBe(direction.toLowerCase());
  }

  await page.reload();
  await expect.poll(() => page.locator('html').getAttribute('data-direction')).toBe('origin');
});

test('Developer Platform simulates credentials, event delivery, MCP, and request logs', async ({
  page,
}) => {
  await page.keyboard.press('Control+k');
  const command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  await command.getByLabel('Search anything').fill('developer');
  await command.getByRole('button', { name: /open developer platform/i }).click();

  await expect(page.getByRole('heading', { name: 'Developer', exact: true })).toBeVisible();
  const developerTabs = page.getByRole('tablist', { name: 'Developer sections' });

  await developerTabs.getByRole('tab', { name: /^API keys/i }).click();
  await page.getByRole('button', { name: 'Create key' }).click();
  let credentialDialog = page.getByRole('dialog', { name: 'Create API key' });
  await credentialDialog.getByLabel(/key name/i).fill('Quarterly export');
  await credentialDialog.getByLabel(/portfolio access/i).selectOption('personal');
  await credentialDialog.getByRole('button', { name: 'Create secure key' }).click();
  credentialDialog = page.getByRole('dialog', { name: 'Your new API key' });
  await expect(credentialDialog).toContainText('Shown once');
  await expect(credentialDialog).toContainText('btk_demo_');
  await credentialDialog.getByRole('button', { name: /i stored these safely/i }).click();
  await expect(page.getByRole('region', { name: 'API keys' })).toContainText('Quarterly export');

  await developerTabs.getByRole('tab', { name: /^OAuth apps/i }).click();
  await page.getByRole('button', { name: 'Register app' }).click();
  credentialDialog = page.getByRole('dialog', { name: 'Register OAuth app' });
  await credentialDialog.getByLabel(/app name/i).fill('Reporting companion');
  await credentialDialog.getByLabel(/^Confidential/i).check();
  await credentialDialog.getByRole('button', { name: 'Register application' }).click();
  credentialDialog = page.getByRole('dialog', { name: 'OAuth credentials' });
  await expect(credentialDialog).toContainText('Client secret');
  await expect(credentialDialog).toContainText('btsec_demo_');
  await credentialDialog.getByRole('button', { name: /i stored these safely/i }).click();
  await expect(page.getByRole('region', { name: 'Registered OAuth apps' })).toContainText(
    'Reporting companion',
  );

  await developerTabs.getByRole('tab', { name: /^Webhooks/i }).click();
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  credentialDialog = page.getByRole('dialog', { name: 'Add webhook endpoint' });
  await credentialDialog.getByLabel(/endpoint name/i).fill('Tax event mirror');
  await credentialDialog.getByLabel(/https endpoint/i).fill('https://example.dev/hooks/tax-events');
  await credentialDialog.getByRole('button', { name: 'Create endpoint' }).click();
  credentialDialog = page.getByRole('dialog', { name: 'Webhook signing secret' });
  await expect(credentialDialog).toContainText('btwhsec_demo_');
  await credentialDialog.getByRole('button', { name: /i stored these safely/i }).click();
  const webhook = page
    .getByRole('region', { name: 'Webhook endpoints' })
    .locator('article')
    .filter({ hasText: 'Tax event mirror' });
  await webhook.getByRole('button', { name: 'Send test' }).click();
  await expect(webhook).toContainText('Just now');

  await developerTabs.getByRole('tab', { name: /^MCP/i }).click();
  await expect(page.getByRole('heading', { name: 'MCP', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rotate token' }).click();
  await expect(page.getByRole('status')).toContainText('MCP access token rotated');

  await developerTabs.getByRole('tab', { name: /^Logs/i }).click();
  await expect(page.getByRole('heading', { name: 'Usage & logs' })).toBeVisible();
  await page.getByLabel('Search request logs').fill('Tax export worker');
  await page.getByLabel('Filter by result').selectOption('error');
  await expect(page.getByRole('table', { name: 'Request logs' })).toContainText(
    'Tax export worker',
  );
  await expect(page.getByRole('table', { name: 'Request logs' })).toContainText('401');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Developer', exact: true })).toBeVisible();
  const restoredTabs = page.getByRole('tablist', { name: 'Developer sections' });
  await restoredTabs.getByRole('tab', { name: /^API keys/i }).click();
  await expect(page.getByRole('region', { name: 'API keys' })).toContainText('Quarterly export');
  await restoredTabs.getByRole('tab', { name: /^OAuth apps/i }).click();
  await expect(page.getByRole('region', { name: 'Registered OAuth apps' })).toContainText(
    'Reporting companion',
  );
  await restoredTabs.getByRole('tab', { name: /^Webhooks/i }).click();
  await expect(page.getByRole('region', { name: 'Webhook endpoints' })).toContainText(
    'Tax event mirror',
  );
});
