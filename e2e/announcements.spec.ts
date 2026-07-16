import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * Announcements (§13.4 V4-P5b). Proves the two behaviors e2e is uniquely
 * suited for end-to-end:
 *
 *  1. an activated announcement reaches every user's banner (delivery + render);
 *  2. dismissal is per-user (Alice hides it, Bob still sees it) and survives a
 *     fresh sign-in.
 *
 * The admin composer surface is exercised through the admin API (the composer
 * page unit tests cover its form UI). This spec keeps the admin path lean and
 * focuses the browser-driven assertions on the user-facing banner.
 */
test('announcements: an active announcement reaches every user and stays dismissed per user', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);

  const alice = await provisionUser(browser, apiRequest, 'annalice');
  const bob = await provisionUser(browser, apiRequest, 'annbob');

  // Compose + publish an announcement (admin API — the composer page tests
  // cover the form itself). Delivery = banner + inbox for both users.
  const create = await apiRequest.post(`${API_BASE_URL}/api/v1/admin/announcements`, {
    headers: { 'X-Requested-With': 'BetterTrack' },
    data: {
      severity: 'warning',
      titleEn: 'E2E scheduled maintenance',
      bodyEn: 'BetterTrack will be briefly unavailable at 22:00 UTC for upgrades.',
      titleDe: 'Geplante Wartung (E2E)',
      bodyDe: 'BetterTrack ist um 22:00 UTC kurz nicht verfügbar.',
      active: true,
    },
  });
  expect(create.status()).toBe(201);
  const created = (await create.json()) as { id: string };
  await apiRequest.dispose();

  // Alice sees the banner on any authenticated route.
  await alice.page.goto('/portfolio');
  const aliceBanner = alice.page.getByTestId(`announcement-${created.id}`);
  await expect(aliceBanner).toBeVisible({ timeout: 15_000 });
  await expect(aliceBanner).toContainText('E2E scheduled maintenance');

  // Bob sees the banner too.
  await bob.page.goto('/portfolio');
  const bobBanner = bob.page.getByTestId(`announcement-${created.id}`);
  await expect(bobBanner).toBeVisible({ timeout: 15_000 });

  // Alice dismisses — the banner leaves her view immediately.
  await aliceBanner.getByRole('button', { name: /Dismiss/i }).click();
  await expect(aliceBanner).toHaveCount(0, { timeout: 15_000 });

  // Bob still sees it — dismissal is per user.
  await bob.page.reload();
  await expect(bob.page.getByTestId(`announcement-${created.id}`)).toBeVisible({
    timeout: 15_000,
  });

  // A fresh session for Alice — the dismissal persists.
  await alice.context.close();
  const aliceReturn = await browser.newContext();
  const aliceReturnPage = await aliceReturn.newPage();
  await aliceReturnPage.goto('/login');
  await aliceReturnPage.getByLabel('Email or username').fill(alice.email);
  await aliceReturnPage.getByLabel('Password').fill('Sup3rSecret!Passw0rd2');
  await aliceReturnPage.getByRole('button', { name: 'Sign in' }).click();
  await aliceReturnPage.waitForURL(/\/portfolio/);
  await expect(aliceReturnPage.getByTestId(`announcement-${created.id}`)).toHaveCount(0, {
    timeout: 15_000,
  });
  // And the inbox notification remains (banner ≠ inbox — she can still read it).
  await aliceReturnPage.goto('/settings/notifications');
  await expect(aliceReturnPage.getByText('E2E scheduled maintenance').first()).toBeVisible({
    timeout: 15_000,
  });

  await aliceReturn.close();
  await bob.context.close();
});
