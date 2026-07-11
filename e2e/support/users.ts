import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { createInvite } from './adminApi';
import { ACCOUNT_PASSWORD } from './config';
import { acceptInvite } from './flows';

/**
 * Shared provisioning helpers for the V3 flow specs (issue #426). They extend
 * the happy-path's patterns (admin-invite → drive the real invite-accept page)
 * so every spec starts from freshly minted accounts without forking a second
 * harness. A brand-new BetterTrack account already owns a default "Main"
 * portfolio and a default "General" watchlist — the flows build on those.
 */

export interface E2EUser {
  context: BrowserContext;
  page: Page;
  username: string;
  email: string;
}

/** Monotonic disambiguator so two users minted in the same millisecond never collide. */
let seq = 0;

/**
 * Mint a brand-new account: create an admin invite for it, then drive the real
 * `/invite/:token` page in a fresh browser context. Returns the context + page
 * (already at `/portfolio`) plus the generated username/email.
 */
export async function provisionUser(
  browser: Browser,
  apiRequest: APIRequestContext,
  label: string,
): Promise<E2EUser> {
  const uid = `${Date.now().toString(36)}${(seq++).toString(36)}`;
  const email = `e2e-${label}-${uid}@bettertrack.local`;
  const username = `e2e${label}${uid}`
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 40);

  const token = await createInvite(apiRequest, email);
  const context = await browser.newContext();
  const page = await context.newPage();
  await acceptInvite(page, token, username, ACCOUNT_PASSWORD);
  return { context, page, username, email };
}

/**
 * Establish a mutual friendship, driven entirely through the real Friends UI:
 * `from` sends the request by username, `to` accepts it. Asserts `to`'s friends
 * list then carries `from` as a friend card.
 */
export async function befriend(from: E2EUser, to: E2EUser): Promise<void> {
  await from.page.goto('/social/friends');
  await from.page.getByLabel('Username or email').fill(to.username);
  await from.page.getByRole('button', { name: 'Send request' }).click();
  await expect(from.page.getByText(/we've sent your friend request/i)).toBeVisible();

  await to.page.goto('/social/friends');
  const requestRow = to.page.getByRole('listitem').filter({ hasText: from.username });
  await expect(requestRow).toBeVisible({ timeout: 15_000 });
  await requestRow.getByRole('button', { name: 'Accept' }).click();

  // The accepted request becomes a friend card (its expand button is labelled
  // with the friend's username).
  await expect(to.page.getByRole('button', { name: from.username })).toBeVisible({
    timeout: 15_000,
  });
}
