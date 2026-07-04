import { expect, type Page } from '@playwright/test';

/** Drives the real /invite/:token page to provision a brand-new account. */
export async function acceptInvite(
  page: Page,
  token: string,
  username: string,
  password: string,
): Promise<void> {
  await page.goto(`/invite/${token}`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/portfolio$/, { timeout: 20_000 });
}

/** Searches the local catalog and watches the first matching asset's symbol. */
export async function watchAsset(page: Page, query: string, symbol: string): Promise<void> {
  await page.goto('/assets/search');
  await page.getByRole('searchbox', { name: 'Search assets' }).fill(query);
  const watchButton = page.getByRole('button', { name: `Add ${symbol} to Workboard` });
  await expect(watchButton).toBeVisible({ timeout: 15_000 });
  await watchButton.click();
  await expect(watchButton).toHaveText(/watchlisted/i);
}
