import { expect, request as newRequestContext, test } from '@playwright/test';

import { newAdminRequestContext } from './support/adminApi';
import { passwordSignIn } from './support/auth';
import { ACCOUNT_PASSWORD, API_BASE_URL } from './support/config';
import { recentBookingDates } from './support/dates';
import { expectUserShellReady, recordSapTrade, watchAsset } from './support/flows';
import { befriend, provisionUser, provisionUserInContext } from './support/users';

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
});

/** Exactly `PIN_LENGTH` digits (#288); e2e cannot resolve the contracts package. */
const MOBILE_PIN = '4913';

/**
 * The phone-width journey the two mobile usability sweeps were built around.
 * Keep this as one user story: splitting it into isolated page checks would no
 * longer prove that the mobile shell, sheets and state changes compose.
 */
test('mobile happy path: money, portfolio wizard, market, chat and settings', async ({
  browser,
  context,
}) => {
  test.setTimeout(300_000);

  const apiRequest = await newAdminRequestContext(newRequestContext);
  const owner = await provisionUserInContext(context, apiRequest, 'mobile-owner');
  // The friend only supplies chat state; the owner's context is the viewport under test.
  const friend = await provisionUser(browser, apiRequest, 'mobile-friend');
  await apiRequest.dispose();

  const { page } = owner;
  const [tradeDate] = recentBookingDates(1);

  // The spec's contract is stricter than a project nickname: hold the actual
  // browser context to the owner-mandated iPhone-sized viewport and touch DPR.
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => ({
      devicePixelRatio: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
    })),
  ).toEqual({ devicePixelRatio: 3, maxTouchPoints: 1 });

  // Provisioning leaves a valid session. Sign out and drive the real password
  // form so the journey itself begins at login, as a returning phone user does.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Logout' }).click();
  await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
  await passwordSignIn(page, owner.username, ACCOUNT_PASSWORD);
  await expectUserShellReady(page);

  await test.step('open the portfolio overview and record a transaction', async () => {
    await page.goto('/portfolio');
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Your portfolio is empty')).toBeVisible();

    await recordSapTrade(page, {
      side: 'buy',
      quantity: '2',
      price: '50',
      date: tradeDate!,
    });
    await expect(
      page.getByRole('region', { name: 'Holdings' }).getByRole('link', { name: 'SAP.DE' }),
    ).toBeVisible({ timeout: 20_000 });
  });

  await test.step('record and manually tag a cash movement', async () => {
    await page.goto('/portfolio/cash/labels');
    await expect(page.getByRole('heading', { name: 'Labels & rules' })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'New tag' }).click();
    const tagDialog = page.getByRole('dialog', { name: 'New tag' });
    await tagDialog.getByLabel('Name', { exact: true }).fill('Mobile income');
    await tagDialog.getByRole('button', { name: 'Save' }).click();
    await expect(tagDialog).toBeHidden({ timeout: 15_000 });

    await page.goto('/portfolio/cash');
    await page.getByRole('button', { name: 'Record money in' }).click();
    const cashDialog = page.getByRole('dialog', { name: 'Record transaction' });
    await cashDialog.getByLabel('Amount', { exact: true }).fill('250');
    await cashDialog.getByLabel('What for').fill('Mobile test income');
    await cashDialog.getByRole('button', { name: 'Details' }).click();
    const tag = cashDialog
      .getByRole('group', { name: 'Tags' })
      .getByRole('button', { name: 'Mobile income' });
    await tag.click();
    await expect(tag).toHaveAttribute('aria-pressed', 'true');
    await cashDialog.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(cashDialog).toBeHidden({ timeout: 15_000 });

    await page.goto('/portfolio/cash/movements');
    const movement = page
      .getByRole('list', { name: 'Cash movements' })
      .getByRole('listitem')
      .filter({ hasText: 'Mobile test income' });
    await expect(movement).toBeVisible({ timeout: 20_000 });
    await expect(movement).toContainText('Mobile income');
  });

  await test.step('complete the add-portfolio wizard', async () => {
    await page.goto('/portfolio');
    const switcher = page.getByRole('button', { name: 'Switch portfolio' });
    await switcher.click();
    const portfolios = page.getByRole('group', { name: 'Portfolios' });
    await portfolios.getByRole('button', { name: 'Add portfolio' }).click();

    const wizard = page.getByRole('dialog', { name: 'Add portfolio' });
    await wizard.getByLabel('Portfolio name').fill('Mobile Growth');
    await wizard.getByRole('radio', { name: 'Savings' }).click();
    await wizard.getByRole('radio', { name: /Just me/ }).click();
    await wizard.getByRole('button', { name: 'Create portfolio' }).click();
    await expect(wizard).toBeHidden({ timeout: 20_000 });
    await expect(switcher).toContainText('Mobile Growth');

    // Keep the remaining journey on Main, where the transaction and cash row
    // above live; the switch itself is part of the wizard's hand-off contract.
    await switcher.click();
    await portfolios.getByRole('button', { name: 'Main' }).click();
    await expect(switcher).toContainText('Main');
  });

  await test.step('add a watchlist item and create an alert', async () => {
    await watchAsset(page, 'Apple', 'AAPL');

    await page.goto('/workbench/alerts');
    await page.getByRole('button', { name: '+ New alert' }).click();
    const alertDialog = page.getByRole('dialog', { name: 'New price alert' });
    await alertDialog.getByRole('searchbox', { name: 'Search assets' }).fill('Apple');
    await alertDialog.getByRole('button', { name: 'Select AAPL', exact: true }).click();
    await alertDialog.getByLabel('Threshold price (USD)').fill('10000');
    await alertDialog.getByRole('button', { name: 'Create alert' }).click();
    await expect(alertDialog).toBeHidden({ timeout: 20_000 });
    const alertRow = page.getByRole('listitem').filter({ hasText: 'AAPL' });
    await expect(alertRow).toContainText('Active', { timeout: 20_000 });
  });

  await test.step('open a friend chat and change a setting', async () => {
    await befriend(owner, friend);
    await page.goto('/people/chat');
    await page.getByRole('button', { name: 'New message' }).click();
    const newChat = page.getByRole('dialog', { name: 'New message' });
    await newChat.getByRole('button', { name: friend.username }).click();
    await page.getByPlaceholder('Message').fill('Hello from the mobile gate');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Hello from the mobile gate', { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    await page.goto('/control/privacy');
    const controlCenter = page.getByRole('dialog');
    const discreet = controlCenter.getByRole('switch', { name: 'Discreet mode' });
    await expect(discreet).not.toBeChecked();
    await discreet.click();
    await expect(discreet).toBeChecked();
  });

  // The acceptance criteria for the phone run name "login incl. PIN" as a
  // primary flow (§13.5 V5-P13b), and the PIN gate renders BEFORE the router —
  // it owns no route, so the overflow gate's route inventory can never reach
  // it. Close the journey the way a returning phone user re-opens the app.
  await test.step('re-open behind the PIN gate and unlock at phone width', async () => {
    const enabled = await owner.context.request.put(`${API_BASE_URL}/api/v1/auth/pin`, {
      headers: { 'X-Requested-With': 'BetterTrack' },
      data: { pin: MOBILE_PIN },
    });
    expect(enabled.ok(), `enabling the PIN: ${enabled.status()} ${await enabled.text()}`).toBe(
      true,
    );

    // The lock is idle-driven and local (AuthContext `isPinLocked`): with the
    // PIN on, a load with no recorded activity gates. Dropping the activity
    // record and reloading is exactly a cold open on the phone.
    await page.evaluate(() => localStorage.removeItem('bettertrack.pinActivity'));
    await page.reload();

    // Structural, not copy-bound: the gate is the only surface rendering the
    // segmented PIN entry.
    const digits = page.locator('[data-pin-input="true"] input');
    await expect(digits.first()).toBeVisible({ timeout: 20_000 });
    await expect(digits).toHaveCount(MOBILE_PIN.length);
    await expect(page.getByTestId('global-create-trigger')).toBeHidden();

    await digits.first().click();
    // The gate auto-submits on the last digit (#288) — no button press.
    await page.keyboard.type(MOBILE_PIN);
    await expectUserShellReady(page);
  });

  await friend.context.close();
});
