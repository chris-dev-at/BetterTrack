import { expect, request as newRequestContext, test } from '@playwright/test';

import { createInvite, loginAsAdmin } from './support/adminApi';
import { ACCOUNT_PASSWORD, API_BASE_URL } from './support/config';
import { acceptInvite } from './support/flows';

/**
 * V4-P2b — the OAuth consent screen ALWAYS interposes an account confirmation
 * before any redirect, INCLUDING first-party auto-approve clients (owner
 * directive 2026-07-07: Android Custom Tabs share browser cookies, so silently
 * reusing the browser session could sign the app in as the wrong account).
 * Auto-approve still skips the SCOPE prompt for first-party clients — it never
 * skips this account confirmation.
 *
 * Two flows the plan-row acceptance calls out ("chooser renders for a
 * first-party client (e2e)" + "Use another account round-trip"):
 *
 *   1. Navigating to `/oauth/authorize?…` for the seeded first-party mobile
 *      client renders the chooser (app identity + "Signed in as X" + Continue
 *      + Use another account) and does NOT call `POST /oauth/authorize`.
 *   2. Clicking Use another account signs the current session out, lands on
 *      the login screen, and — after re-authenticating as a different account
 *      — returns to the SAME authorize request (original PKCE + state + scope
 *      intact), where the chooser appears again for the newly-signed-in user.
 *
 * Not exercised here: clicking Continue, because the seeded first-party client
 * uses `bettertrack://oauth/callback` (a custom scheme Playwright's Chromium
 * cannot follow). The unit suite covers the Continue → redirect path against
 * a stubbed `window.location`.
 */
test('oauth consent: first-party chooser renders and Use another account round-trips through login', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const runId = Date.now();
  const firstEmail = `e2e-oauth-a-${runId}@bettertrack.local`;
  const secondEmail = `e2e-oauth-b-${runId}@bettertrack.local`;
  const firstUsername = `e2eoautha${runId}`.slice(0, 40);
  const secondUsername = `e2eoauthb${runId}`.slice(0, 40);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const firstInvite = await createInvite(apiRequest, firstEmail);
  const secondInvite = await createInvite(apiRequest, secondEmail);
  await apiRequest.dispose();

  // Provision the "other" account (account B) in a throwaway context so its
  // password is on file for the later /login form. The OAuth flow itself runs
  // in `contextA`, which stays signed in as account A the whole time.
  const contextB = await browser.newContext();
  try {
    await acceptInvite(await contextB.newPage(), secondInvite, secondUsername, ACCOUNT_PASSWORD);
  } finally {
    await contextB.close();
  }

  const contextA = await browser.newContext();
  const page = await contextA.newPage();

  try {
    await acceptInvite(page, firstInvite, firstUsername, ACCOUNT_PASSWORD);

    // The seeded first-party mobile client (see
    // apps/api/src/services/oauth/firstPartyClients.ts): stable client_id,
    // PKCE public client with a custom-scheme redirect URI. Any registered
    // scope works; portfolio:read is the least-privileged one always in the
    // ceiling.
    const authorizeQuery = new URLSearchParams({
      response_type: 'code',
      client_id: 'btc_IbT1mzw_7kBiPHPkGfaE0Q',
      redirect_uri: 'bettertrack://oauth/callback',
      scope: 'portfolio:read',
      state: `e2e-state-${runId}`,
      // 43-char base64url ≈ a real S256 code challenge (32 raw bytes).
      code_challenge: 'e2e-pkce-challenge-abcdefghijklmnopqrstuvwxyz01234',
      code_challenge_method: 'S256',
    }).toString();
    const authorizePath = `/oauth/authorize?${authorizeQuery}`;

    // Watch for the approve POST so we can prove it never fires without an
    // explicit Continue click — the whole point of the interpose.
    const approveHits: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/v1/oauth/authorize')) {
        approveHits.push(req.url());
      }
    });

    await page.goto(authorizePath);

    // Chooser renders for the first-party client — official-app badge, the
    // signed-in identity, Continue and Use another account.
    await expect(page.getByText('Official BetterTrack app')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`Signed in as ${firstUsername}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use another account' })).toBeVisible();
    // The scope-approval prompt stays skipped for first-party clients.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    // Nothing has been authorized — no POST /oauth/authorize without a click.
    expect(approveHits).toHaveLength(0);

    // Use another account: current session ends and the browser lands on
    // /login carrying the untouched authorize URL as the return target.
    await page.getByRole('button', { name: 'Use another account' }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
    await expect(page.getByText('Sign in to your account')).toBeVisible();
    expect(approveHits).toHaveLength(0);

    // A different account signs in on the login form: the login handler
    // navigates back to the original `from` (the authorize URL, query
    // untouched), where the chooser reappears for the newly-signed-in identity.
    await page.getByLabel('Email or username').fill(secondUsername);
    await page.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL(
      (url) => {
        if (url.pathname !== '/oauth/authorize') return false;
        return (
          url.searchParams.get('client_id') === 'btc_IbT1mzw_7kBiPHPkGfaE0Q' &&
          url.searchParams.get('state') === `e2e-state-${runId}` &&
          url.searchParams.get('code_challenge') ===
            'e2e-pkce-challenge-abcdefghijklmnopqrstuvwxyz01234'
        );
      },
      { timeout: 20_000 },
    );
    await expect(page.getByText('Official BetterTrack app')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`Signed in as ${secondUsername}`)).toBeVisible();
    // The interpose still holds for the newly-signed-in identity — Continue and
    // Use another account both reappear, and auto-approve keeps skipping the
    // scope-approval prompt (V4-P2b invariant, not just a first-user quirk).
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use another account' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    // Still zero approves — the whole round-trip never authorizes.
    expect(approveHits).toHaveLength(0);
  } finally {
    await contextA.close();
  }
});
