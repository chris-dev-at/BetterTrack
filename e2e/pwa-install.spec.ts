import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { newAdminRequestContext } from './support/adminApi';
import { expectUserShellReady } from './support/flows';
import { provisionUserInContext } from './support/users';

/**
 * The installable-PWA half of V5-P13b (PROJECTPLAN §7.1).
 *
 * Everything here is browser-shaped and therefore invisible to the web
 * package's vitest run: whether the manifest is actually attached to the user
 * origin at runtime, whether the icons it names are really served, and whether
 * a dismissal survives a real reload rather than a remount.
 *
 * Two things are SIMULATED, and cannot honestly be otherwise:
 *   • `beforeinstallprompt` — Chromium fires it on its own installability
 *     heuristics and never in a headless run. It is dispatched here with the
 *     shape the component reads, which is exactly the contract under test:
 *     capture it, show the card, call `prompt()` on the user's click.
 *   • standalone mode — Playwright has no display-mode emulation, so the
 *     `matchMedia` answer is stubbed before the app boots. That is the one
 *     input `apps/web/src/lib/pwaDisplayMode.ts` reads, so the app cannot tell
 *     the difference.
 *
 * Each test gets a fresh context, so `localStorage` starts empty and the
 * "never answered" state needs no setup.
 */

const DISMISS_KEY = 'bt.pwa.install';

/** Dispatch the Chromium event with the two fields the component uses. */
async function fireBeforeInstallPrompt(page: Page): Promise<void> {
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt?: () => Promise<void>;
    };
    event.prompt = () => {
      (window as unknown as { __btInstallPrompted?: boolean }).__btInstallPrompted = true;
      return Promise.resolve();
    };
    window.dispatchEvent(event);
  });
}

/**
 * Stub `(display-mode: standalone)` before the app boots. Playwright has no
 * display-mode emulation, and this is the one input `lib/pwaDisplayMode.ts`
 * reads, so the app cannot tell the difference.
 */
async function pretendStandalone(target: Pick<Page, 'addInitScript'>): Promise<void> {
  await target.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        query.includes('display-mode: standalone')
          ? {
              matches: true,
              media: query,
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              addListener: () => {},
              removeListener: () => {},
              dispatchEvent: () => false,
            }
          : real(query),
    });
  });
}

test.describe('installable PWA', () => {
  test('pwa: the user origin serves an installable manifest and its iOS icon', async ({
    page,
    baseURL,
  }) => {
    await page.goto('/login');

    // Attached at RUNTIME by lib/appServiceWorker.ts and never in index.html —
    // that is what keeps the admin origin deliberately non-installable.
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest',
    );
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('sizes', '180x180');

    const response = await page.request.get(new URL('/manifest.webmanifest', baseURL!).href);
    expect(response.ok()).toBe(true);
    const manifest = (await response.json()) as {
      display: string;
      icons: { src: string }[];
      lang: string;
      orientation: string;
      scope: string;
      start_url: string;
    };
    expect(manifest).toMatchObject({
      display: 'standalone',
      lang: 'en',
      orientation: 'any',
      scope: '/',
      start_url: '/',
    });

    for (const src of [
      ...manifest.icons.map((icon) => icon.src),
      '/icons/bettertrack-apple-touch-180.png',
    ]) {
      const icon = await page.request.get(new URL(src, baseURL!).href);
      expect(icon.ok(), `${src} must be served`).toBe(true);
      expect(icon.headers()['content-type']).toContain('image/png');
    }
  });

  test('pwa: the install affordance appears, dismisses, and stays dismissed across a reload', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByTestId('pwa-install-prompt')).toHaveCount(0);

    await fireBeforeInstallPrompt(page);
    const card = page.getByTestId('pwa-install-prompt');
    await expect(card).toBeVisible();

    // Anti-bloat (owner, binding): out of the document flow, so it takes no
    // layout from whichever surface it floats over.
    await expect(card).toHaveCSS('position', 'fixed');

    await page.getByTestId('pwa-install-dismiss').click();
    await expect(card).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), DISMISS_KEY)).toBe('dismissed');

    // A real reload, and the browser offering the install again: the card must
    // not come back. An install prompt that returns is the nagging the
    // anti-bloat rule exists to forbid.
    await page.reload();
    await fireBeforeInstallPrompt(page);
    await expect(page.getByTestId('pwa-install-prompt')).toHaveCount(0);
  });

  test('pwa: no install affordance in a standalone window, and the standalone rules are stamped', async ({
    page,
  }) => {
    await pretendStandalone(page);

    await page.goto('/login');

    // The root attribute the stylesheet's standalone block keys off — stamped
    // for the iOS versions whose only signal is `navigator.standalone`.
    await expect(page.locator('html')).toHaveAttribute('data-bt-display-mode', 'standalone');

    // Already an app: nothing to install, so nothing is offered.
    await fireBeforeInstallPrompt(page);
    await expect(page.getByTestId('pwa-install-prompt')).toHaveCount(0);
  });

  /**
   * The other half of the acceptance line: the in-app back affordance. A
   * chromeless window has no browser back at all on iOS, so the topbar brings
   * its own — and it must exist ONLY where `navigate(-1)` has somewhere to go.
   * Needs the authenticated shell, hence the provisioned account.
   */
  test('pwa: a standalone window carries its own back button, and never a dead one', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const apiRequest = await newAdminRequestContext(newRequestContext);
    const context = await browser.newContext();
    await pretendStandalone(context);
    const user = await provisionUserInContext(context, apiRequest, 'pwaback');
    await apiRequest.dispose();
    const page = user.page;

    try {
      // A fresh load is history index 0, whatever boot-time redirects the shell
      // performed on the way (each mints a new router location key while the
      // index stays put). A back button here would be dead, or would walk the
      // user out of the app entirely.
      await page.goto('/portfolio');
      await expectUserShellReady(page);
      await expect(page.locator('html')).toHaveAttribute('data-bt-display-mode', 'standalone');
      await expect(page.getByTestId('standalone-back')).toHaveCount(0);

      // One real in-app navigation, and the affordance appears.
      await page.locator('.bt-rail-item__link[href="/assets"]').first().click();
      await expect(page).toHaveURL(/\/assets$/);
      const back = page.getByTestId('standalone-back');
      await expect(back).toBeVisible();

      await back.click();
      await expect(page).toHaveURL(/\/portfolio/);
      // Back at the entry the window opened on, so the control retires again.
      await expect(page.getByTestId('standalone-back')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
