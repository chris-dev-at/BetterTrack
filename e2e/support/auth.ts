import { type Page } from '@playwright/test';

/**
 * Submits the password form on the current login page.
 *
 * `getByRole` name matching is substring-based: the passkey control is named
 * "Sign in with a passkey", so a bare "Sign in" locator would match both it
 * and the password submit button. Keep the exact match here rather than
 * duplicating an ambiguous locator across specs.
 */
export async function passwordSignIn(
  page: Page,
  identifier: string,
  password: string,
): Promise<void> {
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
