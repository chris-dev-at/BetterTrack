import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * Notification UX smoke (V4-P0c). Proves the two behaviors e2e is uniquely
 * suited for end-to-end:
 *
 *  1. **click-through deep link** — a friend.request notification, opened from
 *     the bell, navigates to the Friends → requests target (the full per-type
 *     route-key matrix is asserted deterministically in the NotificationBell
 *     component test against docs/mobile-push.md §4);
 *  2. **read = archive** — reading a notification archives it: it leaves the
 *     bell (active inbox = unread only) and shows up under the Archived view,
 *     where the bulk actions still live.
 */
test('notifications: bell deep-link + read archives it into the Archived view', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const sender = await provisionUser(browser, apiRequest, 'notifsender');
  const recipient = await provisionUser(browser, apiRequest, 'notifrecipient');
  await apiRequest.dispose();

  // Sender fires a friend request at the recipient (but nobody accepts) — that
  // produces exactly one `friend.request` in-app notification for the recipient.
  await sender.page.goto('/social/friends');
  await sender.page.getByLabel('Username or email').fill(recipient.username);
  await sender.page.getByRole('button', { name: 'Send request' }).click();
  await expect(sender.page.getByText(/we've sent your friend request/i)).toBeVisible();

  // The recipient's bell lights up. Poll a few reloads for the async pipeline.
  const bell = recipient.page.getByRole('button', { name: /Notifications/ });
  await expect(async () => {
    await recipient.page.goto('/portfolio');
    await expect(
      recipient.page.getByRole('button', { name: /Notifications \(\d+ unread\)/ }),
    ).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 60_000 });

  // Open the bell and click the friend.request row → it deep-links to the
  // Friends tab's requests anchor (V4-P0c route-key contract).
  await bell.click();
  const row = recipient.page.getByRole('link', { name: /New friend request/ });
  await expect(row).toBeVisible();
  await row.click();
  await expect(recipient.page).toHaveURL(/\/social\/friends(#requests)?$/);

  // read = archive: the row is now read, so it has left the active inbox — the
  // bell badge is gone and the dropdown no longer lists it.
  await expect(
    recipient.page.getByRole('button', { name: /Notifications \(\d+ unread\)/ }),
  ).toHaveCount(0);
  await recipient.page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(recipient.page.getByRole('link', { name: /New friend request/ })).toHaveCount(0);

  // …and it is retained under the Archived view on the full notifications page.
  await recipient.page.goto('/settings/notifications');
  await recipient.page.getByRole('button', { name: 'Archived' }).click();
  await expect(recipient.page.getByText('New friend request').first()).toBeVisible({
    timeout: 15_000,
  });

  await sender.context.close();
  await recipient.context.close();
});
