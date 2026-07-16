import { expect, request as newRequestContext, test } from '@playwright/test';

import {
  createRegistrationToken,
  getRegistrationMode,
  loginAsAdmin,
  newAdminBrowserContext,
  setRegistrationMode,
} from './support/adminApi';
import { ACCOUNT_PASSWORD, API_BASE_URL } from './support/config';

/**
 * Registration-modes smoke (§6.12 / v3 #420, via issue #446). The admin flips
 * the global mode to `open` through the real settings API (a live change, no
 * restart), a brand-new visitor self-registers at /register, and — open mode
 * signs the account straight in — lands on /portfolio. The prior mode is read
 * first and restored in a `finally`, so the rest of the suite keeps the seed
 * default (`closed`: invite links only).
 */
test('registration modes: open mode allows self-serve signup at /register', async ({ browser }) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const priorMode = await getRegistrationMode(apiRequest);
  await setRegistrationMode(apiRequest, 'open');

  // Everything after the mode flip runs inside the try — even a failed
  // newContext() must not leave the instance in open registration.
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    const uid = Date.now().toString(36);
    const email = `e2e-openreg-${uid}@bettertrack.local`;
    const username = `e2eopenreg${uid}`.slice(0, 40);

    await page.goto('/register');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    // Open mode signs the new account straight in → "/" → /portfolio.
    await expect(page).toHaveURL(/\/portfolio$/, { timeout: 20_000 });
  } finally {
    await setRegistrationMode(apiRequest, priorMode);
    await apiRequest.dispose();
    await context?.close();
  }
});

/**
 * Invite-token mode (§6.12 / #420, via issue #506). Admin mints a single-use
 * registration token through the admin API; a visitor drives the real
 * /register surface with the token field visible and lands signed in. A second
 * visitor reusing the now-spent token gets the localized
 * `INVALID_REGISTRATION_TOKEN` message and no session — the same token can
 * never mint a second account. Mode is restored in `finally` so the rest of
 * the suite (and the closed-mode regression below) can rely on it.
 */
test('registration modes: invite-token mode consumes a single-use token', async ({ browser }) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const priorMode = await getRegistrationMode(apiRequest);
  await setRegistrationMode(apiRequest, 'invite_token');
  const token = await createRegistrationToken(apiRequest, {
    maxUses: 1,
    label: 'e2e-invite-token',
  });

  let goodCtx: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let badCtx: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const uid = Date.now().toString(36);

    // (1) A valid single-use token registers a real account and signs it in.
    goodCtx = await browser.newContext();
    const goodPage = await goodCtx.newPage();
    const goodEmail = `e2e-tokgood-${uid}@bettertrack.local`;
    const goodUsername = `e2etokgood${uid}`.slice(0, 40);

    await goodPage.goto('/register');
    await goodPage.getByLabel('Access token').fill(token);
    await goodPage.getByLabel('Email').fill(goodEmail);
    await goodPage.getByLabel('Username').fill(goodUsername);
    await goodPage.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await goodPage.getByRole('button', { name: 'Create account' }).click();
    await expect(goodPage).toHaveURL(/\/portfolio$/, { timeout: 20_000 });

    // (2) The same token — now spent — surfaces INVALID_REGISTRATION_TOKEN
    // (i18n key auth.register.invalidToken) and no account is created. The
    // visitor stays on /register (no /portfolio redirect), so a follow-up
    // navigation to /portfolio bounces to /login: no session was minted.
    badCtx = await browser.newContext();
    const badPage = await badCtx.newPage();
    const badEmail = `e2e-tokbad-${uid}@bettertrack.local`;
    const badUsername = `e2etokbad${uid}`.slice(0, 40);

    await badPage.goto('/register');
    await badPage.getByLabel('Access token').fill(token);
    await badPage.getByLabel('Email').fill(badEmail);
    await badPage.getByLabel('Username').fill(badUsername);
    await badPage.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await badPage.getByRole('button', { name: 'Create account' }).click();
    await expect(badPage.getByText(/registration token is invalid or has expired/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(badPage).toHaveURL(/\/register/);

    await badPage.goto('/portfolio');
    await expect(badPage).toHaveURL(/\/login/, { timeout: 15_000 });
  } finally {
    await setRegistrationMode(apiRequest, priorMode);
    await apiRequest.dispose();
    await goodCtx?.close();
    await badCtx?.close();
  }
});

/**
 * Approval mode (§6.12 / #420, via issue #506). Two visitors self-register and
 * each lands `pending` — no session yet, and the `auth.register.pendingMessage`
 * copy confirms the request is queued. An admin drives the real Settings-page
 * approval queue (part of what shipped, so covered by e2e) and approves the
 * first applicant + rejects the second; the approved applicant then signs in
 * successfully, while the rejected one is still met with the generic
 * invalid-credentials error at /login. The admin browser context reuses the
 * API-authed session cookie via {@link newAdminBrowserContext}, so the admin
 * SPA lands directly on the console — no admin-login UI to drive.
 */
test('registration modes: approval mode gates on admin approve / reject via the admin UI', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const priorMode = await getRegistrationMode(apiRequest);
  await setRegistrationMode(apiRequest, 'approval');

  let approveCtx: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let rejectCtx: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let adminCtx: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const uid = Date.now().toString(36);
    const approveEmail = `e2e-apprvok-${uid}@bettertrack.local`;
    const approveUsername = `e2eapprvok${uid}`.slice(0, 40);
    const rejectEmail = `e2e-apprvno-${uid}@bettertrack.local`;
    const rejectUsername = `e2eapprvno${uid}`.slice(0, 40);

    // (1) Applicant A registers — the response is `pending` (202), no session
    // is minted, and the SPA swaps the form for the queued-request notice.
    approveCtx = await browser.newContext();
    const approvePage = await approveCtx.newPage();
    await approvePage.goto('/register');
    await approvePage.getByLabel('Email').fill(approveEmail);
    await approvePage.getByLabel('Username').fill(approveUsername);
    await approvePage.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await approvePage.getByRole('button', { name: 'Request account' }).click();
    await expect(approvePage.getByText(/registration is pending/i)).toBeVisible({
      timeout: 15_000,
    });
    // Still on /register — pending never signs anyone in.
    await expect(approvePage).toHaveURL(/\/register/);

    // (2) Applicant B registers the same way, so the queue has TWO rows to
    // resolve independently through the admin UI.
    rejectCtx = await browser.newContext();
    const rejectPage = await rejectCtx.newPage();
    await rejectPage.goto('/register');
    await rejectPage.getByLabel('Email').fill(rejectEmail);
    await rejectPage.getByLabel('Username').fill(rejectUsername);
    await rejectPage.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await rejectPage.getByRole('button', { name: 'Request account' }).click();
    await expect(rejectPage.getByText(/registration is pending/i)).toBeVisible({
      timeout: 15_000,
    });

    // (3) Admin drives the real Settings page — approve A, reject B. Each row
    // is keyed on the applicant's username, so we scope by that to avoid a
    // race between them.
    adminCtx = await newAdminBrowserContext(browser, apiRequest);
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/admin/settings');
    const approveRow = adminPage.getByRole('listitem').filter({ hasText: approveUsername });
    await expect(approveRow).toBeVisible({ timeout: 30_000 });
    await approveRow.getByRole('button', { name: 'Approve' }).click();
    await expect(approveRow).toBeHidden({ timeout: 15_000 });

    const rejectRow = adminPage.getByRole('listitem').filter({ hasText: rejectUsername });
    await expect(rejectRow).toBeVisible();
    await rejectRow.getByRole('button', { name: 'Reject' }).click();
    await expect(rejectRow).toBeHidden({ timeout: 15_000 });

    // (4) Applicant A can now sign in — an approved application minted a real
    // account with the same email + username + password.
    await approvePage.goto('/login');
    await approvePage.getByLabel('Email or username').fill(approveUsername);
    await approvePage.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await approvePage.getByRole('button', { name: 'Sign in' }).click();
    await expect(approvePage).toHaveURL(/\/portfolio$/, { timeout: 20_000 });

    // (5) Applicant B still cannot sign in — a rejected application never
    // becomes an account; §6.1 hides the reason behind the generic form error.
    await rejectPage.goto('/login');
    await rejectPage.getByLabel('Email or username').fill(rejectUsername);
    await rejectPage.getByLabel('Password').fill(ACCOUNT_PASSWORD);
    await rejectPage.getByRole('button', { name: 'Sign in' }).click();
    await expect(rejectPage.getByText(/incorrect email\/username or password/i)).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await setRegistrationMode(apiRequest, priorMode);
    await apiRequest.dispose();
    await approveCtx?.close();
    await rejectCtx?.close();
    await adminCtx?.close();
  }
});

/**
 * Closed-mode regression (§6.12 / #420, via issue #506). Runs AFTER the flips
 * above so it doubles as evidence that each `finally` restored the mode back
 * to the seed default. Reads the mode through the public discovery endpoint
 * (mirrors what the SPA does on load) and confirms the closed surface: closed
 * copy, no email/password fields, no submit button — no usable self-serve
 * form.
 */
test('registration modes: closed mode leaves /register without a usable form', async ({
  browser,
}) => {
  test.setTimeout(60_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);

  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    // The prior tests each restored to their read-first prior mode; the seed
    // default is `closed`, so a fresh compose stack lands here without another
    // flip. Assert via the public discovery endpoint (unauthenticated, the
    // exact contract the SPA uses on /register load) so the assertion doesn't
    // rely on the admin cookie either.
    const info = await apiRequest.get(`${API_BASE_URL}/api/v1/auth/registration-info`);
    if (!info.ok()) {
      throw new Error(`registration-info fetch failed: ${info.status()} ${await info.text()}`);
    }
    const { mode } = (await info.json()) as { mode: string };
    expect(mode).toBe('closed');

    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/register');
    await expect(page.getByText(/registration is currently closed/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByLabel('Email')).toHaveCount(0);
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);
  } finally {
    await apiRequest.dispose();
    await context?.close();
  }
});
