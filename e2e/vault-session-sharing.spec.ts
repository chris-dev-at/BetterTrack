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
 * VAULT-UX-B — the in-place unlock and §12-conformant session sharing, end to
 * end in a real browser.
 *
 * ── WHAT THIS ARC ASSERTS, AND WHY IT IS NOT "KEEP UNLOCKED" ──────────────
 *
 * `docs/paranoid-design.md` §12 is binding: K_dev lives only in volatile
 * memory, and the persisted "keep unlocked on this device" convenience is
 * deliberately retired. PR #1604's first shape shipped it anyway; the Chief
 * upheld §12 and it was removed. So a RELOAD re-locks — `[E10-A1]` asserts
 * exactly that and keeps passing unchanged — and the mitigation is that the
 * unlock is now one step, where the user already stands.
 *
 * What §12 does scope to the ENDPOINT rather than the tab is the session
 * itself: "entering it once per session unlocks ALL wrapped phrases on that
 * endpoint", and an endpoint is a device. A second tab therefore joins the live
 * session over `BroadcastChannel` — memory-only, dying with the last tab — and
 * a lock in any tab revokes every one of them.
 *
 * Everything here is driven through the real UI, over the real browser. Nothing
 * stubs the keystore, and the step order is load-bearing: the reload arc runs
 * while `page` is the ONLY tab, because a sibling tab would (correctly) hand the
 * session back and there would be nothing to re-enter.
 */

// Same recorder hygiene as the paranoid arcs: this spec types a real device
// password, and an aria snapshot prints input values in cleartext.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const DEVICE_PASSWORD = 'Session-Device-Password-2026!';

test.describe('per-vault endpoint session', () => {
  test('re-locks on reload, unlocks in one step, is shared across tabs, and dies on lock', async ({
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === 'mobile-chromium',
      'The account menu and the shield chip have their own phone layout; this is the desktop arc.',
    );
    test.setTimeout(180_000);

    const sensitive: Pd9SensitiveCanary[] = [
      { name: 'session-device-password', value: DEVICE_PASSWORD },
    ];
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;
    // Assigned inside a test.step, so the narrowing has to be widened explicitly.
    let second = null as Page | null;

    try {
      owner = await provisionUserInContext(context, admin, 'session');
      const { page } = owner;
      await openPrivacyPanel(page);

      const name = `Session ${randomUUID().slice(0, 8)}`;
      const created = await createVaultThroughCeremony(owner, {
        name,
        devicePassword: DEVICE_PASSWORD,
      });
      sensitive.push({ name: 'session-mnemonic', value: created.mnemonic });

      await test.step('§12: a RELOAD re-locks, because K_dev is never persisted', async () => {
        // PROVE THE PRECONDITION FIRST. The ceremony leaves the vault open, and
        // without this assertion the reload below would pass just as happily
        // against a vault that was never unlocked at all — a locked-stays-locked
        // tautology dressed up as a revocation test.
        await expectVaultState(page, name, 'Ready on this device');

        // This is the only tab, so there is no live session anywhere on the
        // device to rejoin. A1's claim, restated for this arc.
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Vaults', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await expectVaultState(page, name, 'Locked on this device');
        await shot(page, testInfo, '01-locked-after-reload');
      });

      await test.step('ONE password entry, in place, restores it where the user stands', async () => {
        await leaveControlCenter(page);
        const chip = await openSyncChip(page, 'Locked (1)');
        await expect(
          chip.getByRole('link', { name: 'Unlock', exact: true }),
          'the unlock affordance must be a button, not a link into settings',
        ).toHaveCount(0);
        await chip.getByRole('button', { name: 'Unlock', exact: true }).click();

        const prompt = page.getByRole('dialog', { name: /^Unlock/u });
        await expect(prompt).toBeVisible({ timeout: 30_000 });
        // §12 again, on the surface this time: the prompt offers NO option to
        // keep anything on the device, because there is nothing to keep.
        await expect(
          prompt.getByRole('switch'),
          'a keep-unlocked switch would contradict §12',
        ).toHaveCount(0);
        await expect(prompt.getByText(/keep unlocked/iu)).toHaveCount(0);
        await shot(page, testInfo, '02-in-place-prompt');

        await prompt.getByLabel('Device password').fill(DEVICE_PASSWORD);
        await prompt.getByRole('button', { name: 'Unlock vault', exact: true }).click();
        await expect(prompt).toBeHidden({ timeout: 60_000 });

        // The unlock resolved WHERE THE USER WAS. Every assertion here is
        // deliberately in-place: `page.goto` would END the session, because with
        // no sibling tab open there is nothing on this device left holding it —
        // which is §12 working, not a defect. The proof is therefore the shell's
        // own live state, not a settings page.
        expect(new URL(page.url()).pathname).toBe('/portfolio');
        await expect(page.getByRole('button', { name: 'All synced ✓', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        const unlockedChip = await openSyncChip(page, 'All synced ✓');
        await expect(unlockedChip.getByRole('link', { name: 'Open', exact: true })).toBeVisible();
        await expect(
          unlockedChip.getByRole('button', { name: 'Unlock', exact: true }),
          'an open vault must not still be offering to unlock',
        ).toHaveCount(0);
        await shot(page, testInfo, '03-unlocked-in-place');
      });

      await test.step('SECOND TAB: the same device resolves unlocked, with no prompt', async () => {
        // A NEW TAB of the same context — the same origin, the same profile, a
        // different JS process. Its keystore has no key of its own; it asks the
        // account's channel and tab one answers with the live session.
        second = await context.newPage();
        await openPrivacyPanel(second);
        await expectVaultState(second, name, 'Ready on this device');
        await expect(
          vaultRow(second, name).getByRole('button', { name: 'Unlock', exact: true }),
          'a tab that joined a live session must not ask for the password',
        ).toHaveCount(0);
        await shot(second, testInfo, '04-second-tab-unlocked');
        // …and tab one is untouched by tab two having looked.
        await expect(page.getByRole('button', { name: 'All synced ✓', exact: true })).toBeVisible();
      });

      await test.step('a full navigation BESIDE a live sibling rejoins it — the session is the DEVICE', async () => {
        // The same `goto` that would have re-locked tab one a moment ago now
        // resolves unlocked, and the ONLY thing that changed is that another tab
        // of this device is holding the session. That difference is the feature.
        await openPrivacyPanel(page);
        await expectVaultState(page, name, 'Ready on this device');
        await expect(
          vaultRow(page, name).getByRole('button', { name: 'Unlock', exact: true }),
          'a device with a live session must not ask again',
        ).toHaveCount(0);
        await shot(page, testInfo, '05-reload-rejoined-from-sibling');
      });

      await test.step('MANUAL LOCK revokes the session in EVERY tab', async () => {
        await leaveControlCenter(page);
        await page.getByRole('button', { name: 'Account menu' }).first().click();
        await page.getByRole('menuitem', { name: 'Lock vault', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Locked (1)', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await shot(page, testInfo, '06-locked-manually');
        await openPrivacyPanel(page);
        await expectVaultState(page, name, 'Locked on this device');

        // Cross-tab, through the session channel and the storage twin.
        await expect
          .poll(async () => vaultRow(second!, name).getByText('Locked on this device').count(), {
            timeout: 30_000,
            intervals: [500],
          })
          .toBe(1);
        await shot(second!, testInfo, '07-second-tab-revoked');
      });

      await test.step('and a locked device stays locked — the sibling has nothing to give', async () => {
        // Tab two is still open, so this proves the revocation, not the reload:
        // a tab that had been unlocked a moment ago must not hand the session
        // back after the user locked it.
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Vaults', exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await expectVaultState(page, name, 'Locked on this device');
        await shot(page, testInfo, '08-still-locked-after-reload');
      });
    } catch (error) {
      bodyFailure = error;
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      await assertNoSessionSecrets(testInfo, sensitive, bodyFailure);
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
async function assertNoSessionSecrets(
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
 * The shield chip's popover — the shell's own live view of every vault on this
 * endpoint, and the nearest in-place unlock that needs no vaulted portfolio. It
 * hosts the same `VaultStateAction inPlace` the locked portfolio stub renders,
 * so this arc reaches the dialog without paying for the whole move-in pipeline.
 *
 * It is also the ONLY honest way to assert an unlocked session in a single tab:
 * anything that navigates ends the session by design (§12).
 */
async function openSyncChip(page: Page, label: string): Promise<Locator> {
  const popover = page.getByRole('dialog', { name: 'Encrypted vault sync' });
  // The chip TOGGLES, and the popover survives the unlock dialog that opens over
  // it — so a second unconditional click would close the thing we came to read.
  if (!(await popover.isVisible())) {
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  await expect(popover).toBeVisible({ timeout: 30_000 });
  return popover;
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
