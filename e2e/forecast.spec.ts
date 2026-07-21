import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * V5-P6b forecast + standing-orders regression (issue #626, area 2). A recurring
 * cash-add standing order ("salary") is created through the real Forecast UI and
 * must (a) show up as an active, next-run-scheduled row and (b) move the
 * net-worth projection: a fresh account projects a flat €0, and once the order
 * exists the projection line rises into the thousands.
 *
 * Kept to a tight happy path (the nightly per-test budget is real). The
 * scheduling edge cases (exactly-once booking, catch-up, clamp, pause/resume,
 * overdraw) live in `apps/api/src/services/standingOrders/__tests__/**` and the
 * projection math in `apps/web/src/user/forecast/projection.test.ts`; this spec
 * is the missing e2e layer wiring the create UI to the projection surface.
 */

/**
 * A projected/legend money value ≥ €1,000 carries a thousands separator
 * (`1.234` / `1,234`) that a flat `0,00` never does — a locale-agnostic proxy
 * for "the projection moved above zero".
 */
const HAS_THOUSANDS = /\d[.,]\d{3}/;

test('forecast: a cash-add standing order records and lifts the net-worth projection', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'forecastowner');
  await apiRequest.dispose();

  const page = owner.page;

  await page.goto('/forecast');

  // A brand-new account has €0 net worth and no orders: the base projection line
  // sits flat at zero (no thousands separator).
  const baseLegend = page.getByTestId('projection-series-base');
  await expect(baseLegend).toBeVisible({ timeout: 15_000 });
  await expect(baseLegend).toContainText(/0[.,]00/);
  await expect(baseLegend).not.toContainText(HAS_THOUSANDS);

  // Create a monthly €500 "salary" cash-add through the real dialog.
  await page.getByRole('button', { name: 'New standing order' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add cash' }).click();
  await dialog.getByLabel('Amount (€)').fill('500');
  await dialog.getByLabel('Label (optional)').fill('salary');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();

  // It lands as an active row with a scheduled next run.
  const section = page.getByRole('region', { name: /standing orders/i });
  const row = section.getByRole('listitem').filter({ hasText: 'salary' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText('Active');
  await expect(row).toContainText(/Next run/i);

  // The projection now reflects the standing order: 20 years of €500/month lifts
  // the base line well into the thousands.
  await expect(baseLegend).toContainText(HAS_THOUSANDS, { timeout: 15_000 });

  await owner.context.close();
});
