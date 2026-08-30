import { randomUUID } from 'node:crypto';

import {
  expect,
  request as newRequestContext,
  test,
  type Locator,
  type Page,
} from '@playwright/test';

import { newAdminRequestContext } from './support/adminApi';
import { withoutMatcherAriaSnapshot } from './support/artifactHygiene';
import { assertNoPd9Secrets, type Pd9SensitiveCanary } from './support/pd9Drive';
import {
  createVaultThroughCeremony,
  expectVaultState,
  openPrivacyPanel,
  vaultRow,
} from './support/e10';
import { provisionUserInContext, type E2EUser } from './support/users';

/**
 * VAULT-UX-B — "keep unlocked on this device", end to end in a real browser.
 *
 * The failure this exists to prevent is the one the owner reported: the vault
 * re-locking on every page load and in every new tab. `[E10-A1]` asserts the
 * OPPOSITE — that a reload IS the lock — and both are correct, because custody
 * is opt-in: without the switch the endpoint session stays memory-only and A1
 * keeps passing unchanged.
 *
 * Everything here is driven through the real UI, over the real IndexedDB the
 * browser gives the page. Nothing stubs the keystore.
 */

// Same recorder hygiene as the paranoid arcs: this spec types a real device
// password, and an aria snapshot prints input values in cleartext.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const DEVICE_PASSWORD = 'Custody-Device-Password-2026!';

test.describe('per-vault device custody', () => {
  test('keeps a vault unlocked across a reload and a second tab until it is locked', async ({
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === 'mobile-chromium',
      'The account menu and the shield chip have their own phone layout; this is the desktop arc.',
    );
    test.setTimeout(180_000);

    const sensitive: Pd9SensitiveCanary[] = [
      { name: 'custody-device-password', value: DEVICE_PASSWORD },
    ];
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;
    // Assigned inside a test.step, so the narrowing has to be widened explicitly.
    let second = null as Page | null;

    try {
      owner = await provisionUserInContext(context, admin, 'custody');
      const { page } = owner;
      await openPrivacyPanel(page);

      const name = `Custody ${randomUUID().slice(0, 8)}`;
      const created = await createVaultThroughCeremony(owner, {
        name,
        devicePassword: DEVICE_PASSWORD,
      });
      sensitive.push({ name: 'custody-mnemonic', value: created.mnemonic });

      await test.step('without the opt-in, a reload still locks — A1 unchanged', async () => {
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Vaults', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await expectVaultState(page, name, 'Locked on this device');
        await shot(page, testInfo, '01-locked-after-reload');
      });

      await test.step('the shield chip prompts IN PLACE, with the keep-unlocked switch', async () => {
        await leaveControlCenter(page);
        const prompt = await openUnlockPromptFromChip(page);
        await shot(page, testInfo, '02-in-place-prompt');
        await prompt.getByLabel('Device password').fill(DEVICE_PASSWORD);
        await prompt.getByRole('switch', { name: 'Keep unlocked on this device' }).click();
        await prompt.getByRole('button', { name: 'Unlock vault', exact: true }).click();
        await expect(prompt).toBeHidden({ timeout: 60_000 });
        // The unlock resolved WHERE THE USER WAS: no navigation, and the chip
        // itself is the proof — its aggregate label is derived from live state.
        expect(new URL(page.url()).pathname).toBe('/portfolio');
        await expect(page.getByRole('button', { name: 'All synced ✓', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await shot(page, testInfo, '03-unlocked-in-place');
        await openPrivacyPanel(page);
        await expectVaultState(page, name, 'Ready on this device');
      });

      await test.step('RELOAD: the vault is still open, with no prompt', async () => {
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Vaults', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await expectVaultState(page, name, 'Ready on this device');
        await expect(
          vaultRow(page, name).getByRole('button', { name: 'Unlock', exact: true }),
          'a device the user kept unlocked must never ask again',
        ).toHaveCount(0);
        await expect(
          vaultRow(page, name).getByRole('link', { name: 'Unlock', exact: true }),
        ).toHaveCount(0);
        await shot(page, testInfo, '04-still-unlocked-after-reload');
      });

      await test.step('SECOND TAB: the same browser profile resolves unlocked', async () => {
        second = await context.newPage();
        await openPrivacyPanel(second);
        await expectVaultState(second, name, 'Ready on this device');
        await shot(second, testInfo, '05-second-tab-unlocked');
        // …and tab one is untouched by tab two having looked.
        await expectVaultState(page, name, 'Ready on this device');
      });

      await test.step('MANUAL LOCK revokes the device key in every tab', async () => {
        await leaveControlCenter(page);
        await page.getByRole('button', { name: 'Account menu' }).first().click();
        await page.getByRole('menuitem', { name: 'Lock vault', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Locked (1)', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await shot(page, testInfo, '06-locked-manually');
        await openPrivacyPanel(page);
        await expectVaultState(page, name, 'Locked on this device');

        // Cross-tab, through the account-scoped storage signal.
        await expect
          .poll(async () => vaultRow(second!, name).getByText('Locked on this device').count(), {
            timeout: 30_000,
            intervals: [500],
          })
          .toBe(1);
      });

      await test.step('and the revocation survives a reload — custody is gone, not hidden', async () => {
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Vaults', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await expectVaultState(page, name, 'Locked on this device');
        await shot(page, testInfo, '07-still-locked-after-reload');
      });
    } catch (error) {
      bodyFailure = error;
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      await assertNoCustodySecrets(testInfo, sensitive, bodyFailure);
      await second?.close();
      await owner?.context.close();
      await admin.dispose();
    }
  });
});

/**
 * The artifact scan, extracted so its throw is not lexically inside a `finally`
 * (`no-unsafe-finally`) — the same shape `paranoid-e10.spec.ts` uses. A leak
 * must never mask the real failure that produced it.
 */
async function assertNoCustodySecrets(
  testInfo: Parameters<typeof assertNoPd9Secrets>[0],
  sensitive: readonly Pd9SensitiveCanary[],
  bodyFailure: unknown,
): Promise<void> {
  try {
    await assertNoPd9Secrets(testInfo, [], sensitive);
  } catch (error) {
    if (bodyFailure === undefined) throw error;
    testInfo.errors.push({ message: String(error) });
  }
}

/**
 * The Control Center is a full-page overlay with its own scrim, so the shell
 * behind it — the shield chip, the account menu — is not clickable while it is
 * open. Every in-place affordance this arc exercises lives out there.
 */
async function leaveControlCenter(page: Page): Promise<void> {
  await page.goto('/portfolio');
  await expect(page.locator('.bt-cc-root')).toHaveCount(0, { timeout: 30_000 });
}

/**
 * The shield chip's popover row is the nearest in-place unlock that needs no
 * vaulted portfolio, so this arc reaches the dialog without paying for the whole
 * move-in pipeline. It is the same `VaultStateAction inPlace` the locked
 * portfolio stub renders.
 */
async function openUnlockPromptFromChip(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Locked (1)', exact: true }).click();
  const popover = page.getByRole('dialog', { name: 'Encrypted vault sync' });
  await expect(popover).toBeVisible({ timeout: 30_000 });
  await expect(
    popover.getByRole('link', { name: 'Unlock', exact: true }),
    'the unlock affordance must be a button, not a link into settings',
  ).toHaveCount(0);
  await popover.getByRole('button', { name: 'Unlock', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: /^Unlock/u });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  return prompt;
}

/**
 * Screenshots are OFF for this spec (they would carry the typed password), so
 * each one is taken deliberately, after the field is empty or unmounted.
 */
async function shot(page: Page, testInfo: { outputPath(name: string): string }, name: string) {
  // Overlays fade in, and a screenshot taken on the frame they mount catches
  // them at opacity 0 — which is how the first capture of the unlock prompt
  // came back showing only the popover behind it.
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
}
