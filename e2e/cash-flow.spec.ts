import { expect, request as newRequestContext, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * THE FUSED CASH LEDGER, END TO END IN A BROWSER (V5 cash fusion phase 2).
 *
 * `expenses-budget.spec.ts` is skipped and stays skipped: it drove the retired
 * `expense_*` island through a bank-statement import that no longer exists.
 * But everything that spec guarded EXCEPT the import leg is live on the fused
 * ledger today, and until now nothing exercised it in a browser —
 * `cash-sources.spec.ts` covers sources and stops there.
 *
 * So this is the same journey through the surface that replaced it: tag →
 * rule → a real cash entry whose note the rule matches → the tagged ledger →
 * a budget the spend blows. Plus the two things phase 2 added that the old
 * island had no equivalent for: the `fee` kind carrying its app-owned tag
 * (§16 2026-07-30), and applying rules to movements that already exist.
 *
 * Every date is absolute and precedes "now": cash solvency is replayed
 * chronologically, so a deposit must predate the spending it funds regardless
 * of the wall clock (the trap that expired `tax-at.spec.ts`).
 */

const FUNDING_DATE = '2026-01-05';
const SPEND_DATE = '2026-01-12';

/**
 * In-app navigation inside the Cash area — tab clicks, not `page.goto`.
 *
 * Every `page.goto` is a full SPA reload that refires the shell's provider
 * queries (auth/me, feature flags, portfolios, notifications, announcements,
 * vault media) on top of the target page's own. At Playwright speed this
 * spec's ~12 reloads landed 254 API requests inside the limiter's 10-second
 * burst window (trace-verified), and the 429s failed the very queries the
 * spec asserts on. A person clicks the tab strip; so does the spec — one goto
 * enters the area, everything after rides the client-side router.
 */
async function openCashTab(
  page: Page,
  tab: 'Overview' | 'Transactions' | 'Budgets',
): Promise<void> {
  const strip = page.getByRole('navigation', { name: 'Cash', exact: true });
  if (!(await strip.isVisible().catch(() => false))) await page.goto('/portfolio/cash');
  await strip.getByRole('link', { name: tab, exact: true }).click();
}

/** Labels & rules is setup, off the tab strip — Movements links to it. */
async function openCashLabels(page: Page): Promise<void> {
  if (page.url().includes('/portfolio/cash/labels')) return;
  await openCashTab(page, 'Transactions');
  await page.getByRole('link', { name: 'Labels & rules' }).click();
  await expect(page.getByRole('heading', { name: 'Labels & rules' })).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Record one movement through the NEW fast path: the record pair ("Record
 * money in" / "Record money out") in the Cash page header, not the accounts
 * table.
 *
 * This is the flow the redesign exists for — press the half that matches the
 * direction, type an amount, type what it was for. Date and the holding-cost
 * tick sit in the main form; only manual tags live behind "Details".
 */
async function recordCashEntry(
  page: Page,
  entry: {
    direction: 'Money out' | 'Money in';
    amount: string;
    date?: string;
    note?: string;
    countsToPerformance?: boolean;
  },
): Promise<void> {
  // Only navigate when we are not already here — and via the tab strip, never
  // a reload; re-navigating to a page you are standing on is not what a person
  // does anyway.
  if (!page.url().endsWith('/portfolio/cash')) await openCashTab(page, 'Overview');
  // The opener is a joined pair now — one tinted half per direction (owner,
  // 2026-07-31, second pass) — so there is no single "Record transaction"
  // button; the group carries that name, its halves are the buttons.
  await page
    .getByRole('button', {
      name: entry.direction === 'Money in' ? 'Record money in' : 'Record money out',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Record transaction' });
  // The half pre-arms the direction; clicking the segment keeps the spec
  // honest about which one is active either way.
  await dialog.getByRole('button', { name: entry.direction, exact: true }).click();
  await dialog.getByLabel('Amount').fill(entry.amount);
  if (entry.note !== undefined) await dialog.getByLabel('What for').fill(entry.note);
  // Date sits in the main form now (the "Details" disclosure only holds tags
  // and the receipt slot), and the holding-cost tick — the user-facing face of
  // the `fee` kind — rides beside the date whenever the direction is out.
  if (entry.date !== undefined) await dialog.getByLabel('Date').fill(entry.date);
  if (entry.countsToPerformance) await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/** Create a user tag through the Tags tab. */
async function createTag(page: Page, name: string): Promise<void> {
  await openCashLabels(page);
  await page.getByRole('button', { name: 'New tag' }).click();
  const dialog = page.getByRole('dialog', { name: 'New tag' });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/** Create an auto-tagging rule through the Rules tab. */
async function createRule(page: Page, pattern: string, tagName: string): Promise<void> {
  await openCashLabels(page);
  await page.getByRole('button', { name: 'New rule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New rule' });
  await dialog.getByLabel('Pattern', { exact: true }).fill(pattern);
  // Tags are toggle-chips; the chip's own text is the button's accessible name.
  await dialog
    .getByRole('group', { name: 'Tags' })
    .getByRole('button', { name: tagName, exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

/** The Movements-tab row for a movement carrying `note`. */
function movementRow(page: Page, note: string) {
  return page.locator('table[aria-label="Cash movements"] tbody tr').filter({ hasText: note });
}

test('cash flow: a rule tags a real entry, the ledger shows it, and a budget blows', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'cashflowowner');
  await apiRequest.dispose();
  const page = owner.page;

  try {
    // ── Classification first: a tag, and a rule that assigns it ──
    await createTag(page, 'Groceries');
    await createRule(page, 'SPAR', 'Groceries');

    // ── Then the money: fund Main, then spend at a merchant the rule knows ──
    await recordCashEntry(page, { direction: 'Money in', amount: '1000', date: FUNDING_DATE });
    await recordCashEntry(page, {
      direction: 'Money out',
      amount: '300',
      date: SPEND_DATE,
      note: 'SPAR MARKT 4021',
    });

    // THE POINT OF THE WHOLE FEATURE: the spend arrived already labelled, with
    // BOTH halves of auto-tagging — `Withdrawal` from its kind, `Groceries`
    // from the user's rule. Nothing was tagged by hand.
    await openCashTab(page, 'Transactions');
    const spendRow = movementRow(page, 'SPAR MARKT 4021');
    await expect(spendRow).toBeVisible({ timeout: 15_000 });
    await expect(spendRow).toContainText('Groceries');
    await expect(spendRow).toContainText('Withdrawal');

    // ── A €200 target the €300 spend has already blown ──
    await openCashTab(page, 'Budgets');
    await page.getByRole('button', { name: 'New budget' }).click();
    const budgetDialog = page.getByRole('dialog', { name: 'New budget' });
    await budgetDialog.getByLabel('Tag', { exact: true }).selectOption({ label: 'Groceries' });
    await budgetDialog.getByLabel('Monthly target', { exact: true }).fill('200');
    await budgetDialog.getByRole('button', { name: 'Save' }).click();
    await expect(budgetDialog).toBeHidden({ timeout: 15_000 });

    // The budget reads against the month the spending happened in, so the
    // month picker has to be pointed at it — "this month" is empty by design.
    await page.getByLabel('Month', { exact: true }).fill(SPEND_DATE.slice(0, 7));
    const budgetRow = page.getByRole('listitem').filter({ hasText: 'Groceries' });
    await expect(budgetRow).toContainText('Over budget', { timeout: 15_000 });
    // €300 of a €200 target — €100 over. Locale-agnostic (EN "100.00", DE "100,00").
    await expect(budgetRow).toContainText(/100[.,]00/);

    // ── The `fee` kind carries the app-owned `Fees` tag (§16 2026-07-30) ──
    // "Counts against my investment performance" is the user-facing name for the
    // `fee` kind — the word "fee" appears nowhere in the interface any more.
    await recordCashEntry(page, {
      direction: 'Money out',
      amount: '25',
      date: SPEND_DATE,
      note: 'Custody charge Q1',
      countsToPerformance: true,
    });
    await openCashTab(page, 'Transactions');
    const feeRow = movementRow(page, 'Custody charge Q1');
    await expect(feeRow).toBeVisible({ timeout: 15_000 });
    await expect(feeRow).toContainText('Fees');

    // ── Applying rules to what already exists ──
    //
    // The back-catalogue case, which is the normal one: the movement is booked
    // first and only later described by a rule. Book-time tagging cannot reach
    // it, so without the explicit re-run this row would stay untagged forever.
    await recordCashEntry(page, {
      direction: 'Money out',
      amount: '40',
      date: SPEND_DATE,
      note: 'BILLA DANKT 77',
    });
    await openCashTab(page, 'Transactions');
    const lateRow = movementRow(page, 'BILLA DANKT 77');
    await expect(lateRow).toBeVisible({ timeout: 15_000 });
    await expect(lateRow).not.toContainText('Groceries');

    await createRule(page, 'BILLA', 'Groceries');
    // Still untagged — a new rule changes nothing that already happened.
    await openCashTab(page, 'Transactions');
    await expect(movementRow(page, 'BILLA DANKT 77')).not.toContainText('Groceries');

    await openCashLabels(page);
    // Re-running rules over the back catalogue is destructive enough to ask first
    // (#1115): the button arms an inline confirm, the confirm runs it.
    await page.getByRole('button', { name: 'Apply to existing' }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    // Success notices announce politely (`role="status"`, #1122) while errors keep
    // `role="alert"`; the filter keeps this immune to the loading `role="status"`
    // regions the same page renders while the ledger refetches.
    await expect(page.getByRole('status').filter({ hasText: /Tagged 1 movement/ })).toBeVisible({
      timeout: 20_000,
    });

    await openCashTab(page, 'Transactions');
    await expect(movementRow(page, 'BILLA DANKT 77')).toContainText('Groceries', {
      timeout: 15_000,
    });
    // Additive and idempotent: the earlier rows kept exactly what they had.
    await expect(movementRow(page, 'SPAR MARKT 4021')).toContainText('Groceries');
  } finally {
    await owner.context.close();
  }
});
