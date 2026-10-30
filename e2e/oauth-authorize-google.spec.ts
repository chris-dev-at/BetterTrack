import { createHash, randomBytes } from 'node:crypto';

import { devices, expect, request as newRequestContext, test } from '@playwright/test';

import { newAdminRequestContext } from './support/adminApi';
import { API_BASE_URL, FAKE_GOOGLE_URL, WEB_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * The mobile app's sign-in, end to end, through Google (owner-reported
 * 2026-10-29). BetterTrackMobile opens the platform's `/oauth/authorize?…` in an
 * Android Custom Tab; an anonymous visitor lands on the login page, which now
 * offers every method the web login offers. Choosing Google must come back
 * INTO the pending authorize request — not the webapp — and finish the PKCE
 * hand-off to `bettertrack://oauth/callback`.
 *
 * Drives the REAL chain: the authorize URL (a real S256 challenge) → RequireUser
 * → `/login` → "Continue with Google" → the API's `/auth/google/start?returnTo=…`
 * → the fake IdP ({@link ../e2e/support/fakeGoogleIdp.mjs}) → the API callback
 * → back on `/oauth/authorize?…` signed in → the first-party account
 * confirmation → Continue → the API-validated custom-scheme redirect. The
 * custom scheme is not followable by Chromium, so the hand-off is asserted on
 * the approve response the consent screen navigates to (the ONLY value it ever
 * assigns to `window.location`) and proven real by redeeming the code with the
 * PKCE verifier, exactly as the app would.
 *
 * Runs in a Pixel-7 context (a Custom Tab is a phone browser), so the method
 * list is also checked at phone width. Gate: the nightly e2e suite (both
 * projects), alongside `oauth-consent.spec.ts` and `google-login.spec.ts`.
 */

const MOBILE_CLIENT_ID = 'btc_IbT1mzw_7kBiPHPkGfaE0Q';
const MOBILE_REDIRECT_URI = 'bettertrack://oauth/callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

test('oauth authorize: Google sign-in from the Custom-Tab login returns into the pending request and hands the app its PKCE code', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newAdminRequestContext(newRequestContext);
  const idp = await newRequestContext.newContext();
  const tokenClient = await newRequestContext.newContext();
  // An existing account; Google's VERIFIED email matches it, so the callback
  // links + signs it in (resolution step 2) — no registration detour.
  const user = await provisionUser(browser, apiRequest, 'gauthz');
  await user.context.close();

  const runId = Date.now().toString(36);
  const appState = `e2e-gauthz-${runId}`;
  const { verifier, challenge } = pkce();
  const authorizePath = `/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: MOBILE_CLIENT_ID,
    redirect_uri: MOBILE_REDIRECT_URI,
    scope: 'portfolio:read',
    state: appState,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()}`;

  const context = await browser.newContext({ ...devices['Pixel 7'] });
  try {
    const page = await context.newPage();
    await page.goto(authorizePath);

    // Anonymous → the login page, carrying the request in router state.
    await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
    await expect(page.getByText('Sign in to your account')).toBeVisible();

    // Every method the web login offers is offered here — visible at phone width.
    const google = page.getByRole('link', { name: 'Continue with Google' });
    const passkey = page.getByRole('button', { name: 'Sign in with a passkey' });
    // The password method is located by the marker the login page declares on
    // its form (the same marker the parity unit test enumerates); the form box
    // spans its fields and submit, so the viewport check covers them all.
    const password = page.locator('form[data-sign-in-method="password"]');
    for (const method of [google, passkey, password]) {
      await expect(method).toBeVisible({ timeout: 15_000 });
      await method.scrollIntoViewIfNeeded();
      const box = await method.boundingBox();
      const viewport = page.viewportSize();
      expect(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width).toBeTruthy();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // Google, through the fake IdP, with the account's verified email.
    const primed = await idp.post(`${FAKE_GOOGLE_URL}/__identity`, {
      data: {
        sub: `google-sub-authz-${runId}`,
        email: user.email,
        email_verified: true,
        name: 'Authorize Tester',
      },
    });
    expect(primed.ok(), await primed.text()).toBe(true);
    await google.click();

    // Back INSIDE the same authorize request, on the web origin itself (never
    // another host) — PKCE + state untouched.
    await page.waitForURL(
      (url) =>
        url.origin === new URL(WEB_BASE_URL).origin &&
        url.pathname === '/oauth/authorize' &&
        url.searchParams.get('client_id') === MOBILE_CLIENT_ID &&
        url.searchParams.get('state') === appState &&
        url.searchParams.get('code_challenge') === challenge,
      { timeout: 30_000 },
    );
    await expect(page.getByText('Official BetterTrack app')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`Signed in as ${user.username}`)).toBeVisible();

    // First-party: no scope prompt, but the account confirmation is interposed.
    const approved = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith('/api/v1/oauth/authorize'),
    );
    await page.getByRole('button', { name: 'Continue' }).click();
    const approval = await approved;
    expect(approval.status()).toBe(200);
    const { redirectTo } = (await approval.json()) as { redirectTo: string };

    // The hand-off the consent screen navigates to: the app's callback.
    const callback = new URL(redirectTo);
    expect(callback.protocol).toBe('bettertrack:');
    expect(callback.host).toBe('oauth');
    expect(`${callback.protocol}//${callback.host}${callback.pathname}`).toBe(MOBILE_REDIRECT_URI);
    expect(callback.searchParams.get('state')).toBe(appState);
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();

    // …and it is real: the code redeems with THIS flow's PKCE verifier.
    const exchanged = await tokenClient.post(`${API_BASE_URL}/api/v1/oauth/token`, {
      data: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: MOBILE_REDIRECT_URI,
        client_id: MOBILE_CLIENT_ID,
        code_verifier: verifier,
      },
    });
    expect(exchanged.status(), await exchanged.text()).toBe(200);
    const token = (await exchanged.json()) as { access_token?: string };
    expect(token.access_token).toBeTruthy();
  } finally {
    await context.close();
    await tokenClient.dispose();
    await idp.dispose();
    await apiRequest.dispose();
  }
});
