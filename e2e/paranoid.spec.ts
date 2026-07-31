import {
  expect,
  request as newRequestContext,
  test,
  type APIResponse,
  type Page,
  type TestInfo,
} from '@playwright/test';

import {
  isParanoidKilledPath,
  safeDestination,
} from '../apps/web/src/user/vault/ui/ParanoidSurfaceGate';
import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import {
  assertPd9DesignPrecondition,
  createPd9Harness,
  PD9_TRACEABILITY,
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
  ['/portfolio/cash-flow', '/portfolio/cash-flow/accounts'],
  ['/portfolio/cash-flow/transactions', '/portfolio/cash-flow/accounts'],
  ['/portfolio/cash-flow/budgets', '/portfolio/cash-flow/accounts'],
  ['/portfolio/cash-flow/categories', '/portfolio/cash-flow/accounts'],
  ['/portfolio/cash-flow/rules', '/portfolio/cash-flow/accounts'],
  ['/portfolio/cash-flow/import', '/portfolio/cash-flow/accounts'],
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
}

interface AlertFixture {
  id: string;
  symbol: string;
}

// These scenarios intentionally enter real passphrases into the DOM. Keep
// secret-bearing recorder formats off, then enforce that with the sentinel scan
// in each test's finally block.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test.describe('PD9 paranoid-mode end-to-end gate', () => {
  test('normal account remains on the server store when the Drive seam is installed', async ({
    context,
  }, testInfo) => {
    const diagnostics: string[] = [];
    const monitor = await installPd9Drive(context);
    const admin = await newRequestContext.newContext({ baseURL: API_BASE_URL });
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;
    try {
      await loginAsAdmin(admin);
      owner = await provisionUserInContext(context, admin, 'pd9normal');
      await assertPd9DriveInstalled(owner.page);
      collectSanitizedDiagnostics(owner.page, diagnostics);

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
      throw error;
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
    test.skip(
      testInfo.project.name === 'mobile-chromium',
      'PD9 is the desktop cryptographic transition gate; phone layout has its own permanent suite.',
    );
    test.setTimeout(360_000);

    const diagnostics: string[] = [];
    const sensitive: Pd9SensitiveCanary[] = [];
    const monitor = await installPd9Drive(context);
    const admin = await newRequestContext.newContext({ baseURL: API_BASE_URL });
    const harness = createPd9Harness();
    let owner: E2EUser | null = null;
    let bodyFailure: unknown;

    try {
      await test.step('[PD9-A1] binding design precondition', async () => {
        await assertPd9DesignPrecondition();
        expect(PD9_TRACEABILITY).toHaveLength(7);
      });

      await loginAsAdmin(admin);
      owner = await provisionUserInContext(context, admin, 'pd9vault');
      const { page } = owner;
      await assertPd9DriveInstalled(page);
      collectSanitizedDiagnostics(page, diagnostics);
      const fixture = await createMoneyFixture(owner);
      const purgeOnly = await harness.seedPurgeOnlyFixture({
        email: owner.email,
        portfolioId: fixture.portfolioId,
        assetId: fixture.asset.id,
      });
      const scope = await harness.captureCleartextScope(owner.email);

      await test.step('seeded vault-classification coverage', async () => {
        const before = await harness.probeCleartext(scope);
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

      await test.step('[PD9-A3] Drive-only enable and zero-server round trip', async () => {
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
        for (const [from, to] of KILLED_ROUTE_MATRIX) {
          expect(isParanoidKilledPath(from), `${from} must remain in the product kill list`).toBe(
            true,
          );
          expect(safeDestination(from), `${from} safe destination drifted`).toBe(to);
          await expectRedirect(page, from, to);
        }
        await navigateInApp(page, '/people');
        await expect(page.getByRole('heading', { name: 'Friends' })).toBeVisible();
      });

      await test.step('[PD9-A7] real evaluator and notification dispatcher', async () => {
        // Create this kept, global-asset row only after paranoid enable. That
        // removes the several-minute window in which the scheduled worker could
        // consume a one-shot before this focused evaluator call. If the worker
        // wins the remaining instant, final status + UI delivery are still the
        // invariant; race-sensitive evaluated/fired counters are not.
        const alert = await createKeptAlert(owner!);
        const fired = await harness.fireAlert({ email: owner!.email, alertId: alert.id });
        expect(fired.status).toBe('triggered');

        await navigateInApp(page, '/workbench/alerts');
        const alertRow = page.getByRole('listitem').filter({ hasText: alert.symbol });
        await expect(alertRow).toContainText('Triggered');
        const bell = page.getByRole('button', { name: /Notifications \(\d+ unread\)/ });
        await expect(bell).toBeVisible();
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
        await expect(page.getByText(/1[.,]000[.,]00/)).toHaveCount(0);

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

      await test.step('disable rehydrates restorable rows and drops purge-only history', async () => {
        await navigateInApp(page, '/control/privacy');
        await page.getByText('Disable Paranoid mode', { exact: true }).click();
        await page
          .getByLabel('I want to rehydrate this unlocked vault and disable Paranoid mode.')
          .check();
        await page.getByRole('button', { name: 'Restore normal mode' }).click();
        await expect(page.getByText('Client-encrypted vault')).toBeVisible({ timeout: 30_000 });

        // Owner-audit decision: these five strict-document/operational kinds are
        // intentionally purge-only. The current-period budget marker is not
        // restored, so one post-disable evaluation may re-fire the breach; its
        // newly-created marker then restores ordinary once-per-period behavior.
        expect(await harness.purgeOnlyCounts(purgeOnly)).toEqual({
          importBatch: 0,
          importRow: 0,
          portfolioDailySnapshot: 0,
          portfolioSnapshotState: 0,
          expenseBudgetFire: 0,
        });
        expect(await harness.vaultStorage(owner!.email)).toEqual(emptyVaultStorage());
        expect(await pd9DriveState(page)).toMatchObject({ present: false });

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
      throw error;
    } finally {
      try {
        await Promise.all([admin.dispose(), harness.dispose()]);
      } finally {
        await softAssertNoPd9Secrets(testInfo, diagnostics, sensitive, bodyFailure);
      }
    }
  });
});

async function createMoneyFixture(owner: E2EUser): Promise<MoneyFixture> {
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

  const categories = await json<{ categories: Array<{ id: string; name: string }> }>(
    await api.get(apiV1('/expenses/categories')),
  );
  const groceries = categories.categories.find((category) => category.name === 'Groceries');
  expect(groceries, 'default Groceries category exists').toBeTruthy();
  await ok(
    await api.post(apiV1('/expenses/budgets'), {
      headers: CSRF_HEADERS,
      data: { categoryId: groceries!.id, amount: 200, currency: 'EUR' },
    }),
  );
  await ok(
    await api.post(apiV1('/expenses/transactions'), {
      headers: CSRF_HEADERS,
      data: {
        categoryId: groceries!.id,
        direction: 'expense',
        amount: 300,
        currency: 'EUR',
        bookedOn: today,
        description: 'PD9 current-period groceries',
      },
    }),
  );

  return { portfolioId: portfolioId!, asset };
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
  const alertBody = await json<{ alert: { id: string } }>(
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

  return { id: alertBody.alert.id, symbol: 'AAPL' };
}

async function enableDriveOnly(page: Page, sensitive: Pd9SensitiveCanary[]): Promise<void> {
  await page.goto('/control/privacy');
  await page.getByRole('button', { name: 'Set up' }).click();
  await expect(page.getByRole('heading', { name: 'What changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByText('Google Drive only', { exact: true }).click();
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
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible({
    timeout: 60_000,
  });
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
    await navigateInApp(page, '/portfolio');
    await assertKnownMoney(page, fixture);
  } finally {
    page.off('request', listener);
  }
  expect(reads).toEqual([]);
}

async function assertKnownMoney(page: Page, fixture: MoneyFixture): Promise<void> {
  const holdings = page.getByRole('region', { name: 'Holdings' });
  const row = holdings.getByRole('row').filter({ hasText: fixture.asset.symbol });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(fixture.asset.name);
  await expect(row).toContainText(/\b2\b/);
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

async function openVaultStorage(page: Page): Promise<void> {
  const fold = page.getByText('Vault storage copies', { exact: true });
  const open = await fold.evaluate(
    (summary) => (summary.parentElement as HTMLDetailsElement | null)?.open === true,
  );
  if (!open) await fold.click();
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
