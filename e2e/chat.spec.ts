import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { befriend, provisionUser } from './support/users';

/**
 * V3-P8 friend chat (issue #426, flow 5). A DM sent between two friends must
 * reach the recipient — the poll fallback is enough here, no realtime
 * dependency in the assertion.
 */
test('chat: a direct message reaches the recipient', async ({ browser }) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const sender = await provisionUser(browser, apiRequest, 'chatsender');
  const recipient = await provisionUser(browser, apiRequest, 'chatrecipient');
  await apiRequest.dispose();

  await befriend(sender, recipient);

  const body = `hello from e2e ${Date.now().toString(36)}`;

  // Sender opens a new chat with the friend and sends a message.
  await sender.page.goto('/social/chat');
  await sender.page.getByRole('button', { name: 'New message' }).click();
  const newChat = sender.page.getByRole('dialog', { name: 'New message' });
  await newChat.getByRole('button', { name: recipient.username }).click();
  await sender.page.getByPlaceholder('Message').fill(body);
  await sender.page.getByRole('button', { name: 'Send' }).click();
  await expect(sender.page.getByText(body)).toBeVisible({ timeout: 15_000 });

  // Recipient opens their chat list, selects the conversation, and sees the DM.
  await recipient.page.goto('/social/chat');
  const conversation = recipient.page.getByRole('button').filter({ hasText: sender.username });
  await expect(conversation).toBeVisible({ timeout: 20_000 });
  await conversation.click();
  await expect(recipient.page.getByText(body)).toBeVisible({ timeout: 15_000 });

  await sender.context.close();
  await recipient.context.close();
});
