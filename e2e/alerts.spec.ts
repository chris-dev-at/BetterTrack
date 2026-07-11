import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/** Mutating API calls need this header or the CSRF guard 403s them. */
const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' };

/**
 * V3-P10 price alerts (issue #426, flow 6). A custom asset gives a deterministic
 * quote: setting a value point pins its price, so a `price_above` alert below
 * that price is guaranteed to fire on the next evaluator tick. The evaluator
 * only runs in the BullMQ worker (wired into the Playwright stack for this
 * flow), and it ticks once a minute — so the waits are honest expect-polls with
 * a ≤90s budget, never a bare sleep.
 */
test('alerts: a price_above alert fires and surfaces in the notification bell', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'alertowner');
  await apiRequest.dispose();

  const page = owner.page;
  // The owner's own session cookies back these API calls (the browser context's
  // request shares the cookie jar) — this is deterministic-quote test setup, the
  // same seam the issue calls out (custom asset + value-points).
  const api = owner.context.request;
  const symbol = `E2E Gold ${Date.now().toString(36)}`;

  const createRes = await api.post(`${API_BASE_URL}/api/v1/custom-assets`, {
    headers: CSRF_HEADERS,
    data: { name: symbol, category: 'commodity', currency: 'EUR' },
  });
  expect(createRes.ok(), await createRes.text()).toBeTruthy();
  const assetId = ((await createRes.json()) as { asset: { id: string } }).asset.id;

  // Pin the quote at 500 EUR by setting a value point for today.
  const today = new Date().toISOString().slice(0, 10);
  const pointsRes = await api.put(`${API_BASE_URL}/api/v1/custom-assets/${assetId}/value-points`, {
    headers: CSRF_HEADERS,
    data: { points: [{ date: today, value: 500 }] },
  });
  expect(pointsRes.ok(), await pointsRes.text()).toBeTruthy();

  // A one-shot "rises above 100 EUR" alert — 500 ≥ 100, so it fires next tick.
  const alertRes = await api.post(`${API_BASE_URL}/api/v1/alerts`, {
    headers: CSRF_HEADERS,
    data: { assetId, kind: 'price_above', threshold: 100, repeat: false },
  });
  expect(alertRes.ok(), await alertRes.text()).toBeTruthy();

  // The alert shows on the panel, initially Active.
  await page.goto('/workboard/alerts');
  await expect(page.getByText(symbol)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Active')).toBeVisible();

  // Wait out the ~60s evaluator tick (budget ≤90s), reloading to re-poll the
  // list rather than sleeping. Once it fires it flips to Triggered + offers a
  // Re-arm on the one-shot.
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Triggered')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Re-arm' })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000, intervals: [3_000, 3_000, 5_000] });

  // The fire also lands an in-app notification: the bell badge goes unread and
  // the dropdown carries the alert row.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: /Notifications \(\d+ unread\)/ })).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 30_000, intervals: [3_000] });

  await page.getByRole('button', { name: /Notifications/ }).click();
  const bell = page.getByRole('dialog', { name: 'Notifications' });
  await expect(bell.getByText(`Price alert: ${symbol}`)).toBeVisible({ timeout: 10_000 });

  await owner.context.close();
});
