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

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test('mobile suite remains usable without horizontal page overflow', async ({ page }) => {
  const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(mobileNav).toBeVisible();
  await expectNoHorizontalOverflow(page);

  for (const destination of ['Portfolios', 'Workbench', 'Assets']) {
    await mobileNav.getByRole('button', { name: destination }).click();
    await expectNoHorizontalOverflow(page);
  }

  await mobileNav.getByRole('button', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Customize' }).click();
  const customize = page.getByRole('dialog', { name: 'Customize BetterTrack' });
  await customize.getByRole('button', { name: 'People' }).click();
  await customize.getByRole('button', { name: 'Done' }).click();
  await expect(mobileNav.getByRole('button', { name: 'People' })).toBeVisible();
  await expect(mobileNav.getByRole('button', { name: 'Assets' })).toHaveCount(0);
  await page.reload();
  await expect(mobileNav.getByRole('button', { name: 'People' })).toBeVisible();

  await mobileNav.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog', { name: 'Create' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('dialog', { name: 'Create' }).getByRole('button', { name: 'Close' }).click();
});

test('cash workspace and expense flow stay contained on a phone', async ({ page }) => {
  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await page
    .getByRole('navigation', { name: 'Mobile navigation' })
    .getByRole('button', { name: 'Portfolios' })
    .click();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Cash flow' }).click();

  await expect(page.getByText('Total available cash', { exact: true })).toBeVisible();
  await expect(page.getByText('Cash accounts', { exact: true })).toBeVisible();
  await expect(page.getByText('This month', { exact: true })).toBeVisible();
  await expect(page.getByText('Upcoming 14 days', { exact: true })).toBeVisible();
  await expect(page.getByText('Recent activity', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const expenseAction = page.getByRole('button', { name: 'Expense', exact: true }).first();
  await expenseAction.scrollIntoViewIfNeeded();
  await expect(expenseAction).toBeVisible();
  await expenseAction.click();

  const expense = page.getByRole('dialog', { name: 'Record expense' });
  await expect(expense).toBeVisible();
  await expect(expense.getByLabel('Expense amount')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expense.getByRole('button', { name: 'Close' }).click();
});

test('secondary surfaces adapt to a phone viewport', async ({ page }) => {
  const openModes = async () => {
    await page.getByLabel('Open demo preview modes').click();
    return page.getByRole('dialog', { name: 'Preview modes' });
  };

  for (const surface of ['Onboarding', 'Settings', 'Public share', 'Advisor', 'Admin']) {
    const modes = await openModes();
    await modes.getByRole('button', { name: new RegExp(surface, 'i') }).click();
    await expectNoHorizontalOverflow(page);
    await page
      .getByRole('button', { name: /back to suite|exit setup|^back$/i })
      .last()
      .click();
  }
});

test('every visual direction retains the responsive suite contract', async ({ page }) => {
  for (const direction of ['northstar', 'ledger', 'signal', 'atelier', 'prism', 'origin']) {
    await page.getByLabel('Open demo preview modes').click();
    await page
      .getByRole('dialog', { name: 'Preview modes' })
      .getByRole('button', { name: new RegExp(`^${direction}:`, 'i') })
      .click();
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expect.poll(() => page.locator('html').getAttribute('data-direction')).toBe(direction);
  }
});

test('deep Workbench, Assets, and People views stay contained on mobile', async ({ page }) => {
  const cases = [
    {
      destination: 'Workbench',
      nav: '.workbench-tabs',
      tabs: ['Forecasts', 'Blueprints', 'Backtests', 'Compare', 'Ideas', 'Calculators'],
    },
    {
      destination: 'Assets',
      nav: '.asset-tabs',
      tabs: ['Watchlists', 'Discover', 'Screener', 'News', 'Calendar'],
    },
  ] as const;

  for (const item of cases) {
    await page
      .getByRole('navigation', { name: 'Mobile navigation' })
      .getByRole('button', { name: item.destination })
      .click();
    for (const tab of item.tabs) {
      const tabButton = page.locator(item.nav).getByRole('button', { name: tab });
      await tabButton.click();
      await expect(tabButton).toHaveAttribute('aria-current', 'page');
      await expectNoHorizontalOverflow(page);
    }
  }

  await page
    .getByRole('navigation', { name: 'Mobile navigation' })
    .getByRole('button', { name: 'Workbench' })
    .click();
  await page.locator('.workbench-tabs').getByRole('button', { name: 'Alerts' }).click();
  await expect(
    page.getByRole('heading', { name: 'Conditions worth your attention' }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.keyboard.press('Control+k');
  const command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  await command.getByLabel('Search anything').fill('collaboration');
  await command.getByRole('button', { name: /open collaboration workspace/i }).click();
  for (const tab of ['Clients', 'Teams', 'Shared with me', 'Updates']) {
    const tabButton = page
      .locator('.people-tabs')
      .getByRole('button', { name: new RegExp(`^${tab}`) });
    await tabButton.click();
    await expect(tabButton).toHaveAttribute('aria-current', 'page');
    await expectNoHorizontalOverflow(page);
  }
});

test('Developer Platform can replace the fourth mobile destination', async ({ page }) => {
  const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' });
  await page.getByRole('button', { name: 'Customize' }).click();
  const customize = page.getByRole('dialog', { name: 'Customize BetterTrack' });
  await customize.getByRole('button', { name: 'Develop' }).click();
  await customize.getByRole('button', { name: 'Done' }).click();

  await mobileNav.getByRole('button', { name: 'Developer' }).click();
  await expect(page.getByRole('heading', { name: 'Developer', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const developerTabs = page.getByRole('tablist', { name: 'Developer sections' });
  for (const tab of ['API keys', 'OAuth apps', 'Webhooks', 'MCP', 'Logs']) {
    await developerTabs.getByRole('tab', { name: new RegExp(`^${tab}`, 'i') }).click();
    await expectNoHorizontalOverflow(page);
  }
});

test('Origin trade, import, Review, and Connections stay contained on a phone', async ({
  page,
}) => {
  const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' });

  await mobileNav.getByRole('button', { name: 'Assets' }).click();
  await page.getByLabel('Search assets').fill('Microsoft');
  await page
    .locator('.origin-asset-search-results')
    .getByRole('button', { name: /MSFT.*Microsoft/i })
    .click();
  await page.getByRole('button', { name: 'Add to portfolio' }).click();
  const trade = page.getByRole('dialog', { name: 'Buy MSFT' });
  await expectNoHorizontalOverflow(page);
  await trade.getByRole('button', { name: 'Review order' }).click();
  await expect(trade.getByText(/review market order/i)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await trade.getByRole('button', { name: 'Close' }).click();

  await page.keyboard.press('Control+k');
  let command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  await command.getByLabel('Search anything').fill('import');
  await command.getByRole('button', { name: /import and reconcile portfolio data/i }).click();
  const importFlow = page.getByRole('dialog', { name: 'Import into Personal wealth' });
  await expectNoHorizontalOverflow(page);
  await importFlow.getByRole('button', { name: 'Set up source' }).click();
  await expectNoHorizontalOverflow(page);
  await importFlow.getByRole('button', { name: 'Close import' }).click();

  await page.keyboard.press('Control+k');
  command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  await command.getByLabel('Search anything').fill('connections');
  await command.getByRole('button', { name: /manage connections/i }).click();
  const connections = page.getByRole('dialog', { name: 'Connections' });
  await expectNoHorizontalOverflow(page);
  await connections.locator('.ocn-connection-row').filter({ hasText: 'Parqet' }).click();
  await expectNoHorizontalOverflow(page);
  await connections.getByRole('button', { name: /conflicts/i }).click();
  await expectNoHorizontalOverflow(page);
  await connections.getByRole('button', { name: 'Close connections' }).click();

  await page.keyboard.press('Control+k');
  command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  await command.getByLabel('Search anything').fill('review');
  await command.getByRole('button', { name: /review uncategorized activity/i }).click();
  await expect(page.getByRole('dialog', { name: 'Review Center' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('Origin portfolio truth, continuity, and data health stay deliberate on a phone', async ({
  page,
}) => {
  await page.keyboard.press('Control+k');
  const command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  await command.getByLabel('Search anything').fill('Personal wealth');
  await command.getByRole('button', { name: /open personal wealth/i }).click();
  await expect(page.locator('.scope-button')).toContainText('Personal wealth');
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: /open data health, current quality 96 percent/i }).click();
  const health = page.getByRole('dialog', { name: 'Personal wealth data health' });
  await expect(health.getByRole('heading', { name: 'Data health' })).toBeVisible();
  await expect
    .poll(() =>
      health
        .getByPlaceholder('Search portfolio objects, fields, sources…')
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThan(280);
  await expectNoHorizontalOverflow(page);
  await health.getByRole('tab', { name: /check policies/i }).click();
  await expectNoHorizontalOverflow(page);
  await health.getByRole('button', { name: 'Close data health' }).click();

  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Plan' }).click();
  await page
    .getByRole('tablist', { name: 'Plan sections' })
    .getByRole('tab', { name: /protection & continuity/i })
    .click();
  await expect(page.locator('.origin-continuity')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const handoffTrigger = page.getByRole('button', { name: 'Prepare handoff' });
  await handoffTrigger.click();
  await expect(
    page.getByRole('dialog', { name: 'Prepare the minimum useful package' }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(handoffTrigger).toBeFocused();
});

test('Origin structure, portfolio events, and rebalance stay contained on a phone', async ({
  page,
}) => {
  await page.keyboard.press('Control+k');
  const command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  await command.getByLabel('Search anything').fill('Personal wealth');
  await command.getByRole('button', { name: /open personal wealth/i }).click();

  await page.getByRole('button', { name: 'Portfolio structure' }).click();
  const structure = page.getByRole('dialog', {
    name: 'Personal wealth portfolio structure',
  });
  await expect(structure.getByRole('heading', { name: 'Portfolio structure' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await structure.getByRole('tab', { name: 'Ownership' }).click();
  await expectNoHorizontalOverflow(page);
  await structure.getByRole('button', { name: 'Close portfolio structure' }).click();

  await page
    .locator('.portfolio-tabs')
    .getByRole('button', { name: /^Activity/ })
    .click();
  await page.getByRole('button', { name: 'Portfolio events' }).click();
  const events = page.getByRole('dialog', { name: 'Events inbox' });
  await expect(events.getByRole('heading', { name: 'Events inbox' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await events.getByRole('tab', { name: /Audit & receipts/ }).click();
  await expectNoHorizontalOverflow(page);
  await events.getByRole('button', { name: 'Close portfolio events' }).click();

  await page
    .getByRole('navigation', { name: 'Mobile navigation' })
    .getByRole('button', { name: 'Workbench' })
    .click();
  await page.locator('.workbench-tabs').getByRole('button', { name: 'Rebalance' }).click();
  await expect(page.getByRole('heading', { name: 'Constraint-aware rebalance' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Calculate exact plan' }).click();
  await expect(page.getByRole('button', { name: 'Submit exact plan' })).toBeEnabled({
    timeout: 5_000,
  });
  await expectNoHorizontalOverflow(page);
});

test('portfolio settings and private markets remain complete mobile workspaces', async ({
  page,
}) => {
  await page.keyboard.press('Control+k');
  let command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  await command.getByLabel('Search anything').fill('Personal wealth');
  await command.getByRole('button', { name: /open personal wealth/i }).click();

  await page.getByRole('button', { name: 'Portfolio settings' }).click();
  const settings = page.getByRole('dialog', {
    name: 'Personal wealth portfolio settings',
  });
  await expect(settings.getByTestId('settings-view-overview')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await settings.getByTestId('settings-tab-calculation').click();
  await expect(settings.getByTestId('settings-view-calculation')).toBeVisible();
  await expect(settings.getByRole('heading', { name: 'Performance calculation' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await settings.getByRole('button', { name: 'Close portfolio settings' }).click();

  await page.keyboard.press('Control+k');
  command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  await command.getByLabel('Search anything').fill('private-market');
  await command.getByRole('button', { name: /manage private-market commitments/i }).click();
  const privateMarkets = page.getByTestId('origin-private-markets');
  await expect(privateMarkets.getByRole('heading', { name: 'Private markets' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await privateMarkets.getByRole('tab', { name: /Cash plan/ }).click();
  await expect(
    privateMarkets.getByRole('heading', { name: 'Capital-call coverage' }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await privateMarkets
    .getByTestId('private-call-call_horizon_aug')
    .getByRole('button', { name: /Prepare funding/ })
    .click();
  const capitalCall = privateMarkets.getByTestId('private-markets-capital-call-dialog');
  await expect(
    capitalCall.getByRole('heading', { name: 'Prepare capital-call funding' }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
