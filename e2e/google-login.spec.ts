import {
  expect,
  request as newRequestContext,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

import { getRegistrationMode, loginAsAdmin, setRegistrationMode } from './support/adminApi';
import { ACCOUNT_PASSWORD, API_BASE_URL, FAKE_GOOGLE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * Google sign-in end-to-end (§13.4 V4-P11, issue #520). Drives the REAL redirect
 * chain — `Continue with Google` → the API's `/auth/google/start` → the fake IdP's
 * authorize → the API callback — against a local {@link fakeGoogleIdp} that mints
 * jose-signed `id_token`s served from its own JWKS. The API's three Google
 * endpoints are pointed at the fake IdP via the test-only `BT_GOOGLE_*` overrides
 * (defaulting to the production Google constants when unset), so the API's
 * signature/`iss`/`aud`/`exp` verification runs UNMODIFIED — only the URLs move.
 *
 * Covered (§16 2026-07-16 V4-P4b behaviors): a verified-email match links an
 * existing account and both Google and password then sign it in; an UNVERIFIED
 * Google email never links (account-takeover guard) and falls through to
 * EMAIL_TAKEN; `open` mode registers a brand-new identity; `closed` mode rejects
 * it (regression). The `bt_goog_state` cookie + Redis double-submit state check is
 * exercised by driving the browser through the real chain, never a hand-crafted
 * callback URL. Worker- and retry-safe: unique per-run emails/subs; the mode is
 * read first and restored in a `finally`.
 */

interface GoogleIdentity {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
}

/**
 * Prime the identity the NEXT authorize round-trip will sign in as. The fake IdP
 * holds a single pending identity, consumed by the next `/authorize` and keyed to
 * the code it issues — race-free because Playwright runs one flow at a time.
 */
async function primeGoogleIdentity(
  request: APIRequestContext,
  identity: GoogleIdentity,
): Promise<void> {
  const res = await request.post(`${FAKE_GOOGLE_URL}/__identity`, { data: identity });
  if (!res.ok()) {
    throw new Error(`Priming the fake Google identity failed: ${res.status()} ${await res.text()}`);
  }
}

/** Click "Continue with Google" — a full-page navigation that follows the chain. */
async function clickContinueWithGoogle(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Continue with Google' }).click();
}

/** Password sign-in through the real login form; asserts it lands on /portfolio. */
async function passwordSignIn(page: Page, identifier: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email or username').fill(identifier);
  await page.getByLabel('Password').fill(ACCOUNT_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/portfolio$/, { timeout: 20_000 });
}

test('google login: verified-email match links an existing account; Google and password both sign in', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  const idp = await newRequestContext.newContext();
  await loginAsAdmin(apiRequest);
  const user = await provisionUser(browser, apiRequest, 'glink');
  // Only the account is needed; drop the provisioning context so the sign-in
  // flows below run anonymous (a live session would turn `start` into a LINK flow).
  await user.context.close();

  const sub = `google-sub-link-${Date.now().toString(36)}`;
  let signInCtx: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let repeatCtx: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let pwCtx: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    // (1) Anonymous Google sign-in with the SAME verified email → link + sign in.
    signInCtx = await browser.newContext();
    const page = await signInCtx.newPage();
    await page.goto('/login');
    await primeGoogleIdentity(idp, {
      sub,
      email: user.email,
      email_verified: true,
      name: 'Link Tester',
    });
    await clickContinueWithGoogle(page);
    await expect(page).toHaveURL(/\/portfolio$/, { timeout: 30_000 });

    // (2) A second Google sign-in with the same sub now hits the linked identity
    // directly (resolution step 1) — proof the first sign-in persisted the link.
    repeatCtx = await browser.newContext();
    const repeatPage = await repeatCtx.newPage();
    await repeatPage.goto('/login');
    await primeGoogleIdentity(idp, { sub, email: user.email, email_verified: true });
    await clickContinueWithGoogle(repeatPage);
    await expect(repeatPage).toHaveURL(/\/portfolio$/, { timeout: 30_000 });

    // (3) Password login for the same account still works — linking never
    // disables the existing credential.
    pwCtx = await browser.newContext();
    await passwordSignIn(await pwCtx.newPage(), user.username);
  } finally {
    await idp.dispose();
    await apiRequest.dispose();
    await signInCtx?.close();
    await repeatCtx?.close();
    await pwCtx?.close();
  }
});

test('google login: open mode registers a brand-new verified identity', async ({ browser }) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  const idp = await newRequestContext.newContext();
  await loginAsAdmin(apiRequest);
  const priorMode = await getRegistrationMode(apiRequest);
  await setRegistrationMode(apiRequest, 'open');

  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const uid = Date.now().toString(36);
    const email = `e2e-gopen-${uid}@bettertrack.local`;
    const username = `e2egopen${uid}`.slice(0, 40);

    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/login');
    await primeGoogleIdentity(idp, { sub: `google-sub-open-${uid}`, email, email_verified: true });
    await clickContinueWithGoogle(page);

    // A brand-new identity lands on the connected register form (owner order
    // 2026-07-16 — no account is created at the callback); the verified email is
    // locked to the ticket.
    await expect(page).toHaveURL(/\/register\?google=connected/, { timeout: 30_000 });
    await expect(page.getByText('Connected to Google as')).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    // Open mode signs the freshly-registered account straight in.
    await expect(page).toHaveURL(/\/portfolio$/, { timeout: 30_000 });
  } finally {
    await setRegistrationMode(apiRequest, priorMode);
    await idp.dispose();
    await apiRequest.dispose();
    await context?.close();
  }
});

test('google login: an unverified Google email never links and falls through to EMAIL_TAKEN', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  const idp = await newRequestContext.newContext();
  await loginAsAdmin(apiRequest);
  const user = await provisionUser(browser, apiRequest, 'gunver');
  await user.context.close();
  const priorMode = await getRegistrationMode(apiRequest);
  // Open mode so a brand-new identity reaches the register form (where the taken
  // email surfaces EMAIL_TAKEN); the unverified email must NOT link regardless.
  await setRegistrationMode(apiRequest, 'open');

  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let pwCtx: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const uid = Date.now().toString(36);
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/login');
    // An UNVERIFIED Google email that matches an existing account: the
    // account-takeover guard means it never links.
    await primeGoogleIdentity(idp, {
      sub: `google-sub-unver-${uid}`,
      email: user.email,
      email_verified: false,
    });
    await clickContinueWithGoogle(page);

    // No link, no sign-in — it is treated as a brand-new identity and lands on the
    // connected register form with the (taken) email locked.
    await expect(page).toHaveURL(/\/register\?google=connected/, { timeout: 30_000 });
    await page.getByLabel('Username').fill(`e2egunv${uid}`.slice(0, 40));
    await page.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    // The taken email surfaces EMAIL_TAKEN; nothing is created and no session set.
    await expect(page.getByText(/account already exists for this email/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.goto('/portfolio');
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

    // The existing account is untouched — its password login still works.
    pwCtx = await browser.newContext();
    await passwordSignIn(await pwCtx.newPage(), user.username);
  } finally {
    await setRegistrationMode(apiRequest, priorMode);
    await idp.dispose();
    await apiRequest.dispose();
    await context?.close();
    await pwCtx?.close();
  }
});

test('google login: closed mode rejects a brand-new identity with the friendly message', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  const idp = await newRequestContext.newContext();
  await loginAsAdmin(apiRequest);
  const priorMode = await getRegistrationMode(apiRequest);
  await setRegistrationMode(apiRequest, 'closed');

  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const uid = Date.now().toString(36);
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/login');
    await primeGoogleIdentity(idp, {
      sub: `google-sub-closed-${uid}`,
      email: `e2e-gclosed-${uid}@bettertrack.local`,
      email_verified: true,
    });
    await clickContinueWithGoogle(page);

    // Rejected at the callback → back on /login carrying the friendly closed
    // notice (no ticket, no account, no session).
    await expect(page).toHaveURL(/\/login\?error=google_registration_closed/, { timeout: 30_000 });
    await expect(page.getByText(/registration is currently closed/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.goto('/portfolio');
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  } finally {
    await setRegistrationMode(apiRequest, priorMode);
    await idp.dispose();
    await apiRequest.dispose();
    await context?.close();
  }
});
