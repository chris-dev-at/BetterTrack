import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { createE1Harness } from './support/e1';
import { provisionUser } from './support/users';
import { newAdminRequestContext } from './support/adminApi';

/**
 * V5-P14 [E1] — digest delivery + quiet-hours release ([#734]).
 *
 * The two V5-P3 behaviors the owner mandated as browser gates:
 *
 *  1. a daily-digest user receives EXACTLY ONE summary for a closed period,
 *     containing only the notification types/channels their matrix allows;
 *  2. a non-urgent notification created inside quiet hours stays deferred and is
 *     released exactly once at the configured window end.
 *
 * Neither has an in-run HTTP seam (the production driver is the worker's cron,
 * the current period is deliberately never flushed, and the Playwright stack has
 * SMTP off so its own mail is suppressed bodyless). Per the owner's COD decision
 * on #734, the browser configures the real digest cadence / quiet-hours settings
 * through the Settings UI, and `support/e1.ts` drives the REAL notification
 * dispatcher + digest/deferred service (production repositories, injected clock,
 * in-memory capture transport) against the same test database — no product-code
 * change, no SMTP, no external service, no wall-clock sleeps. See e1.ts for the
 * far-future-clock trick that keeps this race-free against the live worker.
 */

/** Open the collapsed "Delivery frequency" block and set one type's cadence. */
async function setCadence(page: Page, typeLabel: string, cadence: string): Promise<void> {
  const select = page.getByRole('combobox', { name: `Delivery frequency for ${typeLabel}` });
  await select.selectOption(cadence);
  await expect(select).toHaveValue(cadence);
}

/** Two fixed far-future instants: dispatch stamps day D, the digest runs on D+1. */
const DIGEST_DISPATCH = new Date('2099-06-15T12:00:00.000Z');
const DIGEST_DELIVER = new Date('2099-06-16T12:00:00.000Z');

test('digest: a daily-digest user gets exactly one matrix-honoring summary for the period', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newAdminRequestContext(newRequestContext);
  const recipient = await provisionUser(browser, apiRequest, 'digestrcpt');
  await apiRequest.dispose();
  const page = recipient.page;

  // Configure the digest cadence through the real Settings UI: friend requests
  // AND shared-watchlist notices both go DAILY, so the ONLY reason a watchlist
  // notice is absent from the email digest below is the email matrix — not its
  // cadence.
  await page.goto('/settings/notifications');
  const digestSummary = page.locator('summary').filter({ hasText: 'Delivery frequency' });
  await expect(digestSummary).toBeVisible({ timeout: 15_000 });
  await digestSummary.click();
  await setCadence(page, 'Friend requests', 'daily');
  await setCadence(page, 'Shared watchlists', 'daily');

  const e1 = createE1Harness();
  try {
    const userId = await e1.findUserIdByEmail(recipient.email);
    // Email is SMTP-gated (its matrix column is hidden in the SMTP-less UI), so
    // the routing the UI can't expose is set through the production repository:
    // friend.request → email ON, watchlist.shared → email OFF.
    await e1.setEmailMatrix(userId, { 'friend.request': true, 'watchlist.shared': false });

    // Generate the period's notifications at a fixed far-future instant (so the
    // live worker's real-clock cron never treats this period as closed).
    e1.setNow(DIGEST_DISPATCH);
    await e1.dispatchFriendRequest({ userId, actorUsername: 'digestalice', requestId: 'e1-fr-1' });
    await e1.dispatchFriendRequest({ userId, actorUsername: 'digestbob', requestId: 'e1-fr-2' });
    await e1.dispatchWatchlistShared({
      userId,
      actorUsername: 'digestcarol',
      watchlistId: 'e1-wl-1',
    });

    // Nothing is sent instantly — the outbound copies were deferred to the digest.
    expect(e1.captured).toHaveLength(0);

    // Run the digest once the period has closed (a strictly later day): exactly
    // one summary email lands, covering both friend requests.
    e1.setNow(DIGEST_DELIVER);
    const first = await e1.deliverDailyDigest();
    expect(first.sent).toBe(1);

    const mine = e1.captured.filter((m) => m.to === recipient.email);
    expect(mine).toHaveLength(1);
    const mail = mine[0]!;
    expect(mail.subject.toLowerCase()).toContain('daily');
    // Matrix-honoring: the email-routed friend requests are present…
    expect(mail.text).toContain('digestalice');
    expect(mail.text).toContain('digestbob');
    // …and the daily-cadence but email-OFF watchlist notice is absent.
    expect(mail.text).not.toContain('digestcarol');
    expect(mail.text.toLowerCase()).not.toContain('watchlist');

    // Exactly once: a second delivery run of the same closed period sends nothing.
    const second = await e1.deliverDailyDigest();
    expect(second.sent).toBe(0);
    expect(e1.captured.filter((m) => m.to === recipient.email)).toHaveLength(1);
  } finally {
    await e1.dispose();
  }

  await recipient.context.close();
});

/**
 * Quiet-hours window 22:00→07:00 (UTC). Dispatch inside it (23:00) → the window
 * closes next day at 07:00; deliver-before is still held, deliver-after releases
 * exactly once. All instants far-future so the live worker never claims the row.
 */
const QUIET_DISPATCH = new Date('2099-06-15T23:00:00.000Z');
const QUIET_BEFORE_END = new Date('2099-06-16T06:00:00.000Z');
const QUIET_AFTER_END = new Date('2099-06-16T07:30:00.000Z');

test('quiet hours: a non-urgent notification defers and releases once at window end', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newAdminRequestContext(newRequestContext);
  const recipient = await provisionUser(browser, apiRequest, 'quietrcpt');
  await apiRequest.dispose();
  const page = recipient.page;

  // Configure quiet hours through the real Settings UI: enable + a 22:00→07:00
  // window (timezone left at the UTC default). friend.request cadence stays
  // instant, so it takes the quiet-hours defer path (not the digest queue).
  await page.goto('/settings/notifications');
  const quietSummary = page.locator('summary').filter({ hasText: 'Quiet hours' });
  await expect(quietSummary).toBeVisible({ timeout: 15_000 });
  await quietSummary.click();
  const enable = page.getByRole('switch', { name: 'Enable quiet hours' });
  // `click()`, not `check()`: this switch is CONTROLLED by server state and only
  // flips once `PATCH /settings/notifications` returns, which `check()`'s
  // same-tick verification can never observe (it re-clicks instead, toggling the
  // intent back). `toBeChecked()` below is the auto-retrying wait.
  await enable.click();
  await expect(enable).toBeChecked();
  // Exact: `getByLabel` matches substrings, and the routing matrix on the same
  // panel labels cells "… New from people you follow via …".
  const start = page.getByLabel('From', { exact: true });
  const end = page.getByLabel('Until', { exact: true });
  await start.fill('22:00');
  await expect(start).toHaveValue('22:00');
  await end.fill('07:00');
  await expect(end).toHaveValue('07:00');

  const e1 = createE1Harness();
  try {
    const userId = await e1.findUserIdByEmail(recipient.email);
    await e1.setEmailMatrix(userId, { 'friend.request': true });

    // Fired INSIDE the window → deferred to window end, nothing sent now.
    e1.setNow(QUIET_DISPATCH);
    await e1.dispatchFriendRequest({ userId, actorUsername: 'quietdave', requestId: 'e1-qh-1' });
    expect(e1.captured).toHaveLength(0);

    // Still before the window closes → the deferral stays held.
    e1.setNow(QUIET_BEFORE_END);
    const early = await e1.deliverDeferred();
    expect(early.sent).toBe(0);
    expect(e1.captured).toHaveLength(0);

    // At/after the window end → released exactly once.
    e1.setNow(QUIET_AFTER_END);
    const released = await e1.deliverDeferred();
    expect(released.sent).toBe(1);
    const mine = e1.captured.filter((m) => m.to === recipient.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain('quietdave');

    // Exactly once: a later pass has nothing left to release.
    const again = await e1.deliverDeferred();
    expect(again.sent).toBe(0);
    expect(e1.captured.filter((m) => m.to === recipient.email)).toHaveLength(1);
  } finally {
    await e1.dispose();
  }

  await recipient.context.close();
});
