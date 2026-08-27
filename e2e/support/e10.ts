import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// The root e2e context resolves workspace contracts by path, exactly as the PD9
// harness does — there is no `@bettertrack/contracts` alias in this tsconfig.
import type { DriveConnection, VaultConfig } from '../../packages/contracts/src/vaults';

import { API_BASE_URL } from './config';
import type { E2EUser } from './users';

/**
 * E10-specific e2e harness — the PARANOID vault gate (`docs/paranoid-design.md`
 * §20 row E10, line 959).
 *
 * Unlike the E1/E2/E3 harnesses, this module stands up NO out-of-band service:
 * every arc E10 can actually run is reachable through the shipped browser
 * surface plus the account's own session-scoped API. That is deliberate — the
 * epic's value is proving the SHIPPED surface behaves, so a helper that reached
 * around it would be testing the harness.
 *
 * Three seams needed a decision, and each is recorded here rather than in a
 * comment beside one assertion:
 *
 *  - **"Lock" is a reload.** E3's endpoint keystore holds the unwrapped device
 *    key in memory on one module-scoped singleton (`keystore/runtime.ts`) and
 *    zeroes it when the session ends; nothing about a live wrapped session is
 *    persisted. A fresh document is therefore the product's own lock gesture for
 *    a per-vault endpoint session, and {@link lockVaultsByReload} names it so a
 *    future reader does not mistake `page.reload()` for incidental navigation.
 *
 *  - **The "mocked camera" is the shipped paste seam.** E7's receiver
 *    (`VaultReceivePhrase.tsx`) exposes its scan input as a textarea —
 *    `#vault-transfer-payload`, labelled "Transfer code", hinted "Paste the
 *    complete value beginning with btvault1:." — behind the "Scan or paste code"
 *    method button. A camera double would test a device API the product does not
 *    call on web; feeding decoded payloads through the real seam exercises the
 *    real parser, the real fetch-then-compare verification and the real custody
 *    write. Payloads are built with the product's OWN serializer
 *    (`serializeVaultTransferPayload`), so a wire-format change breaks this gate
 *    instead of being papered over by a hand-written string.
 *
 *  - **No Drive HTTP double.** E10's Drive arcs run against the surface that is
 *    actually shipped. Per-vault Drive PROVISIONING is off in this build
 *    (`PER_VAULT_DRIVE_PROVISIONING_AVAILABLE === false`), and the e2e web
 *    config does not override it (`apps/web/vite.e2e.config.mts` sets only
 *    `googleDriveClientId`), so flipping it here would test a build that does
 *    not exist. What IS shipped is E5's `drive_connections` directory, and it
 *    needs no Google at all: the create contract is `{ googleSub, email,
 *    displayName }` with no server-held token by design (§8/§22), which is
 *    exactly what makes the two-users-one-Drive isolation arc drivable.
 *    The account-level v1 Drive round trip keeps its existing coverage in
 *    `e2e/paranoid.spec.ts` ([PD9-A3]) with its own DataHome double; duplicating
 *    that six-minute flow here would add nightly cost and no assertion.
 *
 * Secrets: these arcs enter real BIP39 phrases and device passwords into the
 * DOM. What protects them in a FAILURE artifact — and, just as important, what
 * the `assertNoPd9Secrets` scan structurally cannot reach — is written up in
 * `e2e/support/artifactHygiene.ts`. Read that before assuming the scan covers
 * `error-context.md`; it does not, and it cannot.
 */

/**
 * Every E10 sub-arc named by the spec line, and where it is discharged.
 *
 * `arc` quotes `docs/paranoid-design.md:959` verbatim — it is the CLAIM. `status`
 * and `note` are what this suite actually proves against it, which is not always
 * the same thing; `partial` entries name the missing half rather than rounding it
 * up. [E10-A0] holds the guard that keeps this table honest.
 */
export const E10_TRACEABILITY = [
  {
    arc: 'full create→move-in→lock→unlock→move-out arc',
    assertion: '[E10-A1] vault ceremony, endpoint lock and unlock',
    status: 'partial',
    note: 'Create/lock/unlock run. The move halves are blocked by E6 — see [E10-A6].',
  },
  {
    arc: 'Drive-only vault round trip',
    assertion: '[E10-A5] Drive storage is refused honestly, not offered',
    status: 'blocked',
    note: 'PER_VAULT_DRIVE_PROVISIONING_AVAILABLE is false; [PD9-A3] covers the v1 account-level round trip.',
  },
  {
    arc: 'two-users-one-Drive isolation',
    assertion: '[E10-A4] one Google identity, two accounts, no shared reach',
    status: 'partial',
    note:
      'PROVEN: real ACCOUNT isolation at the repository — one Google identity yields two ' +
      'connections, each account lists only its own, and the other account gets 404 on ' +
      'PATCH/DELETE/GET (the same answer a nonexistent id gets, so no oracle), for both ' +
      'drive_connections and vaults. NOT PROVEN: the Drive ADDRESS-SPACE half the arc name ' +
      'implies. No Drive object is ever addressed here — ensureFolder(ownerDigest) and the ' +
      'appProperty filter in driveDataHome.ts are never exercised, because per-vault Drive ' +
      'provisioning is off in this build. What [E10-A4] shows about the namespace is only ' +
      'that two distinct account ids yield two distinct digests, which is SHA-256 ' +
      'injectivity, not a demonstration that the two namespaces stay apart in Drive. ' +
      'Promote with [E10-A9] when the provisioning flag flips.',
  },
  {
    arc: 'mixed-account full-functionality sweep',
    assertion: '[E10-A3] a vault does not degrade the normal account',
    status: 'partial',
    note:
      'PROVEN: the account stays privacyMode=normal, no portfolio is vaulted or stubbed, and ' +
      'each path in the product’s OWN paranoid kill set is reachable — shell landmark ' +
      'present, and never the safeDestination() a paranoid account would be sent to. NOT ' +
      'PROVEN: that each of those surfaces is functionally intact. It is a reachability ' +
      'sweep, not a per-feature sweep; "full functionality" is the spec line’s wording, ' +
      'not this test’s claim.',
  },
  {
    arc: 'QR handoff (mocked camera)',
    assertion: '[E10-A7] a serialized btvault1: payload opens the vault on a second device',
    status: 'covered',
    note:
      'The accepted payload is built by the product’s own serializer from this ' +
      'account’s ceremony phrase — deliberately NOT the shared golden vector, which ' +
      'names a vault no account owns and so cannot be verified against a real header. The ' +
      'golden vector and its ACCEPT siblings are pinned by qr/payload.test.ts.',
  },
  {
    arc: 'wrong-password lockout',
    assertion: '[E10-A2] five wrong device passwords, and the vault does not reopen',
    status: 'covered',
  },
  {
    arc: 'fresh-start notice after the §17 wipe',
    assertion: '[E10-A8] fresh-start notice after the §17 wipe',
    status: 'blocked',
    note: 'E9 is unbuilt and owner-gated; the arc is a documented test.fixme.',
  },
] as const;

export function apiV1(path: string): string {
  return `${API_BASE_URL}/api/v1${path}`;
}

/** Session-scoped reads/writes, same context (and therefore same cookies) as the page. */
export async function listVaultsApi(user: E2EUser): Promise<VaultConfig[]> {
  const response = await user.context.request.get(apiV1('/vaults'));
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { vaults: VaultConfig[] }).vaults;
}

export async function listDriveConnectionsApi(
  request: APIRequestContext,
): Promise<DriveConnection[]> {
  const response = await request.get(apiV1('/drive-connections'));
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { connections: DriveConnection[] }).connections;
}

/**
 * Control Center → Privacy: the ONE paranoid entry point (owner ruling
 * 2026-08-19, PROJECTPLAN §16) and the host of the E8 vault manager.
 */
export async function openPrivacyPanel(page: Page): Promise<void> {
  await page.goto('/control/privacy');
  await expect(page.getByRole('heading', { name: 'Vaults', exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** The manager's list row for one vault, addressed by its cleartext name (§21 Q4). */
export function vaultRow(page: Page, name: string): Locator {
  return page.getByRole('list', { name: 'Your vaults' }).getByRole('listitem').filter({
    hasText: name,
  });
}

/**
 * The row's state text, rendered by `vaultStateAffordance` as
 * `<media> · <state>`. Asserting the STATE string rather than the button keeps
 * the check on E8's state→affordance invariant instead of on one control.
 */
export async function expectVaultState(page: Page, name: string, state: string): Promise<void> {
  await expect(vaultRow(page, name).getByText(state, { exact: false })).toBeVisible({
    timeout: 30_000,
  });
}

export interface CeremonyResult {
  /** The 12 words, exactly as the ceremony rendered them. */
  mnemonic: string;
  vaultId: string;
}

/**
 * Drive E8's six-step creation ceremony end to end (§21 Q2: twelve words, ONE
 * verified word, one loss acknowledgment, no added friction).
 *
 * `wrongWordFirst` exercises the verify-step refusal before the correct answer:
 * the ceremony must keep the phrase and let the user retry, never restart.
 */
export async function createVaultThroughCeremony(
  user: E2EUser,
  input: { name: string; devicePassword: string; wrongWordFirst?: boolean },
): Promise<CeremonyResult> {
  const { page } = user;
  await page.getByRole('button', { name: 'Create vault', exact: true }).click();
  const ceremony = page.getByRole('region', { name: 'Create a vault' });
  await expect(ceremony).toBeVisible();

  // Step 1 — Name.
  await expect(ceremony.getByRole('heading', { name: 'Name', exact: true })).toBeVisible();
  await ceremony.locator('#vault-create-name').fill(input.name);
  await ceremony.getByRole('button', { name: 'Continue', exact: true }).click();

  // Step 2 — Storage. The build's honest refusal of Drive is asserted here, in
  // the arc that would otherwise silently pick the server medium.
  await expect(ceremony.getByRole('heading', { name: 'Storage', exact: true })).toBeVisible();
  await expectDriveProvisioningRefused(ceremony);
  await ceremony.getByRole('button', { name: 'Continue', exact: true }).click();

  // Step 3 — Recovery words.
  await expect(
    ceremony.getByRole('heading', { name: 'Recovery words', exact: true }),
  ).toBeVisible();
  const mnemonic = await readCeremonyWords(ceremony);
  await ceremony.getByRole('button', { name: 'I stored the words', exact: true }).click();

  // Step 4 — Verify exactly one randomly chosen word.
  await expect(
    ceremony.getByRole('heading', { name: 'Verify one word', exact: true }),
  ).toBeVisible();
  const answer = ceremony.locator('#vault-create-word');
  const wordNumber = await readChallengedWordNumber(ceremony);
  const words = mnemonic.split(' ');
  if (input.wrongWordFirst) {
    // Any word that is not the challenged one; `words` always holds 12 entries.
    await answer.fill(words[(wordNumber % words.length) as number] ?? 'zoo');
    await ceremony.getByRole('button', { name: 'Verify word', exact: true }).click();
    await expect(ceremony.getByText('That word does not match.', { exact: false })).toBeVisible();
    // The phrase survives a wrong answer: the same challenge is still on screen.
    expect(await readChallengedWordNumber(ceremony)).toBe(wordNumber);
  }
  await answer.fill(words[wordNumber - 1] ?? '');
  await ceremony.getByRole('button', { name: 'Verify word', exact: true }).click();

  // Step 5 — the one compact lost-phrase acknowledgment.
  await expect(
    ceremony.getByRole('heading', { name: 'Keep the words safe', exact: true }),
  ).toBeVisible();
  await ceremony.getByRole('checkbox', { name: /losing every copy of the 12 words/ }).check();
  await ceremony.getByRole('button', { name: 'Continue', exact: true }).click();

  // Step 6 — device custody. Wrapped is the default and the recommended one.
  await expect(ceremony.getByRole('heading', { name: 'This device', exact: true })).toBeVisible();
  await ceremony.locator('#vault-device-password').fill(input.devicePassword);
  await ceremony.getByRole('button', { name: 'Create vault', exact: true }).click();

  // The ceremony closes only on a committed vault; a provision failure leaves it
  // open with its own error, so this wait is the commit assertion.
  await expect(ceremony).toBeHidden({ timeout: 60_000 });
  await expect(vaultRow(page, input.name)).toBeVisible({ timeout: 30_000 });

  const vaults = await listVaultsApi(user);
  const created = vaults.find((vault) => vault.name === input.name);
  expect(created, 'the ceremony must have committed a server-side vault row').toBeTruthy();
  return { mnemonic, vaultId: created!.id };
}

/**
 * §12's state→affordance invariant applied to a capability this build does not
 * have: the Drive options are present, disabled, and say what is missing —
 * never a selectable option whose provisioning would refuse at the end.
 */
export async function expectDriveProvisioningRefused(ceremony: Locator): Promise<void> {
  const radios = ceremony.getByRole('radio');
  await expect(radios).toHaveCount(3);
  await expect(radios.nth(0)).toBeEnabled();
  await expect(radios.nth(0)).toBeChecked();
  await expect(radios.nth(1)).toBeDisabled();
  await expect(radios.nth(2)).toBeDisabled();
  await expect(
    ceremony.getByText('Drive storage for a new vault isn’t available yet', { exact: false }),
  ).toHaveCount(2);
}

async function readCeremonyWords(ceremony: Locator): Promise<string> {
  const items = await ceremony.getByRole('listitem').allInnerTexts();
  const words = items.map((item) => item.replace(/^\s*\d+\.\s*/u, '').trim()).filter(Boolean);
  expect(words, 'the ceremony must render exactly twelve words').toHaveLength(12);
  return words.join(' ');
}

/** The challenge label is `Word {{n}}`; the number is the whole challenge. */
async function readChallengedWordNumber(ceremony: Locator): Promise<number> {
  const label = await ceremony.locator('label[for="vault-create-word"]').innerText();
  const parsed = Number(/(\d+)/u.exec(label)?.[1]);
  expect(Number.isInteger(parsed) && parsed >= 1 && parsed <= 12).toBe(true);
  return parsed;
}

/**
 * End every live endpoint session. E3 keeps the unwrapped device key only in
 * memory, so a fresh document IS the lock — see the module header.
 */
export async function lockVaultsByReload(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Vaults', exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

export type VaultAccessAction =
  | 'unlock'
  | 'open'
  | 'provide-phrase'
  | 'reset-endpoint'
  | 'scan-qr'
  | 'restore';

/** The access surface is URL-addressed, exactly as `VaultStateAction` links it. */
export async function openVaultAction(
  page: Page,
  vaultId: string,
  action: VaultAccessAction,
): Promise<Locator> {
  await page.goto(
    `/control/privacy?vault=${encodeURIComponent(vaultId)}&action=${encodeURIComponent(action)}`,
  );
  const section = page.getByRole('region', { name: /access$/ });
  await expect(section).toBeVisible({ timeout: 30_000 });
  return section;
}

/**
 * One unlock attempt through the real access surface. Returns without asserting
 * the outcome so a caller can drive both the refusal ladder and the success.
 */
export async function attemptUnlock(
  page: Page,
  vaultId: string,
  devicePassword: string,
): Promise<Locator> {
  const section = await openVaultAction(page, vaultId, 'unlock');
  await section.locator(`#vault-access-secret-${vaultId}`).fill(devicePassword);
  await section.getByRole('button', { name: 'Continue', exact: true }).click();
  return section;
}

/**
 * Open E7's receiver. It is account-mode independent and sits in the Privacy
 * panel above the v1 mode split, so it is reachable on a brand-new endpoint.
 */
export async function openTransferReceiver(page: Page): Promise<Locator> {
  await openPrivacyPanel(page);
  // The transfer surface is a collapsed `<details>` fold; its body is not even
  // mounted until the summary opens it (`expanded` gates the subtree).
  await page.getByText('Transfer between devices', { exact: true }).click();
  await page.getByRole('button', { name: 'Receive transferred vault', exact: true }).click();
  const receiver = page.locator('[data-vault-transfer-screen="receiver"]');
  await expect(receiver).toBeVisible({ timeout: 30_000 });
  await receiver.getByRole('button', { name: 'Scan or paste code', exact: true }).click();
  return receiver;
}

/**
 * Feed one decoded `btvault1:` payload through the shipped scan seam and stop at
 * the parse verdict — the "mocked camera" of the spec line.
 */
export async function submitTransferPayload(receiver: Locator, payload: string): Promise<void> {
  await receiver.locator('#vault-transfer-payload').fill(payload);
  await receiver.getByRole('button', { name: 'Continue', exact: true }).click();
}

/**
 * §8's owner namespace, derived by the PRODUCT's own function in the PRODUCT's
 * own runtime.
 *
 * It is evaluated in the page rather than imported here on purpose:
 * `driveDataHome.ts` reaches `window.google` through the web app's ambient
 * `vite-env.d.ts`, which the separate `e2e/tsconfig.json` project does not (and
 * should not) include. Pulling the module into the spec's type graph would
 * either fail to compile or force that ambient file into a project it does not
 * belong to. Importing it through the dev server keeps the assertion on the real
 * derivation — a change to `DRIVE_OWNER_CONTEXT` or the digest breaks this — and
 * uses the same "Vite serves `/src/...`" fact `pd9Drive.ts` already relies on.
 */
export async function driveOwnerDigestInBrowser(page: Page, accountId: string): Promise<string> {
  const digest = await page.evaluate(
    async ({ id, specifier }) => {
      // The specifier is passed in rather than written inline so the e2e
      // TypeScript project does not try to resolve a dev-server URL as a module.
      const module = (await import(/* @vite-ignore */ specifier)) as {
        driveOwnerDigest(accountId: string): Promise<string>;
      };
      return module.driveOwnerDigest(id);
    },
    { id: accountId, specifier: '/src/user/vault/drive/driveDataHome.ts' },
  );
  expect(digest, 'the §8 owner digest must be a non-empty base64url selector').toMatch(
    /^[A-Za-z0-9_-]{16,}$/u,
  );
  return digest;
}
