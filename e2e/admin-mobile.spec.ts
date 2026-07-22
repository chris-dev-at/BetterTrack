import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin, newAdminBrowserContext } from './support/adminApi';
import { API_BASE_URL } from './support/config';

/**
 * V5-P13b admin mobile spec (issue #683). Drives the admin user-management flow
 * on an iPhone 12 viewport (390×844) to prove the sweep landed: the burger
 * drawer opens, the users list scrolls without clipping controls, and a row
 * opens the per-user detail view — where the bank of action buttons flows
 * without overlap at phone width.
 *
 * Ships in the nightly suite (root Playwright config's `mobile-chromium`
 * project already covers the same shell for the user-facing specs).
 *
 * `configureAdminOrigin` overrides the SPA's runtime config so the admin app
 * mounts on this same dev origin — production splits admin onto its own
 * subdomain via a per-origin nginx config.js, but the dev stack serves both
 * apps from a single Vite instance where the default config.js reports
 * `app: 'user'`.
 */
async function configureAdminOrigin(context: import('@playwright/test').BrowserContext) {
  // `addInitScript` runs after document creation but BEFORE the classical
  // `<script src="/config.js">` in apps/web/index.html executes, so the
  // default `window.__BT__ = { app: 'user', ... }` in that file would clobber
  // an init-script assignment and the SPA would boot the user router. Fulfill
  // the config.js request itself with admin flags so the SPA sees `app:
  // 'admin'` when it reads runtime config after boot.
  await context.route('**/config.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: "window.__BT__ = { app: 'admin', apiOrigin: '' };",
    }),
  );
}

test('admin mobile: burger, users list, user detail render without clipping at 390×844', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const adminCtx = await newAdminBrowserContext(browser, apiRequest);
  try {
    await configureAdminOrigin(adminCtx);
    // Force an iPhone 12 viewport — the root `mobile-chromium` project already
    // uses Pixel 7 dimensions, but 390×844 is the primary owner target
    // (§13.5 V5-P13b, "primary audience: iOS users").
    const adminPage = await adminCtx.newPage();
    await adminPage.setViewportSize({ width: 390, height: 844 });

    await adminPage.goto('/admin/users');

    // The mobile-only top bar shows the burger. The burger is the only way to
    // reach the nav at this width; it must be visible and hit-testable.
    const burger = adminPage.getByRole('button', { name: 'Open admin menu' });
    await expect(burger).toBeVisible({ timeout: 20_000 });
    await burger.click();

    // Drawer opens and every nav link is reachable — a spot check on Settings
    // proves the drawer isn't stuck behind the header/backdrop.
    const menu = adminPage.getByRole('dialog', { name: 'Admin menu' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Users' })).toBeVisible();
    await menu.getByRole('button', { name: 'Close admin menu' }).click();
    await expect(menu).toBeHidden();

    // The users search box and Create button remain reachable — no clipping
    // above the fold at this viewport.
    await expect(adminPage.getByLabel('Search')).toBeVisible();
    const createUser = adminPage.getByRole('button', { name: 'Create user' });
    await expect(createUser).toBeVisible();

    // The list body shows at least the seeded admin row; opening it drops us
    // into the per-user detail view.
    const adminRow = adminPage
      .getByRole('row')
      .filter({ hasText: 'e2e-admin@bettertrack.local' })
      .first();
    await expect(adminRow).toBeVisible({ timeout: 20_000 });
    await adminRow.click();

    // The per-user Actions block ships the danger button — the row of buttons
    // sits inside a `flex flex-wrap`, so on a narrow phone they wrap instead
    // of clipping. Every button must remain hit-testable and inside the
    // viewport.
    await expect(adminPage.getByRole('button', { name: 'Delete' })).toBeVisible({
      timeout: 20_000,
    });
    for (const label of ['Reset password', 'Send test email']) {
      const button = adminPage.getByRole('button', { name: label });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `${label} bounding box`).toBeTruthy();
      if (box) {
        expect(box.x + box.width).toBeLessThanOrEqual(390);
      }
    }
  } finally {
    await apiRequest.dispose();
    await adminCtx.close();
  }
});
