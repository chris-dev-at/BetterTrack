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
  light: 'rgb(255, 255, 255)', // #ffffff — clean white (THEME2)
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
    '#ffffff',
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
  expect(tooltipTokens.border).toBe('rgba(19, 24, 32, 0.1)');
  expect(tooltipTokens.shadow).toBe('0 10px 34px rgba(16, 24, 32, 0.16)');
});

/**
 * The gold override reaches paint (THEME3, owner final word 2026-08-07).
 *
 * The unit suite proves the token VALUES in the stylesheet. What it cannot
 * prove is that a real browser, on a real page, resolves them — a cascade
 * mistake, a stale rule or a component painting its own gold all look fine to a
 * file scanner. So this loads the two pages that carry the most gold (portfolio
 * and analytics) with light pinned, and reads the values back off the document.
 *
 * The geometry half matters most here: `--bt-gold-edge` is the token that pays
 * for keeping brand gold bright at 1.78:1 on white, and a laid-out `4px` dash
 * is the only honest proof it did.
 */
test('light mode resolves the bright gold and its geometry on real pages', async ({
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One browser is enough for a theme smoke.');

  const { page } = await provisionUserInContext(context, apiRequest, 'theme-gold');

  await page.evaluate(() => localStorage.setItem('bt.ui.theme', 'light'));

  for (const route of ['/portfolio', '/portfolio/analysis']) {
    await page.goto(route, { waitUntil: 'networkidle' });
    expect(await theme(page), `${route} is light`).toBe('light');

    const gold = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const read = (name: string) => style.getPropertyValue(name).trim();
      return {
        ink: read('--bt-gold-ink'),
        graphic: read('--bt-gold-graphic'),
        fill: read('--bt-gold-fill'),
        soft: read('--bt-gold-soft'),
        chartFlag: read('--bt-chart-flag'),
        accent: read('--bt-border-accent'),
        hair: read('--bt-gold-hair'),
        ring: read('--bt-gold-ring'),
        edge: read('--bt-gold-edge'),
        // The safety valve is declared as `var(--bt-text)`; only a browser
        // resolves that chain, and a converted sentence is unreadable if it
        // ever resolves back to the gold.
        safe: getComputedStyle(document.body).color,
      };
    });

    // Bright brand gold, on every graphical job.
    expect(gold.graphic, `${route} graphic gold`).toBe('#f6b82e');
    expect(gold.fill, `${route} gold fill`).toBe('#f6b82e');
    expect(gold.chartFlag, `${route} chart flag`).toBe('#f6b82e');
    // Gold as an accent ink, sub-AA by owner decision.
    expect(gold.ink, `${route} gold ink`).toBe('#d49e28');
    // The wash family the badges sit on is unchanged and still opaque.
    expect(gold.soft, `${route} gold surface`).toBe('#fcf1db');
    // Geometry compensation: heavier strokes, doubled edge alpha.
    expect(gold.hair, `${route} gold hairline`).toBe('2px');
    expect(gold.ring, `${route} gold ring`).toBe('3px');
    expect(gold.edge, `${route} gold edge`).toBe('4px');
    expect(gold.accent, `${route} edge alpha`).toBe('rgba(246, 184, 46, 0.6)');
  }

  // …and the active-rail dash is really laid out at the compensated width, not
  // merely declared at it.
  const dash = await page
    .locator('.bt-rail-item.is-active')
    .first()
    .evaluate((row) => getComputedStyle(row, '::before').width);
  expect(dash).toBe('4px');

  // The safety valve resolves to the page ink rather than back to the gold.
  const noteInk = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.className = 'bt-gold-note';
    document.querySelector('.bt-app')?.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  expect(noteInk).toBe('rgb(19, 24, 32)'); // --bt-text, not --bt-gold-ink
});
