import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { setWideningAudienceThroughLadder } from './support/audience';
import { API_BASE_URL } from './support/config';
import { apiV1, CSRF_HEADERS, ownerDeleteComment, ownerThreadComments } from './support/e2';
import { befriend, provisionUser } from './support/users';

/**
 * V5-P8 comments + reactions on shared items, through the real shared-item UI
 * ([V5-P14][E2], #736). One flow proves the whole audience-scoped surface:
 *
 *  - an in-audience friend (a member of a friend GROUP the item is shared to)
 *    sees the thread, adds comments, and reacts to the shared item;
 *  - delete-own: that friend removes their own comment from the thread;
 *  - item-owner moderation: the OWNER removes the friend's other comment —
 *    driven through the owner's own authenticated session because comments mount
 *    only on the friendship-gated friend-shared pages, which an item's owner
 *    cannot open for their own item (there is no owner comment UI); the effect is
 *    then re-observed in the friend's real UI;
 *  - an equally-befriended NON-member (outside the group audience) can reach
 *    neither the shared item nor its thread/reaction state.
 *
 * The friend GROUP is the sharing audience here (criterion 4). Group creation +
 * membership *editing* stays covered end-to-end by `friend-groups.spec.ts`; this
 * spec provisions the group through the owner's authenticated API so it does not
 * duplicate that scenario, and spends its UI budget on comments/reactions.
 */
test('comments: audience-scoped thread, reactions, delete-own and owner moderation', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'cmtowner');
  const member = await provisionUser(browser, apiRequest, 'cmtmember');
  const outsider = await provisionUser(browser, apiRequest, 'cmtoutsider');
  await apiRequest.dispose();

  // Both are friends of the owner — so group membership is the only variable.
  await befriend(owner, member);
  await befriend(owner, outsider);

  const ownerApi = owner.context.request;

  // ── Provision a friend group with only `member` in it (via the owner's own
  //    session — group management itself is friend-groups.spec's job). ──
  const groupName = 'E2 Comment Circle';
  const groupRes = await ownerApi.post(apiV1('/social/groups'), {
    headers: CSRF_HEADERS,
    data: { name: groupName },
  });
  expect(groupRes.ok(), await groupRes.text()).toBeTruthy();
  const groupId = ((await groupRes.json()) as { id: string }).id;

  const friendsRes = await ownerApi.get(apiV1('/social/friends'));
  expect(friendsRes.ok(), await friendsRes.text()).toBeTruthy();
  const friends = (
    (await friendsRes.json()) as { friends: { user: { id: string; username: string } }[] }
  ).friends;
  const memberUserId = friends.find((f) => f.user.username === member.username)?.user.id;
  expect(memberUserId, 'member must be an accepted friend').toBeTruthy();

  const addRes = await ownerApi.post(apiV1(`/social/groups/${groupId}/members`), {
    headers: CSRF_HEADERS,
    data: { userId: memberUserId },
  });
  expect(addRes.ok(), await addRes.text()).toBeTruthy();

  // The owner's default "Main" portfolio id — needed for the owner-side thread
  // read + the outsider's fail-closed check below.
  const portfoliosRes = await ownerApi.get(apiV1('/portfolios'));
  const portfolios = (
    (await portfoliosRes.json()) as { portfolios: { id: string; name: string }[] }
  ).portfolios;
  const portfolioId = portfolios.find((p) => p.name === 'Main')?.id;
  expect(portfolioId, 'owner has a default Main portfolio').toBeTruthy();

  // ── Owner shares "Main" to the group audience (real audience picker). ──
  await owner.page.goto('/people/shared');
  const portfolioRow = owner.page.getByRole('listitem').filter({ hasText: 'Main' });
  await portfolioRow.getByRole('button', { name: 'Share' }).click();
  const picker = owner.page.getByRole('dialog', { name: /Share/ });
  await expect(picker).toBeVisible();
  await setWideningAudienceThroughLadder(picker, { audience: 'group', recipient: groupName });
  await expect(picker).toBeHidden();

  // ── The in-audience member opens the shared portfolio → the comment thread. ──
  await member.page.goto('/people');
  await member.page.getByRole('button', { name: owner.username }).click();
  const sharedLink = member.page.getByRole('link', { name: /Main/ });
  await expect(sharedLink).toBeVisible({ timeout: 15_000 });
  await sharedLink.click();
  await expect(member.page.getByText(new RegExp(`shared by ${owner.username}`, 'i'))).toBeVisible({
    timeout: 15_000,
  });

  // Expand the (initially collapsed, count 0) thread and post two comments.
  await member.page.getByRole('button', { name: '0 comments' }).click();
  const composer = member.page.getByRole('textbox', { name: /Add a comment/ });
  const post = member.page.getByRole('button', { name: 'Post', exact: true });
  await composer.fill('delete-own probe comment');
  await post.click();
  await expect(member.page.getByText('delete-own probe comment')).toBeVisible({ timeout: 15_000 });
  // The thread can refetch the inserted row just before the POST mutation settles.
  // Wait for onSuccess to clear the first draft before typing the second, or that
  // late clear can erase it while the substring locator still matches "Posting…".
  await expect(composer).toHaveValue('', { timeout: 15_000 });
  await composer.fill('owner-moderation probe comment');
  await expect(post).toBeEnabled();
  await post.click();
  await expect(member.page.getByText('owner-moderation probe comment')).toBeVisible({
    timeout: 15_000,
  });
  await expect(member.page.getByRole('button', { name: '2 comments' })).toBeVisible();

  // React to the shared item with 👍 — the chip flips to pressed.
  const itemReactions = member.page.getByRole('group', { name: 'React to this item' });
  const thumb = itemReactions.getByRole('button', { name: '👍' });
  await thumb.click();
  await expect(thumb).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

  // delete-own: the member removes their FIRST comment; the second remains.
  const ownComment = member.page
    .getByRole('listitem')
    .filter({ hasText: 'delete-own probe comment' });
  await ownComment.getByRole('button', { name: 'Delete' }).click();
  await expect(member.page.getByText('delete-own probe comment')).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(member.page.getByText('owner-moderation probe comment')).toBeVisible();

  // item-owner moderation: exactly one comment is left (the member's), and the
  // OWNER deletes it through the real endpoint (authorized by ownership).
  const remaining = await ownerThreadComments(ownerApi, portfolioId!);
  expect(remaining).toHaveLength(1);
  expect(remaining[0]!.body).toBe('owner-moderation probe comment');
  expect(remaining[0]!.author.username).toBe(member.username);
  await ownerDeleteComment(ownerApi, remaining[0]!.id);

  // The member's real UI reflects the moderation: the thread empties out.
  await member.page.reload();
  await expect(member.page.getByRole('button', { name: '0 comments' })).toBeVisible({
    timeout: 15_000,
  });
  await member.page.getByRole('button', { name: '0 comments' }).click();
  await expect(member.page.getByText('owner-moderation probe comment')).toHaveCount(0);
  await expect(member.page.getByText('No comments yet.')).toBeVisible();

  // ── The equally-befriended NON-member sees neither the item nor its thread. ──
  await outsider.page.goto('/people');
  await outsider.page.getByRole('button', { name: owner.username }).click();
  await expect(
    outsider.page.getByText(new RegExp(`${owner.username} isn't sharing anything`, 'i')),
  ).toBeVisible({ timeout: 15_000 });
  await expect(outsider.page.getByRole('link', { name: /Main/ })).toHaveCount(0);
  // Fail-closed at the API too: the thread (and its reaction state) is a uniform
  // 404 for a viewer the audience does not admit (§6.9 no-enumeration).
  // The path must be the real `/social/**` mount: while this read pointed at the
  // non-existent `/api/v1/people/**`, Express answered 404 for EVERY caller and
  // this privacy assertion passed without once exercising the audience check.
  const outsiderThread = await outsider.context.request.get(
    apiV1(`/social/items/portfolio/${portfolioId}/thread`),
  );
  expect(outsiderThread.status()).toBe(404);

  await owner.context.close();
  await member.context.close();
  await outsider.context.close();
});

/**
 * The public-link regression (§16, criterion 3): a public share stays a
 * read-only view with NO comment composer, thread toggle, or reaction controls —
 * comments/reactions never mount on the unauthenticated `/s/:token` page.
 */
test('comments: a public link stays read-only with no comment or reaction UI', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'publinkowner');
  await apiRequest.dispose();

  // Owner mints a public link for "Main" through the real picker (strong-ack tier).
  await owner.page.goto('/people/shared');
  const portfolioRow = owner.page.getByRole('listitem').filter({ hasText: 'Main' });
  await portfolioRow.getByRole('button', { name: 'Share' }).click();
  const picker = owner.page.getByRole('dialog', { name: /Share/ });
  await expect(picker).toBeVisible();
  await setWideningAudienceThroughLadder(picker, { audience: 'public_link' });

  // The minted URL is shown exactly once in a <code> element.
  const code = picker.locator('code');
  await expect(code).toBeVisible({ timeout: 15_000 });
  const publicUrl = (await code.textContent())?.trim() ?? '';
  expect(publicUrl).toMatch(/\/s\/[A-Za-z0-9_-]+$/);

  // A logged-OUT visitor opens the link: read-only, and none of the comment or
  // reaction surfaces exist.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(publicUrl);
  await expect(anonPage.getByText('Read-only shared view')).toBeVisible({ timeout: 15_000 });
  await expect(anonPage.getByRole('textbox', { name: /Add a comment/ })).toHaveCount(0);
  await expect(anonPage.getByRole('button', { name: 'Post' })).toHaveCount(0);
  await expect(anonPage.getByRole('group', { name: 'React to this item' })).toHaveCount(0);
  await expect(anonPage.getByRole('group', { name: 'React to this comment' })).toHaveCount(0);
  await expect(anonPage.getByRole('button', { name: /comments$/ })).toHaveCount(0);

  await anon.close();
  await owner.context.close();
});
