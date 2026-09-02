import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import {
  serializeVaultTransferPayload,
  VAULT_TRANSFER_CONFORMANCE_VECTORS,
  VAULT_TRANSFER_VECTOR_FINGERPRINT,
  type VaultTransferPayload,
} from '../apps/web/src/user/vault/qr';
import {
  isParanoidKilledPath,
  safeDestination,
} from '../apps/web/src/user/vault/ui/ParanoidSurfaceGate';
import { newAdminRequestContext } from './support/adminApi';
import { withoutMatcherAriaSnapshot } from './support/artifactHygiene';
import { ACCOUNT_PASSWORD } from './support/config';
import { passwordSignIn } from './support/auth';
import { expectUserShellReady } from './support/flows';
import { assertNoPd9Secrets, type Pd9SensitiveCanary } from './support/pd9Drive';
import {
  ACCESS_LOCKOUT_COPY,
  ACCESS_REFUSAL_COPY,
  apiV1,
  attemptUnlock,
  createVaultThroughCeremony,
  E10_TRACEABILITY,
  ENDPOINT_LOCKOUT_INITIAL_MS,
  ensureLockoutWindow,
  expectStillLockedOut,
  expectVaultState,
  listDriveConnectionsApi,
  listVaultsApi,
  driveOwnerDigestInBrowser,
  lockVaultsByReload,
  openPrivacyPanel,
  openVaultAction,
  openTransferReceiver,
  readEndpointLockout,
  submitTransferPayload,
  runParanoidV1TransitionFor,
  vaultRow,
} from './support/e10';
import { assetIdFor, listTransactions, recordBuy } from './support/mirror';
import { provisionUser, provisionUserInContext, type E2EUser } from './support/users';

/**
 * PARANOID E10 — the Playwright vault gate (`docs/paranoid-design.md:959`).
 *
 * The spec line names seven arcs. Two of them cannot run against this build,
 * and each is a `test.fixme` naming the exact missing piece rather than a
 * weakened assertion:
 *
 *  1. **`test.fixme` — the fresh-start notice after the §17 wipe** needs **E9**
 *     (transition + v1 retirement), which is unbuilt and owner-gated.
 *  2. **`test.fixme` — the Drive-only vault round trip** needs per-vault Drive
 *     provisioning, which `PER_VAULT_DRIVE_PROVISIONING_AVAILABLE === false`
 *     refuses in `provisionVault.ts`. The e2e web config does not override the
 *     flag and this spec does not either; what the flag DOES ship — an honest,
 *     disabled option that names the missing epic — is asserted in [E10-A5].
 *     The account-level v1 Drive-only round trip ([PD9-A3] in
 *     `e2e/paranoid.spec.ts`) USED to carry this coverage; it is quarantined
 *     since the §16 2026-08-30 ruling retired the v1 enable entry point, so the
 *     product currently has NO Drive-medium e2e at all. Stated, not hidden.
 *
 * The former third carve-out — executable move-in / move-out — closed with the
 * E6 capture residual (#1525): [E10-A10] runs the full
 * create → move-in → lock → unlock → move-out arc for real, and [E10-A6] keeps
 * pinning that a genuinely-unready state (the target vault locked on this
 * endpoint) still refuses BEFORE the destructive request — a resolvable
 * capture engine does not mean every state is ready.
 *
 * Everything else the line names runs for real here.
 *
 * This suite joins the V5-P14 nightly by construction: `playwright.config.ts`
 * has `testDir: './e2e'` and `e2e-nightly.yml` shards the whole directory, so a
 * spec file in `e2e/` IS a member of the gate. There is no tag to opt into.
 */

// Real BIP39 phrases and real device passwords enter the DOM in every test
// below, so every secret-bearing recorder format is off.
//
// The scan each arc runs in its `finally` is NOT what keeps them out of the
// failure artifact — `error-context.md` is written later, in fixture teardown,
// and `testInfo.errors` is still empty when the scan runs. What keeps them out
// is suppression, in two halves: `PLAYWRIGHT_NO_COPY_PROMPT` (set in
// `playwright.config.ts` and the nightly) for the teardown snapshot, and
// `withoutMatcherAriaSnapshot` on every rethrow for the matcher's own. Both
// halves, the measurements behind them and the one residual channel are written
// up in `e2e/support/artifactHygiene.ts`.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

/**
 * Distinct per test so one arc's device password can never satisfy another's
 * assertion, and long enough for the receiver's `MIN_PASSWORD_LENGTH`.
 */
const DEVICE_PASSWORD = 'E10-Device-Password-2026!';
const WRONG_DEVICE_PASSWORD = 'E10-Wrong-Password-2026!';

/**
 * PD9's scan reports on a fixed canary set plus whatever the caller adds. E10
 * adds its own per-test secrets; the shared helper is reused rather than
 * duplicated so a future artifact format is covered in one place.
 */
async function assertNoE10Secrets(
  testInfo: Parameters<typeof assertNoPd9Secrets>[0],
  diagnostics: readonly string[],
  sensitive: readonly Pd9SensitiveCanary[],
  bodyFailure: unknown,
): Promise<void> {
  try {
    await assertNoPd9Secrets(testInfo, diagnostics, sensitive);
  } catch (error) {
    // A leak must never mask the real failure that produced it.
    if (bodyFailure === undefined) throw error;
    testInfo.errors.push({ message: String(error) });
  }
}

/**
 * Console/pageerror text and failed-request method+path only — never a body or
 * a query string, so the collector itself cannot become the leak it looks for.
 */
function collectSanitizedDiagnostics(page: Page, sink: string[]): void {
  page.on('console', (message) => sink.push(`console:${message.type()}:${message.text()}`));
  page.on('pageerror', (error) => sink.push(`pageerror:${error.message}`));
  page.on('requestfailed', (request) => {
    sink.push(`requestfailed:${request.method()}:${new URL(request.url()).pathname}`);
  });
}

/**
 * The conformance fixture's REJECT half, selected by shape rather than by a
 * hand-kept list: an entry carries `outcome` only if it is meant to be refused.
 * [E10-A7] indexes with this, so promoting one of its vectors to an accept
 * vector stops the spec from compiling instead of quietly leaving it asserting a
 * refusal message that can no longer appear.
 */
type VaultTransferRejectVectorName = {
  [Name in keyof typeof VAULT_TRANSFER_CONFORMANCE_VECTORS]: (typeof VAULT_TRANSFER_CONFORMANCE_VECTORS)[Name] extends {
    outcome: string;
  }
    ? Name
    : never;
}[keyof typeof VAULT_TRANSFER_CONFORMANCE_VECTORS];

/**
 * The fixture's ACCEPT half — the mirror of the type above, selected the same
 * way: an entry carries `expected` only if it is meant to parse.
 */
type VaultTransferAcceptVectorName = {
  [Name in keyof typeof VAULT_TRANSFER_CONFORMANCE_VECTORS]: (typeof VAULT_TRANSFER_CONFORMANCE_VECTORS)[Name] extends {
    expected: VaultTransferPayload;
  }
    ? Name
    : never;
}[keyof typeof VAULT_TRANSFER_CONFORMANCE_VECTORS];

interface VaultTransferAcceptVector {
  payload: string;
  expected: VaultTransferPayload;
}

/**
 * Every ACCEPT vector, enumerated from the fixture rather than transcribed
 * (#1527/F8). A vector added there is covered by the receive-seam pass below on
 * the next run; none can be forgotten, and the count assertion in [E10-A7]
 * keeps a fixture that shrinks to nothing from passing vacuously.
 */
const VAULT_TRANSFER_ACCEPT_VECTORS: ReadonlyArray<
  [VaultTransferAcceptVectorName, VaultTransferAcceptVector]
> = (
  Object.entries(VAULT_TRANSFER_CONFORMANCE_VECTORS) as Array<
    [
      keyof typeof VAULT_TRANSFER_CONFORMANCE_VECTORS,
      { payload: string; expected?: VaultTransferPayload },
    ]
  >
).filter((entry): entry is [VaultTransferAcceptVectorName, VaultTransferAcceptVector] =>
  Object.hasOwn(entry[1], 'expected'),
);

/** The phone project has its own permanent suite; these are desktop arcs. */
function skipOnPhone(testInfo: { project: { name: string } }): void {
  test.skip(
    testInfo.project.name === 'mobile-chromium',
    'E10 is the desktop per-vault gate; the phone layout has its own permanent suite.',
  );
}

test.describe('PARANOID E10 per-vault gate', () => {
  /**
   * The inventory guard, deliberately its OWN test rather than a step inside
   * [E10-A1].
   *
   * As a step it was self-defeating: the failure mode it exists to catch is an
   * arc quietly disappearing from this file, and a commit that deleted [E10-A1]
   * would have deleted the guard along with it — leaving the count unchecked and
   * the suite green. Standing alone, it survives the deletion of any arc.
   *
   * It also cross-checks each table entry against a real test title in this
   * file, so the table cannot go on naming an assertion that no longer exists.
   * No browser, no fixtures: it runs in both projects for the price of a file
   * read.
   */
  // Playwright requires the first argument to be an object destructuring
  // pattern; this test genuinely needs no fixture, hence the empty one.
  // eslint-disable-next-line no-empty-pattern
  test('[E10-A0] the E10 arc inventory stays complete', async ({}, testInfo) => {
    // The spec line names seven sub-arcs; a dropped one is the whole point.
    expect(E10_TRACEABILITY).toHaveLength(7);

    const source = await readFile(testInfo.file, 'utf8');
    const titles = [...source.matchAll(/^\s*test(?:\.fixme)?\(\s*'([^']+)'/gmu)].map(
      (match) => match[1]!,
    );
    // Sanity on the extractor itself: a regex that silently matched nothing
    // would make every assertion below vacuous.
    expect(titles.length, 'the title extractor must find this file’s tests').toBeGreaterThanOrEqual(
      E10_TRACEABILITY.length,
    );
    for (const entry of E10_TRACEABILITY) {
      // A prefix, not equality: the blocked arcs' titles carry a trailing
      // "(blocked: …)" that names the epic, which the table does not repeat.
      expect(
        titles.filter((title) => title.startsWith(entry.assertion)),
        `"${entry.arc}" names an assertion that is not a test in this file: ${entry.assertion}`,
      ).toHaveLength(1);
    }
  });

  test('[E10-A1] vault ceremony, endpoint lock and unlock', async ({
    browser,
    context,
  }, testInfo) => {
    skipOnPhone(testInfo);
    test.setTimeout(180_000);

    const diagnostics: string[] = [];
    const sensitive: Pd9SensitiveCanary[] = [
      { name: 'e10-device-password', value: DEVICE_PASSWORD },
    ];
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;

    try {
      owner = await provisionUserInContext(context, admin, 'e10arc');
      const { page } = owner;
      collectSanitizedDiagnostics(page, diagnostics);
      await openPrivacyPanel(page);

      await expect(
        page.getByText('No vaults yet.', { exact: false }),
        'a brand-new account owns no vault',
      ).toBeVisible();

      const name = `E10 Arc ${randomUUID().slice(0, 8)}`;
      const created = await createVaultThroughCeremony(owner, {
        name,
        devicePassword: DEVICE_PASSWORD,
        wrongWordFirst: true,
      });
      sensitive.push({ name: 'e10-mnemonic', value: created.mnemonic });

      await test.step('the committed vault is server-side, server-medium and open here', async () => {
        const vaults = await listVaultsApi(owner!);
        expect(vaults).toHaveLength(1);
        expect(vaults[0]!.media).toEqual(['server']);
        expect(vaults[0]!.driveConnectionId).toBeNull();
        // Cleartext by ruling (§21 Q4): the name is server-visible config.
        expect(vaults[0]!.name).toBe(name);
        await expectVaultState(page, name, 'Ready on this device');
        await expect(vaultRow(page, name).getByText('Encrypted on BetterTrack')).toBeVisible();
        await expect(
          vaultRow(page, name).getByRole('link', { name: 'Open', exact: true }),
        ).toBeVisible();
      });

      await test.step('LOCK: a fresh document ends the in-memory endpoint session', async () => {
        await lockVaultsByReload(page);
        await expectVaultState(page, name, 'Locked on this device');
        await expect(
          vaultRow(page, name).getByRole('link', { name: 'Unlock', exact: true }),
        ).toBeVisible();
        // Locking is an ENDPOINT event, never a server one: the vault row and
        // its encrypted documents are untouched.
        expect(await listVaultsApi(owner!)).toHaveLength(1);
      });

      await test.step('UNLOCK: the device password reopens the same vault', async () => {
        const section = await attemptUnlock(page, created.vaultId, DEVICE_PASSWORD);
        await expect(section).toBeHidden({ timeout: 60_000 });
        await expectVaultState(page, name, 'Ready on this device');
      });

      await test.step('the vault stays scoped to its owner', async () => {
        // Ownership scoping belongs in the repository, and the observable proof
        // is that a second account cannot address this vault id at all.
        //
        // A CONTEXT OF ITS OWN is load-bearing, not tidiness: two accounts
        // provisioned into one browser context share one cookie jar, so the
        // second registration silently replaces the first's session and both
        // "accounts" issue identical requests. That turns this assertion into a
        // tautology — and it is exactly what made [E10-A4] mint one connection
        // id for two users on the first run of this spec.
        const stranger = await provisionUser(browser, admin, 'e10stranger');
        try {
          const denied = await stranger.context.request.get(apiV1(`/vaults/${created.vaultId}`));
          expect(denied.status()).toBe(404);
          expect(await listVaultsApi(stranger)).toHaveLength(0);
          // Proof the two really are different accounts.
          expect(await accountId(stranger)).not.toBe(await accountId(owner!));
        } finally {
          await stranger.context.close();
        }
      });
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`: it prints input VALUES, this arc types a real device
      // password, and the artifact is uploaded by the nightly. See
      // `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await admin.dispose();
      } finally {
        await assertNoE10Secrets(testInfo, diagnostics, sensitive, bodyFailure);
      }
    }
  });

  test('[E10-A2] five wrong device passwords, and the vault does not reopen', async ({
    context,
  }, testInfo) => {
    skipOnPhone(testInfo);
    test.setTimeout(240_000);

    const diagnostics: string[] = [];
    const sensitive: Pd9SensitiveCanary[] = [
      { name: 'e10-device-password', value: DEVICE_PASSWORD },
      { name: 'e10-wrong-device-password', value: WRONG_DEVICE_PASSWORD },
    ];
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;

    try {
      owner = await provisionUserInContext(context, admin, 'e10lockout');
      const { page } = owner;
      collectSanitizedDiagnostics(page, diagnostics);
      await openPrivacyPanel(page);

      const name = `E10 Lockout ${randomUUID().slice(0, 8)}`;
      const created = await createVaultThroughCeremony(owner, {
        name,
        devicePassword: DEVICE_PASSWORD,
      });
      sensitive.push({ name: 'e10-mnemonic', value: created.mnemonic });
      await lockVaultsByReload(page);
      await expectVaultState(page, name, 'Locked on this device');

      await test.step('POSITIVE CONTROL: the correct password opens it right now', async () => {
        // Without this, the six refusals below discriminate nothing: a typo in
        // DEVICE_PASSWORD, a broken fill, or an unlock surface that refuses
        // everything would produce exactly the same six refusals and the same
        // green run. Establishing the open FIRST is what turns them into
        // evidence about the lockout rather than about the harness.
        const section = await attemptUnlock(page, created.vaultId, DEVICE_PASSWORD);
        await expect(section).toBeHidden({ timeout: 60_000 });
        await expectVaultState(page, name, 'Ready on this device');
        // Re-lock, so the ladder below starts from the same state it did before.
        await lockVaultsByReload(page);
        await expectVaultState(page, name, 'Locked on this device');
      });

      // E3's ladder: failures 1-4 refuse without a delay, the 5th arms the
      // 30 s lockout (`keystore/core.ts` LOCKOUT_FIRST_FAILURE = 5). The
      // successful open above resets the failure counter, so the ladder starts
      // from zero exactly as it would on a fresh endpoint.
      await test.step('four refusals never open the vault', async () => {
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          const section = await attemptUnlock(page, created.vaultId, WRONG_DEVICE_PASSWORD);
          await expect(
            section.getByText(ACCESS_REFUSAL_COPY, { exact: false }),
            `attempt ${attempt} must be refused`,
          ).toBeVisible({ timeout: 60_000 });
          // The refusal is not a partial open: the row never claims readiness.
          await expect(page.getByText('Ready on this device')).toHaveCount(0);
        }
        await openPrivacyPanel(page);
        await expectVaultState(page, name, 'Locked on this device');
        await expect(
          vaultRow(page, name).getByRole('link', { name: 'Unlock', exact: true }),
          'four failures must not yet withdraw the unlock affordance',
        ).toBeVisible();
      });

      await test.step('[E10-A2 proof] the fifth failure arms the lockout', async () => {
        const section = await attemptUnlock(page, created.vaultId, WRONG_DEVICE_PASSWORD);
        // #1526: the refusal that ARMS the lockout says so, with the instant the
        // endpoint accepts a password again — not the generic wrong-password
        // copy the four attempts above got.
        const armedNotice = section.getByText(ACCESS_LOCKOUT_COPY, { exact: false });
        await expect(armedNotice).toBeVisible({ timeout: 60_000 });
        expect(
          (await armedNotice.textContent()) ?? '',
          'the lockout copy must carry its retry time',
        ).toMatch(/\d{1,2}:\d{2}/);
        await expect(section.getByText(ACCESS_REFUSAL_COPY, { exact: false })).toHaveCount(0);

        // The window is read from E3's OWN persisted record rather than inferred
        // from the wall clock. That is the #1527/F7 repair: every claim below
        // names the deadline it was taken inside, so a slow runner reports "the
        // window closed first" instead of timing out on a control that had
        // legitimately come back.
        const armed = await readEndpointLockout(page);
        expect(armed.failures, 'the fifth consecutive refusal is what arms it').toBe(5);
        expect(armed.remainingMs, 'the fifth refusal must arm a live window').toBeGreaterThan(0);
        expect(armed.remainingMs).toBeLessThanOrEqual(ENDPOINT_LOCKOUT_INITIAL_MS);
      });

      await test.step('THE assertion: no password — right or wrong — is taken while it lasts', async () => {
        // The whole point of a lockout, and it is taken FIRST now: it used to
        // run after three further SPA loads inside the frozen 30 s window
        // (#1527/F7). One navigation is deliberate — a fresh document is also
        // what proves the lockout is not an in-memory counter a refresh clears;
        // E3 persists `{ failures, lockedUntil }` in the endpoint keystore.
        //
        // Since #1526 the deep link is reconciled against that record, so the
        // form the CORRECT password would go into is not rendered at all: the
        // URL-addressed surface answers with the same wait-or-reset affordance
        // the row offers. "The right password is still refused inside the
        // window" is E3's own claim and stays pinned in `keystore.test.ts`;
        // what this arc proves is that the surface never invites it.
        const live = await ensureLockoutWindow(page, created.vaultId, WRONG_DEVICE_PASSWORD);
        const section = await openVaultAction(page, created.vaultId, 'unlock');
        await expect(
          section.getByText(ACCESS_LOCKOUT_COPY, { exact: false }),
          'a locked-out unlock deep link must name the lockout',
        ).toBeVisible({ timeout: 60_000 });
        await expect(
          section.locator(`#vault-access-secret-${created.vaultId}`),
          'no live password field may be offered inside the window',
        ).toHaveCount(0);
        await expect(section.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
        await expect(
          section.getByRole('link', { name: 'Reset this device', exact: true }),
        ).toBeVisible();
        await expect(page.getByText('Ready on this device')).toHaveCount(0);
        await expectStillLockedOut(page, live, 'the withdrawn unlock form');
      });

      await test.step('the lockout withdraws the unlock affordance while it lasts', async () => {
        // The state→affordance invariant carries the lockout: E3 projects
        // `wait-or-reset`, and E8 must therefore stop offering "Unlock".
        const live = await ensureLockoutWindow(page, created.vaultId, WRONG_DEVICE_PASSWORD);
        await openPrivacyPanel(page);
        await expectVaultState(page, name, 'Locked on this device');
        await expect(
          vaultRow(page, name).getByRole('link', { name: 'Reset this device', exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          vaultRow(page, name).getByRole('link', { name: 'Unlock', exact: true }),
        ).toHaveCount(0);
        await expect(page.getByText('Ready on this device')).toHaveCount(0);
        await expectStillLockedOut(page, live, 'the withdrawn unlock affordance');
      });

      await test.step('the lockout is an endpoint fact, not a server one', async () => {
        // No server call can be made to hold this state, and none does: the
        // vault row is untouched and a second endpoint is unaffected.
        const vaults = await listVaultsApi(owner!);
        expect(vaults).toHaveLength(1);
        expect(vaults[0]!.id).toBe(created.vaultId);
      });
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`: it prints input VALUES, this arc types a real device
      // password, and the artifact is uploaded by the nightly. See
      // `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await admin.dispose();
      } finally {
        await assertNoE10Secrets(testInfo, diagnostics, sensitive, bodyFailure);
      }
    }
  });

  test('[E10-A3] a vault does not degrade the normal account', async ({ context }, testInfo) => {
    skipOnPhone(testInfo);
    test.setTimeout(240_000);

    const diagnostics: string[] = [];
    const sensitive: Pd9SensitiveCanary[] = [
      { name: 'e10-device-password', value: DEVICE_PASSWORD },
    ];
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;

    try {
      owner = await provisionUserInContext(context, admin, 'e10mixed');
      const { page } = owner;
      collectSanitizedDiagnostics(page, diagnostics);
      await openPrivacyPanel(page);

      const name = `E10 Mixed ${randomUUID().slice(0, 8)}`;
      const created = await createVaultThroughCeremony(owner, {
        name,
        devicePassword: DEVICE_PASSWORD,
      });
      sensitive.push({ name: 'e10-mnemonic', value: created.mnemonic });

      await test.step('owning a vault does not make the ACCOUNT paranoid', async () => {
        // The E2 un-kill: per-portfolio vaults replaced the account-wide rail,
        // so an account that merely owns a vault keeps every server feature.
        const me = await owner!.context.request.get(apiV1('/auth/me'));
        expect(me.ok(), await me.text()).toBeTruthy();
        expect(((await me.json()) as { privacyMode?: string }).privacyMode).toBe('normal');
      });

      await test.step('every surface paranoid mode would kill is shell-ready and off the fallback', async () => {
        // WHAT THIS CHECKS, precisely: for each path the product itself calls
        // killable, the page reaches its shell landmark and does NOT land on the
        // paranoid fallback. That is a REACHABILITY sweep. It is not the spec
        // line's "full-functionality sweep" — no feature on any of these pages
        // is exercised, and this step would not notice one that rendered its
        // shell and then failed. The honest scope is recorded against the arc in
        // `E10_TRACEABILITY`; do not let this step's name drift back up to the
        // spec line's wording.
        //
        // The sweep is defined by the PRODUCT's own kill list rather than by a
        // hand-picked page list: `isParanoidKilledPath` is the predicate
        // `ParanoidSurfaceGate` redirects on, and `paranoid.spec.ts` proves each
        // of these lands on a fallback for a paranoid ACCOUNT. Owning a vault
        // must do none of that, so every one is asserted twice — the product
        // still calls it killable, and it still does not redirect here.
        //
        // Landing is asserted by the shell landmark plus the ONE destination
        // that would prove a regression: `safeDestination(path)` is where the
        // gate sends a paranoid account, so a normal account arriving there is
        // the leak. Plain "must not redirect" is deliberately NOT asserted —
        // several of these are ordinary router aliases that redirect for
        // everyone (`/people/profile` → `/control/profile`), and failing on that
        // would be this spec mis-reading a rename as a privacy bug.
        const killable: ReadonlyArray<{ path: string; shell: boolean }> = [
          { path: '/portfolio/import', shell: true },
          { path: '/people/shared', shell: true },
          { path: '/people/profile', shell: true },
          { path: '/portfolio/people', shell: true },
          { path: '/assets/news', shell: true },
          { path: '/social/my-shared', shell: true },
          // The tax print view is a `FullScreenRoute` by design (§13.5 V5-P4b:
          // a chrome-free document), so it carries no shell landmark at all.
          { path: '/portfolio/tax/print', shell: false },
        ];
        for (const { path, shell } of killable) {
          expect(
            isParanoidKilledPath(path),
            `${path} must still be in the paranoid kill set for this contrast to mean anything`,
          ).toBe(true);
          await page.goto(path);
          if (shell) await expectUserShellReady(page);
          expect(
            new URL(page.url()).pathname,
            `${path} must not land on the paranoid fallback for a normal account`,
          ).not.toBe(safeDestination(path));
        }
      });

      await test.step('no portfolio is locked, so no stub renders', async () => {
        await page.goto('/portfolio');
        await expect(page.getByTestId('locked-portfolio-stub')).toHaveCount(0);
        const portfolios = await owner!.context.request.get(apiV1('/portfolios'));
        expect(portfolios.ok(), await portfolios.text()).toBeTruthy();
        const body = (await portfolios.json()) as {
          portfolios: Array<{ vaultId: string | null }>;
        };
        expect(body.portfolios.length).toBeGreaterThan(0);
        expect(body.portfolios.every((portfolio) => portfolio.vaultId == null)).toBe(true);
      });

      await test.step('and the vault is still there, listed with no members', async () => {
        await openPrivacyPanel(page);
        await expect(
          vaultRow(page, name).getByText('No portfolios in this vault yet.'),
        ).toBeVisible();
      });
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`: it prints input VALUES, this arc types a real device
      // password, and the artifact is uploaded by the nightly. See
      // `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await admin.dispose();
      } finally {
        await assertNoE10Secrets(testInfo, diagnostics, sensitive, bodyFailure);
      }
    }
  });

  test('[E10-A4] one Google identity, two accounts, no shared reach', async ({
    browser,
  }, testInfo) => {
    skipOnPhone(testInfo);
    test.setTimeout(180_000);

    const diagnostics: string[] = [];
    const admin = await newAdminRequestContext(newRequestContext);
    let alice: E2EUser | null = null;
    let bob: E2EUser | null = null;
    let bodyFailure: unknown;

    try {
      // One context per account. Sharing the fixture context shares the cookie
      // jar, which would make every "two accounts" assertion below vacuous.
      alice = await provisionUser(browser, admin, 'e10drivea');
      bob = await provisionUser(browser, admin, 'e10driveb');
      collectSanitizedDiagnostics(alice.page, diagnostics);
      collectSanitizedDiagnostics(bob.page, diagnostics);

      // ONE Google identity, connected by two different BetterTrack accounts —
      // the "two users, one Drive" premise. No Google is involved: §22 forbids
      // a server-held Drive token, so the create contract is identity-only.
      const googleSub = `e10-${randomUUID()}`;
      const email = `e10.shared.drive.${randomUUID().slice(0, 8)}@example.test`;

      const connections: Record<'alice' | 'bob', string> = { alice: '', bob: '' };
      for (const [label, user] of [
        ['alice', alice],
        ['bob', bob],
      ] as const) {
        const created = await user.context.request.post(apiV1('/drive-connections'), {
          data: { googleSub, email, displayName: null },
          headers: { 'X-Requested-With': 'BetterTrack' },
        });
        expect(created.status(), await created.text()).toBe(201);
        connections[label] = (
          (await created.json()) as { connection: { id: string } }
        ).connection.id;
      }

      await test.step('the same Google account yields two independent connections', async () => {
        expect(connections.alice).not.toBe(connections.bob);
        const [aliceList, bobList] = await Promise.all([
          listDriveConnectionsApi(alice!.context.request),
          listDriveConnectionsApi(bob!.context.request),
        ]);
        expect(aliceList.map((connection) => connection.id)).toEqual([connections.alice]);
        expect(bobList.map((connection) => connection.id)).toEqual([connections.bob]);
      });

      await test.step("neither account can address the other's connection", async () => {
        // Ownership scoping in the repository, observed from outside: a wrong
        // owner gets the same NOT_FOUND a nonexistent id gets — no oracle.
        const verified = await bob!.context.request.patch(
          apiV1(`/drive-connections/${connections.alice}/verified`),
          { data: {}, headers: { 'X-Requested-With': 'BetterTrack' } },
        );
        expect(verified.status()).toBe(404);
        const removed = await bob!.context.request.delete(
          apiV1(`/drive-connections/${connections.alice}`),
          { headers: { 'X-Requested-With': 'BetterTrack' } },
        );
        expect(removed.status()).toBe(404);

        // And the refused call changed nothing.
        expect(await listDriveConnectionsApi(alice!.context.request)).toHaveLength(1);
      });

      await test.step('[E10-A4 proof] one Drive, two disjoint §8 namespaces', async () => {
        // Even sharing one Drive, the two accounts never address one object:
        // every vault object is selected by `ownerDigest`, derived from the
        // BetterTrack account id — not from the Google identity. This is the
        // product's own function, so a change to the derivation breaks here.
        const aliceId = await accountId(alice!);
        const bobId = await accountId(bob!);
        expect(aliceId).not.toBe(bobId);
        const aliceDigest = await driveOwnerDigestInBrowser(alice!.page, aliceId);
        const bobDigest = await driveOwnerDigestInBrowser(alice!.page, bobId);
        expect(aliceDigest).not.toBe(bobDigest);
        // Deterministic, so a per-run digest cannot pass by accident.
        expect(await driveOwnerDigestInBrowser(bob!.page, aliceId)).toBe(aliceDigest);
      });

      await test.step("and neither can read the other's vaults", async () => {
        await openPrivacyPanel(alice!.page);
        const name = `E10 Isolation ${randomUUID().slice(0, 8)}`;
        const created = await createVaultThroughCeremony(alice!, {
          name,
          devicePassword: DEVICE_PASSWORD,
        });
        expect(await listVaultsApi(bob!)).toHaveLength(0);
        const denied = await bob!.context.request.get(apiV1(`/vaults/${created.vaultId}`));
        expect(denied.status()).toBe(404);
      });
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`: it prints input VALUES, this arc types a real device
      // password, and the artifact is uploaded by the nightly. See
      // `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await admin.dispose();
      } finally {
        await assertNoE10Secrets(
          testInfo,
          diagnostics,
          [{ name: 'e10-device-password', value: DEVICE_PASSWORD }],
          bodyFailure,
        );
      }
    }
  });

  test('[E10-A5] Drive storage is refused honestly, not offered', async ({ context }, testInfo) => {
    skipOnPhone(testInfo);
    test.setTimeout(120_000);

    const diagnostics: string[] = [];
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;

    try {
      owner = await provisionUserInContext(context, admin, 'e10driveoff');
      const { page } = owner;
      collectSanitizedDiagnostics(page, diagnostics);
      await openPrivacyPanel(page);

      // The CARVE-OUT, asserted rather than assumed. A build that flipped
      // PER_VAULT_DRIVE_PROVISIONING_AVAILABLE would fail here, which is the
      // signal to promote the fixme below into a real round trip.
      await page.getByRole('button', { name: 'Create vault', exact: true }).click();
      const ceremony = page.getByRole('region', { name: 'Create a vault' });
      await ceremony.locator('#vault-create-name').fill('E10 Drive refusal');
      await ceremony.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(ceremony.getByRole('heading', { name: 'Storage', exact: true })).toBeVisible();

      const radios = ceremony.getByRole('radio');
      await expect(radios).toHaveCount(3);
      await expect(radios.nth(1), 'BetterTrack + Google Drive').toBeDisabled();
      await expect(radios.nth(2), 'Google Drive only').toBeDisabled();
      await expect(
        ceremony.getByText('Drive storage for a new vault isn’t available yet', { exact: false }),
        'a disabled option must SAY what is missing (§12: no silent dead control)',
      ).toHaveCount(2);
      // The server medium is preselected, so Continue is never blocked: the
      // ceremony offers a next step, it does not strand the user.
      await expect(ceremony.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`: it prints input VALUES, this arc types a real device
      // password, and the artifact is uploaded by the nightly. See
      // `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await admin.dispose();
      } finally {
        await assertNoE10Secrets(testInfo, diagnostics, [], bodyFailure);
      }
    }
  });

  /**
   * [E10-A11] — the #1354 ORDERING property, carried over to the surface that
   * still exists.
   *
   * #1354 ruled that the storage/medium consent is collected BEFORE the
   * passphrase, so it can never be asked for after the point of no return. It
   * was asserted on the account-level enable wizard, whose entry point the §16
   * 2026-08-30 ruling retired (see `V1_ENABLE_ENTRY_RETIRED` in
   * `e2e/paranoid.spec.ts`) — so the assertion moves to the per-portfolio
   * ceremony, which is the ceremony a user can actually reach.
   *
   * The property survives the move intact and is, if anything, stronger here:
   * `VaultCreationCeremony.nextFromMedia()` generates the seed phrase only
   * after the medium is settled, so at the storage step no key material exists
   * at all — not merely "is not on screen yet". The Drive-CONSENT half of
   * #1354 cannot be asserted on this path because per-vault Drive is off at
   * build level; [E10-A5] pins that it is refused honestly instead, and the
   * account-level consent ordering is the fixme below.
   */
  test('[E10-A11] storage is chosen before any key material exists', async ({
    context,
  }, testInfo) => {
    skipOnPhone(testInfo);
    test.setTimeout(120_000);

    const diagnostics: string[] = [];
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;

    try {
      owner = await provisionUserInContext(context, admin, 'e10consent');
      const { page } = owner;
      collectSanitizedDiagnostics(page, diagnostics);
      await openPrivacyPanel(page);

      await test.step('the retired account-level entry is gone, not merely unused', async () => {
        // The §16 ruling's own regression pin. "Set up" also exists in the
        // first-run security step, so this asserts the count on THIS panel
        // rather than assuming the string is unique app-wide.
        await expect(page.getByRole('button', { name: 'Set up', exact: true })).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: 'Create vault', exact: true }),
          'the per-portfolio ceremony is what a normal account is offered instead',
        ).toBeVisible();
      });

      await page.getByRole('button', { name: 'Create vault', exact: true }).click();
      const ceremony = page.getByRole('region', { name: 'Create a vault' });
      await expect(ceremony.getByText('Step 1 of 6')).toBeVisible();
      await ceremony.locator('#vault-create-name').fill('E10 ordering');
      await ceremony.getByRole('button', { name: 'Continue', exact: true }).click();

      await test.step('[E10-A11 proof] storage is step 2 and NO secret exists yet', async () => {
        // The ordering IS the security property, so it is asserted as an
        // ordering: the medium is on screen while neither the recovery words
        // nor the device password exist anywhere in the DOM.
        await expect(ceremony.getByText('Step 2 of 6')).toBeVisible();
        await expect(ceremony.getByRole('heading', { name: 'Storage', exact: true })).toBeVisible();
        await expect(
          ceremony.getByRole('radio'),
          'the storage choice must be offered here',
        ).toHaveCount(3);
        await expect(
          ceremony.locator('ol li'),
          'the recovery words must NOT exist before the storage choice is settled',
        ).toHaveCount(0);
        await expect(
          ceremony.locator('#vault-device-password'),
          'the device password must NOT be collectable before the storage choice',
        ).toHaveCount(0);
      });

      await test.step('the key material follows, and only then', async () => {
        await ceremony.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(ceremony.getByText('Step 3 of 6')).toBeVisible();
        await expect(
          ceremony.getByRole('heading', { name: 'Recovery words', exact: true }),
        ).toBeVisible();
        await expect(ceremony.locator('ol li')).toHaveCount(12);
        // Still nothing irreversible: the vault is created at step 6, and the
        // words are only ever displayed once the medium is decided.
        await expect(ceremony.locator('#vault-device-password')).toHaveCount(0);
      });

      await test.step('and walking the ceremony changed nothing', async () => {
        // Reaching the words and leaving must create no vault — the commit is
        // the only thing that does.
        await page.goto('/portfolio');
        await expectUserShellReady(page);
        expect(await listVaultsApi(owner!)).toHaveLength(0);
        const me = await owner!.context.request.get(apiV1('/auth/me'));
        expect(((await me.json()) as { privacyMode?: string }).privacyMode).toBe('normal');
      });
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`: it prints input VALUES, and the artifact is
      // uploaded by the nightly. See `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await admin.dispose();
      } finally {
        await assertNoE10Secrets(testInfo, diagnostics, [], bodyFailure);
      }
    }
  });

  /**
   * CARVE-OUT 3 — the ACCOUNT-LEVEL half of #1354's ordering.
   *
   * "Drive consent is collected before the passphrase" was proven end to end on
   * the v1 enable wizard until its entry point was retired (§16, 2026-08-30);
   * the wizard component still exists and `POST /vault/enable` still serves the
   * accounts that already took it, but nothing renders it, so there is nothing
   * to drive. [E10-A11] above keeps the ORDERING property alive on the
   * per-portfolio ceremony. Promote this only if the account-level entry
   * returns; otherwise it retires with the v1 stack in §17/§19.
   */
  test.fixme('[E10-A11b] account-level Drive consent precedes the passphrase (blocked: the v1 enable entry point is retired)', () => {
    // Intentionally empty: see the block comment above.
  });

  /**
   * CARVE-OUT 2 — needs per-vault Drive provisioning.
   *
   * `PER_VAULT_DRIVE_PROVISIONING_AVAILABLE` (apps/web/src/user/vault/capabilities.ts)
   * is `false`, and `provisionVault.ts` refuses any `media` containing `drive`,
   * so no per-vault Drive document can be written to round-trip. The e2e web
   * config sets only `googleDriveClientId`; it does not override the flag, and
   * neither does this spec — a test that flipped it would be exercising a build
   * that does not exist. Promote this when E5's per-connection data home lands
   * the provisioning path (#1415); [E10-A5] fails the moment the flag flips,
   * which is the reminder. The account-level v1 Drive-only round trip is
   * covered today by [PD9-A3] in `e2e/paranoid.spec.ts`.
   */
  test.fixme('[E10-A9] Drive-only vault round trip (blocked: PER_VAULT_DRIVE_PROVISIONING_AVAILABLE === false)', () => {
    // Intentionally empty: see the block comment above.
  });

  test('[E10-A6] the move wizards refuse before the destructive request', async ({
    context,
  }, testInfo) => {
    skipOnPhone(testInfo);
    test.setTimeout(180_000);

    const diagnostics: string[] = [];
    const sensitive: Pd9SensitiveCanary[] = [
      { name: 'e10-device-password', value: DEVICE_PASSWORD },
    ];
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;

    try {
      owner = await provisionUserInContext(context, admin, 'e10move');
      const { page } = owner;
      collectSanitizedDiagnostics(page, diagnostics);
      await openPrivacyPanel(page);

      const name = `E10 Move ${randomUUID().slice(0, 8)}`;
      const created = await createVaultThroughCeremony(owner, {
        name,
        devicePassword: DEVICE_PASSWORD,
      });
      sensitive.push({ name: 'e10-mnemonic', value: created.mnemonic });

      const portfolios = await owner.context.request.get(apiV1('/portfolios'));
      expect(portfolios.ok(), await portfolios.text()).toBeTruthy();
      const portfolioId = ((await portfolios.json()) as { portfolios: Array<{ id: string }> })
        .portfolios[0]!.id;

      // Watch for the destructive call itself. The precondition is only
      // meaningful if it stops the REQUEST, not merely the happy-path button.
      const destructive: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (/\/vault\/move-(in|out)/u.test(path)) destructive.push(`${request.method()} ${path}`);
      });

      await test.step('a locked target vault is stated as a blocking step and stays blocked', async () => {
        // The full-page navigation IS the lock: E3 keeps the unwrapped device
        // key only in memory, so the settings page opens with the freshly
        // created vault locked on this endpoint — a genuinely-unready state
        // even though the E6 capture engine resolves (#1525).
        await page.goto(`/portfolio/settings?portfolio=${encodeURIComponent(portfolioId)}`);
        await page.getByRole('button', { name: 'Move into vault', exact: true }).click();
        const wizard = page.getByRole('region', { name: 'Move portfolio into a vault' });
        await expect(wizard).toBeVisible({ timeout: 30_000 });
        await wizard.getByLabel('Target vault').selectOption(created.vaultId);
        await expect(
          wizard.getByText('Open the target vault on this device', { exact: false }),
          'the locked-vault precondition must be stated, not hidden',
        ).toBeVisible();
        await expect(
          wizard.getByRole('link', { name: 'Unlock', exact: true }),
          'a precondition is a fixable step, never a dead end',
        ).toBeVisible();
        await wizard.locator(`#vault-move-credential-in`).fill('E10-Account-Password-Placeholder');

        // ATTEMPT THE COMMIT, do not merely look at it.
        //
        // As a plain `toBeDisabled()` this arc never tried to move anything, so
        // the request listener above could not have fired under any behaviour
        // and `destructive` was decorative — it would read empty on a build that
        // had lost the precondition entirely.
        //
        // Click-if-enabled / assert-disabled-otherwise fixes that. On `main` the
        // else branch runs and asserts the refusal. On the regression this arc
        // exists to catch — a build where the locked-vault precondition stops
        // disabling the commit — the button IS enabled, the click really
        // happens, the client really issues `POST …/vault/move-in`, and the
        // listener is what catches it. Force-clicking the disabled button
        // instead would prove nothing: browsers do not dispatch click events on
        // a disabled control, so it is a no-op by construction.
        const commit = wizard.getByRole('button', { name: 'Move into vault', exact: true });
        if (await commit.isEnabled()) {
          await commit.click();
        } else {
          await expect(
            commit,
            'the destructive commit must stay disabled while the target vault is locked',
          ).toBeDisabled();
        }
      });

      await test.step('nothing destructive was attempted', async () => {
        // A request the click DID start needs a window to reach the network
        // before absence is asserted. The move-in commit is a single fetch off
        // the click handler, so this is far more than it needs; it bounds the
        // "nothing happened" claim instead of leaving it to a race.
        await page.waitForTimeout(2_000);
        expect(destructive, 'no move-in/move-out request may be issued').toEqual([]);
        // And the portfolio is untouched: still server-readable, still unvaulted.
        const after = await owner!.context.request.get(apiV1('/portfolios'));
        const body = (await after.json()) as { portfolios: Array<{ vaultId: string | null }> };
        expect(body.portfolios.every((portfolio) => portfolio.vaultId == null)).toBe(true);
      });
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`: it prints input VALUES, this arc types a real device
      // password, and the artifact is uploaded by the nightly. See
      // `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await admin.dispose();
      } finally {
        await assertNoE10Secrets(testInfo, diagnostics, sensitive, bodyFailure);
      }
    }
  });

  /**
   * The full §9/§10 arc, executable since the E6 capture residual closed
   * (#1525): create → move-in → lock → unlock → move-out, driven entirely
   * through the product's own wizards and access surfaces. Two properties are
   * load-bearing throughout:
   *
   *  - The keystore session lives ONLY in page memory, so any full-page
   *    navigation locks the vault. Move-in therefore exercises the
   *    state→affordance invariant for real: the wizard states the locked
   *    precondition, its own Unlock link (an SPA navigation) clears it, and
   *    history-back returns to a wizard whose commit finally opens.
   *  - Both destructive commits carry the §15 step-up in the body; the arc
   *    types the real account password into the product's own field.
   *
   * On what "the data survived" means here: BOTH ways, since the E6 store
   * resolver was wired into the workspace (#1416).
   *
   *  - DIRECTLY: with the vault unlocked, the portfolio renders in place and
   *    the SAP.DE buy is on screen with its quantity. The server has already
   *    hard-deleted those rows and refuses to serve them (asserted above), so
   *    every figure in that table was decrypted and derived on this device.
   *    The step also runs A6's request listener in reverse — the client store
   *    must not so much as ASK the server for the portfolio's money.
   *  - INDIRECTLY: move-in hard-deletes the server rows, so the same-UUID
   *    `quantity`/`price` fields asserted after move-out can only have come
   *    from the encrypted document, re-authored by the client engine.
   */
  test('[E10-A10] executable move-in and move-out', async ({ context }, testInfo) => {
    skipOnPhone(testInfo);
    test.setTimeout(420_000);

    const diagnostics: string[] = [];
    const sensitive: Pd9SensitiveCanary[] = [
      { name: 'e10-device-password', value: DEVICE_PASSWORD },
    ];
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;

    try {
      owner = await provisionUserInContext(context, admin, 'e10a10');
      const { page } = owner;
      collectSanitizedDiagnostics(page, diagnostics);

      const portfolios = await owner.context.request.get(apiV1('/portfolios'));
      expect(portfolios.ok(), await portfolios.text()).toBeTruthy();
      const portfolioId = ((await portfolios.json()) as { portfolios: Array<{ id: string }> })
        .portfolios[0]!.id;

      // A portfolio with real money rows, so the round trip proves content —
      // not just membership flags.
      const assetId = await assetIdFor(owner, 'SAP', 'SAP.DE');
      const transactionId = await recordBuy(owner, portfolioId, {
        assetId,
        quantity: 2,
        price: 100,
      });

      await openPrivacyPanel(page);
      const name = `E10 A10 ${randomUUID().slice(0, 8)}`;
      const created = await createVaultThroughCeremony(owner, {
        name,
        devicePassword: DEVICE_PASSWORD,
      });
      sensitive.push({ name: 'e10-mnemonic', value: created.mnemonic });

      const vaultedState = async (): Promise<string | null> => {
        const after = await owner!.context.request.get(apiV1('/portfolios'));
        const body = (await after.json()) as {
          portfolios: Array<{ id: string; vaultId: string | null }>;
        };
        return body.portfolios.find((portfolio) => portfolio.id === portfolioId)?.vaultId ?? null;
      };

      await test.step('MOVE-IN through the wizard on an unlocked endpoint', async () => {
        // Unlock FIRST through the real access surface. The endpoint session
        // lives only in page memory, so every navigation from here to the
        // commit must be an SPA transition — a page load would relock it.
        const access = await attemptUnlock(page, created.vaultId, DEVICE_PASSWORD);
        await expect(access).toBeHidden({ timeout: 60_000 });
        await expectVaultState(page, name, 'Ready on this device');

        // Leave the Control Center popup the product's own way (SPA), then
        // walk the product's own path to portfolio settings: shell rail →
        // workspace → switcher → settings.
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('link', { name: 'Portfolio', exact: true }).first().click();
        await page.getByRole('button', { name: 'Switch portfolio' }).click();
        await page.getByRole('link', { name: 'Portfolio settings', exact: true }).click();

        await page.getByRole('button', { name: 'Move into vault', exact: true }).click();
        const wizard = page.getByRole('region', { name: 'Move portfolio into a vault' });
        await expect(wizard).toBeVisible({ timeout: 30_000 });
        await wizard.getByLabel('Target vault').selectOption(created.vaultId);
        // The unready-state precondition [E10-A6] pins must NOT appear on an
        // unlocked endpoint — the capture resolving plus an open vault is the
        // ready state.
        await expect(
          wizard.getByText('Open the target vault on this device', { exact: false }),
        ).toBeHidden();
        await wizard.locator('#vault-move-credential-in').fill(ACCOUNT_PASSWORD);
        await wizard.getByRole('button', { name: 'Move into vault', exact: true }).click();

        // The capture writes + verifies + attests before the destructive
        // commit; give the whole §9 pipeline a real budget.
        await expect
          .poll(vaultedState, { timeout: 120_000, intervals: [1_000] })
          .toBe(created.vaultId);
      });

      await test.step('the vaulted portfolio is a content-free stub server-side', async () => {
        const refused = await owner!.context.request.get(
          apiV1(`/portfolios/${portfolioId}/transactions`),
        );
        expect(refused.ok()).toBe(false);
        expect(await refused.text()).toContain('VAULTED_PORTFOLIO');
      });

      await test.step('LOCK, and the stub refuses move-out from a locked endpoint', async () => {
        // The full-page navigation IS the lock (E3 memory-only session).
        await page.goto(`/portfolio?portfolio=${encodeURIComponent(portfolioId)}`);
        const stub = page.getByTestId('locked-portfolio-stub');
        await expect(stub).toBeVisible({ timeout: 30_000 });
        await stub.getByRole('button', { name: 'Restore as a normal portfolio' }).click();
        const wizard = page.getByRole('region', { name: 'Move portfolio out of the vault' });
        await expect(wizard).toBeVisible({ timeout: 30_000 });
        await expect(
          wizard.getByText('Unlock this vault on this device', { exact: false }),
        ).toBeVisible();
        await wizard
          .getByRole('checkbox', { name: /portfolio becomes server-readable again/i })
          .check();
        await wizard.locator('#vault-move-credential-out').fill(ACCOUNT_PASSWORD);
        await expect(
          wizard.getByRole('button', { name: 'Restore as a normal portfolio' }),
          'the destructive commit must stay disabled while the vault is locked',
        ).toBeDisabled();
        // Close the refusing wizard so the post-unlock flow below reopens one
        // deterministically fresh instance.
        await wizard.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(wizard).toBeHidden();
      });

      await test.step('UNLOCK, then MOVE-OUT restores the same rows under the same ids', async () => {
        const stub = page.getByTestId('locked-portfolio-stub');
        // The stub's own state action is the §12 affordance — an SPA link into
        // the Control Center popup; the workspace stays mounted behind it.
        await stub.getByRole('link', { name: 'Unlock', exact: true }).click();
        const access = page.getByRole('region', { name: /access$/ });
        await expect(access).toBeVisible({ timeout: 30_000 });
        await access.locator(`#vault-access-secret-${created.vaultId}`).fill(DEVICE_PASSWORD);
        await access.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(access).toBeHidden({ timeout: 60_000 });

        // A6's listener, inverted: the unlocked view is only worth anything if
        // it reads the VAULT. A single money request for this portfolio would
        // mean the resolver-backed store was bypassed — and the server would
        // refuse it anyway, so the number on screen would be a stale cache hit.
        //
        // MATCHED ON THE WHOLE URL, not the `/portfolios/:id` prefix. Most of
        // this portfolio's money lives on routes that name it in a SEARCH
        // PARAM or under another prefix entirely — `/cash/summary?portfolioId=`,
        // `/cash/trends?portfolioId=`, `/standing-orders?portfolioId=`,
        // `/analytics/portfolios/:id/series` — and a prefix test sees none of
        // them, so the old listener would have stayed empty on a build that
        // read every one of them from the server.
        //
        // Account-wide market intel (`/assets/portfolio/dividend-*`,
        // `/assets/portfolio/news-digest`) is deliberately NOT matched: those
        // routes name no portfolio and answer from the caller's SERVER-visible
        // holdings, which for a sealed portfolio is nothing. Asserting on them
        // would fail a correct build.
        //
        // BLIND SPOT, stated rather than solved: this watches HTTP only. A
        // money read tunnelled over the realtime WebSocket would not appear
        // here; catching that needs a frame-level assertion the runner does not
        // give us cheaply, and §4.5 pushes invalidations, not figures.
        const serverMoneyReads: string[] = [];
        page.on('request', (request) => {
          const url = new URL(request.url());
          if (!url.pathname.startsWith('/api/v1/')) return;
          // Vault routes are the POINT, and all three shapes legitimately name
          // this portfolio: the `/vaults` ciphertext reader addresses the
          // per-portfolio document by `docId === portfolio.id`, the revision
          // poll and the §10 move endpoints hang off the portfolio itself.
          if (/^\/api\/v1\/vaults?(\/|$)/u.test(url.pathname)) return;
          if (/\/vault(-revision)?(\/|$)/u.test(url.pathname)) return;
          const namesThisPortfolio =
            url.pathname.includes(portfolioId) || url.search.includes(portfolioId);
          if (namesThisPortfolio) {
            serverMoneyReads.push(`${request.method()} ${url.pathname}${url.search}`);
          }
        });

        // Leave the popup its own way (SPA back to the workspace behind it).
        await page.getByRole('button', { name: 'Close', exact: true }).click();

        // THE UNLOCKED IN-PLACE VIEW (#1416). The stub gives way to the real
        // portfolio, served by the client engine out of the encrypted document.
        await expect(stub).toBeHidden({ timeout: 60_000 });
        const opened = page.getByTestId('unlocked-vault-portfolio');
        await expect(opened).toBeVisible({ timeout: 60_000 });
        const holdings = page.getByRole('region', { name: 'Holdings' });
        const sapRow = holdings.getByRole('row').filter({ hasText: 'SAP.DE' });
        await expect(sapRow).toHaveCount(1, { timeout: 60_000 });
        // The buy itself: two shares, from bytes the server cannot read.
        await expect(sapRow.getByRole('cell').nth(2)).toHaveText(/^2([.,]0+)?$/);

        // ROW-LEVEL READ through the #1532 document seam. Holdings are a
        // DERIVATION — the client engine computes them and never touches the
        // row projections — so a passing holdings assertion says nothing about
        // whether `listTransactions` works. This one does: the ledger row
        // itself, rendered from the same ~4000-line projection set the account
        // store uses, now pointed at the resolution's authenticated document.
        //
        // Asserted on the OVERVIEW's recent-transactions section rather than on
        // an Activity tab: that tab is still a Coming-Soon placeholder, and the
        // overview is where the store's `listTransactions` actually renders.
        const recent = page.getByRole('region', { name: 'Recent transactions' });
        await expect(recent).toBeVisible({ timeout: 60_000 });
        await expect(recent.getByText('SAP.DE').first()).toBeVisible({ timeout: 60_000 });

        await page.waitForTimeout(2_000);
        expect(serverMoneyReads, 'the unlocked view must read the vault, not the server').toEqual(
          [],
        );

        // §10 stays reachable from the unlocked view, exactly as from the stub.
        await opened.getByRole('button', { name: 'Restore as a normal portfolio' }).click();
        const wizard = page.getByRole('region', { name: 'Move portfolio out of the vault' });
        await expect(wizard).toBeVisible({ timeout: 30_000 });
        await expect(
          wizard.getByText('Unlock this vault on this device', { exact: false }),
        ).toBeHidden({ timeout: 15_000 });
        await wizard
          .getByRole('checkbox', { name: /portfolio becomes server-readable again/i })
          .check();
        await wizard.locator('#vault-move-credential-out').fill(ACCOUNT_PASSWORD);
        await wizard.getByRole('button', { name: 'Restore as a normal portfolio' }).click();

        await expect.poll(vaultedState, { timeout: 120_000, intervals: [1_000] }).toBeNull();

        // Same-UUID restore (§10): the SAME transaction row is readable again,
        // byte-relevant fields intact.
        const restored = await listTransactions(owner!, portfolioId);
        expect(restored.map(({ id }) => id)).toContain(transactionId);
        const row = restored.find(({ id }) => id === transactionId)!;
        expect(row).toMatchObject({ side: 'buy', quantity: 2, price: 100 });
      });
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`: it prints input VALUES, this arc types a real
      // device password and account password, and the artifact is uploaded by
      // the nightly. See `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await admin.dispose();
      } finally {
        await assertNoE10Secrets(testInfo, diagnostics, sensitive, bodyFailure);
      }
    }
  });

  // NOT "golden": the accepted payload is serialized from THIS account's own
  // ceremony phrase. `VAULT_TRANSFER_GOLDEN_PAYLOAD` names a vault id no account
  // owns, so it can never survive the receiver's fetch-then-compare against a
  // real header — the golden ACCEPT vector is pinned in `qr/payload.test.ts`,
  // and only its REJECT siblings are drivable through this UI seam.
  test('[E10-A7] a serialized btvault1: payload opens the vault on a second device', async ({
    browser,
    context,
  }, testInfo) => {
    skipOnPhone(testInfo);
    test.setTimeout(420_000);

    const diagnostics: string[] = [];
    const sensitive: Pd9SensitiveCanary[] = [
      { name: 'e10-device-password', value: DEVICE_PASSWORD },
    ];
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let secondDevice: Awaited<ReturnType<typeof browser.newContext>> | null = null;
    let bodyFailure: unknown;

    try {
      owner = await provisionUserInContext(context, admin, 'e10qr');
      collectSanitizedDiagnostics(owner.page, diagnostics);
      await openPrivacyPanel(owner.page);

      const name = `E10 QR ${randomUUID().slice(0, 8)}`;
      const created = await createVaultThroughCeremony(owner, {
        name,
        devicePassword: DEVICE_PASSWORD,
      });
      sensitive.push({ name: 'e10-mnemonic', value: created.mnemonic });

      // The SECOND device: the same account, a brand-new browser profile, so
      // its endpoint keystore has never seen this vault's phrase.
      secondDevice = await browser.newContext();
      const receiverPage = await secondDevice.newPage();
      collectSanitizedDiagnostics(receiverPage, diagnostics);
      await receiverPage.goto('/login');
      await passwordSignIn(receiverPage, owner.email, ACCOUNT_PASSWORD);
      // A returning sign-in lands the Home command center, not `/portfolio`;
      // the shared readiness landmark is the shell's own create trigger.
      await expectUserShellReady(receiverPage);

      await test.step('the second device knows the vault but not its phrase', async () => {
        await openPrivacyPanel(receiverPage);
        await expectVaultState(receiverPage, name, 'Words needed on this device');
      });

      // Reassigned once: the `f=` mismatch step below leaves the receiver to
      // prove nothing was saved, and comes back to a freshly opened one.
      let receiver = await openTransferReceiver(receiverPage);

      await test.step('the shared conformance reject vectors stay rejected at the scan seam', async () => {
        // The mocked camera, fed the cross-client fixture. These are the exact
        // strings the mobile scanner consumes, so a divergence here IS a
        // wire-format regression.
        //
        // Each iteration CLEARS the previous verdict first and asserts the alert
        // is gone before submitting. Without that clear this loop asserted the
        // previous iteration's DOM: `badChecksum` and `elevenWords` both map to
        // `invalid-mnemonic` and therefore render the identical string back to
        // back, so an `elevenWords` submission that silently did nothing — a
        // disabled Continue, a dead form — would still have found the message on
        // screen and passed. The clear makes every refusal an observed state
        // transition produced by its OWN submission.
        //
        // Those two sharing one message is deliberate, not a gap: the receiver
        // must not tell a holder of a bad code WHICH BIP39 rule failed. Which
        // rule broke is discriminated where the outcome code is visible, in
        // `qr/payload.test.ts`; what is checked here is the vector's declared
        // OUTCOME against the copy the receiver actually shows for it, so the
        // fixture and this UI seam cannot drift apart.
        const rejects: ReadonlyArray<readonly [VaultTransferRejectVectorName, string, string]> = [
          ['unknownPrefix', 'update-required', 'This transfer code uses an unsupported version.'],
          [
            'missingMnemonic',
            'missing-mnemonic',
            'The transfer code has no seed phrase and was rejected.',
          ],
          [
            'missingVaultId',
            'missing-vault-id',
            'The transfer code has no vault ID and was rejected.',
          ],
          [
            'badChecksum',
            'invalid-mnemonic',
            'The seed phrase must be 12 valid English BIP39 words',
          ],
          [
            'elevenWords',
            'invalid-mnemonic',
            'The seed phrase must be 12 valid English BIP39 words',
          ],
          [
            'duplicateVaultId',
            'invalid-vault-id',
            'The transfer code contains an invalid vault ID.',
          ],
        ];
        for (const [vectorName, outcome, message] of rejects) {
          const vector = VAULT_TRANSFER_CONFORMANCE_VECTORS[vectorName];
          // Indexing `.outcome` also pins these six as REJECT vectors at the
          // type level: promote one to an accept vector and this stops compiling
          // rather than quietly asserting a message that can no longer appear.
          expect(vector.outcome, `${vectorName} must still be a ${outcome} vector`).toBe(outcome);

          // The shipped method button re-selects the scan source, which is the
          // receiver's own reset of the error state — no test-only hook.
          await receiver.getByRole('button', { name: 'Scan or paste code', exact: true }).click();
          await expect(
            receiver.getByRole('alert'),
            `the previous verdict must be cleared before ${vectorName} is submitted`,
          ).toHaveCount(0);

          await submitTransferPayload(receiver, vector.payload);
          await expect(
            receiver.getByRole('alert').getByText(message, { exact: false }),
            `${vectorName} must be refused`,
          ).toBeVisible({ timeout: 30_000 });
          // A refused code saves nothing: the receiver is still on its input.
          await expect(receiver.locator('#vault-transfer-payload')).toBeVisible();
        }
      });

      await test.step('every shared ACCEPT vector round-trips through the real receive seam', async () => {
        // #1527/F8. The reject half above proves only what the receiver
        // REFUSES; the fixture's ACCEPT vectors — the normalization rules two
        // client implementations must agree on: `+` vs `%20`, uppercase words,
        // the normative `n` trim set, the trim-before-cap order, an unknown
        // forward-compatible key — were unit-covered only, so this seam could
        // have diverged from the parser without any suite going red.
        //
        // These vectors name a vault no account owns, so the pass deliberately
        // stops at the parse verdict. The fetch-then-compare half is exercised
        // against a real header by the two steps that follow.
        expect(
          VAULT_TRANSFER_ACCEPT_VECTORS.length,
          'the shared fixture must still carry its ACCEPT half',
        ).toBe(14);

        for (const [vectorName, vector] of VAULT_TRANSFER_ACCEPT_VECTORS) {
          // The shipped method button is the receiver's own reset, exactly as
          // in the reject loop: every verdict below is a transition produced by
          // its OWN submission, never the previous iteration's DOM.
          await receiver.getByRole('button', { name: 'Scan or paste code', exact: true }).click();
          await expect(
            receiver.locator('#vault-transfer-payload'),
            `the receiver must be back on its input before ${vectorName}`,
          ).toBeVisible();

          await submitTransferPayload(receiver, vector.payload);
          await expect(
            receiver.getByText('The phrase and transfer format are valid'),
            `${vectorName} must be accepted at the scan seam`,
          ).toBeVisible({ timeout: 30_000 });
          await expect(
            receiver.getByText(vector.expected.vaultId),
            `${vectorName} must carry its vault id through the seam`,
          ).toBeVisible();
          // `n` is a display hint, and the receiver prefills its editable name
          // with the NORMALIZED value — or leaves it empty where the vector
          // declares no name at all.
          await expect(
            receiver.locator('#vault-receive-name'),
            `${vectorName} must carry its normalized name hint through the seam`,
          ).toHaveValue(vector.expected.name ?? '');
        }
      });

      await test.step('a structurally valid but WRONG f= is refused after the header fetch', async () => {
        // The other half of #1527/F8. `f` binds a code to one vault key. The
        // fixture's fingerprint is well-formed, so the parser accepts it and
        // only the authenticated comparison can catch it — which is the point:
        // a receiver that ignored `f` would pass every parse test and still
        // save a phrase against the wrong key.
        const mismatched = serializeVaultTransferPayload({
          mnemonic: created.mnemonic,
          vaultId: created.vaultId,
          name,
          fingerprint: VAULT_TRANSFER_VECTOR_FINGERPRINT,
        });
        sensitive.push({ name: 'e10-transfer-payload-f-mismatch', value: mismatched });

        await receiver.getByRole('button', { name: 'Scan or paste code', exact: true }).click();
        await submitTransferPayload(receiver, mismatched);
        await expect(
          receiver.getByText('The phrase and transfer format are valid'),
          'a well-formed f= must pass the PARSER — the refusal has to come later',
        ).toBeVisible({ timeout: 30_000 });

        await receiver.locator('#vault-receive-device-password').fill(DEVICE_PASSWORD);
        await receiver.getByRole('button', { name: 'Verify and open vault', exact: true }).click();
        await expect(
          receiver
            .getByRole('alert')
            .getByText('The phrase did not open the authenticated vault header.', { exact: false }),
          'a mismatched f= must be refused by the real verification',
        ).toBeVisible({ timeout: 90_000 });

        // "Nothing was saved on this device" is a claim, so it is checked: the
        // endpoint must still be asking for the words.
        await openPrivacyPanel(receiverPage);
        await expectVaultState(receiverPage, name, 'Words needed on this device');
        receiver = await openTransferReceiver(receiverPage);
      });

      await test.step('[E10-A7 proof] the real handoff opens the vault here', async () => {
        // Built with the PRODUCT's serializer, from the phrase this account's
        // own ceremony issued — a hand-written string would hide a format change.
        const payload = serializeVaultTransferPayload({
          mnemonic: created.mnemonic,
          vaultId: created.vaultId,
          name,
        });
        sensitive.push({ name: 'e10-transfer-payload', value: payload });
        expect(payload.startsWith('btvault1:')).toBe(true);

        await submitTransferPayload(receiver, payload);
        await expect(receiver.getByText('The phrase and transfer format are valid')).toBeVisible({
          timeout: 30_000,
        });
        await expect(receiver.getByText(created.vaultId)).toBeVisible();

        await receiver.locator('#vault-receive-device-password').fill(DEVICE_PASSWORD);
        await receiver.getByRole('button', { name: 'Verify and open vault', exact: true }).click();

        // Fetch-then-compare: the receiver pulls the opaque header envelope,
        // unwraps its key slot with the phrase and only then reports success.
        await expect(
          receiverPage.getByText('The transferred vault was verified and saved on this device.'),
        ).toBeVisible({ timeout: 90_000 });
      });

      await test.step('the received phrase is real custody, not a one-shot open', async () => {
        // The state must have moved off "Words needed on this device" for good.
        // A fresh document is asserted deliberately: the transfer wrote a
        // WRAPPED endpoint entry, so after a reload this device must present
        // the same locked-but-known vault a locally created one does — the
        // phrase is stored here now, and only the device password is missing.
        await openPrivacyPanel(receiverPage);
        await expectVaultState(receiverPage, name, 'Locked on this device');
        await expect(
          vaultRow(receiverPage, name).getByRole('link', { name: 'Unlock', exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          vaultRow(receiverPage, name).getByRole('link', { name: 'Enter words', exact: true }),
          'the second device must no longer be asking for the words',
        ).toHaveCount(0);

        // And the transferred phrase really opens it here.
        const section = await attemptUnlock(receiverPage, created.vaultId, DEVICE_PASSWORD);
        await expect(section).toBeHidden({ timeout: 60_000 });
        await expectVaultState(receiverPage, name, 'Ready on this device');
      });

      await test.step('the handoff is endpoint-local: the first device is unchanged', async () => {
        expect(await listVaultsApi(owner!)).toHaveLength(1);
        await openPrivacyPanel(owner!.page);
        // The first device reloads into the same locked-but-known state; the
        // transfer neither revoked nor duplicated its custody.
        await expectVaultState(owner!.page, name, 'Locked on this device');
        const section = await attemptUnlock(owner!.page, created.vaultId, DEVICE_PASSWORD);
        await expect(section).toBeHidden({ timeout: 60_000 });
        await expectVaultState(owner!.page, name, 'Ready on this device');
      });
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`: it prints input VALUES, this arc types a real device
      // password, and the artifact is uploaded by the nightly. See
      // `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await secondDevice?.close();
      } finally {
        try {
          await admin.dispose();
        } finally {
          await assertNoE10Secrets(testInfo, diagnostics, sensitive, bodyFailure);
        }
      }
    }
  });

  /**
   * §17 as ruled (C): an owner-run verified ciphertext backup, then a wipe/reset
   * (privacy_mode→normal, the account kill rail cleared, v1 rows quarantined),
   * and only then the one-time fresh-start notice this arc asserts.
   *
   * The setup runs that sequence for real — `scripts/ops/export-paranoid-v1-backup.mjs`
   * as a child process for the dump/verify/attest and the `--confirm-offsite`
   * step, then `paranoidV1WipeService` for the wipe — so the banner asserted below
   * is the product of an actual §17 transition and not a hand-written row. The
   * wipe has no HTTP route by design, which is exactly why this arc reaches for
   * the operator path instead of an endpoint.
   *
   * Both halves of "one-time" are covered: it shows for the wiped account, and it
   * is gone after acknowledgement — across a reload, because the flag lives on the
   * session payload and not in browser state.
   */
  test('[E10-A8] fresh-start notice after the §17 wipe', async ({ browser, context }, testInfo) => {
    skipOnPhone(testInfo);
    test.setTimeout(180_000);

    const admin = await newAdminRequestContext(newRequestContext);
    let wiped: E2EUser | null = null;
    try {
      wiped = await provisionUser(browser, admin, 'e9-wiped');
      const untouched = await provisionUserInContext(context, admin, 'e9-untouched');

      await runParanoidV1TransitionFor(await accountId(wiped));

      await test.step('the wiped account is told once, calmly, with the create-a-vault CTA', async () => {
        // `provisionUser` leaves the account signed in, and the transition ran
        // after that session opened — so the SPA is still holding the pre-wipe
        // session payload. A reload re-reads `/auth/me`, which is exactly the
        // "at next login" moment §17 describes. (That the LOGIN response carries
        // the flag too is pinned server-side by the paranoidFreshStartNotice suite.)
        await wiped!.page.reload();
        await expectUserShellReady(wiped!.page);

        const notice = wiped!.page.getByTestId('paranoid-fresh-start-notice');
        await expect(notice).toBeVisible();
        // §17 step 3 forbids a conversion ceremony and a legacy passphrase prompt;
        // the CTA points at the new per-portfolio model instead.
        await expect(notice.getByRole('link')).toHaveAttribute('href', /\/control\/privacy/u);
        await expect(notice).not.toContainText(/passphrase/iu);

        // The wipe really did put the account back to normal: the v1 kill rail is
        // cleared, so the shell is the ordinary authenticated one.
        const me = await wiped!.context.request.get(apiV1('/auth/me'));
        expect(((await me.json()) as { privacyMode: string }).privacyMode).toBe('normal');
      });

      await test.step('acknowledging spends it — and a reload does not bring it back', async () => {
        const notice = wiped!.page.getByTestId('paranoid-fresh-start-notice');
        await notice.getByRole('button').click();
        await expect(notice).toBeHidden();

        await wiped!.page.reload();
        await expectUserShellReady(wiped!.page);
        await expect(wiped!.page.getByTestId('paranoid-fresh-start-notice')).toBeHidden();
      });

      await test.step('an account the transition never touched is never told', async () => {
        await untouched.page.reload();
        await expectUserShellReady(untouched.page);
        // Structural, not conditional: a never-wiped account has no wipe receipt,
        // so there is nothing for the notice to read.
        await expect(untouched.page.getByTestId('paranoid-fresh-start-notice')).toBeHidden();
      });
    } finally {
      await admin.dispose();
    }
  });
});

/** The account's own id, read from the session — the §8 owner-digest input. */
async function accountId(user: E2EUser): Promise<string> {
  const response = await user.context.request.get(apiV1('/auth/me'));
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}
