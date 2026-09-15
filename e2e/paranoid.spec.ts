import { randomUUID } from 'node:crypto';

import {
  expect,
  request as newRequestContext,
  test,
  type APIResponse,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';

import {
  isParanoidKilledPath,
  safeDestination,
} from '../apps/web/src/user/vault/ui/ParanoidSurfaceGate';
import { newAdminRequestContext } from './support/adminApi';
import { withoutMatcherAriaSnapshot } from './support/artifactHygiene';
import { API_BASE_URL } from './support/config';
import {
  assertPd9DesignPrecondition,
  createPd9Harness,
  PD9_TRACEABILITY,
  type Pd9Harness,
  type Pd9VaultStorageProbe,
} from './support/pd9';
import {
  assertNoPd9Secrets,
  assertPd9DriveInstalled,
  fillPd9Secret,
  installPd9Drive,
  pd9CiphertextCanaries,
  pd9DriveState,
  pd9RecoveryCanaries,
  restorePd9StoredDrive,
  setPd9TamperReads,
  tamperPd9StoredDrive,
  type Pd9BoundaryEvent,
  type Pd9SensitiveCanary,
} from './support/pd9Drive';
import { provisionUserInContext, type E2EUser } from './support/users';

const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' } as const;
const KILLED_ROUTE_MATRIX = [
  ['/s/pd9-public-token', '/portfolio'],
  ['/u/pd9-public-profile', '/portfolio'],
  ['/people/shared', '/people'],
  ['/people/shared/pd9-portfolio', '/people'],
  ['/people/profile', '/people'],
  ['/control/profile', '/control/account'],
  ['/settings/profile', '/portfolio'],
  ['/portfolio/import', '/portfolio'],
  // Both vocabularies of the cash area land on the CANONICAL accounts page:
  // the area was renamed /portfolio/cash (V5 cash fusion phase 2) and the
  // legacy /portfolio/cash-flow names only survive as router aliases.
  ['/portfolio/cash-flow', '/portfolio/cash/accounts'],
  ['/portfolio/cash-flow/transactions', '/portfolio/cash/accounts'],
  ['/portfolio/cash-flow/budgets', '/portfolio/cash/accounts'],
  ['/portfolio/cash-flow/categories', '/portfolio/cash/accounts'],
  ['/portfolio/cash-flow/rules', '/portfolio/cash/accounts'],
  ['/portfolio/cash-flow/import', '/portfolio/cash/accounts'],
  ['/portfolio/cash', '/portfolio/cash/accounts'],
  ['/portfolio/cash/movements', '/portfolio/cash/accounts'],
  ['/portfolio/cash/budgets', '/portfolio/cash/accounts'],
  ['/portfolio/cash/labels', '/portfolio/cash/accounts'],
  ['/portfolio/cash/import', '/portfolio/cash/accounts'],
  ['/portfolio/people', '/portfolio'],
  ['/portfolio/tax/print', '/portfolio/tax'],
  ['/assets/news', '/assets'],
  ['/social/my-shared', '/people'],
  ['/social/shared-with-me/pd9-portfolio', '/people'],
  ['/social/profile', '/people'],
] as const;

interface MoneyFixture {
  portfolioId: string;
  asset: { id: string; symbol: string; name: string };
  /**
   * A unique plaintext marker carried by the seeded expense transaction's
   * description. Once paranoid mode is on it exists ONLY inside the encrypted
   * vault document, so it is the content half of AC4: a fail-open that rendered
   * or logged decrypted portfolio material would carry this exact string.
   */
  contentSentinel: string;
}

interface AlertFixture {
  id: string;
  symbol: string;
}

// These scenarios intentionally enter real passphrases into the DOM. Keep
// secret-bearing recorder formats off, then enforce that with the sentinel scan
// in each test's finally block.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

/**
 * QUARANTINE, not deletion (PROJECTPLAN §16, 2026-08-30).
 *
 * Both arcs in this file drive the legacy ACCOUNT-LEVEL enable ceremony, and
 * they reach it the only way a user ever could: Control Center → Privacy →
 * "Set up". That entry point was retired client-side by the Chief ruling that
 * closed the two-competing-paranoid-models finding (paranoid-UX failure map
 * #9), so `openParanoidSetup` now has nothing to click — for these specs and
 * for every user.
 *
 * WHY NOT REWORK THEM. There is no other entry: the wizard renders under
 * `privacyMode === 'normal'` only, so it is unreachable for an existing
 * paranoid account too, and `ParanoidEnableWizard` is referenced by nothing in
 * the app. The only way to keep these green would be a test-only door back into
 * a security ceremony no user can reach — a suite that is green about something
 * that does not exist, which is worse than a loud skip.
 *
 * WHAT THIS COSTS, stated rather than hidden: `POST /vault/enable` keeps its
 * service/route coverage, but the account-level ceremony loses its ONLY
 * end-to-end coverage, and with it the product's only Drive-medium e2e
 * ([PD9-A3]) — per-vault Drive is off at build level
 * (`PER_VAULT_DRIVE_PROVISIONING_AVAILABLE === false`), which is exactly the
 * finding that motivated the ruling. `e2e/paranoid-e10.spec.ts` carries the
 * per-portfolio successors, including [E10-A11] for the #1354 ordering
 * property and [E10-A5] for the honest Drive refusal.
 *
 * UN-SKIP when either the entry point returns, or §17/§19 retires the v1 stack
 * and these arcs go with it. Do not weaken them in place.
 *
 * REGISTERED AS A WAIVER: "paranoid Drive-only round trip" is one of V5-P14's
 * ten required scenarios, and with this arc quarantined AND [E10-A9] blocked it
 * had no live test anywhere — which the nightly reported as green. Both dead
 * entries are now the single `paranoid-drive-only-round-trip` waiver in
 * `e2e/support/v5Gate.mjs`: waived against #1638, printed in the job summary as
 * an explicit gap, and red the day either arc starts passing again.
 *
 * SO IS THE [PD9-A2] STEP PROOF. The nightly used to assert that the complete-DB
 * cleartext probe below occurred exactly once — a step inside the quarantined
 * arc, which therefore never occurs, so the assertion could only ever fail. It
 * is the `pd9-cleartext-probe` entry in `V5_STEP_PROOFS`, waived against the
 * same #1638 and graded by the same rule: a reported gap while this arc sleeps,
 * red the moment the probe runs again.
 */
const V1_ENABLE_ENTRY_RETIRED =
  'The account-level Paranoid enable entry was retired client-side (PROJECTPLAN §16, 2026-08-30). ' +
  'This arc drives that ceremony through the Privacy panel’s "Set up" button, which no longer ' +
  'exists for any account. See the note above this constant.';

test.describe('PD9 paranoid-mode end-to-end gate', () => {
  test('normal account remains on the server store after opening the paranoid setup wizard with the Drive seam installed', async ({
    context,
  }, testInfo) => {
    test.skip(true, V1_ENABLE_ENTRY_RETIRED);
    const diagnostics: string[] = [];
    const monitor = await installPd9Drive(context);
    const admin = await newAdminRequestContext(newRequestContext);
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;
    try {
      owner = await provisionUserInContext(context, admin, 'pd9normal');
      // Registered before the first paranoid gesture so console/pageerror output
      // from the privacy panel AND the lazy vault-chunk load — the exact window
      // where a lazy-boundary regression announces itself — lands in the report.
      collectSanitizedDiagnostics(owner.page, diagnostics);
      // PRECONDITION: this step must stay ABOVE `openParanoidSetup`. The injected
      // assignment sits in the provider's component body, so it re-sets the flag
      // on every render; it only proves fail-closed while the provider is
      // guaranteed unmounted, which post-PERF1 holds until the enable gesture
      // pulls in the vault chunk. Moving it below any vault mount makes it flake.
      await test.step('the unconsumed lazy boundary fails closed', async () => {
        expect(
          await owner!.page.evaluate(() => window.__bettertrackE2EVaultDependencies !== undefined),
        ).toBe(true);
        // Self-enforce the precondition above instead of leaving it to the
        // comment: if a future reorder puts this step below a vault mount, the
        // flag is already true here and this fails LOUDLY with that fact,
        // rather than degrading into a re-render race on the 100 ms budget.
        expect(
          await owner!.page.evaluate(() => window.__bettertrackPd9DependencyConsumed === true),
        ).toBe(false);
        await owner!.page.evaluate(() => {
          window.__bettertrackPd9DependencyConsumed = false;
        });
        await expect(assertPd9DriveInstalled(owner!.page, 100)).rejects.toThrow(
          'PD9 Drive dependency was installed but not consumed by the vault provider.',
        );
      });
      await openParanoidSetup(owner.page);

      const portfolioReads: string[] = [];
      owner.page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/v1/portfolios')) portfolioReads.push(path);
      });
      await owner.page.goto('/portfolio');
      await expect(owner.page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
      expect(portfolioReads.length).toBeGreaterThan(0);
      expect(monitor.all().filter((event) => event.kind.startsWith('drive-'))).toEqual([]);

      const portfolios = await owner.context.request.get(apiV1('/portfolios'));
      expect(portfolios.ok(), await portfolios.text()).toBeTruthy();
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`. `assertNoPd9Secrets` cannot cover that file — it is
      // written in fixture teardown, after the scan — and an aria snapshot
      // prints input VALUES, including the `fillPd9Secret` passphrase sitting in
      // the DOM. `PLAYWRIGHT_NO_COPY_PROMPT` does NOT stop this half; only the
      // strip does. See `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await admin.dispose();
      } finally {
        await softAssertNoPd9Secrets(testInfo, diagnostics, [], bodyFailure);
      }
    }
  });

  test('Drive-only enable → lock/reload → tamper fail-closed → verified media switch → disable', async ({
    context,
  }, testInfo) => {
    test.skip(true, V1_ENABLE_ENTRY_RETIRED);
    test.skip(
      testInfo.project.name === 'mobile-chromium',
      'PD9 is the desktop cryptographic transition gate; phone layout has its own permanent suite.',
    );
    test.setTimeout(360_000);

    const diagnostics: string[] = [];
    const sensitive: Pd9SensitiveCanary[] = [];
    const monitor = await installPd9Drive(context);
    const admin = await newAdminRequestContext(newRequestContext);
    const harness = createPd9Harness();
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;

    try {
      await test.step('[PD9-A1] binding design precondition', async () => {
        await assertPd9DesignPrecondition();
        expect(PD9_TRACEABILITY).toEqual([
          {
            criterion: 'Design note §16-logged + owner-acked BEFORE code',
            assertion: '[PD9-A1] binding design precondition',
          },
          {
            criterion: 'Mode on ⇒ server stores no cleartext portfolio data (schema/probe test)',
            assertion: '[PD9-A2] complete DB cleartext probe',
          },
          {
            criterion:
              'Drive-only round trip: zero portfolio rows server-side and the app remains fully functional (e2e)',
            assertion: '[PD9-A3] Drive-only enable and zero active server medium round trip',
          },
          {
            criterion: 'Media switching migrates the blob correctly (test)',
            assertion: '[PD9-A4] verified media ordering and retained-source failure',
          },
          {
            criterion: 'Social/sharing surfaces are absent for the account (matrix test)',
            assertion: '[PD9-A5] killed/kept browser route matrix',
          },
          {
            criterion: 'A client computes correct stats from encrypted fixture data (test)',
            assertion: '[PD9-A6] known custom-asset totals without portfolio API reads',
          },
          {
            criterion: 'Alerts still fire (test)',
            assertion: '[PD9-A7] real evaluator and notification dispatcher',
          },
        ]);
      });

      owner = await provisionUserInContext(context, admin, 'pd9vault');
      const { page } = owner;
      collectSanitizedDiagnostics(page, diagnostics);
      const fixture = await createMoneyFixture(owner, harness);
      // The decrypted-content canary joins the scan set for the whole flow. It
      // cannot false-positive on the pre-enable seed traffic: that traffic runs
      // through the context-level APIRequestContext (no page events at all),
      // and `collectSanitizedDiagnostics` records only console/pageerror text
      // plus a failed request's method + pathname — never a body or query.
      sensitive.push({ name: 'vault-content', value: fixture.contentSentinel });
      const purgeOnly = await harness.seedPurgeOnlyFixture({
        email: owner.email,
        portfolioId: fixture.portfolioId,
        assetId: fixture.asset.id,
      });
      const scope = await harness.captureCleartextScope(owner.email);

      await test.step('seeded vault-classification coverage', async () => {
        const before = await harness.probeCleartext(scope);
        // The transaction-triggered recompute worker persists only through
        // yesterday. This fixture's portfolio history starts today, so the
        // intentionally seeded 2001 row remains the sole daily snapshot.
        expect(before).toMatchObject({
          portfolios: 1,
          transactions: 1,
          assets: 1,
          price_history: 1,
          import_batches: 1,
          import_rows: 1,
          portfolio_daily_snapshots: 1,
          portfolio_snapshot_state: 1,
          expense_transactions: 1,
          expense_budgets: 1,
          expense_budget_fires: 1,
        });
        expect(await harness.purgeOnlyCounts(purgeOnly)).toEqual({
          importBatch: 1,
          importRow: 1,
          portfolioDailySnapshot: 1,
          portfolioSnapshotState: 1,
          expenseBudgetFire: 1,
        });
      });

      await assertNormalMoneyApi(owner, fixture);

      await test.step('[PD9-A3] Drive-only enable and zero active server medium round trip', async () => {
        const enableMark = monitor.mark();
        await enableDriveOnly(page, sensitive);
        sensitive.push(...(await pd9CiphertextCanaries(page)));
        const enableEvents = monitor.since(enableMark);
        const driveWrite = enableEvents.findIndex((event) => event.kind === 'drive-write');
        const verifiedRead = enableEvents.findIndex(
          (event, index) => index > driveWrite && event.kind === 'drive-read',
        );
        expect(driveWrite).toBeGreaterThanOrEqual(0);
        expect(verifiedRead).toBeGreaterThan(driveWrite);

        await test.step('[PD9-A2] complete DB cleartext probe', async () => {
          const afterEnable = await harness.probeCleartext(scope);
          expect(
            Object.values(afterEnable).every((value) => value === 0),
            afterEnable,
          ).toBeTruthy();
          expect(await harness.vaultStorage(owner!.email)).toEqual(emptyVaultStorage());
          expect(await pd9DriveState(page)).toMatchObject({ present: true, tamperReads: false });
        });

        await test.step('[PD9-A6] known custom-asset totals without portfolio API reads', () =>
          assertClientMoneyWithoutServerReads(page, fixture));
      });

      await test.step('[PD9-A5] killed/kept browser route matrix', async () => {
        await expectNoForbiddenApiResponses(page, async () => {
          for (const [from, to] of KILLED_ROUTE_MATRIX) {
            expect(isParanoidKilledPath(from), `${from} must remain in the product kill list`).toBe(
              true,
            );
            expect(safeDestination(from), `${from} safe destination drifted`).toBe(to);
            await expectRedirect(page, from, to);
          }
          await navigateInApp(page, '/people');
          // Level-pinned: the People page renders the "Friends" h1 AND a
          // same-named section heading, and role-name matching is substring.
          await expect(page.getByRole('heading', { name: 'Friends', level: 1 })).toBeVisible();
        });
      });

      await test.step('[PD9-A7] real evaluator and notification dispatcher', async () => {
        // A kept, global-asset alert has two legitimate writers: this focused
        // evaluation and the real minute-scheduled worker. `fireAlert` therefore
        // converges on the persisted invariant — status `triggered` plus the
        // delivered inbox row — rather than sampling it once; whichever writer
        // wins, the state below is what §15's "alerts still fire" claims.
        const alert = await createKeptAlert(owner!);
        const fired = await harness.fireAlert({ email: owner!.email, alertId: alert.id });
        expect(fired, 'the kept global alert never converged to a delivered fire').toMatchObject({
          status: 'triggered',
        });
        expect(fired.notifications).toBeGreaterThan(0);

        await navigateInApp(page, '/workbench/alerts');
        const alertRow = page.getByRole('listitem').filter({ hasText: alert.symbol });
        await expect(alertRow).toContainText('Triggered');
        // The harness delivers the fire through its own in-process dispatcher,
        // so no realtime push reaches THIS browser — the bell learns of the
        // inbox row through its 30-second poll (the product's designed
        // fallback). The wait must cover a full poll cycle.
        const bell = page.getByRole('button', { name: /Notifications \(\d+ unread\)/ });
        await expect(bell).toBeVisible({ timeout: 45_000 });
        await bell.click();
        await expect(
          page
            .getByRole('group', { name: 'Notifications' })
            .getByText(`Price alert: ${alert.symbol}`),
        ).toBeVisible();
      });

      await test.step('manual lock, locked-route pair, wrong passphrase and reload unlock', async () => {
        await lockVault(page);
        await expect(page.getByText('Unlock your vault', { exact: true })).toBeVisible();

        await page.goto('/oauth/authorize?client_id=pd9&scope=portfolio%3Aread');
        await expect(page.getByText('Unlock your vault', { exact: true })).toBeVisible();
        await page.goto('/account/delete');
        await expect(page.getByRole('heading', { name: 'Delete your account' })).toBeVisible();
        await expect(page.getByText('Unlock your vault', { exact: true })).toHaveCount(0);

        await page.reload();
        await page.goto('/portfolio');
        await fillPd9Secret(page, 'Vault passphrase', 'wrongPassphrase');
        await page.getByRole('button', { name: 'Unlock vault' }).click();
        await expect(page.getByText('That vault passphrase is incorrect.')).toBeVisible();

        await fillPd9Secret(page, 'Vault passphrase', 'passphrase');
        await page.getByRole('button', { name: 'Unlock vault' }).click();
        await assertKnownMoney(page, fixture);
      });

      await test.step('tampered Drive ciphertext fails closed and a good copy restores', async () => {
        await lockVault(page);
        await tamperPd9StoredDrive(page);
        sensitive.push(...(await pd9CiphertextCanaries(page)));
        await page.reload();
        await fillPd9Secret(page, 'Vault passphrase', 'passphrase');
        await page.getByRole('button', { name: 'Unlock vault' }).click();
        // Authentication deliberately does not reveal whether the passphrase
        // or the ciphertext tag was wrong. The observable guarantee is that
        // the vault stays locked and no decrypted money reaches the page.
        await expect(page.getByText('That vault passphrase is incorrect.')).toBeVisible();
        await expect(page.getByText('Unlock your vault', { exact: true })).toBeVisible();
        await expect(page.getByText(fixture.asset.symbol, { exact: true })).toHaveCount(0);
        await expect(page.getByText(fixture.asset.name, { exact: true })).toHaveCount(0);
        await expect(page.getByText(/1[.,]000[.,]00/)).toHaveCount(0);
        // AC4's second half: never RENDER *or LOG* decrypted portfolio material.
        // The content canary covers what the symbol/amount checks cannot — a
        // fail-open that decrypted the document and parked it in a hidden node,
        // an attribute or a console line while still showing the locked screen.
        await assertNoDecryptedContent(page, diagnostics, fixture.contentSentinel);

        await restorePd9StoredDrive(page);
        await fillPd9Secret(page, 'Vault passphrase', 'passphrase');
        await page.getByRole('button', { name: 'Unlock vault' }).click();
        await assertKnownMoney(page, fixture);
      });

      await test.step('[PD9-A4] verified media ordering and retained-source failure', async () => {
        await navigateInApp(page, '/control/connections');
        await openVaultStorage(page);

        const addMark = monitor.mark();
        await page.getByRole('button', { name: 'Add server copy' }).click();
        await expect(page.getByText('An authenticated server copy was added.')).toBeVisible();
        assertAddServerOrdering(monitor.since(addMark));
        expect(await harness.vaultStorage(owner!.email)).toMatchObject({
          active: { rows: 1 },
          candidates: { rows: 0 },
          retired: { rows: 0 },
        });

        await setPd9TamperReads(page, true);
        await openVaultStorage(page);
        const failedMark = monitor.mark();
        await page.getByRole('button', { name: 'Use Drive only' }).click();
        await expect(
          page.getByText(
            /storage change was cancelled|storage choice was left unchanged|latest encrypted changes are not/i,
          ),
        ).toBeVisible();
        expect(monitor.since(failedMark).some((event) => event.kind === 'media-patch')).toBe(false);
        expect((await harness.vaultStorage(owner!.email)).active.rows).toBe(1);

        await setPd9TamperReads(page, false);
        await openVaultStorage(page);
        const removeMark = monitor.mark();
        await page.getByRole('button', { name: 'Use Drive only' }).click();
        await expect(
          page.getByText(
            'Drive-only storage activated. The server recovery copy remains retained until you explicitly delete it.',
          ),
        ).toBeVisible();
        assertRemoveServerOrdering(monitor.since(removeMark));

        const retired = await harness.vaultStorage(owner!.email);
        expect(retired.active).toEqual({ rows: 0, bytes: 0 });
        expect(retired.history).toEqual({ rows: 0, bytes: 0 });
        expect(retired.candidates).toEqual({ rows: 0, bytes: 0 });
        expect(retired.retired.rows).toBeGreaterThan(0);
        expect(retired.retired.bytes).toBeGreaterThan(0);
        expect(retired.retirements).toBe(1);
        sensitive.push(...(await pd9CiphertextCanaries(page)));
      });

      await test.step('explicitly purges the elapsed retained server recovery copy', async () => {
        await harness.makeRetirementPurgeable(owner!.email);
        // Refetch the server-authored purgeAfter timestamp. A browser-only
        // clock override cannot make the repository retention gate elapse.
        // The account gate seeds this query from its short-lived local mode
        // cache after reload, so wait for the first authoritative GET rather
        // than sampling that intentionally stale bootstrap value.
        const refreshedMedia = page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname === '/api/v1/vault/media' &&
            response.ok(),
          { timeout: 30_000 },
        );
        await page.reload();
        // The reload drops the in-memory vault key, so the global gate — not the
        // panel's inline form — is the deterministic way back in, and it leaves
        // the runtime's Drive connection installed. One flow, no branch.
        await fillPd9Secret(page, 'Vault passphrase', 'passphrase');
        await page.getByRole('button', { name: 'Unlock vault' }).click();
        await navigateInApp(page, '/control/connections');
        await refreshedMedia;
        await openVaultStorage(page);

        await expect(page.getByText('Retained server recovery copy', { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        const retiredFold = await openFold(page, 'Retained server recovery copy');
        const purge = page.getByRole('button', { name: 'Delete retained server copy' });
        await expect(purge).toBeEnabled();
        await purge.click();

        await expect(
          page.getByText('The retained server recovery copy was deleted.', { exact: true }),
        ).toBeVisible();
        await expect(retiredFold).toHaveCount(0);
        expect(await harness.vaultStorage(owner!.email)).toEqual(emptyVaultStorage());
      });

      await test.step('disable rehydrates restorable rows and drops purge-only history', async () => {
        await navigateInApp(page, '/control/privacy');
        await page.getByText('Disable Paranoid mode', { exact: true }).click();
        await page
          .getByLabel('I want to rehydrate this unlocked vault and disable Paranoid mode.')
          .check();
        await page.getByRole('button', { name: 'Restore normal mode' }).click();
        // Back-to-normal signal. It used to be the setup entry appearing, which
        // PrivacyPanel rendered exclusively under `privacyMode === 'normal'`;
        // that entry is retired (see V1_ENABLE_ENTRY_RETIRED), so the signal is
        // now the paranoid MANAGEMENT section going away — which the panel
        // renders exclusively under `privacyMode === 'paranoid'`, i.e. the same
        // flip observed from the other side. Asserted on a control the arc has
        // just used, so a silently-missing section cannot pass it vacuously.
        await expect(page.getByText('Disable Paranoid mode', { exact: true })).toHaveCount(0, {
          timeout: 30_000,
        });
        await expect(page.getByRole('switch', { name: 'Discreet mode' })).toBeVisible();

        // Owner-audit decision: these five strict-document/operational kinds are
        // intentionally purge-only. The current-period budget marker is not
        // restored, so one post-disable evaluation may re-fire the breach; its
        // newly-created marker then restores ordinary once-per-period behavior.
        const purged = await harness.purgeOnlyCounts(purgeOnly);
        expect(purged).toMatchObject({
          importBatch: 0,
          importRow: 0,
          portfolioDailySnapshot: 0,
          expenseBudgetFire: 0,
        });
        // The snapshot-state marker is purge-only but SELF-HEALING: restoring
        // the transactions enqueues the recompute worker, which re-derives its
        // `computedThrough` successor (PD3's doctrine — purge-only artifacts
        // are re-derived after rehydration, never restored), and the probe
        // keys by portfolio id so a successor is indistinguishable from a
        // restore. 0 = the worker has not run yet, 1 = the successor landed;
        // anything more would mean duplicated markers.
        expect(purged.portfolioSnapshotState).toBeLessThanOrEqual(1);
        expect(await harness.vaultStorage(owner!.email)).toEqual(emptyVaultStorage());
        // Polled, not sampled once: the server's disable commit (which the
        // probes above observe) precedes the client's `cleanupAfterDisable`,
        // and the Drive delete inside it is deliberately best-effort and
        // asynchronous. The copy must GO — a timeout here still fails — but
        // it goes a beat after the mode flip.
        await expect
          .poll(async () => (await pd9DriveState(page)).present, {
            timeout: 15_000,
            intervals: [250, 500, 1_000],
          })
          .toBe(false);

        const restoredScope = await harness.captureCleartextScope(owner!.email);
        const restored = await harness.probeCleartext(restoredScope);
        expect(restored).toMatchObject({
          portfolios: 1,
          transactions: 1,
          assets: 1,
          price_history: 1,
          expense_transactions: 1,
          expense_budgets: 1,
          import_batches: 0,
          import_rows: 0,
          portfolio_daily_snapshots: 0,
          expense_budget_fires: 0,
        });

        const budget = await harness.evaluateRestoredCurrentBudget(owner!.email);
        expect(budget.emitted).toHaveLength(1);
        expect(budget.emitted[0]).toMatchObject({
          type: 'budget.exceeded',
          period: purgeOnly.periodKey,
          budgetId: purgeOnly.budgetId,
        });
        expect(budget.fireRows).toBe(1);

        await assertNormalMoneyApi(owner!, fixture);
        await navigateInApp(page, '/portfolio');
        await assertKnownMoney(page, fixture);
      });
    } catch (error) {
      bodyFailure = error;
      // Drop the matcher's aria snapshot before the runner turns this into
      // `error-context.md`. `assertNoPd9Secrets` cannot cover that file — it is
      // written in fixture teardown, after the scan — and an aria snapshot
      // prints input VALUES, including the `fillPd9Secret` passphrase sitting in
      // the DOM. `PLAYWRIGHT_NO_COPY_PROMPT` does NOT stop this half; only the
      // strip does. See `e2e/support/artifactHygiene.ts`.
      throw withoutMatcherAriaSnapshot(error);
    } finally {
      try {
        await Promise.all([admin.dispose(), harness.dispose()]);
      } finally {
        await softAssertNoPd9Secrets(testInfo, diagnostics, sensitive, bodyFailure);
      }
    }
  });
});

async function createMoneyFixture(owner: E2EUser, harness: Pd9Harness): Promise<MoneyFixture> {
  const api = owner.context.request;
  const portfolios = await json<{ portfolios: Array<{ id: string; name: string }> }>(
    await api.get(apiV1('/portfolios')),
  );
  const portfolioId = portfolios.portfolios.find((portfolio) => portfolio.name === 'Main')?.id;
  expect(portfolioId, 'fresh account owns Main').toBeTruthy();

  const assetBody = await json<{ asset: { id: string; symbol: string; name: string } }>(
    await api.post(apiV1('/custom-assets'), {
      headers: CSRF_HEADERS,
      data: { name: 'PD9 Vault Gold', category: 'commodity', currency: 'EUR' },
    }),
  );
  const asset = assetBody.asset;
  const today = new Date().toISOString().slice(0, 10);
  await ok(
    await api.put(apiV1(`/custom-assets/${asset.id}/value-points`), {
      headers: CSRF_HEADERS,
      data: { points: [{ date: today, value: 500 }] },
    }),
  );
  await ok(
    await api.post(apiV1(`/portfolios/${portfolioId}/transactions`), {
      headers: CSRF_HEADERS,
      data: {
        transactions: [
          {
            assetId: asset.id,
            side: 'buy',
            quantity: 2,
            price: 400,
            fee: 0,
            executedAt: `${today}T12:00:00.000Z`,
          },
        ],
      },
    }),
  );

  // Unique per run so it cannot collide with any app-emitted text, and never
  // asserted as expected DOM content anywhere in this spec — a canary that the
  // happy path can print into a Playwright failure message would poison the
  // final scan instead of proving anything.
  const contentSentinel = `PD9-CONTENT-${randomUUID().replace(/-/g, '')}`;

  // The whole legacy expense fixture — category, budget, transaction — is
  // seeded through the harness's repositories: V5 cash fusion retired the
  // island's HTTP writes (410 EXPENSE_AREA_RETIRED) and `GET /expenses/
  // categories` is a pure read (#1550), so nothing on the HTTP side produces
  // these rows any more. A pre-fusion account still carries them, and carrying
  // them through enable → purge → disable → restore is precisely what PD9
  // gates.
  await harness.seedLegacyExpenseFixture({
    email: owner.email,
    bookedOn: today,
    description: `PD9 current-period groceries ${contentSentinel}`,
  });
  // Reads DO survive the island's retirement: the seeded category must come
  // back over HTTP, which is what the enable → restore arm later re-checks.
  const categories = await json<{ categories: Array<{ id: string; name: string }> }>(
    await api.get(apiV1('/expenses/categories')),
  );
  const groceries = categories.categories.find((category) => category.name === 'Groceries');
  expect(groceries, 'seeded Groceries category is readable').toBeTruthy();

  return { portfolioId: portfolioId!, asset, contentSentinel };
}

async function createKeptAlert(owner: E2EUser): Promise<AlertFixture> {
  const api = owner.context.request;
  const search = await json<{
    results: Array<{ id: string; symbol: string; ownerId?: string | null }>;
  }>(await api.get(apiV1('/search?q=AAPL')));
  const globalAsset = search.results.find(
    (result) => result.symbol === 'AAPL' && result.ownerId == null,
  );
  expect(globalAsset, 'local catalog returns global AAPL').toBeTruthy();
  // POST /alerts returns the alert DIRECTLY (alertSchema — see
  // alerts.test.ts), not wrapped in an { alert } envelope.
  const alertBody = await json<{ id: string }>(
    await api.post(apiV1('/alerts'), {
      headers: CSRF_HEADERS,
      data: {
        assetId: globalAsset!.id,
        kind: 'price_above',
        threshold: 1,
        repeat: false,
      },
    }),
  );

  return { id: alertBody.id, symbol: 'AAPL' };
}

async function enableDriveOnly(page: Page, sensitive: Pd9SensitiveCanary[]): Promise<void> {
  await openParanoidSetup(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByText('Google Drive only', { exact: true }).click();

  // #1354 moved Drive consent AHEAD of the passphrase: choosing a Drive medium
  // now preloads GIS and then REQUIRES an explicit authorization gesture, and
  // step 2's Continue stays disabled until it lands
  // (`ParanoidEnableWizard.tsx`: `step === 2 && (authorizingDrive ||
  // (driveSelected && drive == null))`). Clicking Continue straight after the
  // radio — what this helper did before — waits on a button that can never
  // enable, so the arc burned its whole 360 s budget on click retries.
  //
  // Waiting for the CONNECTED copy rather than just clicking is deliberate:
  // authorization is asynchronous, and the same button renders "Retry" when
  // preparation failed, so a blind click could sail past a broken seam and fail
  // later somewhere unrelated.
  await page.getByRole('button', { name: 'Connect Google Drive' }).click();
  await expect(
    page.getByText('Google Drive is connected and ready for the encrypted copy.'),
    'the Drive seam must authorize before the wizard offers the passphrase step',
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Continue' }).click();
  await fillPd9Secret(page, 'Vault passphrase', 'passphrase');
  await fillPd9Secret(page, 'Confirm vault passphrase', 'passphrase');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download recovery kit' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('bettertrack-recovery-kit.txt');
  sensitive.push(...(await pd9RecoveryCanaries(download)));
  await page.getByLabel('I have stored my recovery kit safely.').check();
  await page
    .getByLabel(
      'If I lose my vault passphrase and my recovery kit, my data is gone forever. BetterTrack cannot recover it.',
    )
    .check();
  await page.getByRole('button', { name: 'Enable Paranoid mode' }).click();
  // Wait for a signal that enable ACTUALLY completed. The original signal — the
  // account-menu button becoming visible — only meant "the app shell is back",
  // and the Origin redesign renders the Control Center as a popup OVER the
  // shell, so the button is visible the whole time and the wait passed before
  // enable had written anything (the A3 ordering assertions then sampled an
  // empty monitor).
  //
  // Its replacement, the panel's success alert, is TRANSIENT: accepting the
  // receipt flips the account to paranoid, and when that flip remounts the app
  // root the Control Center popup goes with it — taking the alert along before
  // it can be sampled. Locally that raced ~3 runs in 5. So the wait now also
  // accepts the vault sync chip, which `OriginShell` renders only under
  // `privacyMode === 'paranoid' && mediaState != null` — i.e. only once the same
  // receipt has been accepted, but as a permanent part of the shell. Neither
  // branch can appear before enable committed, and the A3 ordering assertions
  // right after this call still prove the drive-write → verified-read pair.
  await expect(
    page
      .getByText('Paranoid mode is on. Your encrypted vault is ready.')
      .or(
        page.getByRole('button', {
          name: /^(Synced|Syncing|Offline|Needs attention|Disconnected)$/,
        }),
      )
      .first(),
  ).toBeVisible({ timeout: 60_000 });
}

// Post-PERF1 the vault stack is code-split: `VaultRuntimeProvider` is pulled in
// only when the privacy panel's setup entry sets `?enable=1`, so this gesture —
// not a bare page load — is what makes the boundary double observable.
//
// This is also where the seam is proven POSITIVELY, and it is what makes the
// whole gate fail closed on drift: if a future URL or module-graph change stops
// the route transform from running, the consumed flag never turns true and this
// assertion throws for every caller (both blocks, both projects). The
// `assertPd9DriveInstalled` self-test above only covers the complementary half —
// that the helper is not a no-op.
async function openParanoidSetup(page: Page): Promise<void> {
  await page.goto('/control/privacy');
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  // Heading FIRST, flag second, so the two failure modes stay distinguishable.
  // On a cold Vite dev server the vault/crypto chunk is the slowest transform in
  // the suite; asserting the flag first would report that slowness as
  // "installed but not consumed" — the seam-regression diagnosis this whole
  // change exists to make trustworthy. Once the wizard has rendered, the chunk
  // demonstrably loaded, so a still-false flag can only mean seam drift.
  await expect(page.getByRole('heading', { name: 'What changes' })).toBeVisible();
  await assertPd9DriveInstalled(page);
}

async function assertClientMoneyWithoutServerReads(
  page: Page,
  fixture: MoneyFixture,
): Promise<void> {
  const reads: string[] = [];
  const listener = (request: { url(): string }) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/v1/portfolios')) reads.push(path);
  };
  page.on('request', listener);
  try {
    await expectNoForbiddenApiResponses(page, async () => {
      await navigateInApp(page, '/portfolio');
      await assertKnownMoney(page, fixture);
    });
  } finally {
    page.off('request', listener);
  }
  expect(reads).toEqual([]);
}

/** A killed paranoid route must be absent, not a background 403 the UI swallows. */
async function expectNoForbiddenApiResponses(
  page: Page,
  action: () => Promise<void>,
): Promise<void> {
  const forbidden: string[] = [];
  const listener = (response: {
    status(): number;
    url(): string;
    request(): { method(): string };
  }) => {
    const path = new URL(response.url()).pathname;
    if (response.status() === 403 && path.startsWith('/api/v1/')) {
      forbidden.push(`${response.request().method()} ${path}`);
    }
  };
  page.on('response', listener);
  try {
    await action();
  } finally {
    page.off('response', listener);
  }
  expect(forbidden).toEqual([]);
}

async function assertKnownMoney(page: Page, fixture: MoneyFixture): Promise<void> {
  const holdings = page.getByRole('region', { name: 'Holdings' });
  const row = holdings.getByRole('row').filter({ hasText: fixture.asset.symbol });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(fixture.asset.name);
  // The quantity as its OWN cell: the redesigned holdings table's concatenated
  // row text glues quantity into the price ("…Gold2400.00 €"), so a \b-anchored
  // regex over the row cannot see the 2 — the cell can.
  await expect(row.getByRole('cell', { name: '2', exact: true })).toBeVisible();
  await expect(row).toContainText(/400[.,]00/);
  await expect(row).toContainText(/500[.,]00/);
  await expect(row).toContainText(/1[.,]000[.,]00/);
  await expect(row).toContainText(/200[.,]00/);
  await expect(row).toContainText(/25[.,]00\s*%/);

  const totals = page.getByRole('region', { name: 'Portfolio totals' });
  await expect(totals).toContainText(/1[.,]000[.,]00/);
  await expect(totals).toContainText(/800[.,]00/);
  await expect(totals).toContainText(/200[.,]00/);
}

async function assertNormalMoneyApi(owner: E2EUser, fixture: MoneyFixture): Promise<void> {
  const overview = await json<{
    holdings: Array<{ asset: { id: string }; quantity: number; marketValueEur: number }>;
    totals: { marketValueEur: number; investedEur: number; unrealizedPnlEur: number };
  }>(await owner.context.request.get(apiV1(`/portfolios/${fixture.portfolioId}`)));
  const holding = overview.holdings.find((entry) => entry.asset.id === fixture.asset.id);
  expect(holding).toMatchObject({ quantity: 2, marketValueEur: 1000 });
  expect(overview.totals).toMatchObject({
    marketValueEur: 1000,
    investedEur: 800,
    unrealizedPnlEur: 200,
  });
  const ledger = await json<{ items: Array<{ assetId: string; quantity: number; price: number }> }>(
    await owner.context.request.get(apiV1(`/portfolios/${fixture.portfolioId}/transactions`)),
  );
  expect(ledger.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ assetId: fixture.asset.id, quantity: 2, price: 400 }),
    ]),
  );
}

async function lockVault(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Lock vault' }).click();
  await expect(page.getByText('Unlock your vault', { exact: true })).toBeVisible();
}

/** Open one `PanelFold` by its summary text, whatever state it was left in. */
async function openFold(page: Page, summaryText: string): Promise<Locator> {
  const fold = page.getByText(summaryText, { exact: true });
  await expect(fold).toBeVisible();
  const open = await fold.evaluate(
    (summary) => (summary.parentElement as HTMLDetailsElement | null)?.open === true,
  );
  if (!open) await fold.click();
  return fold;
}

async function openVaultStorage(page: Page): Promise<void> {
  await openFold(page, 'Vault storage copies');
}

async function expectRedirect(page: Page, from: string, to: string): Promise<void> {
  await navigateInApp(page, from);
  await expect(page).toHaveURL(new RegExp(`${escapeRegex(to)}(?:$|\\?)`));
}

async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((nextPath) => {
    history.pushState(null, '', nextPath);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

function assertAddServerOrdering(events: readonly Pd9BoundaryEvent[]): void {
  const write = events.findIndex((event) => event.kind === 'server-candidate-write');
  const read = events.findIndex((event) => event.kind === 'server-candidate-read');
  const patch = events.findIndex((event) => event.kind === 'media-patch');
  const freshDrive = lastEventIndex(
    events,
    (event, index) => event.kind === 'drive-observe' && index < patch,
  );
  expect(write).toBeGreaterThanOrEqual(0);
  expect(read).toBeGreaterThan(write);
  expect(freshDrive).toBeGreaterThan(read);
  expect(patch).toBeGreaterThan(freshDrive);
}

function assertRemoveServerOrdering(events: readonly Pd9BoundaryEvent[]): void {
  const patch = events.findIndex((event) => event.kind === 'media-patch');
  const verifiedReads = events.filter(
    (event, index) => event.kind === 'drive-observe' && index < patch,
  );
  expect(verifiedReads.length).toBeGreaterThanOrEqual(2);
  const lastVerifiedRead = lastEventIndex(
    events,
    (event, index) => event.kind === 'drive-observe' && index < patch,
  );
  expect(patch).toBeGreaterThan(lastVerifiedRead);
}

function lastEventIndex(
  events: readonly Pd9BoundaryEvent[],
  predicate: (event: Pd9BoundaryEvent, index: number) => boolean,
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index]!, index)) return index;
  }
  return -1;
}

function emptyVaultStorage(): Pd9VaultStorageProbe {
  return {
    active: { rows: 0, bytes: 0 },
    history: { rows: 0, bytes: 0 },
    candidates: { rows: 0, bytes: 0 },
    retired: { rows: 0, bytes: 0 },
    retirements: 0,
  };
}

/**
 * Assert the decrypted-content canary reached neither the document nor the
 * collected diagnostics. Both checks reduce to a boolean/count before it
 * crosses an assertion so a real leak fails on the criterion itself instead of
 * echoing the canary back into `testInfo.errors` — which the final sentinel
 * scan would then report as a second, misleading escape.
 */
async function assertNoDecryptedContent(
  page: Page,
  diagnostics: readonly string[],
  sentinel: string,
): Promise<void> {
  const embedded = await page.evaluate(
    (needle) => document.documentElement.outerHTML.includes(needle),
    sentinel,
  );
  expect(embedded, 'decrypted vault content reached the locked document').toBe(false);
  const logged = diagnostics.filter((entry) => entry.includes(sentinel)).length;
  expect(logged, 'decrypted vault content reached console/pageerror diagnostics').toBe(0);
}

function collectSanitizedDiagnostics(page: Page, diagnostics: string[]): void {
  page.on('console', (message) => diagnostics.push(`console:${message.type()}:${message.text()}`));
  page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`));
  page.on('requestfailed', (request) => {
    diagnostics.push(
      `requestfailed:${request.method()}:${new URL(request.url()).pathname}:${request.failure()?.errorText ?? ''}`,
    );
  });
}

/**
 * Preserve the browser flow's original failure while still making a sentinel
 * leak fail the test. Passing the in-flight error closes the gap before
 * Playwright copies it into `testInfo.errors`; a soft assertion records a
 * second failure without replacing the defect that caused the flow to abort.
 */
async function softAssertNoPd9Secrets(
  testInfo: TestInfo,
  diagnostics: readonly string[],
  sensitive: readonly Pd9SensitiveCanary[],
  bodyFailure: unknown,
): Promise<void> {
  const failureDiagnostics =
    bodyFailure instanceof Error
      ? [bodyFailure.message, bodyFailure.stack ?? '']
      : bodyFailure === undefined
        ? []
        : [String(bodyFailure)];
  try {
    await assertNoPd9Secrets(testInfo, [...diagnostics, ...failureDiagnostics], sensitive);
  } catch (scanError) {
    expect.soft(scanError, 'PD9 secret sentinel scan').toBeUndefined();
  }
}

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as T;
}

async function ok(response: APIResponse): Promise<void> {
  expect(response.ok(), await response.text()).toBeTruthy();
}

function apiV1(path: string): string {
  return `${API_BASE_URL}/api/v1${path}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
