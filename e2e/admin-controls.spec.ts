import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin, setChatBanByUsername } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { befriend, provisionUser } from './support/users';

/**
 * V4-P0d admin controls — per-user chat ban (issue #475). An admin bans a user
 * from chat; the banned user's DM send is refused server-side and the chat UI
 * shows a neutral, localized notice while the conversation stays readable.
 */
test('admin chat ban: a banned user sees the neutral notice and cannot send', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const sender = await provisionUser(browser, apiRequest, 'bansender');
  const recipient = await provisionUser(browser, apiRequest, 'banrecipient');

  await befriend(sender, recipient);

  // Open the conversation BEFORE the ban so history stays reachable to read.
  await sender.page.goto('/social/chat');
  await sender.page.getByRole('button', { name: 'New message' }).click();
  const newChat = sender.page.getByRole('dialog', { name: 'New message' });
  await newChat.getByRole('button', { name: recipient.username }).click();
  const first = `pre-ban ${Date.now().toString(36)}`;
  await sender.page.getByPlaceholder('Message').fill(first);
  await sender.page.getByRole('button', { name: 'Send' }).click();
  await expect(sender.page.getByText(first)).toBeVisible({ timeout: 15_000 });

  // Admin bans the sender from chat.
  await setChatBanByUsername(apiRequest, sender.username, true);
  await apiRequest.dispose();

  // A fresh attempt to send is refused; the neutral notice replaces the composer,
  // and the already-sent message stays readable.
  await sender.page.reload();
  const conversation = sender.page.getByRole('button').filter({ hasText: recipient.username });
  await conversation.first().click();
  await sender.page.getByPlaceholder('Message').fill('should not send');
  await sender.page.getByRole('button', { name: 'Send' }).click();

  await expect(sender.page.getByText(/can't send messages right now/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(sender.page.getByPlaceholder('Message')).toHaveCount(0);
  await expect(sender.page.getByText(first)).toBeVisible();

  await sender.context.close();
  await recipient.context.close();
});
