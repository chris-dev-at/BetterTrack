import { expect, test, type Page } from '@playwright/test';

const wizardStorageKey = 'bettertrack-origin-first-run-v1';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((firstRunKey) => {
    if (!window.sessionStorage.getItem('bt-origin-deep-test-ready')) {
      Object.keys(window.localStorage)
        .filter((key) => key.startsWith('bt-demo-'))
        .forEach((key) => window.localStorage.removeItem(key));
      window.localStorage.removeItem(firstRunKey);
      window.localStorage.setItem('bt-demo-direction-v2', JSON.stringify('origin'));
      window.localStorage.setItem('bt-demo-theme', JSON.stringify('dark'));
      window.sessionStorage.setItem('bt-origin-deep-test-ready', 'true');
    }
  }, wizardStorageKey);
  await page.goto('/');
  await expect.poll(() => page.locator('html').getAttribute('data-direction')).toBe('origin');
});

async function openCommand(page: Page, query: string, action: RegExp) {
  await page.keyboard.press('Control+k');
  const command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  await expect(command).toBeVisible();
  await command.getByLabel('Search anything').fill(query);
  await command.getByRole('button', { name: action }).click();
}

async function advanceFirstRun(page: Page) {
  await page.locator('.ofr-actions').getByRole('button', { name: 'Continue' }).click();
}

test('Home attention and the global Review Center share one persistent queue', async ({ page }) => {
  const attention = page.locator('.review-card');
  await expect(attention.getByRole('heading', { name: 'Needs your attention' })).toBeVisible();
  await expect(attention.getByRole('button', { name: /Review all \(5\)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '5 items need review' })).toBeVisible();

  const importRow = attention
    .locator('.review-item')
    .filter({ hasText: 'Approve July Drive import' });
  await importRow.getByRole('button', { name: 'Inspect' }).click();
  const review = page.getByRole('dialog', { name: 'Review Center' });
  await expect(review.getByRole('heading', { name: 'Approve July Drive import' })).toBeVisible();
  await review.getByRole('button', { name: 'Approve change' }).click();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Confirm approval' }).click();
  await review.getByRole('button', { name: 'Close Review Center' }).click();

  await expect(attention.getByRole('button', { name: /Review all \(4\)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '4 items need review' })).toBeVisible();
  await expect(importRow).toHaveCount(0);

  await attention.getByRole('button', { name: /Review all \(4\)/ }).click();
  await expect(page.getByRole('dialog', { name: 'Review Center' })).toBeVisible();
});

test('command search supports real keyboard navigation and restores its trigger', async ({
  page,
}) => {
  const trigger = page.getByRole('button', { name: /search anything/i }).first();
  await trigger.click();
  let command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  const search = command.getByLabel('Search anything');
  await expect(search).toBeFocused();
  await search.press('ArrowDown');
  await expect(command.getByRole('button', { name: /add an expense/i })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await search.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Create' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Create' }).getByRole('button', { name: 'Close' }).click();

  await trigger.click();
  command = page.getByRole('dialog', { name: 'Search BetterTrack' });
  for (let index = 0; index < 18; index += 1) await page.keyboard.press('Tab');
  await expect
    .poll(() =>
      command.evaluate((element) =>
        element.contains(document.activeElement) ? 'inside-command' : 'escaped',
      ),
    )
    .toBe('inside-command');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('cash workspace brings balances, planning, and cash actions into one view', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Cash flow' }).click();

  await expect(page.getByText('Total available cash', { exact: true })).toBeVisible();
  await expect(page.getByText('€35,492.87', { exact: true })).toBeVisible();

  const cashAccountsLabel = page.getByText('Cash accounts', { exact: true });
  await expect(cashAccountsLabel).toBeVisible();
  const cashAccounts = cashAccountsLabel.locator('xpath=ancestor::section[1]');
  for (const account of ['Cash · Personal wealth', 'Sparkasse •• 1842', 'Trade Republic cash']) {
    await expect(cashAccounts.getByText(account, { exact: true })).toBeVisible();
  }
  await expect(cashAccounts.getByText(/^€[\d,]+\.\d{2}$/).first()).toBeVisible();

  for (const section of ['This month', 'Upcoming 14 days', 'Recent activity']) {
    await expect(page.getByText(section, { exact: true })).toBeVisible();
  }

  for (const action of ['Deposit', 'Expense', 'Transfer']) {
    await expect(page.getByRole('button', { name: action, exact: true }).first()).toBeVisible();
  }

  await page.getByRole('button', { name: 'Expense', exact: true }).first().click();
  const expense = page.getByRole('dialog', { name: 'Record expense' });
  await expect(expense).toBeVisible();
  await expect(expense.getByLabel('Expense amount')).toBeVisible();
  for (const kind of ['Expense', 'Income', 'Transfer']) {
    await expect(expense.getByRole('button', { name: new RegExp(`^${kind}`) })).toBeVisible();
  }
  await expense.getByRole('button', { name: 'Close' }).click();
  await expect(expense).toHaveCount(0);
});

test('an internal transfer records a paired zero-net movement without creating wealth', async ({
  page,
}) => {
  const cashBefore = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('bt-demo-available-cash') || '35492.87'),
  );
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create' });
  await create.getByRole('button', { name: 'Transfer' }).click();
  await create.getByLabel('Amount').fill('725');
  await create.getByLabel('Destination portfolio').selectOption({ label: 'Family reserve' });
  await create.getByRole('button', { name: 'Add transfer' }).click();

  const transfer = page
    .locator('.activity-ledger__row')
    .filter({ hasText: 'Transfer to reserve' })
    .first();
  await expect(transfer).toContainText('Personal wealth → Family reserve');
  await expect(transfer).toContainText('€725.00 · net zero');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(window.localStorage.getItem('bt-demo-available-cash') || '0')),
    )
    .toBe(cashBefore);
});

test('registration activates a complete first workspace and restores it after reload', async ({
  page,
}) => {
  await test.step('move from account registration into the Origin first-run', async () => {
    await page.locator('.account-button').click();
    await page
      .getByRole('dialog', { name: 'Preview modes' })
      .getByRole('button', { name: /authentication/i })
      .click();
    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(
      page.getByRole('heading', { name: 'Create your BetterTrack account' }),
    ).toBeVisible();
    await page.getByRole('button', { name: /create workspace/i }).click();
    await expect(page.getByRole('heading', { name: 'Welcome to BetterTrack' })).toBeVisible();
  });

  await test.step('define account, custody, portfolio structure, and review rhythm', async () => {
    await page.getByRole('button', { name: /interactive demo workspace/i }).click();
    await advanceFirstRun(page);

    await expect(page.getByRole('heading', { name: 'Make this workspace yours' })).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Morgan Reed');
    await advanceFirstRun(page);

    await page.getByRole('button', { name: /track my complete wealth/i }).click();
    await page.getByRole('button', { name: /build with the api/i }).click();
    await advanceFirstRun(page);

    await page.getByRole('button', { name: /google drive data home/i }).click();
    await advanceFirstRun(page);

    await page.getByRole('button', { name: /create a passkey/i }).click();
    await advanceFirstRun(page);

    await page.getByLabel('Tax residency').selectOption({ label: 'Austria' });
    await advanceFirstRun(page);

    await page.getByLabel('Portfolio name').fill('E2E Wealth Hub');
    await advanceFirstRun(page);

    await page.getByRole('button', { name: /build a wealth hub/i }).click();
    await advanceFirstRun(page);

    await page.getByRole('button', { name: /start empty/i }).click();
    await advanceFirstRun(page);

    await expect(page.getByRole('heading', { name: /will start clean/i })).toBeVisible();
    await advanceFirstRun(page);

    await page.getByRole('button', { name: /only me/i }).click();
    await advanceFirstRun(page);

    await page.getByRole('button', { name: /monthly.*first of month/i }).click();
    await advanceFirstRun(page);

    await page.getByRole('button', { name: /this setup looks right/i }).click();
    await page.getByRole('button', { name: 'Build my workspace' }).click();
  });

  await test.step('activate and prove the generated workspace persists', async () => {
    await page.getByRole('button', { name: 'Activate workspace' }).click();
    await expect(page.getByRole('button', { name: 'Open BetterTrack' })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole('button', { name: 'Open BetterTrack' }).click();
    await expect(page.locator('.scope-button')).toContainText('E2E Wealth Hub');

    const persisted = await page.evaluate((firstRunKey) => {
      const firstRun = JSON.parse(window.localStorage.getItem('bt-demo-first-run') || 'null');
      const portfolios = JSON.parse(
        window.localStorage.getItem('bt-demo-created-portfolios') || '[]',
      );
      return {
        wizardDraft: window.localStorage.getItem(firstRunKey),
        portfolioName: firstRun?.portfolio?.name,
        createdNames: portfolios.map((portfolio: { name: string }) => portfolio.name),
      };
    }, wizardStorageKey);
    expect(persisted).toEqual({
      wizardDraft: null,
      portfolioName: 'E2E Wealth Hub',
      createdNames: ['E2E Wealth Hub'],
    });

    await page.reload();
    await expect(page.locator('.scope-button')).toContainText('E2E Wealth Hub');
  });
});

test('asset search creates a reviewed trade receipt and persists cash plus activity', async ({
  page,
}) => {
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /assets/i })
    .click();
  await page.getByLabel('Search assets').fill('Microsoft');
  await page
    .locator('.origin-asset-search-results')
    .getByRole('button', { name: /MSFT.*Microsoft/i })
    .click();
  await expect(page.locator('.asset-detail-header')).toContainText('MSFT · NASDAQ');
  await page.getByRole('button', { name: 'Add to portfolio' }).click();

  const trade = page.getByRole('dialog', { name: 'Buy MSFT' });
  await expect(trade).toBeVisible();
  await trade.getByLabel('Order value').fill('500');
  await trade.getByRole('button', { name: 'Review order' }).click();
  await trade.getByRole('checkbox').check();
  await trade.getByRole('button', { name: 'Confirm simulation' }).click();
  await expect(trade.getByRole('heading', { name: 'Your order is ready to fill.' })).toBeVisible();
  await trade.getByRole('button', { name: 'Simulate fill' }).click();
  await expect(trade.getByText('ORDER FILLED · DEMO')).toBeVisible();
  await trade.getByRole('button', { name: 'View updated portfolio' }).click();

  await expect(
    page.locator('.portfolio-tabs').getByRole('button', { name: /^Activity/ }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.activity-ledger__row').filter({ hasText: 'Buy MSFT' })).toBeVisible();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Overview' }).click();
  await expect(page.locator('.portfolio-write-receipt')).toContainText('CASH AFTER');
  await expect(page.locator('.portfolio-write-receipt')).toContainText('€35K');
  await expect(page.locator('.portfolio-write-receipt')).toContainText(/Buy MSFT · .* units/);
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(window.localStorage.getItem('bt-demo-available-cash') || 'null'),
      ),
    )
    .toBe(34_991.87);

  await page.reload();
  await page
    .locator('.portfolio-tabs')
    .getByRole('button', { name: /^Activity/ })
    .click();
  await expect(page.locator('.activity-ledger__row').filter({ hasText: 'Buy MSFT' })).toBeVisible();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Overview' }).click();
  await expect(page.locator('.portfolio-write-receipt')).toContainText('€35K');
});

test('a nested portfolio and its recurring cash flow remain connected after reload', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create' });
  await create.getByRole('button', { name: /^Portfolio/ }).click();
  await create.getByRole('button', { name: 'Configure portfolio' }).click();

  const portfolioFlow = page.getByRole('dialog', { name: 'Create a portfolio' });
  await portfolioFlow.getByRole('button', { name: /household or goal/i }).click();
  await portfolioFlow.getByLabel('Portfolio name').fill('Family Opportunity');
  await portfolioFlow.getByLabel('Parent portfolio').selectOption('Personal wealth');
  await portfolioFlow.getByRole('button', { name: 'Continue' }).click();
  await portfolioFlow.getByRole('button', { name: /shared.*co-owners/i }).click();
  await portfolioFlow.getByRole('button', { name: 'Continue' }).click();
  await portfolioFlow.getByRole('button', { name: /collaboration.*co-owners/i }).click();
  await portfolioFlow.getByRole('button', { name: 'Create portfolio' }).click();
  await expect(portfolioFlow.getByRole('heading', { name: 'Family Opportunity' })).toBeVisible();
  await expect(portfolioFlow).toContainText('inside Personal wealth');
  await portfolioFlow.getByRole('button', { name: 'Open portfolio' }).click();
  await expect(page.locator('.scope-button')).toContainText('Family Opportunity');

  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const cashCreate = page.getByRole('dialog', { name: 'Create' });
  await cashCreate.getByRole('button', { name: /open full cash-flow details/i }).click();

  const cashFlow = page.getByRole('dialog', { name: 'Record expense' });
  await cashFlow.getByLabel('Expense amount').fill('275');
  await cashFlow.getByLabel('Cash activity description').fill('Quarterly insurance');
  await cashFlow.getByRole('button', { name: 'Add context' }).click();
  await cashFlow.getByRole('button', { name: /attach evidence/i }).click();
  await cashFlow.getByRole('button', { name: 'Review effects' }).click();
  await cashFlow.getByRole('checkbox').check();
  await cashFlow.getByRole('button', { name: 'Record activity' }).click();
  await expect(cashFlow.getByText('ACTIVITY RECORDED')).toBeVisible();
  await cashFlow.getByRole('button', { name: 'View cash-flow ledger' }).click();

  await expect(
    page.locator('.portfolio-tabs').getByRole('button', { name: 'Cash flow' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.locator('.cash-recent').getByText('Quarterly insurance', { exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(page.locator('.scope-button')).toContainText('Family Opportunity');
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Cash flow' }).click();
  await expect(
    page.locator('.cash-recent').getByText('Quarterly insurance', { exact: true }),
  ).toBeVisible();
});

test('staged import produces a receipt and Review records both approval and rejection', async ({
  page,
}) => {
  await openCommand(page, 'import', /import and reconcile portfolio data/i);
  const importFlow = page.getByRole('dialog', { name: 'Import into Personal wealth' });
  await expect(
    importFlow.getByRole('heading', { name: 'Where is this data coming from?' }),
  ).toBeVisible();
  await importFlow.getByRole('button', { name: 'Set up source' }).click();
  await importFlow.getByRole('button', { name: 'Connect Trade Republic' }).click();
  await expect(importFlow.getByRole('button', { name: /source connected/i })).toBeVisible({
    timeout: 3_000,
  });
  await importFlow.getByRole('button', { name: 'Continue' }).click();
  await expect(importFlow.getByRole('heading', { name: 'Confirm the coverage' })).toBeVisible();
  await importFlow.getByRole('button', { name: 'Continue' }).click();
  await expect(
    importFlow.getByRole('heading', { name: 'Map source language to portfolio data' }),
  ).toBeVisible();
  await importFlow.getByRole('button', { name: 'Continue' }).click();
  await importFlow.getByRole('button', { name: 'Create asset' }).click();
  await importFlow.getByRole('button', { name: 'Continue' }).click();
  await importFlow.getByRole('button', { name: 'Apply recommendations' }).click();
  await importFlow.getByRole('button', { name: 'Continue' }).click();
  await importFlow.getByRole('button', { name: /run import/i }).click();
  await expect(importFlow.getByRole('heading', { name: 'Import complete' })).toBeVisible({
    timeout: 4_000,
  });
  await expect(importFlow.getByText(/414 activities joined Personal wealth/)).toBeVisible();
  await importFlow.getByRole('button', { name: 'View imported portfolio' }).click();
  await expect(
    page.locator('.activity-ledger__row').filter({ hasText: 'Imported 414 activities' }),
  ).toBeVisible();

  await page
    .locator('.sidebar__utilities')
    .getByRole('button', { name: /review/i })
    .click();
  let review = page.getByRole('dialog', { name: 'Review Center' });
  await review.getByRole('button', { name: 'Open Approve July Drive import' }).click();
  await review.getByRole('button', { name: 'Approve change' }).click();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Confirm approval' }).click();
  await expect(review.getByRole('status')).toContainText('Change approved');

  await review.getByRole('button', { name: /^Open/ }).first().click();
  await review.getByRole('button', { name: 'Open Start a €200 monthly VWCE proposal' }).click();
  await review.getByRole('button', { name: 'Reject', exact: true }).click();
  await review
    .getByPlaceholder('Explain what should be corrected…')
    .fill('Needs a smaller cash impact.');
  await review.getByRole('button', { name: 'Confirm rejection' }).click();
  await expect(review.getByRole('status')).toContainText('Change rejected');

  await page.reload();
  await page
    .locator('.sidebar__utilities')
    .getByRole('button', { name: /review/i })
    .click();
  review = page.getByRole('dialog', { name: 'Review Center' });
  await review.getByRole('button', { name: /^Approved/ }).click();
  await expect(
    review.getByRole('button', { name: 'Open Approve July Drive import' }),
  ).toBeVisible();
  await review.getByRole('button', { name: /^Rejected/ }).click();
  await expect(
    review.getByRole('button', { name: 'Open Start a €200 monthly VWCE proposal' }),
  ).toBeVisible();
});

test('connection conflict, pause, reload, resume, and manual sync share one lifecycle', async ({
  page,
}) => {
  await openCommand(page, 'connections', /manage connections/i);
  let connections = page.getByRole('dialog', { name: 'Connections' });
  await connections.locator('.ocn-connection-row').filter({ hasText: 'Parqet' }).click();
  await connections.getByRole('button', { name: /conflicts/i }).click();
  await expect(connections.getByRole('heading', { name: '2 decisions waiting' })).toBeVisible();

  let openConflict = connections.locator('.ocn-conflict-card:not(.is-resolved)').first();
  await openConflict.getByRole('button').filter({ hasText: 'Connected source' }).click();
  openConflict = connections.locator('.ocn-conflict-card:not(.is-resolved)').first();
  await openConflict.getByRole('button', { name: /^BetterTrack / }).click();
  await expect(connections.getByRole('heading', { name: 'No open conflicts' })).toBeVisible();

  await connections.locator('.ocn-action-menu > button').click();
  await connections.getByRole('button', { name: 'Pause sync' }).click();
  await expect(connections.locator('.ocn-detail-heading .ocn-status')).toHaveText('paused');
  await connections.getByRole('button', { name: 'Close connections' }).click();

  await page.reload();
  await openCommand(page, 'connections', /manage connections/i);
  connections = page.getByRole('dialog', { name: 'Connections' });
  await connections.locator('.ocn-connection-row').filter({ hasText: 'Parqet' }).click();
  await expect(connections.locator('.ocn-detail-heading .ocn-status')).toHaveText('paused');

  await connections.locator('.ocn-action-menu > button').click();
  await connections.getByRole('button', { name: 'Resume sync' }).click();
  await expect(connections.locator('.ocn-detail-heading .ocn-status')).toHaveText('healthy');
  await connections.getByRole('button', { name: 'Sync now' }).click();
  await expect(connections.getByRole('button', { name: 'Syncing…' })).toBeVisible();
  await expect(connections.getByRole('button', { name: 'Sync now' })).toBeVisible({
    timeout: 4_000,
  });
  await expect(connections.locator('.ocn-detail-heading .ocn-status')).toHaveText('healthy');
});

test('collaboration sharing produces scoped access and an auditable receipt', async ({ page }) => {
  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await page.getByRole('button', { name: 'Share' }).click();

  const share = page.getByRole('dialog', { name: 'Share portfolio' });
  await share.getByRole('button', { name: /invite a collaborator/i }).click();
  await share.getByRole('button', { name: 'Continue' }).click();
  await share.getByPlaceholder('person@example.com').fill('sam@example.com');
  await share.getByPlaceholder('Jamie Lee').fill('Sam Rivera');
  await share.getByRole('button', { name: 'Continue' }).click();
  await share.getByRole('button', { name: /proposer.*suggest, never apply directly/i }).click();
  await share.getByRole('button', { name: 'Continue' }).click();
  await share.getByRole('button', { name: 'Continue' }).click();
  await share.getByRole('button', { name: 'Continue' }).click();
  await share.getByRole('button', { name: 'Send invitation' }).click();
  await expect(
    share.getByRole('heading', { name: 'Waiting for sam@example.com to accept.' }),
  ).toBeVisible();
  await expect(share).toContainText('Proposer');
  await expect(share).toContainText('Audit reference');
  await share.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();

  const storedShares = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('bt-demo-shares') || '[]'),
  );
  expect(storedShares).toHaveLength(1);
  expect(storedShares[0]).toMatchObject({
    kind: 'collaboration',
    status: 'active',
    recipient: { email: 'sam@example.com' },
    access: { role: 'proposer', approvalPolicy: 'proposal-only' },
  });

  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'People' }).click();
  await expect(page.locator('.origin-collaboration')).toBeVisible();
  await expect(page.getByText('Sam Rivera', { exact: true })).toBeVisible();
  await expect(page.getByText('sam@example.com', { exact: true })).toBeVisible();
});

test('portfolio documents resolve evidence and persist a fully linked upload', async ({ page }) => {
  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Files' }).click();
  await expect(page.locator('.origin-documents')).toBeVisible();

  await test.step('resolve a portfolio evidence decision in context', async () => {
    await page
      .locator('.od-review-queue')
      .getByRole('button')
      .filter({ hasText: 'Valuation is stale' })
      .click();
    const resolution = page.getByRole('dialog', { name: 'Resolve Valuation is stale' });
    await resolution
      .getByLabel('Resolution')
      .selectOption({ label: 'Keep current valuation with an exception' });
    await resolution.getByRole('button', { name: 'Confirm resolution' }).click();
    await expect(
      page.locator('.od-metrics > div').filter({ hasText: 'Needs review' }),
    ).toContainText('2');
  });

  await test.step('walk the complete document lifecycle and capture a receipt', async () => {
    await page.getByRole('button', { name: 'Add document' }).click();
    let upload = page.getByRole('dialog', { name: 'Add document' });
    await upload.getByRole('button', { name: /use a demo statement/i }).click();

    await expect(
      upload.getByRole('heading', { name: 'What kind of evidence is this?' }),
    ).toBeVisible({
      timeout: 3_000,
    });
    await upload.getByRole('button', { name: /^Tax/ }).click();
    await upload.getByRole('button', { name: 'Continue' }).click();

    await upload.getByText('Vanguard FTSE All-World', { exact: true }).click();
    await upload.getByText('Buy · VWCE · 12 Jun 2026', { exact: true }).click();
    await upload.getByRole('button', { name: 'Continue' }).click();

    await upload.getByLabel('Display name').fill('IBKR tax evidence · July 2026.pdf');
    await upload.getByLabel('Portfolio folder').fill('/BetterTrack/Tax/2026');
    await upload.getByLabel('Tags').fill('tax, ibkr, 2026');
    await upload
      .getByLabel('Annotation')
      .fill('Evidence retained for the 2026 portfolio tax review.');
    await upload.getByRole('button', { name: 'Continue' }).click();

    await expect(upload).toContainText('IBKR tax evidence · July 2026.pdf');
    await expect(upload).toContainText('1');
    await upload.getByRole('button', { name: 'Add to portfolio' }).click();

    upload = page.getByRole('dialog', { name: 'Document added' });
    await expect(upload.getByText('Persistent demo receipt')).toBeVisible();
    await expect(upload).toContainText('IBKR tax evidence · July 2026.pdf');
    await upload.getByRole('button', { name: 'View document' }).click();
    await expect(
      page.getByText('IBKR tax evidence · July 2026.pdf', { exact: true }).first(),
    ).toBeVisible();
  });

  await page.reload();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Files' }).click();
  await expect(
    page.getByText('IBKR tax evidence · July 2026.pdf', { exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator('.od-metrics > div').filter({ hasText: 'Needs review' })).toContainText(
    '2',
  );

  const stored = await page.evaluate(() => {
    const value = window.localStorage.getItem('bt-origin-documents-v1-personal-wealth');
    return value ? JSON.parse(value) : null;
  });
  expect(stored.receipts).toHaveLength(1);
  expect(stored.documents[0]).toMatchObject({
    name: 'IBKR tax evidence · July 2026.pdf',
    type: 'Tax',
    folder: '/BetterTrack/Tax/2026',
    status: 'current',
    tags: ['tax', 'ibkr', '2026'],
  });
});

test('data management creates a checkpoint, restore receipt, and portable export', async ({
  page,
}) => {
  const openDataManagement = async () => {
    await page
      .locator('.sidebar__utilities')
      .getByRole('button', { name: /control center/i })
      .click();
    const control = page.getByRole('dialog', { name: 'Control center' });
    await control.getByRole('button', { name: /Backups/i }).click();
    await expect(page.getByRole('dialog', { name: 'Data management' })).toBeVisible();
  };

  await openDataManagement();
  const data = page.getByRole('dialog', { name: 'Data management' });
  await expect(data.getByRole('button', { name: 'Create snapshot' })).toBeVisible();

  await test.step('create a verified checkpoint and simulate a guarded restore', async () => {
    await data.getByRole('button', { name: 'Create snapshot' }).click();
    await expect(data.getByRole('status')).toContainText(
      'Encrypted snapshot created and verified',
      {
        timeout: 3_000,
      },
    );
    await data.getByRole('tab', { name: /Backups/ }).click();
    await expect(data.getByRole('heading', { name: '4 retained snapshots' })).toBeVisible();

    await data.getByRole('button', { name: 'Preview restore' }).first().click();
    const restore = page.getByRole('dialog', { name: 'Restore preview' });
    await expect(
      restore.getByRole('heading', { name: 'Preview before replacing anything' }),
    ).toBeVisible();
    await restore.getByLabel('Run the restore simulation').check();
    await restore.getByRole('button', { name: 'Simulate restore' }).click();
    await expect(
      restore.getByRole('heading', { name: 'Restore simulation complete' }),
    ).toBeVisible();
    await expect(restore.getByText('Demo restore receipt')).toBeVisible();
    await restore.getByRole('button', { name: 'Close restore preview' }).click();
  });

  let receiptId = '';
  await test.step('prepare and download a portable manifest', async () => {
    await data.getByRole('tab', { name: /Exports/ }).click();
    await data.getByRole('button', { name: 'Prepare export' }).click();
    await expect(data.getByText('Export ready')).toBeVisible({ timeout: 3_000 });
    receiptId = (await data.locator('.odm-export-preview h2').textContent()) ?? '';
    expect(receiptId).toMatch(/^BT-EXPORT-/);

    const downloadPromise = page.waitForEvent('download');
    await data.getByRole('button', { name: 'Download demo manifest' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('all-wealth');
  });

  await data.getByRole('button', { name: 'Close data management' }).click();
  await page.reload();
  await openDataManagement();
  const restoredData = page.getByRole('dialog', { name: 'Data management' });
  await restoredData.getByRole('tab', { name: /Exports/ }).click();
  await expect(restoredData.getByText(receiptId, { exact: true })).toBeVisible();

  await restoredData.getByRole('tab', { name: /Retention/ }).click();
  await restoredData
    .getByLabel('Developer request logs retention')
    .selectOption({ label: '1 year' });

  const persisted = await page.evaluate(() => {
    const value = window.localStorage.getItem('bt-origin-data-management-v1-all');
    return value ? JSON.parse(value) : null;
  });
  expect(persisted.snapshots).toHaveLength(4);
  expect(persisted.exports[0].id).toBe(receiptId);
  expect(persisted.retention.requestLogs).toBe('1-year');
});

test('a new goal persists with its receipt and sends the monthly rule to Review', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Plan' }).click();
  await expect(page.locator('.origin-goals')).toBeVisible();

  await page.getByRole('button', { name: 'New goal' }).click();
  let goal = page.getByRole('dialog', { name: 'What are you planning for?' });
  await goal.getByRole('button', { name: /custom milestone/i }).click();
  await goal.getByRole('button', { name: 'Continue' }).click();

  goal = page.getByRole('dialog', { name: 'Define the finish line' });
  await goal.getByLabel('Goal name').fill('E2E Creative Studio');
  await goal.getByLabel("Target in today's money").fill('85000');
  await goal.getByRole('button', { name: 'Continue' }).click();

  goal = page.getByRole('dialog', { name: 'Link existing balances' });
  await goal.getByRole('button', { name: 'Continue' }).click();

  goal = page.getByRole('dialog', { name: 'Draft a monthly rule' });
  await goal.getByLabel('Monthly contribution').fill('325');
  await goal.getByLabel('Proposal day').selectOption('10');
  await goal.getByRole('button', { name: 'Continue' }).click();

  goal = page.getByRole('dialog', { name: 'Review the complete plan' });
  await expect(goal).toContainText('E2E Creative Studio');
  await expect(goal).toContainText('Pending Review');
  await goal.getByRole('button', { name: 'Create goal' }).click();

  const review = page.getByRole('dialog', { name: 'Review Center' });
  await expect(
    review.getByRole('button', { name: 'Open Review monthly plan · E2E Creative Studio' }),
  ).toBeVisible();
  await review.getByRole('button', { name: 'Close Review Center' }).click();

  goal = page.getByRole('dialog', { name: 'Goal created' });
  await expect(goal).toContainText('E2E Creative Studio is ready');
  await expect(goal).toContainText('Goal and receipt persist across reloads');
  await goal.getByRole('button', { name: 'View goal' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Creative Studio' })).toBeVisible();
  await expect(page.getByText('Rule pending in Review')).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = window.localStorage.getItem('bt-demo-origin-goals-v1:personal');
        return value ? JSON.parse(value).receipts.length : 0;
      }),
    )
    .toBeGreaterThanOrEqual(2);

  await page.reload();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Plan' }).click();
  await page.getByRole('button', { name: /E2E Creative Studio/ }).click();
  await expect(page.getByRole('heading', { name: 'E2E Creative Studio' })).toBeVisible();
  await expect(page.getByText('Rule pending in Review')).toBeVisible();

  const persisted = await page.evaluate(() => {
    const value = window.localStorage.getItem('bt-demo-origin-goals-v1:personal');
    return value ? JSON.parse(value) : null;
  });
  expect(persisted.goals.at(-1)).toMatchObject({
    name: 'E2E Creative Studio',
    target: 85_000,
    monthlyContribution: 325,
    ruleState: 'pending-review',
  });
  expect(persisted.receipts.map((receipt: { kind: string }) => receipt.kind)).toEqual(
    expect.arrayContaining(['goal.created', 'rule.proposed']),
  );
});

test('tax basis evidence and a downloaded report survive a portfolio reload', async ({ page }) => {
  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Tax' }).click();
  await expect(page.locator('.origin-tax')).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Tax workspace sections' })
    .getByRole('button', { name: /cost basis/i })
    .click();
  await expect(page.getByRole('heading', { name: 'Missing cost basis' })).toBeVisible();
  await page.getByLabel('BTC cost basis', { exact: true }).fill('5772');
  await page.getByLabel('BTC cost basis evidence').selectOption({ label: 'Broker statement' });
  await page
    .getByLabel('BTC basis note')
    .fill('Verified against the archived 2023 broker statement.');
  await page.getByRole('button', { name: 'Attach resolution' }).click();
  await expect(
    page.getByText('Every disposal has a cost-basis path', { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Build report' }).click();
  await expect(page.getByRole('heading', { name: 'Create an accountable snapshot' })).toBeVisible();
  await page.getByRole('button', { name: /realized gains/i }).click();
  await page.getByLabel('Report output format').selectOption('csv');
  await page.getByRole('button', { name: 'Generate export' }).click();
  await expect(page.getByText('TX-2026-001 · CSV')).toBeVisible({ timeout: 3_000 });

  const reportRow = page.locator('.otx-report-table > div').filter({ hasText: 'TX-2026-001' });
  const downloadPromise = page.waitForEvent('download');
  await reportRow.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('bettertrack-realized-2026-TX-2026-001.csv');

  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = window.localStorage.getItem('bt-demo-origin-tax-personal');
        return value ? JSON.parse(value).generatedReports.length : 0;
      }),
    )
    .toBe(1);

  await page.reload();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Tax' }).click();
  await page
    .getByRole('navigation', { name: 'Tax workspace sections' })
    .getByRole('button', { name: /cost basis/i })
    .click();
  await expect(
    page.getByText('Every disposal has a cost-basis path', { exact: true }),
  ).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Tax workspace sections' })
    .getByRole('button', { name: /reports.*1 generated/i })
    .click();
  await expect(page.getByText('TX-2026-001 · CSV')).toBeVisible();

  const persisted = await page.evaluate(() => {
    const value = window.localStorage.getItem('bt-demo-origin-tax-personal');
    return value ? JSON.parse(value) : null;
  });
  expect(persisted.resolutions['btc-may']).toMatchObject({
    basis: 5772,
    evidence: 'Broker statement',
    note: 'Verified against the archived 2023 broker statement.',
  });
  expect(persisted.generatedReports[0]).toMatchObject({
    id: 'TX-2026-001',
    type: 'realized',
    format: 'csv',
    status: 'ready',
  });
});

test('a protected continuity handoff stays review-gated and persists its consent receipt', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Plan' }).click();
  await page
    .getByRole('tablist', { name: 'Plan sections' })
    .getByRole('tab', { name: /protection & continuity/i })
    .click();
  await expect(page.locator('.origin-continuity')).toBeVisible();

  await page.getByRole('button', { name: 'Prepare handoff' }).click();
  const handoff = page.getByRole('dialog', { name: 'Prepare the minimum useful package' });
  await handoff
    .getByRole('checkbox', { name: /I consent to preparing this encrypted handoff/i })
    .check();
  await handoff.getByRole('button', { name: /confirm & submit/i }).click();

  const receipt = page.getByRole('dialog', { name: 'Prepare encrypted continuity handoff' });
  await expect(receipt).toContainText('Explicitly confirmed');
  await expect(receipt).toContainText('Waiting in Review · active plan unchanged');
  await receipt.getByRole('button', { name: 'Open Review' }).click();

  const review = page.getByRole('dialog', { name: 'Review Center' });
  await expect(
    review.getByRole('button', { name: /open prepare encrypted continuity handoff/i }),
  ).toBeVisible();
  await review.getByRole('button', { name: 'Close Review Center' }).click();
  await expect(page.locator('.oct-summary__review')).toContainText('1');

  await page
    .getByRole('tablist', { name: 'Continuity views' })
    .getByRole('tab', { name: /audit & receipts/i })
    .click();
  await expect(page.getByText('Encrypted handoff package submitted').first()).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = window.localStorage.getItem('bt-demo-origin-continuity-v1:personal');
        return value ? JSON.parse(value).proposals.length : 0;
      }),
    )
    .toBe(1);

  await page.reload();
  await page.locator('.portfolio-tabs').getByRole('button', { name: 'Plan' }).click();
  await page
    .getByRole('tablist', { name: 'Plan sections' })
    .getByRole('tab', { name: /protection & continuity/i })
    .click();
  await expect(page.locator('.oct-summary__review')).toContainText('1');
});

test('portfolio data health stages a field correction with lineage and restores it', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await page.getByRole('button', { name: /open data health, current quality 96 percent/i }).click();

  const health = page.getByRole('dialog', { name: 'Personal wealth data health' });
  await expect(health.getByRole('heading', { name: 'Data health' })).toBeVisible();
  await expect(health.getByText('lot.acquisitionCost', { exact: true }).first()).toBeVisible();
  await health.getByRole('button', { name: 'Propose correction' }).click();

  const correction = page.getByRole('dialog', { name: 'Propose resolution' });
  await correction
    .getByLabel('Resolution reason')
    .fill('Verified against the archived Flatex contract note and fee statement.');
  await correction.getByRole('button', { name: 'Submit to Review' }).click();

  await expect(health.getByText('review submitted', { exact: false })).toBeVisible();
  await expect(
    health.getByText(/Verified against the archived Flatex contract note/i),
  ).toBeVisible();
  await health.getByRole('button', { name: 'Open Review', exact: true }).click();

  const review = page.getByRole('dialog', { name: 'Review Center' });
  await expect(
    review.getByRole('button', { name: /open correct lot\.acquisitionCost/i }),
  ).toBeVisible();
  await review.getByRole('button', { name: 'Close Review Center' }).click();

  await page.getByRole('button', { name: /open data health, current quality 96 percent/i }).click();
  const restored = page.getByRole('dialog', { name: 'Personal wealth data health' });
  await expect(restored.getByText('review submitted', { exact: false })).toBeVisible();

  const persisted = await page.evaluate(() => {
    const value = window.localStorage.getItem('bt-origin-data-health-v1-personal');
    return value ? JSON.parse(value) : null;
  });
  expect(
    persisted.issues.find((issue: { id: string }) => issue.id === 'health_basis_vwce_2024'),
  ).toMatchObject({
    status: 'pending-review',
    receipt: {
      action: 'review-submitted',
      reason: 'Verified against the archived Flatex contract note and fee statement.',
    },
  });
  expect(persisted.audit[0].action).toBe('Correction submitted to Review');
});

test('portfolio structure changes remain staged until Review applies the graph mutation', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await page.getByRole('button', { name: 'Portfolio structure' }).click();

  let structure = page.getByRole('dialog', {
    name: 'Personal wealth portfolio structure',
  });
  await expect(structure.getByRole('heading', { name: 'Portfolio structure' })).toBeVisible();
  await structure
    .getByRole('complementary', { name: 'Portfolio hierarchy' })
    .getByRole('button', { name: /Northstar Studio/ })
    .click();
  await structure.getByRole('button', { name: 'Propose move' }).click();

  const proposal = page.getByRole('dialog', { name: 'Propose a new parent' });
  await proposal.getByLabel('New parent').selectOption({ label: 'Global Core · Portfolio' });
  await proposal
    .getByPlaceholder('Explain why this object belongs under the new parent…')
    .fill('Keep the operating-company allocation inside the long-term core mandate.');
  await proposal.getByRole('button', { name: 'Send to Review' }).click();
  await expect(structure.getByRole('status')).toContainText('waiting in Review');
  await structure.getByRole('button', { name: 'Close portfolio structure' }).click();

  await page
    .locator('.sidebar__utilities')
    .getByRole('button', { name: /review/i })
    .click();
  const review = page.getByRole('dialog', { name: 'Review Center' });
  await review.getByRole('button', { name: 'Open Move Northstar Studio to Global Core' }).click();
  await review.getByRole('button', { name: 'Apply structure move' }).click();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Confirm approval' }).click();
  await expect(review.getByRole('status')).toContainText('Change approved');
  await review.getByRole('button', { name: 'Close Review Center' }).click();

  await page.getByRole('button', { name: 'Portfolio structure' }).click();
  structure = page.getByRole('dialog', {
    name: 'Personal wealth portfolio structure',
  });
  await structure
    .getByRole('complementary', { name: 'Portfolio hierarchy' })
    .getByRole('button', { name: /Northstar Studio/ })
    .click();
  await expect(structure.locator('.ops-path')).toContainText('Global Core');
  await expect(structure.getByRole('tab', { name: 'Lifecycle & audit' })).toContainText(
    'Lifecycle & audit',
  );

  await structure.getByRole('button', { name: 'Close portfolio structure' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Portfolio structure' }).click();
  structure = page.getByRole('dialog', {
    name: 'Personal wealth portfolio structure',
  });
  await structure
    .getByRole('complementary', { name: 'Portfolio hierarchy' })
    .getByRole('button', { name: /Northstar Studio/ })
    .click();
  await expect(structure.locator('.ops-path')).toContainText('Global Core');
});

test('portfolio events confirm safe actions and preserve their evidence receipt', async ({
  page,
}) => {
  const cashBefore = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('bt-demo-available-cash') || '35492.87'),
  );
  await page
    .getByRole('button', { name: /all wealth/i })
    .first()
    .click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /personal wealth/i })
    .click();
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /portfolios/i })
    .click();
  await page
    .locator('.portfolio-tabs')
    .getByRole('button', { name: /^Activity/ })
    .click();
  await page.getByRole('button', { name: 'Portfolio events' }).click();

  let events = page.getByRole('dialog', { name: 'Events inbox' });
  await expect(events.getByText('Quarterly cash dividend', { exact: true }).first()).toBeVisible();
  await events.getByRole('button', { name: /Quarterly cash dividend.*MSFT/i }).click();
  await events.getByRole('button', { name: 'Confirm event' }).click();

  const confirm = page.getByRole('dialog', { name: 'Confirm corporate action' });
  await confirm
    .getByPlaceholder('Why is it safe to apply this event?')
    .fill('Issuer notice and connected custodian quantities agree.');
  await confirm.getByRole('checkbox').check();
  await confirm.getByRole('button', { name: 'Confirm & apply' }).click();

  const receipt = page.getByRole('dialog', { name: 'Portfolio event confirmed' });
  await expect(receipt).toContainText('Quarterly cash dividend');
  await expect(receipt).toContainText('Issuer notice and connected custodian quantities agree.');
  await receipt.getByRole('button', { name: 'Close receipt' }).click();
  await events.getByRole('tab', { name: /Completed/ }).click();
  await expect(
    events.getByRole('button', { name: /Cash dividend Completed Quarterly cash dividend MSFT/i }),
  ).toBeVisible();

  await events.getByRole('button', { name: 'Close portfolio events' }).click();
  await page.reload();
  await page
    .locator('.portfolio-tabs')
    .getByRole('button', { name: /^Activity/ })
    .click();
  await page.getByRole('button', { name: 'Portfolio events' }).click();
  events = page.getByRole('dialog', { name: 'Events inbox' });
  await events.getByRole('tab', { name: /Completed/ }).click();
  await expect(
    events.getByRole('button', { name: /Cash dividend Completed Quarterly cash dividend MSFT/i }),
  ).toBeVisible();
  await events.getByRole('tab', { name: /Audit & receipts/ }).click();
  await expect(events).toContainText('Issuer notice and connected custodian quantities agree.');
  await events.getByRole('button', { name: 'Close portfolio events' }).click();
  await expect(
    page.locator('.activity-ledger__row').filter({ hasText: 'MSFT · Quarterly cash dividend' }),
  ).toContainText('Confirmed · EVT');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(window.localStorage.getItem('bt-demo-available-cash') || '0')),
    )
    .toBe(cashBefore + 111.29);
});

test('Workbench calculates an exact constrained rebalance and submits only that plan to Review', async ({
  page,
}) => {
  await openCommand(page, 'Personal wealth', /Open Personal wealth/);
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /workbench/i })
    .click();
  await page.locator('.workbench-tabs').getByRole('button', { name: 'Rebalance' }).click();

  const planner = page.locator('.origin-rebalance');
  await expect(planner.getByRole('heading', { name: 'Constraint-aware rebalance' })).toBeVisible();
  await expect(planner.getByRole('status').filter({ hasText: 'Target total' })).toContainText(
    '100.0%',
  );
  await planner.getByRole('button', { name: 'Calculate exact plan' }).click();
  await expect(
    planner.getByRole('progressbar', { name: 'Calculating rebalance plan' }),
  ).toBeVisible();
  await expect(planner.getByRole('button', { name: 'Submit exact plan' })).toBeEnabled({
    timeout: 5_000,
  });
  await expect(planner).toContainText('Exact trade plan');

  await planner.getByRole('button', { name: 'Submit exact plan' }).click();
  const proposal = page.getByRole('dialog', { name: 'Submit this exact plan?' });
  await proposal.getByRole('checkbox').check();
  await proposal.getByRole('button', { name: 'Submit exact plan' }).click();

  const review = page.getByRole('dialog', { name: 'Review Center' });
  await expect(
    review.getByRole('button', { name: 'Open Execute constraint-aware rebalance' }),
  ).toBeVisible();
  await review.getByRole('button', { name: 'Open Execute constraint-aware rebalance' }).click();
  await expect(review).toContainText('Exact-plan checksum');
  await expect(review.getByRole('button', { name: 'Approve exact trades' })).toBeVisible();
  await review.getByRole('button', { name: 'Close Review Center' }).click();

  await expect(planner.getByRole('button', { name: 'Submitted to Review' })).toBeDisabled();
  const persisted = await page.evaluate(() => {
    const value = window.localStorage.getItem('bt-demo-origin-rebalance-v1:personal');
    return value ? JSON.parse(value) : null;
  });
  expect(persisted.activePlan.status).toBe('ready');
  expect(persisted.receipts).toHaveLength(1);
  expect(persisted.receipts[0].reviewEntryId).toContain('rebalance:');
});

test('aggregate scope requires an explicit portfolio before rebalancing', async ({ page }) => {
  await page.locator('.scope-button').click();
  await page
    .locator('.scope-popover')
    .getByRole('button', { name: /All wealth/ })
    .click();
  await page
    .locator('.suite-nav')
    .getByRole('button', { name: /workbench/i })
    .click();
  await page.locator('.workbench-tabs').getByRole('button', { name: 'Rebalance' }).click();

  const guard = page.locator('.workbench-scope-guard');
  await expect(
    guard.getByRole('heading', { name: 'Choose one portfolio to rebalance.' }),
  ).toBeVisible();
  await expect(page.locator('.origin-rebalance')).toHaveCount(0);
  await guard.getByRole('button', { name: /Personal wealth/ }).click();
  await expect(page.getByRole('heading', { name: 'Constraint-aware rebalance' })).toBeVisible();
});

test('portfolio settings save harmless display choices and stage calculation policy in Review', async ({
  page,
}) => {
  await openCommand(page, 'Personal wealth', /Open Personal wealth/);
  await page.getByRole('button', { name: 'Portfolio settings' }).click();

  let settings = page.getByRole('dialog', {
    name: 'Personal wealth portfolio settings',
  });
  await expect(settings.getByTestId('settings-view-overview')).toBeVisible();
  await expect(settings.getByTestId('settings-tab-overview')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await settings.getByLabel('Reporting timezone').selectOption('UTC');
  await settings.getByTestId('settings-save-identity').click();
  await expect(settings.getByTestId('settings-receipt')).toContainText('Settings saved');
  await settings.getByRole('button', { name: 'Dismiss receipt' }).click();

  await settings.getByTestId('settings-tab-calculation').click();
  await settings.getByLabel('Performance method').selectOption('mwr');
  await settings.getByTestId('settings-save-calculation').click();

  const confirmation = settings.getByTestId('settings-confirm-dialog');
  await expect(confirmation.getByRole('heading')).toHaveText('Change portfolio calculation policy');
  await confirmation
    .getByTestId('settings-reason')
    .fill('IRR better reflects the timing of our contributed capital.');
  await confirmation.getByTestId('settings-consent').check();
  await confirmation.getByTestId('settings-submit-review').click();
  await expect(settings.getByTestId('settings-receipt')).toContainText('Proposal recorded');
  await settings
    .getByTestId('settings-receipt')
    .getByRole('button', { name: 'Open Review' })
    .click();

  const review = page.getByRole('dialog', { name: 'Review Center' });
  await expect(
    review.getByRole('button', { name: 'Open Change portfolio calculation policy' }),
  ).toBeVisible();
  await review.getByRole('button', { name: 'Open Change portfolio calculation policy' }).click();
  await expect(review).toContainText('Money-weighted return (IRR)');
  await expect(review).toContainText('Personal wealth remains authoritative');
  await review.getByRole('button', { name: 'Approve changes' }).click();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Confirm approval' }).click();
  await review.getByRole('button', { name: 'Close Review Center' }).click();

  const persisted = await page.evaluate(() => {
    const value = window.localStorage.getItem('bt-origin-portfolio-settings-v1-personal');
    return value ? JSON.parse(value) : null;
  });
  expect(persisted.config.identity.reportingTimezone).toBe('UTC');
  expect(persisted.config.calculation.performanceMethod).toBe('mwr');
  expect(persisted.proposals).toHaveLength(0);

  await page.reload();
  await page.getByRole('button', { name: 'Portfolio settings' }).click();
  settings = page.getByRole('dialog', {
    name: 'Personal wealth portfolio settings',
  });
  await expect(settings.getByLabel('Reporting timezone')).toHaveValue('UTC');
  await expect(settings).toContainText('Policy verified');
});

test('private-market commitments persist and capital calls join the shared Review queue', async ({
  page,
}) => {
  const cashBefore = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('bt-demo-available-cash') || '35492.87'),
  );
  await openCommand(page, 'private-market', /Manage private-market commitments/);
  let workspace = page.getByTestId('origin-private-markets');
  await expect(workspace.getByRole('heading', { name: 'Private markets' })).toBeVisible();
  await expect(workspace).toContainText('Available portfolio cash');
  await expect(workspace).toContainText('TVPI');

  await workspace.getByTestId('private-markets-add').click();
  const creator = workspace.getByTestId('private-markets-create-dialog');
  await creator.getByLabel('Display name').fill('Danube Growth Partnership');
  await creator.getByLabel('Legal entity name').fill('Danube Growth Partnership SCSp');
  await creator.getByRole('button', { name: 'Continue' }).click();
  await expect(creator.getByRole('heading', { name: 'Opening economics' })).toBeVisible();
  await creator.getByLabel('Committed amount').fill('180000');
  await creator.getByLabel('Already contributed').fill('45000');
  await creator.getByLabel('Opening NAV').fill('49200');
  await creator.getByRole('button', { name: 'Continue' }).click();
  await expect(creator).toContainText('€135,000');
  await creator.getByRole('button', { name: 'Create commitment' }).click();

  let receipt = workspace.getByTestId('private-markets-receipt');
  await expect(receipt.getByRole('heading')).toHaveText('Danube Growth Partnership created');
  await receipt.getByRole('button', { name: 'Done' }).click();
  await expect(workspace).toContainText('Danube Growth Partnership');

  await workspace.getByRole('tab', { name: /Overview/ }).click();
  await workspace.getByRole('button', { name: 'Prepare funding' }).first().click();
  const call = workspace.getByTestId('private-markets-capital-call-dialog');
  await expect(call.getByRole('heading', { name: 'Prepare capital-call funding' })).toBeVisible();
  await call.getByRole('checkbox').check();
  await call.getByTestId('private-call-submit').click();
  receipt = workspace.getByTestId('private-markets-receipt');
  await expect(receipt).toContainText('Capital call sent to Review');
  await receipt.getByRole('button', { name: 'Open Review' }).click();

  const review = page.getByRole('dialog', { name: 'Review Center' });
  await expect(review).toContainText('Capital call 08');
  await expect(review).toContainText('Portfolio cash truth changes only after approval');
  await review.getByRole('button', { name: 'Approve funding' }).click();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Confirm approval' }).click();
  await review.getByRole('button', { name: 'Close Review Center' }).click();

  const persisted = await page.evaluate(() => {
    const value = window.localStorage.getItem('bt-origin-private-markets-v1-personal');
    return value ? JSON.parse(value) : null;
  });
  expect(
    persisted.commitments.some(
      (commitment: { name: string }) => commitment.name === 'Danube Growth Partnership',
    ),
  ).toBe(true);
  expect(persisted.receipts).toHaveLength(2);
  expect(
    persisted.calls.find((call: { id: string }) => call.id === 'call_horizon_aug').status,
  ).toBe('funded');
  expect(
    persisted.commitments.find(
      (commitment: { id: string }) => commitment.id === 'pm_horizon_growth_iii',
    ).contributed,
  ).toBe(285000);
  expect(persisted.pendingActions).toEqual({});
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(window.localStorage.getItem('bt-demo-available-cash') || '0')),
    )
    .toBe(cashBefore - 43350);

  await page.reload();
  await openCommand(page, 'private-market', /Manage private-market commitments/);
  workspace = page.getByTestId('origin-private-markets');
  await workspace.getByRole('tab', { name: /Commitments/ }).click();
  await expect(workspace).toContainText('Danube Growth Partnership');
});
