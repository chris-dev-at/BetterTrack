import {
  expect,
  request as newRequestContext,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUserInContext } from './support/users';

/**
 * Light mode, in a real browser (board #68).
 *
 * The unit suite can prove the token values and the storage contract, but not
 * the two things that only exist once a browser lays the page out:
 *
 *   1. The pre-hydration stamp. `index.html` sets `data-bt-theme` before the
 *      bundle runs; jsdom never executes that script, so only a real load can
 *      show that a light-pinned session does not flash the dark canvas.
 *   2. That the tokens actually reach paint. A stylesheet full of correct light
 *      values proves nothing if a component paints its own colour anyway —
 *      `getComputedStyle` on a real surface is the only honest check.
 *
 * `emulateMedia` drives the OS preference, which is what makes the System state
 * testable at all.
 */

/** The canvas colours the light and dark token blocks declare (`origin.css`). */
const CANVAS = {
  dark: 'rgb(9, 12, 16)', // #090c10
  light: 'rgb(241, 242, 243)', // #f1f2f3
};

const theme = (page: Page) => page.locator('html').getAttribute('data-bt-theme');

/**
 * ONE admin session for the whole file.
 *
 * The seeded admin is 2FA-mandatory, and its TOTP step is 30 seconds wide — so
 * three per-test `loginAsAdmin` calls inside one worker (`workers: 1`) present
 * the same code three times and the API rejects the replays. Signing in once
 * per file is both correct and what the single-test specs do implicitly.
 */
let apiRequest: APIRequestContext;

test.beforeAll(async () => {
  apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
});

test.afterAll(async () => {
  await apiRequest.dispose();
});

test('boots light from a stored pin, without a flash of the dark canvas', async ({
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One browser is enough for a theme smoke.');

  const user = await provisionUserInContext(context, apiRequest, 'theme');
  const { page } = user;

  // Pin light the way the Appearance control does, then reload so the INLINE
  // boot script — not React — is what stamps the root.
  await page.evaluate(() => localStorage.setItem('bt.ui.theme', 'light'));
  await page.reload({ waitUntil: 'commit' });

  // Asserted before networkidle on purpose: the stamp has to be there from the
  // very first paint, not after the app has mounted.
  await expect
    .poll(() => theme(page), { message: 'root stamped light before hydration' })
    .toBe('light');

  await page.waitForLoadState('networkidle');
  expect(await theme(page)).toBe('light');

  // A visible surface really paints light, and the browser chrome agrees.
  const canvas = page.locator('.bt-app').first();
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveCSS('background-color', CANVAS.light);
  expect(await page.locator('meta[name="theme-color"]').first().getAttribute('content')).toBe(
    '#f1f2f3',
  );

  // `color-scheme` is what makes native widgets and the overscroll gutter follow.
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
});

test('System follows the OS, and an explicit pin overrides it', async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One browser is enough for a theme smoke.');

  const { page } = await provisionUserInContext(context, apiRequest, 'theme-system');

  // No stored pin ⇒ System ⇒ the OS decides.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload({ waitUntil: 'networkidle' });
  expect(await theme(page)).toBe('light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload({ waitUntil: 'networkidle' });
  expect(await theme(page)).toBe('dark');
  await expect(page.locator('.bt-app').first()).toHaveCSS('background-color', CANVAS.dark);

  // A pin outranks the OS and survives a reload — the case a media query alone
  // gets wrong, and the reason the setting is not just `prefers-color-scheme`.
  await page.evaluate(() => localStorage.setItem('bt.ui.theme', 'light'));
  await page.reload({ waitUntil: 'networkidle' });
  expect(await theme(page)).toBe('light');
});

test('the Appearance panel switches the theme live', async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One browser is enough for a theme smoke.');

  const { page } = await provisionUserInContext(context, apiRequest, 'theme-panel');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/control/appearance');

  const group = page.getByRole('group', { name: 'Theme' });
  await expect(group).toBeVisible();
  await expect(group.getByRole('button', { name: 'System (Dark)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await group.getByRole('button', { name: 'Light', exact: true }).click();

  expect(await theme(page)).toBe('light');
  await expect(page.locator('.bt-app').first()).toHaveCSS('background-color', CANVAS.light);

  /**
   * The owner's standing nav rule (memory: design-feedback-nav-active): the gold
   * edge line marks the ACTIVE main rail item and nothing else. Light mode had
   * to darken gold to keep that 3px dash visible on a near-white rail, so this
   * asserts the marker exists on the active row and on no other.
   */
  const railItems = page.locator('.bt-rail-item');
  const edges = await railItems.evaluateAll((rows) =>
    rows.map((row) => ({
      active: row.classList.contains('is-active'),
      edge: getComputedStyle(row, '::before').content !== 'none',
    })),
  );
  expect(edges.length).toBeGreaterThan(0);
  expect(edges.filter((row) => row.edge && !row.active)).toEqual([]);

  /**
   * The scrub tooltip (#1164) paints itself from `--bt-*` custom properties in
   * INLINE styles. A unit test can prove it names the right tokens; only a real
   * browser can prove those tokens resolve to light values once the theme is
   * on. Reaching the tooltip itself needs a funded portfolio and a canvas
   * hover, so this resolves the exact three properties it uses — the cheap half
   * of that assertion, and the half a stylesheet typo would break.
   */
  const tooltipTokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      surface: style.getPropertyValue('--bt-surface-strong').trim(),
      border: style.getPropertyValue('--bt-border').trim(),
      shadow: style.getPropertyValue('--bt-shadow-menu').trim(),
    };
  });
  expect(tooltipTokens.surface).toBe('#ffffff');
  // The dark theme's border and menu shadow are a light-on-dark hairline and a
  // 45 % black drop; both must have flipped, or the tooltip is a dark card.
  expect(tooltipTokens.border).toBe('rgba(20, 27, 35, 0.1)');
  expect(tooltipTokens.shadow).toBe('0 10px 34px rgba(16, 24, 32, 0.16)');
});
