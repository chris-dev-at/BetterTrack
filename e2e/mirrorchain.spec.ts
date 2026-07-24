import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { ACCOUNT_PASSWORD, API_BASE_URL } from './support/config';
import {
  activity,
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
import { befriend, provisionUser } from './support/users';

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
  const aliceTx = await waitForTransaction(alice, aliceCopy, (tx) => tx.quantity === 5);
  const bobTx = await waitForTransaction(bob, bobCopy, (tx) => tx.quantity === 5);
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
