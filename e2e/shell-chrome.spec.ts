import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * The shell's chrome must fit the viewport it is given, and its persistent
 * utilities must be reachable at every width (docs/redesign/PRODUCT_BLUEPRINT.md
 * §4 — Create, Notifications and the account switcher are listed as persistent).
 *
 * Both properties failed silently at phone width, and neither is visible to a
 * unit test, because jsdom has no layout:
 *
 *   1. The account menu lived ONLY in the rail, which is `display: none` at
 *      ≤760px — so a phone had no route to My profile, Settings, Discreet mode
 *      or even Logout.
 *   2. The topbar overflowed: a 140px wordmark plus the portfolio switcher's
 *      200px floor beside four utility buttons needed 559px on a 412px device.
 *      That widened the layout viewport, so the document scrolled sideways —
 *      and because a portalled dialog's `position: fixed` overlay sizes to that
 *      widened containing block, every dialog centred itself partly outside the
 *      visible viewport and its buttons stopped being clickable. The e2e suite
 *      experienced this as mobile specs retrying clicks until they timed out.
 *
 * A horizontal scrollbar is the cheap, reliable signal for the whole class, so
 * it is asserted on each primary destination in both projects — on desktop it
 * is trivially true, on `mobile-chromium` it is the real guard.
 */
const PRIMARY_DESTINATIONS = [
  '/',
  '/portfolio',
  '/portfolio/cash-flow/accounts',
  '/workbench',
  '/assets',
  '/people',
] as const;

test('shell chrome fits the viewport and keeps the account menu reachable', async ({ browser }) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const user = await provisionUser(browser, apiRequest, 'chrome');
  await apiRequest.dispose();

  const { page } = user;

  for (const route of PRIMARY_DESTINATIONS) {
    await page.goto(route);

    // The persistent account switcher doubles as this route's settle signal:
    // it only paints once the shell has rendered, and asserting it here proves
    // property (1) on every destination, at whichever width this project runs.
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({
      timeout: 20_000,
    });

    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    // Sub-pixel rounding makes an exact equality test needlessly brittle.
    expect(
      layout.scrollWidth,
      `${route} scrolls horizontally: ${layout.scrollWidth}px of content in a ${layout.clientWidth}px viewport`,
    ).toBeLessThanOrEqual(layout.clientWidth + 1);
  }

  // The menu must actually open and offer the way out, not merely exist.
  await page.getByRole('button', { name: 'Account menu' }).click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Logout' })).toBeVisible();
});
