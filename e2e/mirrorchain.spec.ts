import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { ACCOUNT_PASSWORD, API_BASE_URL } from './support/config';
import {
  activity,
  apiGet,
  apiSend,
  assetIdFor,
  chainRole,
  createEmptyChain,
  errorCode,
  friendUserId,
  inviteAndJoin,
  isChainMember,
  listTransactions,
  members,
  recordBuy,
  recordSapBuyOnCopyUi,
  waitChainSynced,
  waitForTransaction,
  type LedgerTx,
} from './support/mirror';
import { befriend, provisionUser, type E2EUser } from './support/users';

// This spec drives passwords and deliberate test trade values through the
// browser; never retain a trace, screenshot, or video containing them.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

/**
 * MIRRORCHAIN M6 (V5-P7, `docs/mirrorchain-design.md` §12 item 6): the six §13.5
 * "done-when" scenarios as Playwright specs, joining the nightly suite (§13
 * traceability). Everything runs against the REAL stack — HTTP endpoints through
 * each user's session, replication through the live BullMQ worker — so the specs
 * exercise the whole replication/lifecycle path end to end. Cross-copy waits poll
 * on sync/ledger state (design §2 is job-driven); the two visible surfaces the
 * criteria name (the attribution chip, the fork provenance line) are asserted in
 * the browser. No product code is touched (M6 is test-only).
 */

interface MirrorChainCopy {
  chainId: string;
  name: string;
  portfolioId: string | null;
  role: string;
}

/**
 * Wait for the browser-driven create/join flows to materialize a local copy.
 * The API read is intentionally only a deterministic cross-account observation;
 * every lifecycle mutation in the V5-P14 gate below is made through the user UI.
 */
async function waitForNamedChainCopy(
  user: E2EUser,
  name: string,
  timeout = 30_000,
): Promise<MirrorChainCopy & { portfolioId: string }> {
  let copy: MirrorChainCopy | undefined;
  await expect
    .poll(
      async () => {
        const { chains } = await apiGet<{ chains: MirrorChainCopy[] }>(user, '/mirrorchain/chains');
        copy = chains.find((chain) => chain.name === name && chain.portfolioId !== null);
        return copy?.portfolioId ?? '';
      },
      { timeout, intervals: [500, 1000, 2000] },
    )
    .not.toBe('');
  return copy as MirrorChainCopy & { portfolioId: string };
}

async function inviteFriendFromMemberSheet(
  owner: E2EUser,
  portfolioId: string,
  chainName: string,
  friendUsername: string,
): Promise<void> {
  await owner.page.goto(`/portfolio?portfolio=${portfolioId}`);
  const memberSheetTrigger = owner.page.getByRole('button', { name: /Open member sheet/ });
  await expect(memberSheetTrigger).toBeVisible({ timeout: 20_000 });
  await memberSheetTrigger.click();

  const memberSheet = owner.page.getByRole('dialog', { name: chainName });
  await expect(memberSheet).toBeVisible({ timeout: 20_000 });
  await memberSheet.getByRole('button', { name: 'Invite', exact: true }).click();

  const inviteDialog = owner.page.getByRole('dialog', { name: 'Invite a friend' });
  const friendRow = inviteDialog.getByRole('listitem').filter({ hasText: friendUsername });
  await expect(friendRow).toBeVisible({ timeout: 20_000 });
  await friendRow.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(inviteDialog).toBeHidden({ timeout: 20_000 });
}

async function acceptMirrorInviteThroughUi(user: E2EUser, chainName: string): Promise<void> {
  await user.page.goto('/people');
  const invitation = user.page.getByRole('listitem').filter({ hasText: chainName });
  await expect(invitation).toBeVisible({ timeout: 20_000 });
  await invitation.getByRole('button', { name: 'Review', exact: true }).click();

  const acceptDialog = user.page.getByRole('dialog', { name: `Join ${chainName}?` });
  await expect(acceptDialog).toBeVisible({ timeout: 20_000 });
  await acceptDialog.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(acceptDialog).toBeHidden({ timeout: 20_000 });
}

test.describe('mirrorchain lifecycle UI gate', () => {
  test('mirrorchain: invite, join, fork severance, and transfer work through the UI', async ({
    browser,
  }) => {
    test.setTimeout(300_000);

    const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
    let owner: E2EUser | undefined;
    let member: E2EUser | undefined;
    let successor: E2EUser | undefined;

    try {
      await loginAsAdmin(apiRequest);
      owner = await provisionUser(browser, apiRequest, 'mclifecycleowner');
      member = await provisionUser(browser, apiRequest, 'mclifecyclemember');
      successor = await provisionUser(browser, apiRequest, 'mclifecyclesuccessor');

      // Friendship is established through the real Social surface. Reloading
      // the owner's page drops the pre-accept React Query cache before the
      // friend-picker UI is opened below.
      await befriend(owner, member);
      await befriend(owner, successor);
      await owner.page.reload();
      await expect(owner.page.getByRole('button', { name: member.username })).toBeVisible({
        timeout: 20_000,
      });
      await expect(owner.page.getByRole('button', { name: successor.username })).toBeVisible({
        timeout: 20_000,
      });
      const chainName = `E2E lifecycle ${Date.now().toString(36)}`;

      // Owner creates the group portfolio and sends the FIRST friend invite
      // through the post-create picker — no direct lifecycle endpoint calls.
      await owner.page.goto('/portfolio');
      await owner.page.getByRole('button', { name: 'Switch portfolio' }).click();
      // The group book is a branch of the add-portfolio wizard now: name → icon
      // → "Shared with people", which hands off to the very same §11 create
      // dialog (pre-filled with the name typed on step one).
      await owner.page
        .getByRole('group', { name: 'Portfolios' })
        .getByRole('button', { name: 'Add portfolio', exact: true })
        .click();
      const wizard = owner.page.getByRole('dialog', { name: 'Add portfolio' });
      await wizard.getByLabel('Portfolio name').fill(chainName);
      await wizard.getByRole('button', { name: 'Continue' }).click();
      await wizard.getByRole('button', { name: 'Continue' }).click();
      await wizard.getByRole('radio', { name: /Shared with people/ }).click();
      await wizard.getByRole('button', { name: 'Continue' }).click();
      const createDialog = owner.page.getByRole('dialog', { name: 'New group portfolio' });
      await createDialog.getByPlaceholder('Group portfolio name').fill(chainName);
      await createDialog.getByRole('button', { name: 'Create', exact: true }).click();

      const firstInviteDialog = owner.page.getByRole('dialog', { name: 'Invite a friend' });
      const firstFriendRow = firstInviteDialog
        .getByRole('listitem')
        .filter({ hasText: member.username });
      await expect(firstFriendRow).toBeVisible({ timeout: 20_000 });
      await firstFriendRow.getByRole('button', { name: 'Invite', exact: true }).click();
      await expect(firstInviteDialog).toBeHidden({ timeout: 20_000 });

      // The invited friend sees the Social request and makes the one-screen
      // acknowledgement. Materialization/sync are then observed with bounded
      // polling from both authenticated accounts.
      await acceptMirrorInviteThroughUi(member, chainName);
      const ownerChain = await waitForNamedChainCopy(owner, chainName);
      const memberChain = await waitForNamedChainCopy(member, chainName);
      expect(memberChain.chainId).toBe(ownerChain.chainId);
      await Promise.all([
        waitChainSynced(owner, ownerChain.chainId),
        waitChainSynced(member, ownerChain.chainId),
      ]);

      // A member writes through the portfolio UI. The owner sees the replicated
      // row, including the originating member's visible attribution chip.
      await recordSapBuyOnCopyUi(member.page, memberChain.portfolioId, {
        quantity: '5',
        price: '100',
      });
      const replicated = await waitForTransaction(
        owner,
        ownerChain.portfolioId,
        (tx) => tx.quantity === 5 && tx.mirror?.addedBy.username === member!.username,
      );
      expect(replicated.mirror?.addedBy.username).toBe(member.username);
      await owner.page.goto(`/portfolio?portfolio=${ownerChain.portfolioId}`);
      await expect(owner.page.getByTitle(`Added by ${member.username}`)).toBeVisible({
        timeout: 20_000,
      });
      await expect(member.page.getByRole('button', { name: /Open member sheet/ })).toBeVisible({
        timeout: 20_000,
      });

      // Removal is owner-only and happens in the member sheet. The removed
      // account keeps its copy, visibly marked as a fork and locally writable.
      const ownerMemberSheet = owner.page.getByRole('button', { name: /Open member sheet/ });
      await ownerMemberSheet.click();
      const memberSheet = owner.page.getByRole('dialog', { name: chainName });
      // Scoped to the MEMBERS list: the sheet also renders an activity feed
      // whose entries name the same person ("… joined", "… added a
      // transaction"), so an unscoped listitem matched three rows.
      const memberRow = memberSheet
        .getByRole('list', { name: 'Members' })
        .getByRole('listitem')
        .filter({ hasText: member.username });
      await expect(memberRow).toBeVisible({ timeout: 20_000 });
      await memberRow.getByRole('button', { name: 'Remove', exact: true }).click();
      const removeDialog = owner.page.getByRole('dialog', { name: `Remove ${member.username}?` });
      // Asserted before the click, and every click below carries a timeout: an
      // action with no timeout waits FOREVER, so a dialog that never opened
      // turned a 20s failure into a 300s test timeout with nothing to read.
      await expect(removeDialog).toBeVisible({ timeout: 20_000 });
      await removeDialog
        .getByRole('button', { name: 'Remove', exact: true })
        .click({ timeout: 20_000 });
      await expect(removeDialog).toBeHidden({ timeout: 20_000 });
      await expect
        .poll(async () => isChainMember(member!, ownerChain.chainId), {
          timeout: 20_000,
          intervals: [500, 1000, 2000],
        })
        .toBe(false);
      await member.page.goto(`/portfolio?portfolio=${memberChain.portfolioId}`);
      await expect(member.page.getByText(/Forked from/)).toBeVisible({ timeout: 20_000 });
      expect(
        (await listTransactions(member, memberChain.portfolioId)).some((tx) => tx.quantity === 5),
        'the fork retains replicated history',
      ).toBe(true);

      await recordSapBuyOnCopyUi(member.page, memberChain.portfolioId, {
        quantity: '3',
        price: '100',
      });
      const forkWrite = await waitForTransaction(
        member,
        memberChain.portfolioId,
        (tx) => tx.quantity === 3,
      );
      expect(forkWrite.mirror, 'a fork write is a normal local row').toBeUndefined();

      // Bring in a remaining live copy before the post-kick write. Its observed
      // receipt of that write is the worker/watermark barrier before we inspect
      // the severed fork: a local origin write alone is not a replication edge.
      await inviteFriendFromMemberSheet(
        owner,
        ownerChain.portfolioId,
        chainName,
        successor.username,
      );
      await acceptMirrorInviteThroughUi(successor, chainName);
      const successorChain = await waitForNamedChainCopy(successor, chainName);
      expect(successorChain.chainId).toBe(ownerChain.chainId);
      await Promise.all([
        waitChainSynced(owner, ownerChain.chainId),
        waitChainSynced(successor, ownerChain.chainId),
      ]);
      await recordSapBuyOnCopyUi(owner.page, ownerChain.portfolioId, {
        quantity: '7',
        price: '100',
      });
      await waitForTransaction(owner, ownerChain.portfolioId, (tx) => tx.quantity === 7);
      await waitForTransaction(successor, successorChain.portfolioId, (tx) => tx.quantity === 7);
      await Promise.all([
        waitChainSynced(owner, ownerChain.chainId),
        waitChainSynced(successor, ownerChain.chainId),
      ]);
      const [ownerTransactions, successorTransactions, forkTransactions] = await Promise.all([
        listTransactions(owner, ownerChain.portfolioId),
        listTransactions(successor, successorChain.portfolioId),
        listTransactions(member, memberChain.portfolioId),
      ]);
      expect(
        ownerTransactions.some((tx) => tx.quantity === 3),
        'a post-kick fork write never reaches the live chain',
      ).toBe(false);
      expect(
        successorTransactions.some((tx) => tx.quantity === 3),
        'a post-kick fork write never reaches another live copy',
      ).toBe(false);
      expect(
        ownerTransactions.some((tx) => tx.quantity === 7),
        'the live origin keeps its post-kick write',
      ).toBe(true);
      expect(
        successorTransactions.some((tx) => tx.quantity === 7),
        'the remaining live copy receives the post-kick write before fork inspection',
      ).toBe(true);
      expect(
        forkTransactions.some((tx) => tx.quantity === 7),
        'a post-kick live-chain write never reaches the fork',
      ).toBe(false);
      expect(
        forkTransactions.some((tx) => tx.quantity === 3),
        'the fork stays usable',
      ).toBe(true);
      // The successor was already the live watermark witness above, so transfer
      // ownership through the current owner's member sheet.
      expect(
        successorTransactions.some((tx) => tx.quantity === 3),
        'the later chain join replays live history but never the fork-only write',
      ).toBe(false);

      await owner.page.goto(`/portfolio?portfolio=${ownerChain.portfolioId}`);
      await owner.page.getByRole('button', { name: /Open member sheet/ }).click();
      const transferSheet = owner.page.getByRole('dialog', { name: chainName });
      const successorRow = transferSheet
        .getByRole('list', { name: 'Members' })
        .getByRole('listitem')
        .filter({ hasText: successor.username });
      await expect(successorRow).toBeVisible({ timeout: 20_000 });
      await successorRow.getByRole('button', { name: 'Make owner', exact: true }).click();
      const transferDialog = owner.page.getByRole('dialog', {
        name: `Make ${successor.username} the owner?`,
      });
      await transferDialog.getByRole('button', { name: 'Transfer', exact: true }).click();
      await expect(transferDialog).toBeHidden({ timeout: 20_000 });
      await expect
        .poll(async () => chainRole(successor!, ownerChain.chainId), {
          timeout: 20_000,
          intervals: [500, 1000, 2000],
        })
        .toBe('owner');
      await expect
        .poll(async () => chainRole(owner!, ownerChain.chainId), {
          timeout: 20_000,
          intervals: [500, 1000, 2000],
        })
        .toBe('member');

      // The successor now sees final owner controls; the former owner sees
      // their normal-member surface without invite, transfer, or dissolve.
      await successor.page.goto(`/portfolio?portfolio=${successorChain.portfolioId}`);
      await successor.page.getByRole('button', { name: /Open member sheet/ }).click();
      const successorSheet = successor.page.getByRole('dialog', { name: chainName });
      await expect(
        successorSheet.getByRole('button', { name: 'Dissolve group', exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      const oldOwnerRow = successorSheet
        .getByRole('list', { name: 'Members' })
        .getByRole('listitem')
        .filter({ hasText: owner.username });
      await expect(
        oldOwnerRow.getByRole('button', { name: 'Make owner', exact: true }),
      ).toBeVisible({
        timeout: 20_000,
      });

      await owner.page.goto(`/portfolio?portfolio=${ownerChain.portfolioId}`);
      await owner.page.getByRole('button', { name: /Open member sheet/ }).click();
      const formerOwnerSheet = owner.page.getByRole('dialog', { name: chainName });
      await expect(
        formerOwnerSheet.getByRole('button', { name: 'Dissolve group', exact: true }),
      ).toHaveCount(0);
      await expect(
        formerOwnerSheet.getByRole('button', { name: 'Invite', exact: true }),
      ).toHaveCount(0);
      await expect(
        formerOwnerSheet.getByRole('button', { name: 'Make owner', exact: true }),
      ).toHaveCount(0);
    } finally {
      await Promise.all([
        apiRequest.dispose(),
        owner?.context.close(),
        member?.context.close(),
        successor?.context.close(),
      ]);
    }
  });
});

// ─── 1. A member's buy appears in every copy, attributed (§2 + §11) — (e2e) ───

test('mirrorchain: a member buy propagates to every copy, attributed', async ({ browser }) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'mcbuyowner');
  const member = await provisionUser(browser, apiRequest, 'mcbuymember');
  await apiRequest.dispose();
  await befriend(owner, member);

  const { chainId, portfolioId: ownerCopy } = await createEmptyChain(owner, 'Buy Chain');
  const memberCopy = await inviteAndJoin(owner, chainId, member);
  await waitChainSynced(member, chainId);

  // The member records a buy on THEIR synced copy through the real dialog.
  await recordSapBuyOnCopyUi(member.page, memberCopy, { quantity: '5', price: '100' });

  // It replicates to the owner's copy, attributed to the member (design §2).
  const propagated = await waitForTransaction(
    owner,
    ownerCopy,
    (tx) => tx.quantity === 5 && tx.mirror?.addedBy.username === member.username,
  );
  expect(propagated.mirror?.addedBy.username).toBe(member.username);

  // …and the owner SEES it, with the attribution chip, in the rendered UI (§11).
  await owner.page.goto(`/portfolio?portfolio=${ownerCopy}`);
  await expect(owner.page.getByTitle(`Added by ${member.username}`)).toBeVisible({
    timeout: 20_000,
  });

  await owner.context.close();
  await member.context.close();
});

// ─── 2. Concurrent edits converge per the design note (§3 worked example) ─────

test('mirrorchain: concurrent edits converge with exactly one MIRROR_CONFLICT', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const alice = await provisionUser(browser, apiRequest, 'mccncalice');
  const bob = await provisionUser(browser, apiRequest, 'mccncbob');
  await apiRequest.dispose();
  await befriend(alice, bob);

  const { chainId, portfolioId: aliceCopy } = await createEmptyChain(alice, 'Conflict Chain');
  const bobCopy = await inviteAndJoin(alice, chainId, bob);
  await waitChainSynced(bob, chainId);

  // Transaction T exists everywhere at one version: qty 5, price 100 (§3).
  const assetId = await assetIdFor(alice, 'SAP', 'SAP.DE');
  await recordBuy(alice, aliceCopy, { assetId, quantity: 5, price: 100 });
  // The predicate REQUIRES `mirror` as well as the quantity: a replicated row can
  // land a beat before its mirror metadata does, and waiting only on the quantity
  // returned a row whose `mirror` was still undefined — the next line then threw
  // "Cannot read properties of undefined" and read as a replication bug rather
  // than as this spec asking too early.
  const aliceTx = await waitForTransaction(
    alice,
    aliceCopy,
    (tx) => tx.quantity === 5 && tx.mirror != null,
  );
  const bobTx = await waitForTransaction(
    bob,
    bobCopy,
    (tx) => tx.quantity === 5 && tx.mirror != null,
  );
  const baseSeq = aliceTx.mirror!.version;
  expect(bobTx.mirror!.version, 'both copies agree on the base version').toBe(baseSeq);
  expect(bobTx.mirror!.mirrorId).toBe(aliceTx.mirror!.mirrorId);

  // Alice submits qty 5→6 and Bob simultaneously submits price 100→110, both
  // against baseSeq. The append row-lock serializes them — exactly one 409 (§3).
  const [aliceRes, bobRes] = await Promise.all([
    apiSend(alice, 'PATCH', `/portfolios/${aliceCopy}/transactions/${aliceTx.id}`, {
      quantity: 6,
      baseSeq,
    }),
    apiSend(bob, 'PATCH', `/portfolios/${bobCopy}/transactions/${bobTx.id}`, {
      price: 110,
      baseSeq,
    }),
  ]);
  const aliceConflict =
    aliceRes.status() === 409 && (await errorCode(aliceRes)) === 'MIRROR_CONFLICT';
  const bobConflict = bobRes.status() === 409 && (await errorCode(bobRes)) === 'MIRROR_CONFLICT';
  expect([aliceConflict, bobConflict].filter(Boolean).length, 'exactly one edit 409s').toBe(1);
  expect(aliceRes.ok() !== bobRes.ok(), 'exactly one edit wins').toBe(true);

  // The loser refetches fresh state and re-submits ITS OWN change (§3).
  if (aliceConflict) {
    const fresh = await waitForTransaction(alice, aliceCopy, (tx) => tx.mirror!.version > baseSeq);
    const retry = await apiSend(
      alice,
      'PATCH',
      `/portfolios/${aliceCopy}/transactions/${fresh.id}`,
      {
        quantity: 6,
        baseSeq: fresh.mirror!.version,
      },
    );
    expect(retry.ok(), 'alice resubmit succeeds').toBeTruthy();
  } else {
    const fresh = await waitForTransaction(bob, bobCopy, (tx) => tx.mirror!.version > baseSeq);
    const retry = await apiSend(bob, 'PATCH', `/portfolios/${bobCopy}/transactions/${fresh.id}`, {
      price: 110,
      baseSeq: fresh.mirror!.version,
    });
    expect(retry.ok(), 'bob resubmit succeeds').toBeTruthy();
  }

  // Every copy converges to the same byte-identical state: qty 6, price 110 (§3).
  const converged = (tx: LedgerTx) => tx.quantity === 6 && tx.price === 110;
  const finalAlice = await waitForTransaction(alice, aliceCopy, converged);
  const finalBob = await waitForTransaction(bob, bobCopy, converged);
  expect(finalBob.quantity).toBe(finalAlice.quantity);
  expect(finalBob.price).toBe(finalAlice.price);
  expect(finalBob.side).toBe(finalAlice.side);
  expect(finalBob.executedAt).toBe(finalAlice.executedAt);
  expect(finalBob.mirror!.version).toBe(finalAlice.mirror!.version);

  await alice.context.close();
  await bob.context.close();
});

// ─── 3. Per-copy audit trail is complete (§2 + §10) ───────────────────────────

test('mirrorchain: the per-copy audit trail enumerates every applied op', async ({ browser }) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'mcauditowner');
  const member = await provisionUser(browser, apiRequest, 'mcauditmember');
  await apiRequest.dispose();
  await befriend(owner, member);

  const { chainId, portfolioId: ownerCopy } = await createEmptyChain(owner, 'Audit Chain');
  const memberCopy = await inviteAndJoin(owner, chainId, member);
  await waitChainSynced(member, chainId);

  // Two ledger ops by two different actors: owner creates, member edits.
  const assetId = await assetIdFor(owner, 'SAP', 'SAP.DE');
  await recordBuy(owner, ownerCopy, { assetId, quantity: 5, price: 100 });
  const memberTx = await waitForTransaction(member, memberCopy, (tx) => tx.quantity === 5);
  const edit = await apiSend(
    member,
    'PATCH',
    `/portfolios/${memberCopy}/transactions/${memberTx.id}`,
    {
      price: 110,
      baseSeq: memberTx.mirror!.version,
    },
  );
  expect(edit.ok(), 'member edit succeeds').toBeTruthy();
  await waitForTransaction(owner, ownerCopy, (tx) => tx.price === 110);

  // From EACH member's own session the trail is complete: one row per applied
  // op, both edits with both actors (design §2/§10 — audit row per op per copy).
  for (const viewer of [owner, member]) {
    const entries = await activity(viewer, chainId);
    const creates = entries.filter((e) => e.kind === 'tx.create');
    const updates = entries.filter((e) => e.kind === 'tx.update');
    expect(creates.length, `${viewer.username} sees exactly one tx.create`).toBe(1);
    expect(updates.length, `${viewer.username} sees exactly one tx.update`).toBe(1);
    expect(creates[0]!.actorUsername).toBe(owner.username);
    expect(updates[0]!.actorUsername).toBe(member.username);
  }

  await owner.context.close();
  await member.context.close();
});

// ─── 4. Kick leaves a fully working, un-synced fork (§6) ──────────────────────

test('mirrorchain: a kick leaves a fully working, un-synced fork', async ({ browser }) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'mckickowner');
  const member = await provisionUser(browser, apiRequest, 'mckickmember');
  await apiRequest.dispose();
  await befriend(owner, member);

  const { chainId, portfolioId: ownerCopy } = await createEmptyChain(owner, 'Kick Chain');
  const memberCopy = await inviteAndJoin(owner, chainId, member);
  await waitChainSynced(member, chainId);

  // A shared row exists on both copies before the kick.
  const assetId = await assetIdFor(owner, 'SAP', 'SAP.DE');
  await recordBuy(owner, ownerCopy, { assetId, quantity: 5, price: 100 });
  await waitForTransaction(member, memberCopy, (tx) => tx.quantity === 5);

  // Owner kicks the member.
  const memberUserId = await friendUserId(owner, member.username);
  const kicked = await apiSend(
    owner,
    'DELETE',
    `/mirrorchain/chains/${chainId}/members/${memberUserId}`,
  );
  expect(kicked.ok(), 'kick succeeds').toBeTruthy();

  // The member's copy severs from the chain but KEEPS everything (design §6):
  // chain access gone, the shared row retained, the fork provenance line shown.
  await expect.poll(async () => isChainMember(member, chainId), { timeout: 20_000 }).toBe(false);
  const retained = await listTransactions(member, memberCopy);
  expect(
    retained.some((tx) => tx.quantity === 5),
    'fork keeps the shared row',
  ).toBe(true);

  await member.page.goto(`/portfolio?portfolio=${memberCopy}`);
  await expect(member.page.getByText(/Forked from/)).toBeVisible({ timeout: 20_000 });

  // The fork is fully editable — a post-kick write succeeds locally…
  const forkWrite = await apiSend(member, 'POST', `/portfolios/${memberCopy}/transactions`, {
    assetId,
    side: 'buy',
    quantity: 3,
    price: 100,
    fee: 0,
    executedAt: '2024-01-15T00:00:00.000Z',
    note: null,
  });
  expect(forkWrite.status(), 'fork write succeeds locally').toBe(201);

  // …and does NOT cross over: severance is bidirectional and immediate (§6). The
  // owner keeps writing; the two books stay independent.
  await recordBuy(owner, ownerCopy, { assetId, quantity: 7, price: 100 });
  await waitForTransaction(owner, ownerCopy, (tx) => tx.quantity === 7);
  const ownerTxs = await listTransactions(owner, ownerCopy);
  expect(
    ownerTxs.some((tx) => tx.quantity === 3),
    'fork write never reaches the owner',
  ).toBe(false);
  const forkTxs = await listTransactions(member, memberCopy);
  expect(
    forkTxs.some((tx) => tx.quantity === 7),
    'owner write never reaches the fork',
  ).toBe(false);
  expect(
    forkTxs.some((tx) => tx.quantity === 3),
    'the local fork write is present',
  ).toBe(true);

  await owner.context.close();
  await member.context.close();
});

// ─── 5. Ownership transfer; old owner becomes a normal member (§5) ────────────

test('mirrorchain: transfer makes the target owner and demotes the old owner', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'mcxferowner');
  const member = await provisionUser(browser, apiRequest, 'mcxfermember');
  await apiRequest.dispose();
  await befriend(owner, member);

  const { chainId } = await createEmptyChain(owner, 'Transfer Chain');
  await inviteAndJoin(owner, chainId, member);
  await waitChainSynced(member, chainId);

  const memberUserId = await friendUserId(owner, member.username);
  const transferred = await apiSend(owner, 'POST', `/mirrorchain/chains/${chainId}/transfer`, {
    toUserId: memberUserId,
  });
  expect(transferred.ok(), 'transfer succeeds').toBeTruthy();

  // The new owner's roster: they are owner, the old owner is a plain member (§5).
  const roster = await members(member, chainId);
  expect(roster.role, "caller's own role is owner").toBe('owner');
  expect(roster.members.find((m) => m.isSelf)?.role).toBe('owner');
  expect(roster.members.find((m) => m.username === owner.username)?.role).toBe('member');

  // The old owner now sees themselves as a plain member of the still-live chain.
  expect(await chainRole(owner, chainId)).toBe('member');

  await owner.context.close();
  await member.context.close();
});

// ─── 6. A member's account deletion leaves the others intact (§7 non-owner) ───

test('mirrorchain: a non-owner deletion leaves the chain, other copies + sync intact', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'mcdelowner');
  const leaver = await provisionUser(browser, apiRequest, 'mcdelleaver');
  const other = await provisionUser(browser, apiRequest, 'mcdelother');
  await apiRequest.dispose();
  await befriend(owner, leaver);
  await befriend(owner, other);

  const { chainId, portfolioId: ownerCopy } = await createEmptyChain(owner, 'Deletion Chain');
  const leaverCopy = await inviteAndJoin(owner, chainId, leaver);
  const otherCopy = await inviteAndJoin(owner, chainId, other);
  await waitChainSynced(leaver, chainId);
  await waitChainSynced(other, chainId);

  // The soon-to-be-deleted member contributes a row, replicated to every copy.
  const assetId = await assetIdFor(leaver, 'SAP', 'SAP.DE');
  await recordBuy(leaver, leaverCopy, { assetId, quantity: 4, price: 100 });
  await waitForTransaction(owner, ownerCopy, (tx) => tx.quantity === 4);
  await waitForTransaction(other, otherCopy, (tx) => tx.quantity === 4);

  // The member deletes their account through the real danger-zone flow.
  await leaver.page.goto('/account/delete');
  await expect(leaver.page.getByRole('heading', { name: 'Delete your account' })).toBeVisible({
    timeout: 15_000,
  });
  await leaver.page.getByLabel(/Type your username/i).fill(leaver.username);
  await leaver.page.getByLabel('Current password', { exact: true }).fill(ACCOUNT_PASSWORD);
  await leaver.page.getByRole('button', { name: /Delete my account permanently/i }).click();
  await expect(leaver.page).toHaveURL(/\/login$/, { timeout: 20_000 });

  // The chain is untouched: still active, owner still owner (§7 non-owner rule).
  expect(await chainRole(owner, chainId)).toBe('owner');

  // The departed member's row survives in every remaining copy, still attributed
  // (SET-NULL user, denormalized username keeps rendering — design §7).
  for (const [viewer, copy] of [
    [owner, ownerCopy],
    [other, otherCopy],
  ] as const) {
    const row = (await listTransactions(viewer, copy)).find((tx) => tx.quantity === 4);
    expect(row, `${viewer.username} keeps the departed member's row`).toBeTruthy();
    expect(row!.mirror?.addedBy.username).toBe(leaver.username);
  }

  // Sync still works: a fresh owner write reaches the surviving member's copy.
  await recordBuy(owner, ownerCopy, { assetId, quantity: 8, price: 100 });
  await waitForTransaction(other, otherCopy, (tx) => tx.quantity === 8);

  await owner.context.close();
  await leaver.context.close();
  await other.context.close();
});
