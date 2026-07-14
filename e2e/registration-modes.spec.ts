import { expect, request as newRequestContext, test } from '@playwright/test';

import { getRegistrationMode, loginAsAdmin, setRegistrationMode } from './support/adminApi';
import { ACCOUNT_PASSWORD, API_BASE_URL } from './support/config';

/**
 * Registration-modes smoke (§6.12 / v3 #420, via issue #446). The admin flips
 * the global mode to `open` through the real settings API (a live change, no
 * restart), a brand-new visitor self-registers at /register, and — open mode
 * signs the account straight in — lands on /portfolio. The prior mode is read
 * first and restored in a `finally`, so the rest of the suite keeps the seed
 * default (`closed`: invite links only).
 */
test('registration modes: open mode allows self-serve signup at /register', async ({ browser }) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const priorMode = await getRegistrationMode(apiRequest);
  await setRegistrationMode(apiRequest, 'open');

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const uid = Date.now().toString(36);
    const email = `e2e-openreg-${uid}@bettertrack.local`;
    const username = `e2eopenreg${uid}`.slice(0, 40);

    await page.goto('/register');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    // Open mode signs the new account straight in → "/" → /portfolio.
    await expect(page).toHaveURL(/\/portfolio$/, { timeout: 20_000 });
  } finally {
    await setRegistrationMode(apiRequest, priorMode);
    await apiRequest.dispose();
    await context.close();
  }
});
