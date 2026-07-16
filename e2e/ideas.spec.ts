import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { activateConglomerate } from './support/flows';
import { befriend, provisionUser } from './support/users';

/**
 * V4-P9 Ideas e2e (issue #505). One drive over the shipped flow:
 *   1. Author saves a Workboard analysis (a conglomerate + a yearly-rebalance
 *      backtest) as a named idea with a thesis note.
 *   2. Reopening the idea from `/workboard/ideas` restores that exact state —
 *      the same conglomerate, thesis text, and yearly rebalance mode.
 *   3. Sharing the idea to ONE `specific_friend` shows no friction dialog
 *      (the mid tier of the §16 ladder), and the recipient sees the shared
 *      idea from the friend-row expansion, reads it in the read-only view,
 *      and clones it into their own private Ideas byte-for-byte.
 *   4. Sending an idea chip in chat to a friend who is NOT in the audience
 *      renders the chip's non-viewable state ("Not shared with you") on the
 *      recipient's side and NEVER leaks the idea's name.
 */
test('ideas: save → reopen restores, share specific-friends read-only + clone, non-admitted chip stays private', async ({
  browser,
}) => {
  test.setTimeout(300_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const author = await provisionUser(browser, apiRequest, 'ideaauthor');
  const chosen = await provisionUser(browser, apiRequest, 'chosenfriend');
  const excluded = await provisionUser(browser, apiRequest, 'excludedfriend');
  await apiRequest.dispose();

  // Both are the author's friends — so the audience choice is the only variable.
  await befriend(author, chosen);
  await befriend(author, excluded);

  const IDEA_NAME = `Growth thesis ${Date.now().toString(36)}`;
  const THESIS = 'Betting on secular growth in cloud and productivity.';
  const A = author.page;

  // Step 1 — build a conglomerate and switch its backtest to yearly rebalance,
  // then save the Workboard state as a named idea with a thesis note.
  await activateConglomerate(A, 'Growth basket', [
    { query: 'Apple', symbol: 'AAPL' },
    { query: 'Microsoft', symbol: 'MSFT' },
  ]);
  const rebalGroup = A.getByRole('group', { name: 'Select rebalance frequency' });
  await rebalGroup.getByRole('button', { name: 'Yearly' }).click();
  await expect(rebalGroup.getByRole('button', { name: 'Yearly' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await A.getByRole('button', { name: 'Save as idea' }).click();
  const saveDialog = A.getByRole('dialog', { name: 'Save as idea' });
  await saveDialog.getByLabel('Name').fill(IDEA_NAME);
  await saveDialog.getByLabel('Thesis (optional)').fill(THESIS);
  await saveDialog.getByRole('button', { name: 'Save idea' }).click();
  // Success alert names the saved idea; the "View in Ideas" affordance appears.
  await expect(saveDialog.getByText(new RegExp(IDEA_NAME))).toBeVisible({ timeout: 15_000 });
  await saveDialog.getByRole('button', { name: 'View in Ideas' }).click();
  await expect(A).toHaveURL(/\/workboard\/ideas$/);

  // Step 2 — the Ideas list has the row; opening it restores the saved state,
  // including the yearly-rebalance mode (the "same analysis" contract).
  const ideaRow = A.getByRole('listitem').filter({ hasText: IDEA_NAME });
  await expect(ideaRow).toBeVisible();
  await ideaRow.getByRole('link', { name: 'Open' }).click();
  await expect(A).toHaveURL(/\/workboard\/ideas\/[^/]+$/);
  await expect(A.getByRole('heading', { name: IDEA_NAME })).toBeVisible();
  await expect(A.getByText(THESIS)).toBeVisible();
  await expect(
    A.getByRole('group', { name: 'Select rebalance frequency' }).getByRole('button', {
      name: 'Yearly',
    }),
  ).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });

  // Step 3 — share the idea to ONE specific friend. The mid tier of the
  // friction ladder must render no confirm dialog (that's the point of picking
  // "specific friends" over "all friends" / "public link").
  await A.goto('/workboard/ideas');
  await A.getByRole('listitem')
    .filter({ hasText: IDEA_NAME })
    .getByRole('button', { name: 'Share' })
    .click();
  const picker = A.getByRole('dialog', { name: /Share/ });
  await expect(picker).toBeVisible();
  await picker.getByText('Specific friends', { exact: true }).click();
  // No friction dialog on this tier — neither the all-friends confirm nor the
  // public-link acknowledgment surfaces.
  await expect(picker.getByText(/read-only view with everyone/i)).toHaveCount(0);
  await expect(picker.getByText(/I understand that anyone with the link/i)).toHaveCount(0);
  await picker.getByText(chosen.username, { exact: true }).click();
  await expect(picker.getByText('1 selected')).toBeVisible();
  await picker.getByRole('button', { name: 'Save' }).click();
  await expect(picker).toBeHidden();

  // The chosen friend sees the idea inside the author's friend-row expansion
  // — read-only, with a Clone action that lands a byte-exact PRIVATE copy in
  // their own /workboard/ideas.
  const B = chosen.page;
  await B.goto('/social/friends');
  await B.getByRole('button', { name: author.username }).click();
  const sharedLink = B.getByRole('link', { name: new RegExp(IDEA_NAME) });
  await expect(sharedLink).toBeVisible({ timeout: 15_000 });
  await sharedLink.click();
  await expect(B).toHaveURL(/\/social\/shared-with-me\/ideas\/[^/]+$/);
  await expect(B.getByText(new RegExp(`Shared by ${author.username}`, 'i'))).toBeVisible();
  await expect(B.getByText(/read-only idea/i)).toBeVisible();

  await B.getByRole('button', { name: /Clone to my ideas/i }).click();
  await expect(B).toHaveURL(/\/workboard\/ideas\/[^/]+$/, { timeout: 20_000 });
  await expect(B.getByRole('heading', { name: IDEA_NAME })).toBeVisible();
  await B.goto('/workboard/ideas');
  await expect(B.getByRole('listitem').filter({ hasText: IDEA_NAME })).toBeVisible();

  // Step 4 — the author sends an idea chip in chat to the EXCLUDED friend. The
  // audience is `specific_friends` naming only `chosen`, so the recipient's
  // server-side chip resolution flips `viewable: false` and their message
  // renders the no-leak state — a kind-only label + "Not shared with you"
  // — never the idea's name (V3-P8, "sending never widens access").
  await A.goto('/social/chat');
  await A.getByRole('button', { name: 'New message' }).click();
  const newMsg = A.getByRole('dialog', { name: 'New message' });
  await newMsg.getByRole('button', { name: excluded.username }).click();
  await A.getByRole('button', { name: 'Share an item' }).click();
  const sharePicker = A.getByRole('dialog', { name: 'Share in chat' });
  await sharePicker.getByRole('button').filter({ hasText: IDEA_NAME }).first().click();
  await expect(sharePicker).toBeHidden();

  // The chip lands on the excluded friend's side after realtime + poll flush.
  const C = excluded.page;
  await C.goto('/social/chat');
  const excludedConvo = C.getByRole('button').filter({ hasText: author.username });
  await expect(excludedConvo).toBeVisible({ timeout: 20_000 });
  await excludedConvo.click();
  await expect(C.getByText('Not shared with you')).toBeVisible({ timeout: 15_000 });
  // The chip renders a kind-only label ("Idea") — never the idea's name.
  await expect(C.getByText(IDEA_NAME)).toHaveCount(0);

  await author.context.close();
  await chosen.context.close();
  await excluded.context.close();
});
