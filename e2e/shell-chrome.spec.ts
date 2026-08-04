import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUserInContext } from './support/users';

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
  '/portfolio/cash/accounts',
  '/workbench',
  '/assets',
  '/people',
] as const;

test('shell chrome fits the viewport and keeps every main area reachable', async ({
  context,
}, testInfo) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const mobile = testInfo.project.name === 'mobile-chromium';
  const user = await provisionUserInContext(context, apiRequest, `chrome-${testInfo.project.name}`);
  await apiRequest.dispose();

  const { page } = user;
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });

  for (const route of PRIMARY_DESTINATIONS) {
    await page.goto(route);

    // The persistent account switcher doubles as this route's settle signal:
    // it only paints once the shell has rendered, and asserting it here proves
    // property (1) on every destination, at whichever width this project runs.
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({
      timeout: 20_000,
    });

    const mobileNav = page.locator('.bt-bottombar');
    const desktopRail = page.locator('.bt-rail');
    if (mobile) {
      await expect(mobileNav).toBeVisible();
      await expect(desktopRail).toBeHidden();
      await expect(mobileNav.getByRole('link')).toHaveCount(5);
    } else {
      await expect(desktopRail).toBeVisible();
      await expect(mobileNav).toBeHidden();
    }

    const activeMainItems = page.locator(
      '.bt-bottombar:not([hidden]) > a.is-active, .bt-rail:not([hidden]) .bt-rail__group--suite > .bt-rail-item.is-active, .bt-rail:not([hidden]) .bt-rail__group--suite > .bt-rail-group > .bt-rail-item.is-active',
    );
    await expect(activeMainItems).toHaveCount(1);
    const activeEdge = await activeMainItems.evaluate((item) => {
      const goldProbe = document.createElement('span');
      goldProbe.style.backgroundColor = 'var(--bt-gold)';
      item.append(goldProbe);
      const gold = getComputedStyle(goldProbe).backgroundColor;
      goldProbe.remove();

      const edge = getComputedStyle(item, '::before');
      return { backgroundColor: edge.backgroundColor, content: edge.content, gold };
    });
    expect(activeEdge.content).not.toBe('none');
    expect(activeEdge.backgroundColor).toBe(activeEdge.gold);

    const inactiveMainItems = page.locator(
      '.bt-bottombar:not([hidden]) > a:not(.is-active), .bt-rail:not([hidden]) .bt-rail__group--suite > .bt-rail-item:not(.is-active), .bt-rail:not([hidden]) .bt-rail__group--suite > .bt-rail-group > .bt-rail-item:not(.is-active)',
    );
    const inactiveEdges = await inactiveMainItems.evaluateAll((items) =>
      items.map((item) => getComputedStyle(item, '::before').content),
    );
    expect(inactiveEdges.length).toBeGreaterThan(0);
    for (const edge of inactiveEdges) expect(edge).toBe('none');

    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    // Sub-pixel rounding makes an exact equality test needlessly brittle.
    expect(
      layout.scrollWidth,
      `${route} scrolls horizontally: ${layout.scrollWidth}px of content in a ${layout.clientWidth}px viewport`,
    ).toBeLessThanOrEqual(layout.clientWidth + 1);

    if (mobile) {
      const undersizedTargets = await page
        .locator('.bt-topbar a:visible, .bt-topbar button:visible, .bt-bottombar a:visible')
        .evaluateAll((targets) =>
          targets
            .map((target) => {
              const box = target.getBoundingClientRect();
              return {
                label: target.getAttribute('aria-label') ?? target.textContent,
                ...box.toJSON(),
              };
            })
            .filter((target) => target.width < 44 || target.height < 44),
        );
      expect(undersizedTargets, `${route} has undersized chrome targets`).toEqual([]);
    }
  }

  // The menu must actually open and offer the way out, not merely exist.
  await page.getByRole('button', { name: 'Account menu' }).click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Logout' })).toBeVisible();
});
