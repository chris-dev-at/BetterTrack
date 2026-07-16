import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { befriend, provisionUser } from './support/users';

/**
 * V4-P1 bearer scope enforcement (issue #504). The API-key middleware maps
 * every request to a per-module scope and refuses anything else — plus admin
 * remains unreachable to any bearer regardless of scopes (§6.13, account-kind
 * separation, #361/#396/#405 family).
 *
 * Three directions from one minted key:
 *   1. In-scope: a key with `chat:write` (auto-implies `chat:read`) opens a
 *      conversation with a friend and sends a DM — both POSTs are chat writes.
 *   2. Out-of-scope: the same key hits `GET /notifications` and gets a
 *      403 INSUFFICIENT_SCOPE (it never granted `notifications:read`).
 *   3. Admin unreachable: `GET /admin/users` returns 404 to the bearer even
 *      though the token is valid — no scope combination lets an API key see
 *      the admin surface.
 */
test('bearer scopes: chat:write sends a DM; no notifications:read → 403; admin is unreachable', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const sender = await provisionUser(browser, apiRequest, 'bearsender');
  const recipient = await provisionUser(browser, apiRequest, 'bearrecipient');
  await apiRequest.dispose();

  try {
    await befriend(sender, recipient);

    // Read the recipient's user id through the sender's session — `page.request`
    // shares cookies with the browser context, so this is a session-authed call
    // (the bearer we mint below is deliberately blind to `/social/*`).
    const friendsRes = await sender.page.request.get(`${API_BASE_URL}/api/v1/social/friends`);
    expect(friendsRes.ok(), await friendsRes.text()).toBe(true);
    const friends = (await friendsRes.json()) as {
      friends: Array<{ user: { id: string; username: string } }>;
    };
    const recipientId = friends.friends.find((f) => f.user.username === recipient.username)?.user
      .id;
    expect(
      recipientId,
      `recipient ${recipient.username} not found in ${sender.username}'s friends`,
    ).toBeTruthy();

    // Mint an API key in Settings → API Access with only `chat:write` selected.
    // The write-implies-read rule (#371) auto-locks `chat:read` on; neither
    // notifications nor social nor market is granted.
    await sender.page.goto('/settings/api');
    await sender.page.getByLabel('Name', { exact: true }).fill('bearer-scopes-e2e');
    await sender.page.getByRole('checkbox', { name: /Chat · write/i }).check();
    await sender.page.getByRole('button', { name: 'Create key' }).click();

    // The one-time token modal reveals the plaintext exactly once, inside a
    // <code> block. Read it, then dismiss the modal.
    const tokenModal = sender.page.getByRole('dialog', { name: 'Your new API key' });
    await expect(tokenModal).toBeVisible({ timeout: 15_000 });
    const token = (await tokenModal.locator('code').first().innerText()).trim();
    expect(token).toMatch(/^btk_/);
    await tokenModal.getByRole('button', { name: 'Done' }).click();
    await expect(tokenModal).toBeHidden();

    // A fresh request context that carries ONLY the bearer — no session cookie.
    // Every call below runs on the API-key path, not the cookie path.
    const bearer = await newRequestContext.newContext({
      baseURL: API_BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    const body = `bearer scopes e2e ${Date.now().toString(36)}`;
    try {
      // 1. In-scope: open a conversation and send a DM (both POSTs → chat:write).
      const openRes = await bearer.post('/api/v1/chat/conversations', {
        data: { userId: recipientId },
      });
      expect(openRes.status(), await openRes.text()).toBe(201);
      const conversationId = ((await openRes.json()) as { conversation: { id: string } })
        .conversation.id;

      const sendRes = await bearer.post(`/api/v1/chat/conversations/${conversationId}/messages`, {
        data: { body },
      });
      expect(sendRes.status(), await sendRes.text()).toBe(201);

      // 2. Out-of-scope: the inbox is read-gated by `notifications:read`, which
      //    this token was never issued. The error envelope carries the audited
      //    INSUFFICIENT_SCOPE code so mobile can surface a targeted hint.
      const inboxRes = await bearer.get('/api/v1/notifications');
      expect(inboxRes.status()).toBe(403);
      const inboxBody = (await inboxRes.json()) as { error?: { code?: string } };
      expect(inboxBody.error?.code).toBe('INSUFFICIENT_SCOPE');

      // 3. Admin is unreachable to ANY bearer regardless of scopes (§6.13). The
      //    middleware 404s to disclose nothing about the admin surface.
      const adminRes = await bearer.get('/api/v1/admin/users');
      expect(adminRes.status()).toBe(404);
    } finally {
      await bearer.dispose();
    }

    // The recipient sees the DM sent through the bearer — the message reached
    // the friend, not just the sender's own outbox.
    await recipient.page.goto('/social/chat');
    const conversation = recipient.page.getByRole('button').filter({ hasText: sender.username });
    await expect(conversation).toBeVisible({ timeout: 20_000 });
    await conversation.first().click();
    await expect(recipient.page.getByText(body)).toBeVisible({ timeout: 15_000 });
  } finally {
    await sender.context.close();
    await recipient.context.close();
  }
});
