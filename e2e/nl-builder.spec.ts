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
 * the generation never reaches Ollama or any cloud service. "Never auto-commits"
 * is asserted on the wire: every non-GET request to the `/conglomerates` resource
 * is recorded, and the set between the draft returning and the user confirming
 * must be EMPTY (a URL that stays `/new` would not prove it — the Builder
 * autosaves onto an id it already holds without navigating). The same recorder
 * then has to show the confirmed path's PUT + POST, so "empty" can never mean
 * "the listener matched nothing".
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
      // Every write to the conglomerate endpoints, so "nothing was persisted" is
      // asserted on the wire rather than inferred from the URL. The SPA's base is
      // `${apiOrigin}/api/v1`, so match the resource segment rather than an
      // `api/conglomerates` adjacency that the real URLs never have.
      const writes: string[] = [];
      page.on('request', (request) => {
        const method = request.method();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
        if (!/\/conglomerates(\/|\?|$)/.test(new URL(request.url()).pathname)) return;
        writes.push(`${method} ${new URL(request.url()).pathname}`);
      });

      await page.goto('/workbench/blueprints/new');
      await page.getByLabel('Blueprint name').fill('AI Draft Basket');

      // The name alone is meaningful content, so it schedules a create 600 ms
      // later. Let that autosave land BEFORE the snapshot below, otherwise it
      // drifts into the window asserted empty and reds the run for the wrong
      // reason.
      await expect(page.getByText('Draft — saved')).toBeVisible({ timeout: 20_000 });

      // Open the fold-away NL panel and describe the basket in plain words.
      const nlSummary = page.locator('summary').filter({ hasText: 'Describe it with AI' });
      await expect(nlSummary).toBeVisible({ timeout: 15_000 });
      await nlSummary.click();
      await page.getByLabel('Describe it with AI').fill('60% Apple, 40% Microsoft');
      const writesBeforeDraft = writes.length;
      await page.getByRole('button', { name: 'Draft basket' }).click();

      // The draft comes back as a REVIEW step, framed hard as informational only
      // — it has not touched the Builder's positions.
      const review = page.getByRole('group', { name: 'Review the AI draft' });
      await expect(review).toBeVisible({ timeout: 15_000 });
      await expect(review.getByText(/Draft ready: 2 positions/)).toBeVisible();
      await expect(page.getByText(/not financial advice/)).toBeVisible();

      // Exactly one completion, served by the LOCAL fake — never Ollama/cloud.
      expect(fake.chatCalls()).toBe(1);

      // THE guarantee: past the autosave debounce, the model's basket has caused
      // no write at all — no create, no name update, no position replacement.
      await page.waitForTimeout(1_500);
      expect(writes.slice(writesBeforeDraft)).toEqual([]);

      // Only the explicit confirmation moves the draft into the Builder.
      await page.getByRole('button', { name: 'Apply draft' }).click();
      await expect(page.getByText(/Prefilled 2 positions/)).toBeVisible();

      // The resolved positions now sit in the Builder for the user to review/edit.
      const positions = page.getByRole('list', { name: 'Blueprint positions' });
      await expect(positions.getByText('AAPL', { exact: true })).toBeVisible();
      await expect(positions.getByText('MSFT', { exact: true })).toBeVisible();

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

      // Positive control for the recorder itself: the confirmed path DID write,
      // so an empty `writes` above means "nothing was persisted" rather than
      // "the listener matched nothing". Without this a base-path change would
      // silently turn the guarantee back into a vacuous assertion.
      const afterConfirm = writes.slice(writesBeforeDraft);
      expect(
        afterConfirm.some((entry) => /^PUT .*\/conglomerates\/[^/]+\/positions$/.test(entry)),
      ).toBe(true);
      expect(
        afterConfirm.some((entry) => /^POST .*\/conglomerates\/[^/]+\/activate$/.test(entry)),
      ).toBe(true);
    } finally {
      await owner.context.close();
    }
  } finally {
    await clearAiProvider(apiRequest);
    await apiRequest.dispose();
    await fake.close();
  }
});
