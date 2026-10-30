import {
  expect,
  request as newRequestContext,
  test,
  type APIRequestContext,
} from '@playwright/test';

import { newAdminRequestContext } from './support/adminApi';
import { recordSapTrade } from './support/flows';
import { provisionUserInContext } from './support/users';

/**
 * Chart hover under the interface scale, in a real browser (owner bug,
 * 2026-10-29).
 *
 * The Control Center's interface scale is CSS `zoom` on the root. Under it the
 * browser reports pointer positions in rendered px while lightweight-charts
 * reads them as layout px, so at 130 % the scrubbed point ran ahead of the
 * cursor — further the further right it was. The unit suite models the
 * library's coordinate formula and pins it against the installed build; this
 * is the one place the REAL canvas library, the real zoom and real mouse input
 * meet.
 *
 * The scale is the per-device `bt.ui.scale` key the Appearance panel writes;
 * the performance curve is the one surface whose crosshair has a DOM face (the
 * money scrub tooltip), so its anchor is what is read back.
 */

/** The Appearance panel's steps are 1, 1.1 … 1.4; 1.3 is the owner's QHD pick. */
const SCALE = 1.3;

/** Local date `days` ago → ISO `YYYY-MM-DD` (as analytics.spec.ts). */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let apiRequest: APIRequestContext;

test.beforeAll(async () => {
  apiRequest = await newAdminRequestContext(newRequestContext);
});

test.afterAll(async () => {
  await apiRequest.dispose();
});

// Wide enough that 130 % still leaves the desktop layout the ≥1250 effective
// px `autoUiScale` itself insists on (1680 / 1.3 ≈ 1292).
test.use({ viewport: { width: 1680, height: 1050 } });

test('portfolio chart: at 130 % the scrubbed point is the one under the cursor', async ({
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The interface scale is a desktop setting.');
  test.setTimeout(180_000);

  const { page } = await provisionUserInContext(context, apiRequest, 'chartscale');
  // A holding with history, so the overview chart has a curve to scrub.
  await recordSapTrade(page, { side: 'buy', quantity: '5', price: '100', date: isoDaysAgo(200) });

  await page.evaluate((scale) => {
    localStorage.setItem('bt.ui.scale', String(scale));
    localStorage.setItem('bettertrack.chartDisplayMode.portfolio-overview', 'perf');
  }, SCALE);
  await page.goto('/portfolio');
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--bt-zoom')),
    'the stored scale is applied before the chart mounts',
  ).toBe(String(SCALE));

  const chart = page.getByRole('img', { name: 'Portfolio performance over time' });
  await expect(chart.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  // The scrub tooltip is the chart container's next sibling (PriceChart.tsx).
  const tooltip = chart.locator('xpath=following-sibling::div[1]');

  // Playwright's mouse and boundingBox() are both in rendered px. The right
  // price axis (the last ~10 %) is never reached.
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;

  /**
   * How far the crosshair is from `cursorX`, in rendered px. The tooltip is
   * anchored at the crosshair's pointer x (lightweight-charts' `param.point.x`,
   * the very `localX` it snaps the inspected point from) in the chart's LAYOUT
   * px; the zoom draws it at box.x + left × scale.
   */
  async function crosshairOffset(cursorX: number, where: string): Promise<number> {
    await expect(tooltip, `tooltip ${where}`).toBeVisible();
    // Let React commit the reading the crosshair callback just produced.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const left = await tooltip.evaluate((el) => parseFloat((el as HTMLElement).style.left));
    return Math.abs(box.x + left * SCALE - cursorX);
  }

  // Hover. Before the fix the crosshair sat `0.3 × (cursor − box.x)` to the
  // right — 70 px and more here — or left the plot altogether.
  for (const fraction of [0.2, 0.45, 0.7]) {
    const cursorX = box.x + box.width * fraction;
    await page.mouse.move(cursorX, box.y + box.height / 2);
    expect(
      await crosshairOffset(cursorX, `at ${fraction * 100} % across`),
      `at ${fraction * 100} % across, the crosshair is under the cursor`,
    ).toBeLessThan(1.5);
  }

  // Press-and-slide that LEAVES the chart (review of #2075): the library follows
  // the press on the document and clamps the crosshair into the plot, so the
  // reading must stay under the cursor off the chart and after the release.
  const viewport = page.viewportSize()!;
  const outY = box.y > 60 ? box.y - 30 : box.y + box.height + 30;
  expect(outY > 0 && outY < viewport.height, 'room to slide off the chart').toBe(true);
  const outX = box.x + box.width * 0.6;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(outX, outY, { steps: 8 });
  expect(
    await crosshairOffset(outX, 'while sliding off the chart'),
    'a press slid off the chart still reads the point under the cursor',
  ).toBeLessThan(1.5);
  await page.mouse.up();
  expect(
    await crosshairOffset(outX, 'after releasing off the chart'),
    'the reading left on screen after an outside release is the right one',
  ).toBeLessThan(1.5);
});
