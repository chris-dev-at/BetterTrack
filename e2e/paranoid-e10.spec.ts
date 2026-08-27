import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import {
  serializeVaultTransferPayload,
  VAULT_TRANSFER_CONFORMANCE_VECTORS,
} from '../apps/web/src/user/vault/qr';
import {
  isParanoidKilledPath,
  safeDestination,
} from '../apps/web/src/user/vault/ui/ParanoidSurfaceGate';
import { newAdminRequestContext } from './support/adminApi';
import { ACCOUNT_PASSWORD } from './support/config';
import { passwordSignIn } from './support/auth';
import { expectUserShellReady } from './support/flows';
import { assertNoPd9Secrets, type Pd9SensitiveCanary } from './support/pd9Drive';
import {
  apiV1,
  attemptUnlock,
  createVaultThroughCeremony,
  E10_TRACEABILITY,
  expectVaultState,
  listDriveConnectionsApi,
  listVaultsApi,
  driveOwnerDigestInBrowser,
  lockVaultsByReload,
  openPrivacyPanel,
  openTransferReceiver,
  submitTransferPayload,
  vaultRow,
  withoutMatcherAriaSnapshot,
} from './support/e10';
import { provisionUser, provisionUserInContext, type E2EUser } from './support/users';

/**
 * PARANOID E10 — the Playwright vault gate (`docs/paranoid-design.md:959`).
 *
 * The spec line names seven arcs. Three of them cannot run against this build,
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
 *     The account-level v1 Drive-only round trip keeps its coverage in
 *     `e2e/paranoid.spec.ts` ([PD9-A3]).
 *  3. **`test.fixme` — executable move-in / move-out** needs **E6** (client
 *     engine re-home, #1416): `resolvePortfolioVaultMoveCapture()` returns
 *     `null` on `main`, so no capture exists to encrypt a portfolio document or
 *     sign E4's move-out challenge, and BOTH wizards refuse before their
 *     destructive request. [E10-A6] asserts that refusal on the MOVE-IN wizard,
 *     which is the only one reachable: move-out needs a portfolio that is
 *     already in a vault, and the only way to put one there is the move-in this
 *     same precondition blocks. Its request listener watches both paths.
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
// up under "Failure-artifact secret hygiene" in `e2e/support/e10.ts`.
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
      // `withoutMatcherAriaSnapshot`.
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
            section.getByText('That action could not be completed.', { exact: false }),
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
        await expect(
          section.getByText('That action could not be completed.', { exact: false }),
        ).toBeVisible({ timeout: 60_000 });
        await openPrivacyPanel(page);
        // The state→affordance invariant carries the lockout: E3 projects
        // `wait-or-reset`, and E8 must therefore stop offering "Unlock".
        await expectVaultState(page, name, 'Locked on this device');
        await expect(
          vaultRow(page, name).getByRole('link', { name: 'Reset this device', exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          vaultRow(page, name).getByRole('link', { name: 'Unlock', exact: true }),
        ).toHaveCount(0);
      });

      await test.step('THE assertion: the CORRECT password does not silently reopen it', async () => {
        // The whole point of a lockout. A reload first, because an in-memory
        // counter that a refresh clears would be no lockout at all — E3
        // persists `{ failures, lockedUntil }` in the endpoint keystore.
        await lockVaultsByReload(page);
        await expectVaultState(page, name, 'Locked on this device');
        await expect(
          vaultRow(page, name).getByRole('link', { name: 'Reset this device', exact: true }),
          'the lockout must survive a reload',
        ).toBeVisible({ timeout: 30_000 });

        const section = await attemptUnlock(page, created.vaultId, DEVICE_PASSWORD);
        await expect(
          section.getByText('That action could not be completed.', { exact: false }),
          'the right password must NOT open a locked-out endpoint',
        ).toBeVisible({ timeout: 60_000 });
        await openPrivacyPanel(page);
        await expectVaultState(page, name, 'Locked on this device');
        await expect(page.getByText('Ready on this device')).toHaveCount(0);
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
      // `withoutMatcherAriaSnapshot`.
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
      // `withoutMatcherAriaSnapshot`.
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
      // `withoutMatcherAriaSnapshot`.
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
      // `withoutMatcherAriaSnapshot`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await admin.dispose();
      } finally {
        await assertNoE10Secrets(testInfo, diagnostics, [], bodyFailure);
      }
    }
  });

  test('[E10-A11] the enable wizard asks for Drive consent before the passphrase', async ({
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

      // The ONE paranoid entry point. "Set up" also exists in the first-run
      // security step, so the count is asserted rather than assumed unique.
      const setUp = page.getByRole('button', { name: 'Set up', exact: true });
      await expect(setUp).toHaveCount(1);
      await setUp.click();

      const wizard = page.getByLabel('Enable Paranoid mode');
      await expect(wizard).toBeVisible({ timeout: 60_000 });
      await expect(wizard.getByText('Step 1 of 4')).toBeVisible();
      await expect(
        wizard.getByRole('heading', { name: 'What changes', exact: true }),
      ).toBeVisible();
      await wizard.getByRole('button', { name: 'Continue', exact: true }).click();

      await test.step('[E10-A11 proof] storage + Drive consent is step 2, the passphrase is not', async () => {
        // #1354: consent moved AHEAD of the passphrase so it can never be
        // collected after the point of no return. The ordering is the security
        // property, so it is asserted as an ordering — the consent control is
        // on screen while the passphrase field does not exist yet.
        await expect(wizard.getByText('Step 2 of 4')).toBeVisible();
        await expect(
          wizard.getByRole('heading', { name: 'Choose encrypted storage', exact: true }),
        ).toBeVisible();
        await expect(
          wizard.getByText('Also keep a verified copy in my Google Drive'),
          'the Drive consent must be offered here',
        ).toBeVisible();
        await expect(
          wizard.locator('#vault-passphrase'),
          'the passphrase must NOT be collectable before the storage consent',
        ).toHaveCount(0);
      });

      await test.step('the passphrase step follows, and cannot commit unacknowledged', async () => {
        await wizard.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(wizard.getByText('Step 3 of 4')).toBeVisible();
        await expect(
          wizard.getByRole('heading', { name: 'Protect your vault', exact: true }),
        ).toBeVisible();
        await expect(wizard.locator('#vault-passphrase')).toBeVisible();
        // The one-way commit stays blocked until the kit is downloaded and both
        // acknowledgments are given — nothing about this test enables the mode.
        await expect(
          wizard.getByRole('button', { name: 'Enable Paranoid mode', exact: true }),
        ).toBeDisabled();
      });

      await test.step('and walking the wizard changed nothing', async () => {
        // The commit is the ONLY thing that flips the mode; reaching step 3 and
        // leaving must not. (Step 3's footer offers Back and the commit — the
        // quiet exit lives on step 1 — so this leaves by navigation.)
        await page.goto('/portfolio');
        await expectUserShellReady(page);
        const me = await owner!.context.request.get(apiV1('/auth/me'));
        expect(((await me.json()) as { privacyMode?: string }).privacyMode).toBe('normal');
        expect(await listVaultsApi(owner!)).toHaveLength(0);
      });
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`: it prints input VALUES, this arc types a real device
      // password, and the artifact is uploaded by the nightly. See
      // `withoutMatcherAriaSnapshot`.
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

      await test.step('move-in names E6 as the missing piece and stays blocked', async () => {
        await page.goto(`/portfolio/settings?portfolio=${encodeURIComponent(portfolioId)}`);
        await page.getByRole('button', { name: 'Move into vault', exact: true }).click();
        const wizard = page.getByRole('region', { name: 'Move portfolio into a vault' });
        await expect(wizard).toBeVisible({ timeout: 30_000 });
        await expect(
          wizard.getByText('This version can’t prepare the portfolio’s encrypted copy', {
            exact: false,
          }),
          'the capture precondition must be stated, not hidden',
        ).toBeVisible();

        // ATTEMPT THE COMMIT, do not merely look at it.
        //
        // As a plain `toBeDisabled()` this arc never tried to move anything, so
        // the request listener above could not have fired under any behaviour
        // and `destructive` was decorative — it would read empty on a build that
        // had lost the precondition entirely.
        //
        // Click-if-enabled / assert-disabled-otherwise fixes that. On `main` the
        // else branch runs and asserts the refusal. On the regression this arc
        // exists to catch — a build where the capture precondition stops
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
            'the destructive commit must stay disabled while the capture is missing',
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
      // `withoutMatcherAriaSnapshot`.
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
   * CARVE-OUT 3 — needs E6 (client engine re-home + composition, #1416).
   *
   * `resolvePortfolioVaultMoveCapture()` in
   * `apps/web/src/user/vault/portfolioVaultMove.ts` returns `null` on `main`, so
   * there is no engine to write the portfolio's encrypted document (move-in) or
   * to build the strict restore graph and sign E4's challenge (move-out). E4's
   * server pipeline shipped (#1482) and the wizards shipped (#1487); only the
   * client capture is missing, and reimplementing it inside the harness would
   * test the harness rather than the product. Promote this to the executable
   * `create → move-in → lock → unlock → move-out` arc when E6 supplies the
   * capture; [E10-A6] then starts failing on its `captureUnavailable`
   * assertion, which is the reminder.
   */
  test.fixme('[E10-A10] executable move-in and move-out (blocked: E6 #1416)', () => {
    // Intentionally empty: see the block comment above.
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
    test.setTimeout(300_000);

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

      const receiver = await openTransferReceiver(receiverPage);

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
      // `withoutMatcherAriaSnapshot`.
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
   * CARVE-OUT 1 — needs E9 (transition + v1 retirement), unbuilt and owner-gated.
   *
   * §17 as ruled (C) is: an owner-run verified ciphertext backup, then a
   * wipe/reset migration (privacy_mode→normal, the account kill rail cleared,
   * v1 rows quarantined), and only then the one-time fresh-start notice this arc
   * would assert. None of that exists on `main` — there is no migration, no
   * quarantine table write and no notice component — so there is nothing to
   * drive and nothing to assert. Promote this when E9 lands the notice; it must
   * cover the notice appearing exactly once for a wiped account and never for an
   * account that was already normal.
   */
  test.fixme('[E10-A8] fresh-start notice after the §17 wipe (blocked: E9)', () => {
    // Intentionally empty: see the block comment above.
  });
});

/** The account's own id, read from the session — the §8 owner-digest input. */
async function accountId(user: E2EUser): Promise<string> {
  const response = await user.context.request.get(apiV1('/auth/me'));
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}
