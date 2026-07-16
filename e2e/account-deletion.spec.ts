import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { ACCOUNT_PASSWORD, API_BASE_URL } from './support/config';
import { befriend, provisionUser } from './support/users';

/**
 * V4-P2c self-service account deletion (issue #504, shipped #392). The danger-
 * zone flow deletes hard — re-auth (password) + typed username confirmation —
 * revokes every session, and anonymizes the caller in a partner's chat while
 * leaving the message history readable (§16 2026-07-09).
 *
 * Three properties, one end-to-end drive:
 *   1. Delete completes on password + typed confirm → the SPA lands on /login.
 *   2. Re-signing in with the same credentials fails (§6.1 generic invalid-
 *      credentials, since the server never reveals user existence).
 *   3. A partner still opens the conversation — the deleted account renders as
 *      "Deleted user", the pre-delete message body stays visible, and the
 *      thread is closed to new sends (the composer is gone).
 */
test('account deletion: re-auth + typed confirm deletes the account, revokes sessions, and anonymizes chat history', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'delowner');
  const friend = await provisionUser(browser, apiRequest, 'delfriend');
  await apiRequest.dispose();

  const ownerUsername = owner.username;

  try {
    await befriend(owner, friend);

    // Owner sends one DM through the real chat UI so there is history to
    // anonymize after deletion.
    const messageBody = `pre-delete ${Date.now().toString(36)}`;
    await owner.page.goto('/social/chat');
    await owner.page.getByRole('button', { name: 'New message' }).click();
    const newChat = owner.page.getByRole('dialog', { name: 'New message' });
    await newChat.getByRole('button', { name: friend.username }).click();
    await owner.page.getByPlaceholder('Message').fill(messageBody);
    await owner.page.getByRole('button', { name: 'Send' }).click();
    await expect(owner.page.getByText(messageBody)).toBeVisible({ timeout: 15_000 });

    // Danger-zone deletion: the stable public URL Google Play points at. The
    // form gates on typed confirmation + current password server-side; on
    // success every session is already dead and the SPA lands on /login.
    await owner.page.goto('/account/delete');
    await expect(owner.page.getByRole('heading', { name: 'Delete your account' })).toBeVisible({
      timeout: 15_000,
    });
    await owner.page.getByLabel(/Type your username/i).fill(ownerUsername);
    await owner.page.getByLabel('Current password', { exact: true }).fill(ACCOUNT_PASSWORD);
    await owner.page.getByRole('button', { name: /Delete my account permanently/i }).click();
    await expect(owner.page).toHaveURL(/\/login$/, { timeout: 20_000 });

    // Old credentials no longer sign in. §6.1: never distinguish "no such user"
    // from "wrong password", so the visible error is the generic form.
    await owner.page.getByLabel('Email or username').fill(ownerUsername);
    await owner.page.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await owner.page.getByRole('button', { name: 'Sign in' }).click();
    await expect(owner.page.getByText(/incorrect email\/username or password/i)).toBeVisible({
      timeout: 15_000,
    });

    // Friend still opens the same conversation — the partner is anonymized to
    // "Deleted user", the pre-delete DM body is preserved, and the composer is
    // gone (the thread is closed to new messages).
    await friend.page.goto('/social/chat');
    const deletedRow = friend.page.getByRole('button').filter({ hasText: 'Deleted user' });
    await expect(deletedRow).toBeVisible({ timeout: 20_000 });
    await expect(deletedRow).not.toContainText(ownerUsername);

    await deletedRow.first().click();
    await expect(friend.page.getByText(messageBody)).toBeVisible({ timeout: 15_000 });
    await expect(friend.page.getByText(/this account no longer exists/i)).toBeVisible();
    await expect(friend.page.getByPlaceholder('Message')).toHaveCount(0);
  } finally {
    // The owner's context still holds a dead session and its cookies — the
    // finally close-out is enough; no further teardown needed.
    await owner.context.close();
    await friend.context.close();
  }
});
