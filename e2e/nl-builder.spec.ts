import { expect, request as newRequestContext, test } from '@playwright/test';

import { newAdminRequestContext } from './support/adminApi';
import { clearAiProvider, createFakeOllama, setAiProvider } from './support/e3';
import { provisionUser } from './support/users';

/**
 * V5-P14 [E3] — NL conglomerate builder ([#737], §13.5 V5-P12 2/2).
 *
 * The owner-mandated browser gate: a natural-language description drafts a
 * weighted basket through the LOCAL provider, and that draft is ALWAYS a
 * proposal the user reviews and explicitly confirms — it never auto-commits, and
 * the generation never reaches Ollama or any cloud service.
 *
 * The panel only renders when a provider is configured, and a draft POSTs
 * `/api/chat` to it. The Playwright stack has no Ollama, so `support/e3.ts`
 * stands up an in-process fake that answers with a DETERMINISTIC completion and
 * points the admin-configured endpoint at it at runtime (the registry resolves
 * the provider per request — the switch-without-redeploy path). The fake is the
 * ONLY provider ever configured, so `chatCalls()` proves the draft was generated
 * locally; the config is cleared afterwards so the rest of the suite sees AI off.
 *
 * The model extracts weighted intents ONLY — assets are resolved server-side
 * through the local search catalog — so the fixed completion returns two catalog
 * tickers (60/40) that resolve and sum to an activatable 100 %.
 */
const DRAFT_COMPLETION = JSON.stringify({
  lines: [
    { query: 'AAPL', weightPct: 60 },
    { query: 'MSFT', weightPct: 40 },
  ],
});

test('nl builder: a local-provider draft is reviewed and confirmed before it commits', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const fake = await createFakeOllama(DRAFT_COMPLETION);
  const apiRequest = await newAdminRequestContext(newRequestContext);

  try {
    // Point the runtime AI provider at the in-process fake (no redeploy).
    await setAiProvider(apiRequest, fake.endpoint, fake.model);
    const owner = await provisionUser(browser, apiRequest, 'nlbuilder');
    const page = owner.page;

    try {
      await page.goto('/workbench/blueprints/new');
      await page.getByLabel('Blueprint name').fill('AI Draft Basket');

      // Open the fold-away NL panel and describe the basket in plain words.
      const nlSummary = page.locator('summary').filter({ hasText: 'Describe it with AI' });
      await expect(nlSummary).toBeVisible({ timeout: 15_000 });
      await nlSummary.click();
      await page.getByLabel('Describe it with AI').fill('60% Apple, 40% Microsoft');
      await page.getByRole('button', { name: 'Draft basket' }).click();

      // The draft is PREFILLED for review (with the hard review-and-save framing)
      // — never silently applied.
      await expect(page.getByText(/Prefilled 2 positions/)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/AI drafts a starting point/)).toBeVisible();

      // Exactly one completion, served by the LOCAL fake — never Ollama/cloud.
      expect(fake.chatCalls()).toBe(1);

      // The resolved positions sit in the Builder for the user to review/edit.
      const positions = page.getByRole('list', { name: 'Blueprint positions' });
      await expect(positions.getByText('AAPL', { exact: true })).toBeVisible();
      await expect(positions.getByText('MSFT', { exact: true })).toBeVisible();

      // NOT auto-committed: the draft is still an unsaved builder draft (URL never
      // left `/new`, and the primary action is "Activate", not "Re-activate"), so
      // confirmation is a distinct, explicit user action.
      await expect(page).toHaveURL(/\/workbench\/blueprints\/new$/);
      const activate = page.getByRole('button', { name: 'Activate' });
      await expect(activate).toBeEnabled();

      // Explicit confirmation → the basket commits and the detail view is Active.
      // Reaching the detail route (no longer `/new`) only happens AFTER activation
      // resolves, so it is itself the proof the confirm — not the draft — committed.
      await activate.click();
      await expect(page).toHaveURL(/\/workbench\/blueprints\/(?!new(?:\/|$))[^/]+$/, {
        timeout: 20_000,
      });
      await expect(page.getByText('Active', { exact: true }).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText('AAPL', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('MSFT', { exact: true }).first()).toBeVisible();
    } finally {
      await owner.context.close();
    }
  } finally {
    await clearAiProvider(apiRequest);
    await apiRequest.dispose();
    await fake.close();
  }
});
