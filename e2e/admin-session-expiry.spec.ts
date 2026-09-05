import { expect, request as newRequestContext, test, type BrowserContext } from '@playwright/test';

import { newAdminBrowserContext, newAdminRequestContext } from './support/adminApi';

/**
 * V5-P13c — the admin console signs out when its session window closes
 * (issue #1779).
 *
 * The absolute admin window is 6–24 h, so it cannot be waited out in a test and
 * the policy floor forbids setting it lower. What the server actually does when
 * it closes is drop the session, after which every `/admin/*` route answers
 * **404** — §6.12's "answer 404 to everyone else", not a 401. Removing the
 * console's session cookie reproduces exactly that server answer against the
 * real stack, without revoking the worker's shared assured admin session (which
 * every other spec in the same worker rides on).
 *
 * The regression this pins: the console used to read that 404 as "the thing you
 * were editing is gone" and paint a red "could not save" banner on a console
 * whose every next request would fail the same way. It must instead land on the
 * admin login screen and say the session expired.
 */
test('an expired admin window lands the console on the login screen, not a failed save', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newAdminRequestContext(newRequestContext);
  let adminCtx: BrowserContext | undefined;
  try {
    adminCtx = await newAdminBrowserContext(browser, apiRequest);
    const page = await adminCtx.newPage();

    // Global settings: a live console on a page with no live refresh, whose save
    // is `PATCH /admin/settings` — a route with no row id, so a 404 there can
    // only mean the admin window closed.
    await page.goto('/admin/settings');
    const betaToggle = page.getByRole('checkbox');
    await expect(betaToggle).toBeVisible({ timeout: 30_000 });
    const save = page.getByRole('button', { name: 'Save settings' });
    await expect(save).toBeDisabled();

    // Dirty the form BEFORE the window closes: this is the operator who was
    // mid-edit when their session ran out.
    await betaToggle.click();
    await expect(save).toBeEnabled();

    // The window closes. No reload — the point of the bug is that the SPA keeps
    // rendering fully-populated admin data until something is clicked.
    await adminCtx.clearCookies();

    await save.click();

    await expect(page.getByText(/your admin session expired/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Admin sign in' })).toBeAttached();
    await expect(page.getByLabel('Email or username')).toBeVisible();
    // The defect: the expiry rendered as a save that failed.
    await expect(page.getByText(/could not be saved/i)).toHaveCount(0);
  } finally {
    await apiRequest.dispose();
    await adminCtx?.close();
  }
});
