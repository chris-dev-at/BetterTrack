import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// The root e2e context resolves workspace contracts by path, exactly as the PD9
// harness does — there is no `@bettertrack/contracts` alias in this tsconfig.
import type { DriveConnection, VaultConfig } from '../../packages/contracts/src/vaults';

import { API_BASE_URL, DATABASE_URL } from './config';
import type { E2EUser } from './users';

/**
 * E10-specific e2e harness — the PARANOID vault gate (the §20 row E10 arc list,
 * archived verbatim in `docs/history/paranoid-design-history.md` §D by the
 * post-E9 condensation).
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
 * `arc` quotes the §20 row E10 scope sketch verbatim — it is the CLAIM. That row
 * now lives in `docs/history/paranoid-design-history.md` §D; cite it by SECTION,
 * never by line number, which is what went stale here (the row had drifted 217
 * lines by the time anyone looked). `status`
 * and `note` are what this suite actually proves against it, which is not always
 * the same thing; `partial` entries name the missing half rather than rounding it
 * up. [E10-A0] holds the guard that keeps this table honest.
 */
export const E10_TRACEABILITY = [
  {
    arc: 'full create→move-in→lock→unlock→move-out arc',
    assertion: '[E10-A10] executable move-in and move-out',
    status: 'covered',
    note:
      'The whole arc runs for real since the E6 capture residual closed (#1525): ceremony, ' +
      'unlock through the access surface, SPA-only walk to the move-in wizard (the endpoint ' +
      'session lives in page memory), the destructive commit with the §15 step-up, the ' +
      'VAULTED_PORTFOLIO stub proof, lock by navigation, the locked-endpoint move-out ' +
      'refusal, unlock via the stub’s own §12 affordance, and the same-UUID restore of the ' +
      'recorded transaction. [E10-A1] keeps the focused ceremony/lock/unlock coverage; ' +
      '[E10-A6] keeps the unready-state refusal pinned.',
  },
  {
    arc: 'imported + owner-manual portfolio round trip (#1529)',
    assertion: '[E10-A10b] imported + manual portfolio moves in and back out losslessly',
    status: 'covered',
    note:
      'The two portfolio classes the #1528 ruling refused fail-closed — historical import ' +
      'batches and owner-manual assets — now run the A10 arc through the #1529 lossless ' +
      'read seams (the paged import-capture read and the exact manual-asset snapshot ' +
      'read). The bar is re-read identity: the applied batch’s staging rows and the manual ' +
      'asset’s value points come back byte-for-byte after move-out, and both buys restore ' +
      'under their original ids.',
  },
  {
    arc: 'Drive-only vault round trip',
    assertion: '[E10-A5] Drive storage is refused honestly, not offered',
    status: 'blocked',
    note:
      'PER_VAULT_DRIVE_PROVISIONING_AVAILABLE is false. [PD9-A3] used to cover the v1 ' +
      'account-level round trip; it is quarantined since the §16 2026-08-30 ruling retired ' +
      'the v1 enable entry point, so no Drive medium has e2e coverage today.',
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
      'names a vault no account owns and so cannot be verified against a real header. ' +
      'Since #1527/F8 the fixture’s full ACCEPT half also round-trips through the real ' +
      'scan seam (parse verdict only, for that same reason), and a structurally valid but ' +
      'WRONG f= is driven all the way through the authenticated header comparison.',
  },
  {
    arc: 'wrong-password lockout',
    assertion: '[E10-A2] five wrong device passwords, and the vault does not reopen',
    status: 'covered',
    note:
      'Every window-bound claim is anchored to the endpoint’s own `lockedUntil` rather ' +
      'than to the wall clock (#1527/F7), and re-arms through the real access surface ' +
      'when a slow runner burns the frozen window — so a throttled machine reports which ' +
      'claim it could not reach instead of timing out on a control that came back.',
  },
  {
    arc: 'fresh-start notice after the §17 wipe',
    assertion: '[E10-A8] fresh-start notice after the §17 wipe',
    status: 'covered',
    note:
      'E9 landed the transition, so the arc drives it for real: the ops export script ' +
      'dumps/verifies/attests, --confirm-offsite closes §17 step 1, and the wipe service ' +
      'performs the retirement. The notice asserted is the product of an actual §17 wipe, ' +
      'and the never-wiped control account proves it is not shown to everyone.',
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
 *
 * Still true after VAULT-UX-B, and for the SAME reason: `docs/paranoid-design.md`
 * §12 keeps K_dev memory-only and nothing persists it. What that arc adds is a
 * live handoff between OPEN TABS of one device, so this helper only locks while
 * `page` is the account's last tab — which it is in every arc that calls it.
 * The sharing (and its revocation) has its own spec, `vault-session-sharing`.
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
 * The access surface's two refusals, distinct since #1526: a lockout carries the
 * keystore's own code and deadline, so it must never read as the generic "that
 * action could not be completed" a wrong password gets.
 */
export const ACCESS_REFUSAL_COPY = 'That action could not be completed.';
export const ACCESS_LOCKOUT_COPY = 'Too many wrong device passwords.';

/**
 * E3's first lockout tier: the 5th consecutive wrong device password arms a
 * 30 s window (`keystore/core.ts` LOCKOUT_INITIAL_MS). Mirrored rather than
 * imported — `core.ts` is a browser module, and importing it for one number
 * would drag WebCrypto into the Node-side harness.
 */
export const ENDPOINT_LOCKOUT_INITIAL_MS = 30_000;

/** Headroom a window-bound claim needs before it is worth attempting. */
export const ENDPOINT_LOCKOUT_MIN_REMAINING_MS = 8_000;

export interface EndpointLockoutState {
  failures: number;
  lockedUntil: number | null;
  /** Milliseconds left on the window at the moment of the read; 0 when closed. */
  remainingMs: number;
}

/**
 * Read the endpoint's OWN persisted lockout record through the product's own
 * storage + parser.
 *
 * #1527/F7: [E10-A2] used to race the wall clock — it performed several SPA
 * loads inside a frozen 30 s window and, on a slow runner, simply ran out of
 * window and reported a confusing timeout that `retries: 1` masked. Anchoring
 * every window-bound claim to `lockedUntil` turns "the runner was slow" into a
 * named failure and lets {@link ensureLockoutWindow} re-arm instead of losing.
 *
 * Evaluated in the page rather than imported here for the reason spelled out on
 * {@link driveOwnerDigestInBrowser}: the specifiers are passed in so the e2e
 * TypeScript project never tries to resolve a dev-server URL as a module.
 */
export async function readEndpointLockout(page: Page): Promise<EndpointLockoutState> {
  return page.evaluate(
    async ({ storageSpecifier, recordsSpecifier }) => {
      const storage = (await import(/* @vite-ignore */ storageSpecifier)) as {
        createIndexedDbEndpointKeystoreStorage(): {
          readEndpointSnapshot(): Promise<{ revision: number; metadata: unknown | null }>;
        };
      };
      const records = (await import(/* @vite-ignore */ recordsSpecifier)) as {
        parseEndpointPasswordMetadata(value: unknown): {
          lockout: { failures: number; lockedUntil: number | null };
        };
      };
      const snapshot = await storage
        .createIndexedDbEndpointKeystoreStorage()
        .readEndpointSnapshot();
      if (snapshot.metadata == null) {
        throw new Error('This endpoint has no keystore password metadata yet.');
      }
      const { lockout } = records.parseEndpointPasswordMetadata(snapshot.metadata);
      return {
        failures: lockout.failures,
        lockedUntil: lockout.lockedUntil,
        remainingMs:
          lockout.lockedUntil == null ? 0 : Math.max(0, lockout.lockedUntil - Date.now()),
      };
    },
    {
      storageSpecifier: '/src/user/vault/keystore/storage.ts',
      recordsSpecifier: '/src/user/vault/keystore/records.ts',
    },
  );
}

/**
 * Guarantee a live lockout window with enough headroom for the next claim,
 * re-arming through the REAL access surface when the runner burned the last one.
 *
 * The window is frozen once armed: an attempt made inside it does not extend it
 * (`registerWrongPassword` returns the existing lockout unchanged), so a
 * nearly-closed window has to be allowed to close before a fresh refusal can
 * re-arm it at the next, longer tier. Nothing is weakened by re-arming — the
 * claim under test is "a locked-out endpoint refuses", and which failure armed
 * the lockout is not part of it.
 */
export async function ensureLockoutWindow(
  page: Page,
  vaultId: string,
  wrongPassword: string,
  minRemainingMs = ENDPOINT_LOCKOUT_MIN_REMAINING_MS,
): Promise<EndpointLockoutState> {
  const current = await readEndpointLockout(page);
  if (current.remainingMs >= minRemainingMs) return current;
  if (current.remainingMs > 0) await page.waitForTimeout(current.remainingMs + 250);

  // Past the first tier every further failure arms the next window, so this
  // refusal is itself a lockout and says so (#1526).
  const section = await attemptUnlock(page, vaultId, wrongPassword);
  await expect(
    section.getByText(ACCESS_LOCKOUT_COPY, { exact: false }),
    're-arming the lockout must itself be refused, and named as a lockout',
  ).toBeVisible({ timeout: 60_000 });

  const rearmed = await readEndpointLockout(page);
  expect(
    rearmed.remainingMs,
    'a refusal past the first tier must arm a fresh lockout window',
  ).toBeGreaterThan(0);
  return rearmed;
}

/**
 * Assert that a claim just observed was observed INSIDE the window it is about,
 * against the endpoint's own deadline rather than the test's stopwatch.
 */
export async function expectStillLockedOut(
  page: Page,
  armed: EndpointLockoutState,
  claim: string,
): Promise<void> {
  const now = await readEndpointLockout(page);
  expect(now.lockedUntil, `${claim} must be measured against the window the proof armed`).toBe(
    armed.lockedUntil,
  );
  expect(
    now.remainingMs,
    `the lockout window closed before ${claim} was observed — the runner was too slow, ` +
      'which is not evidence about the product',
  ).toBeGreaterThan(0);
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
 * It is evaluated in the page rather than imported here on purpose. The e2e
 * project can now SEE these modules — `e2e/tsconfig.json` includes the web app's
 * ambient `vite-env.d.ts` so `doubles/pd9DriveDouble.ts` can type its doubles
 * against the real interfaces (#1527) — but seeing them is not running them:
 * `driveDataHome.ts` is a browser module built on WebCrypto and `window`, and a
 * value import would execute it in the Node test process. Importing it through
 * the dev server keeps the assertion on the real derivation — a change to
 * `DRIVE_OWNER_CONTEXT` or the digest breaks this — and uses the same "Vite
 * serves `/src/...`" fact `pd9Drive.ts` already relies on.
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

/**
 * PARANOID E9 / §17 — drive the real owner-run transition against the e2e
 * database so [E10-A8] asserts the notice that a REAL wipe produced.
 *
 * The sequence is the operator's own, not a shortcut:
 *
 *   1. seed a live account-level (v1) paranoid account — the population §17
 *      exists for;
 *   2. run `scripts/ops/export-paranoid-v1-backup.mjs` as a child process, which
 *      dumps every v1 row, verifies the archive off disk and records the
 *      attestation;
 *   3. run it again with `--confirm-offsite`, which is §17's "offsite copy
 *      confirmed" and the second half of the gate;
 *   4. call `wipeParanoidV1Account` for THIS account only.
 *
 * Step 4 is scoped deliberately. The operator runner
 * (`pnpm --filter @bettertrack/api wipe:paranoid-v1 --execute`) sweeps every
 * covered account, which in a shared e2e database would reach accounts other
 * specs are using. The gate being proven here is the same either way: the
 * attestation written by the real ops script in steps 2–3 is what unlocks it,
 * and without those steps the wipe refuses.
 */
export async function runParanoidV1TransitionFor(userId: string): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');

  const { createDatabase } = await import('../../apps/api/src/data/db');
  const { eq } = await import('../../apps/api/node_modules/drizzle-orm/index.js');
  const schema = await import('../../apps/api/src/data/schema');
  const { wipeParanoidV1Account } =
    await import('../../apps/api/src/services/account/paranoidV1WipeService');

  // `import.meta.url`, not `__dirname`: the repo is ESM ("type": "module"), where
  // `__dirname` is undefined at runtime even though @types/node declares it.
  const { fileURLToPath } = await import('node:url');
  const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..');
  // Outside every git working tree — the export script refuses a repo-local
  // directory, because the archive is user ciphertext plus the ids that own it.
  const backupDir = mkdtempSync(nodePath.join(tmpdir(), 'bt-e9-e2e-'));

  const { db, client } = createDatabase(DATABASE_URL);
  try {
    // 1. A live v1 paranoid account: the mode flag, the media columns its CHECK
    //    constraint requires, and one encrypted blob to actually preserve.
    await db
      .update(schema.users)
      .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
      .where(eq(schema.users.id, userId));
    await db.insert(schema.paranoidVaults).values({
      userId,
      version: 1,
      formatVersion: 1,
      sizeBytes: 9,
      blob: Buffer.from('e9-cipher'),
    });

    const run = (args: string[]): string =>
      execFileSync('node', ['scripts/ops/export-paranoid-v1-backup.mjs', ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL, BT_PARANOID_V1_BACKUP_DIR: backupDir },
      });

    // 2. Dump + verify + attest.
    const exported = run([]);
    const file = /Wrote (\S+) \(/u.exec(exported)?.[1];
    const sha = /Archive SHA-256 : ([0-9a-f]{64})/u.exec(exported)?.[1];
    if (!file || !sha) throw new Error(`could not parse the export output:\n${exported}`);

    // 3. §17's "offsite copy confirmed". Passing the archive's own digest stands
    //    in for a faithful copy having reached its destination.
    run(['--confirm-offsite', sha, '--archive', file]);

    // 4. The wipe, which re-checks the whole gate inside its own transaction.
    const outcome = await wipeParanoidV1Account(db, userId);
    if (!outcome.ok) throw new Error(`the §17 wipe refused: ${outcome.refusal}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}
