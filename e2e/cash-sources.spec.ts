import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * V3-P3 cash sources (issue #426, flow 1). Create a named source beside the
 * auto-provisioned Main, deposit to Main, then transfer Main → source. Both
 * balances and the movement history must reflect the atomic paired legs (a
 * `transfer_out` on Main and a `transfer_in` on the source) — an internal
 * transfer, never a TWR external flow.
 */
test('cash sources: create, deposit and transfer between two sources', async ({ browser }) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'cashowner');
  await apiRequest.dispose();

  const page = owner.page;
  await page.goto('/portfolio/cash');

  // Create a second cash source (the "Transfer" affordance only earns its place
  // once a second active source exists).
  await page.getByRole('button', { name: 'Add source' }).click();
  const createDialog = page.getByRole('dialog', { name: 'Add cash source' });
  await createDialog.getByLabel('Name').fill('Savings');
  await createDialog.getByRole('button', { name: 'Create source' }).click();
  await expect(createDialog).toBeHidden();

  const rows = page.locator('table[aria-label="Cash sources"] tbody tr');
  // sortSourcesMainFirst: Main is row 0, Savings row 1.
  await expect(rows).toHaveCount(2);

  // Deposit €1000 into Main (its per-row "Deposit" preselects Main).
  await rows.nth(0).getByRole('button', { name: 'Deposit' }).click();
  const depositDialog = page.getByRole('dialog', { name: 'Cash balance' });
  await depositDialog.getByLabel('Amount', { exact: true }).fill('1000');
  await depositDialog.getByRole('button', { name: 'Deposit cash' }).click();
  await expect(depositDialog).toBeHidden();
  // Locale-agnostic: EN renders "1,000.00 €" (en-GB), DE renders "1.000,00 €" (de-AT).
  await expect(rows.nth(0)).toContainText(/1[.,]000[.,]00/);

  // Transfer €400 Main → Savings.
  await page.getByRole('button', { name: 'Transfer' }).click();
  const transferDialog = page.getByRole('dialog', { name: 'Transfer between sources' });
  await transferDialog.getByLabel('To').selectOption({ label: 'Savings' });
  await transferDialog.getByLabel('Amount (EUR)').fill('400');
  await transferDialog.getByRole('button', { name: 'Transfer' }).click();
  await expect(transferDialog).toBeHidden();

  // Both balances reflect the atomic pair: Main 600, Savings 400. Locale-agnostic.
  await expect(rows.nth(0)).toContainText(/600[.,]00/, { timeout: 15_000 });
  await expect(rows.nth(1)).toContainText(/400[.,]00/);

  // The movement history carries both legs of the one transfer.
  const history = page.getByRole('region', { name: 'Movement history' });
  await expect(history.getByText('Transfer out')).toBeVisible();
  await expect(history.getByText('Transfer in')).toBeVisible();

  await owner.context.close();
});
