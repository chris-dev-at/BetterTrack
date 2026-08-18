import { expect, request as newRequestContext, test } from '@playwright/test';

import { newAdminRequestContext } from './support/adminApi';
import { apiV1, buildBankStatement } from './support/e2';
import { provisionUser } from './support/users';

/**
 * V5-P9 expense tracking end-to-end ([V5-P14][E2], #736): one representative bank
 * CSV carried through the real browser from import → auto-categorization →
 * dashboard/budget reconciliation → a single matrix-routed budget alert, proving
 * the area's strict separation from portfolio money along the way.
 *
 * The statement is a current-month Revolut export (see `support/e2.ts` for why it
 * is synthesized rather than checked in): three "SPAR" grocery card payments
 * summing to €300, one €2 000 salary credit. A `contains spar → Groceries` rule
 * auto-files the groceries (reviewed in the preview), the salary row is
 * categorized by hand, and a €200 Groceries budget the groceries overrun fires
 * exactly one `budget.exceeded` alert — which stays exactly one even after the
 * evaluation path is re-driven. Meanwhile the owner's portfolio value + ledger
 * are captured before and after and must come back byte-identical.
 */
// SKIPPED (V5 cash fusion, phase 2 — web side): this spec drove the retired
// `expense_*` island end to end and no longer has a runnable path.
// `/portfolio/cash/import` is now a parked placeholder (statement import
// is being rebuilt on the portfolio cash ledger — no upload form exists to
// drive), the auto-seeded "Groceries"/"Salary" starter categories this spec
// selects by label no longer exist (tags start empty; only the 9 app-owned
// system tags are seeded), and the rule/budget dialogs' field shapes changed
// (multi-tag toggle-chips replace the single category combobox). Restore this
// as a new spec against the fused ledger — rule creation → manual/import
// movement → tag assignment → budget-exceeded alert — once statement import
// re-lands pointed at the portfolio ledger, which is the ONLY remaining
// blocker: the server side is already proven by `apps/api` →
// `cashTagging.test.ts`, whose "alerts exactly once per period however often
// it is evaluated" case pins the same (budget, period) idempotency key this
// spec was written to guard. Left in place (not deleted) because that
// guarantee is real intended behaviour worth re-testing end to end.
test.skip('expenses: bank import → categorize → dashboard → single budget alert, portfolio untouched', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const apiRequest = await newAdminRequestContext(newRequestContext);
  const owner = await provisionUser(browser, apiRequest, 'expuser');
  await apiRequest.dispose();

  const page = owner.page;
  const ownerApi = owner.context.request;
  const stmt = buildBankStatement();

  // ── Portfolio isolation baseline: the default "Main" portfolio's value + ledger
  //    captured BEFORE any expense activity (the owner's own session backs these). ──
  const portfoliosRes = await ownerApi.get(apiV1('/portfolios'));
  const portfolios = (
    (await portfoliosRes.json()) as { portfolios: { id: string; name: string }[] }
  ).portfolios;
  const portfolioId = portfolios.find((p) => p.name === 'Main')?.id;
  expect(portfolioId, 'owner has a default Main portfolio').toBeTruthy();
  const beforeOverview = await (await ownerApi.get(apiV1(`/portfolios/${portfolioId}`))).json();
  const beforeLedger = await (
    await ownerApi.get(apiV1(`/portfolios/${portfolioId}/transactions`))
  ).json();

  // ── An auto-categorization rule: everything containing "spar" → Groceries.
  //    (Visiting the page also seeds the default category set.) ──
  await page.goto('/portfolio/cash/labels');
  await page.getByRole('button', { name: 'New rule' }).click();
  const ruleDialog = page.getByRole('dialog');
  await ruleDialog.getByRole('combobox').first().selectOption({ label: 'Groceries' });
  const rulePattern = ruleDialog.getByRole('textbox');
  await rulePattern.fill('spar');
  await rulePattern.press('Enter');
  await expect(ruleDialog).toBeHidden();

  // ── A €200 monthly Groceries budget (no spend yet, so no alert fires now). ──
  await page.goto('/portfolio/cash/budgets');
  await page.getByRole('button', { name: 'New budget' }).click();
  const budgetDialog = page.getByRole('dialog');
  await budgetDialog.getByRole('combobox').selectOption({ label: 'Groceries' });
  const budgetAmount = budgetDialog.getByRole('spinbutton');
  await budgetAmount.fill(String(stmt.budgetTarget));
  await budgetAmount.press('Enter');
  await expect(budgetDialog).toBeHidden();

  // ── Import the statement: it autodetects as Revolut and stages 4 new rows. ──
  await page.goto('/portfolio/cash/import');
  await page.getByLabel('Choose a CSV file').setInputFiles(stmt.file);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('Detected Revolut')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/4 new/)).toBeVisible();

  // Auto-categorization: every grocery row is pre-filled with Groceries by the rule.
  for (const grocery of stmt.groceries) {
    const row = page.locator('tr', { hasText: grocery.description });
    await expect(row.locator('select option:checked')).toHaveText('Groceries');
  }
  // Review/edit the one row the rules didn't match — file the salary as income.
  await page
    .locator('tr', { hasText: stmt.salary.description })
    .locator('select')
    .selectOption({ label: 'Salary' });

  await page.getByRole('button', { name: `Import ${stmt.appliedCount} transactions` }).click();
  await expect(page.getByText(new RegExp(`Imported ${stmt.appliedCount}`))).toBeVisible({
    timeout: 20_000,
  });

  // ── Reconcile the dashboard to the imported fixture. ──
  await page.goto('/portfolio/cash');
  // Total spend = Σ groceries (€300); income = the salary credit (€2 000).
  await expect(page.getByText(/300[.,]00/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/2[.,]000[.,]00/).first()).toBeVisible();

  // The Groceries budget reads spend €300 against its €200 target, and is blown.
  await page.goto('/portfolio/cash/budgets');
  const groceriesBudget = page.getByRole('listitem').filter({ hasText: 'Groceries' });
  await expect(groceriesBudget).toBeVisible({ timeout: 15_000 });
  await expect(groceriesBudget).toContainText(/300[.,]00/);
  await expect(groceriesBudget).toContainText(/200[.,]00/);
  await expect(groceriesBudget.getByText('Over budget')).toBeVisible();

  // ── Exactly one matrix-routed budget alert lands in the bell (async via the
  //    worker's dispatch queue — poll a few reloads, never a bare sleep). ──
  const bell = page.getByRole('button', { name: /Notifications/ });
  await expect(async () => {
    await page.goto('/portfolio/cash');
    await expect(page.getByRole('button', { name: /Notifications \(\d+ unread\)/ })).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 90_000, intervals: [3_000, 3_000, 5_000] });
  await bell.click();
  await expect(page.getByText('Budget exceeded: Groceries')).toHaveCount(1);

  // ── Re-drive the evaluation path (a budget re-save re-runs evaluate for the
  //    same period): the exactly-once gate means STILL one alert, never two. ──
  await page.goto('/portfolio/cash/budgets');
  await groceriesBudget.getByRole('button', { name: 'Edit' }).click();
  const editDialog = page.getByRole('dialog');
  await editDialog.getByRole('spinbutton').fill('150');
  await editDialog.getByRole('button', { name: 'Save' }).click();
  await expect(editDialog).toBeHidden();
  await expect(groceriesBudget).toContainText(/150[.,]00/);

  await page.goto('/portfolio/cash');
  await bell.click();
  await expect(page.getByText('Budget exceeded: Groceries')).toHaveCount(1);

  // ── Zero portfolio interaction: value + ledger are byte-identical afterwards. ──
  const afterOverview = await (await ownerApi.get(apiV1(`/portfolios/${portfolioId}`))).json();
  const afterLedger = await (
    await ownerApi.get(apiV1(`/portfolios/${portfolioId}/transactions`))
  ).json();
  expect(afterOverview).toEqual(beforeOverview);
  expect(afterLedger).toEqual(beforeLedger);

  await owner.context.close();
});
