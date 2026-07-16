import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * PROJECTPLAN §13.4 V4-P11 broker-import e2e. Drives the whole V4-P8 pipeline
 * from the browser: upload → autodetected broker + staged preview flags →
 * transactional apply into the active portfolio + Main cash source. Uses the
 * Trade Republic mapper (the only shipped mapper — the George/Flatex/IBKR trio
 * lands as unit/golden coverage, not e2e). Nothing here uses the API's own
 * import routes directly: every assertion goes through the real ImportPage so a
 * broken affordance (label, flag badge, apply button) breaks the spec.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'support', 'fixtures');
const HAPPY_CSV = path.join(FIXTURE_DIR, 'trade-republic-happy.csv');
const ERROR_CSV = path.join(FIXTURE_DIR, 'trade-republic-with-error.csv');

test('imports: TR CSV — autodetect, staged preview, transactional apply, re-upload dedupes', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'importsowner');
  await apiRequest.dispose();

  const page = owner.page;

  // ── Step 1: upload & preview ──────────────────────────────────────────────
  await page.goto('/portfolio/import');
  await expect(page.getByRole('heading', { name: 'Broker CSV import' })).toBeVisible();
  await page.getByLabel('CSV export').setInputFiles(HAPPY_CSV);
  await page.getByRole('button', { name: 'Create preview' }).click();

  // Broker autodetect: the framework fingerprints the TR header (all nine
  // columns present) and picks its mapper without a manual override.
  await expect(page.getByText('Broker: Trade Republic')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Preview: trade-republic-happy.csv')).toBeVisible();

  // Counts strip: three rows, all mapped (SAP SE resolves to the seeded SAP.DE
  // via the exact-name match; the deposit needs no instrument).
  await expect(page.getByText('3 rows')).toBeVisible();
  await expect(page.getByText('3 mapped')).toBeVisible();
  await expect(page.getAllByText('Mapped')).toHaveLength(3);
  // The framework resolves 'SAP SE' → SAP.DE by exact whole-name match against
  // the seeded catalog, and the buy + dividend rows both surface that symbol.
  await expect(page.getByText('SAP.DE', { exact: true })).toHaveCount(2);

  // Nothing has landed on the portfolio yet. Opened in a second tab so the
  // preview state on this tab survives — the preview lives in React state and
  // navigating away would drop it.
  const inspector = await owner.context.newPage();
  await inspector.goto('/portfolio');
  await expect(inspector.getByText('Your portfolio is empty')).toBeVisible({ timeout: 15_000 });
  await inspector.close();

  // ── Step 2: confirm & apply into Main cash source ─────────────────────────
  await page.getByRole('button', { name: 'Import 3 rows' }).click();
  await expect(page.getByText('3 imported · 0 skipped · 0 failed')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getAllByText('Imported')).toHaveLength(3);

  // Portfolio now carries the SAP.DE buy through the real HoldingsTable.
  await page.goto('/portfolio');
  const holdings = page.getByRole('region', { name: 'Holdings' });
  await expect(holdings.getByRole('link', { name: 'SAP.DE' })).toBeVisible({ timeout: 30_000 });
  await expect(holdings.getByRole('link', { name: 'SAP.DE' })).toHaveCount(1);

  // Cash source Movement history carries the deposit + dividend legs. Buys are
  // NOT linked to cash by default in the import flow (the linkCash checkbox is
  // off), so no "Buy" movement appears there.
  await page.goto('/portfolio/cash');
  const history = page.getByRole('region', { name: 'Movement history' });
  await expect(history.getByText('Deposit', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(history.getByText('Dividend', { exact: true })).toBeVisible();

  // ── Step 3: re-upload the same file → every row flags as duplicate ────────
  await page.goto('/portfolio/import');
  await page.getByLabel('CSV export').setInputFiles(HAPPY_CSV);
  await page.getByRole('button', { name: 'Create preview' }).click();

  await expect(page.getByText('Broker: Trade Republic')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('3 duplicates')).toBeVisible();
  await expect(page.getAllByText('Duplicate')).toHaveLength(3);
  await expect(page.getByText('0 mapped')).toBeVisible();
  // With zero mapped rows the framework refuses to book anything: the "no
  // importable rows" note appears and the apply button (rendered as "Import 0
  // rows" to make the state visible) is disabled.
  await expect(page.getByText(/No importable rows/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import 0 rows' })).toBeDisabled();

  // Portfolio is unchanged: still exactly one SAP.DE holding, no new buys.
  const inspector2 = await owner.context.newPage();
  await inspector2.goto('/portfolio');
  const holdings2 = inspector2.getByRole('region', { name: 'Holdings' });
  await expect(holdings2.getByRole('link', { name: 'SAP.DE' })).toHaveCount(1);
  await inspector2.close();

  await owner.context.close();
});

test('imports: malformed row shows as error while the rest apply', async ({ browser }) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'importserr');
  await apiRequest.dispose();

  const page = owner.page;

  await page.goto('/portfolio/import');
  await page.getByLabel('CSV export').setInputFiles(ERROR_CSV);
  await page.getByRole('button', { name: 'Create preview' }).click();

  // Preview lands with the broker autodetected and the malformed row surfaced
  // as `error` — the mapper flags the buy whose quantity is "kaputt", the other
  // two rows (deposit + real Allianz SE buy) stay mapped.
  await expect(page.getByText('Broker: Trade Republic')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('3 rows')).toBeVisible();
  await expect(page.getByText('2 mapped')).toBeVisible();
  await expect(page.getByText('1 errors')).toBeVisible();
  await expect(page.getByText(/Invalid quantity "kaputt"/)).toBeVisible();

  // The framework books the two mapped rows even though one row failed —
  // per-row tolerance, never all-or-nothing (§13.4 V4-P8).
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText('2 imported · 1 skipped · 0 failed')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Skipped (error)')).toBeVisible();

  // The applied buy shows up as a real holding — proof that the framework
  // separated the good rows from the bad and only wrote the good ones.
  await page.goto('/portfolio');
  const holdings = page.getByRole('region', { name: 'Holdings' });
  await expect(holdings.getByRole('link', { name: 'ALV.DE' })).toBeVisible({ timeout: 30_000 });

  await owner.context.close();
});
