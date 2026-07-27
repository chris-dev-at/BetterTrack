import { webcrypto } from 'node:crypto';

import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createVaultMoneyEngine } from '../engine';
import {
  CLIENT_MONEY_IDS,
  createClientMoneyMarket,
  createMutableTestSync,
  decryptClientMoneyFixture,
} from '../engine/clientMoney.testSupport';
import { createClientCleartextExport } from './cleartext';
import { createClientTaxCsv } from './taxCsv';
import { createPrintableTaxReport } from './taxPrint';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const OTHER_PORTFOLIO_ID = '018f0000-0000-7000-8000-000000000301';
const OTHER_VAULT_KEY_ID = '018f0000-0000-7000-8000-000000000302';
const OTHER_OWNER_ID = '018f0000-0000-7000-8000-000000000303';
const OTHER_WRITE_ID = '018f0000-0000-7000-8000-000000000304';

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

describe('paranoid client exports', () => {
  it('serializes the in-memory report in the exact server CSV format and a localized print document', async () => {
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header, fixture.envelope);
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const tax = await createVaultMoneyEngine(sync, createClientMoneyMarket().market, {
      now: () => NOW,
    }).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    expect(tax.ok).toBe(true);
    if (!tax.ok) return;
    expect(tax.value.writeId).toBe(fixture.header.writeId);

    const csv = createClientTaxCsv(sync, CLIENT_MONEY_IDS.portfolio, tax.value, 'en');
    expect(csv.ok).toBe(true);
    if (!csv.ok) return;
    expect(csv.value.filename).toBe('tax-report-2026.csv');
    expect(csv.value.text).toBe(serverCsvFixture());
    const deCsv = createClientTaxCsv(sync, CLIENT_MONEY_IDS.portfolio, tax.value, 'de');
    expect(deCsv).toMatchObject({ ok: true });
    if (deCsv.ok) {
      expect(deCsv.value.text).toContain('Abschnitt,Zusammenfassung');
      expect(deCsv.value.text).toContain('Realisierter G/V (EUR)');
      expect(deCsv.value.text).toContain('Abschnitt,Haftungsausschluss');
    }
    const escapedTax = structuredClone(tax.value);
    escapedTax.report.positions[0]!.asset.name = 'Euro, "Asset"';
    const escaped = createClientTaxCsv(sync, CLIENT_MONEY_IDS.portfolio, escapedTax, 'en');
    expect(escaped.ok).toBe(true);
    if (escaped.ok) {
      expect(escaped.value.text).toContain('EURA,"Euro, ""Asset""",37.00,30.00,0.00');
    }

    const printable = createPrintableTaxReport(
      sync,
      CLIENT_MONEY_IDS.portfolio,
      tax.value,
      'de',
      'Encrypted & <private>',
    );
    expect(printable.ok).toBe(true);
    if (!printable.ok) return;
    expect(printable.value.report).toBe(tax.value.report);
    expect(printable.value.html).toContain('<html lang="de">');
    expect(printable.value.html).toContain('Steuerbericht 2026');
    expect(printable.value.html).toContain('Deutschland (Abgeltungsteuer)');
    expect(printable.value.html).toContain('Encrypted &amp; &lt;private&gt;');
    expect(printable.value.html).toContain('238,00 €');
    expect(printable.value.html).toContain('201,00 €');
    expect(printable.value.html).toContain('<th>Einstand</th>');
    expect(printable.value.html).toContain('@media print');
    expect(printable.value.html).toContain('keine Steuerberatung');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('builds an account-export-compatible cleartext archive without vault or sync material', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    document.entities.transaction![0]!.data.note = '=HYPERLINK("https://invalid")';
    const sync = createMutableTestSync(document, fixture.header, fixture.envelope);
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');

    const exported = await createClientCleartextExport(sync, {
      generatedAt: new Date('2026-07-27T12:00:00.000Z'),
      locale: 'de',
    });

    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.filename).toBe('bettertrack-cleartext-export-2026-07-27.zip');
    expect(exported.value.manifest).toMatchObject({
      format: 'bettertrack-account-export',
      version: 1,
      userId: CLIENT_MONEY_IDS.user,
      generatedAt: '2026-07-27T12:00:00.000Z',
      entities: {
        portfolios: 1,
        transactions: 3,
        dividends: 1,
        cashSources: 1,
        cashMovements: 3,
        taxSettings: 1,
        customAssets: 2,
      },
      csv: ['transactions', 'cash-movements', 'holdings'],
    });

    const files = unzipSync(exported.value.bytes);
    expect(Object.keys(files).sort()).toEqual(
      [
        'README.txt',
        'csv/cash-movements.csv',
        'csv/holdings.csv',
        'csv/transactions.csv',
        'data/cashMovements.json',
        'data/cashSources.json',
        'data/customAssetPriceHistory.json',
        'data/customAssets.json',
        'data/dividends.json',
        'data/expenseBudgets.json',
        'data/expenseCategories.json',
        'data/expenseRules.json',
        'data/expenseTransactions.json',
        'data/portfolioSettings.json',
        'data/portfolios.json',
        'data/standingOrders.json',
        'data/taxSettings.json',
        'data/transactions.json',
        'manifest.json',
      ].sort(),
    );
    const transactionRows = JSON.parse(strFromU8(files['data/transactions.json']!)) as Array<
      Record<string, unknown>
    >;
    expect(transactionRows[0]).toMatchObject({
      id: '018f0000-0000-7000-8000-000000000110',
      quantity: '10',
      price: '100',
      fee: '5',
    });
    expect(transactionRows[0]).not.toHaveProperty('rev');
    expect(transactionRows[0]).not.toHaveProperty('editedAt');
    expect(transactionRows[0]).not.toHaveProperty('editedBy');
    expect(strFromU8(files['csv/transactions.csv']!)).toContain(
      `"'=HYPERLINK(""https://invalid"")"`,
    );
    expect(strFromU8(files['README.txt']!)).toContain(
      'lokal aus deinem entsperrten verschlüsselten Tresor',
    );

    const allDecoded = Object.values(files)
      .map((bytes) => strFromU8(bytes))
      .join('\n');
    expect(allDecoded).not.toContain(fixture.envelope.toString());
    expect(allDecoded).not.toContain('BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=');
    expect(allDecoded).not.toContain('"wrappedVk"');
    expect(allDecoded).not.toContain('"vaultVersion"');
    expect(allDecoded).not.toContain('"editedBy"');
    expect(storageWrite).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('binds tax exports to the producing owner, vault, and selected portfolio', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = structuredClone(fixture.document);
    const sourcePortfolio = document.entities.portfolio?.[0];
    if (sourcePortfolio === undefined) throw new Error('Fixture portfolio is missing.');
    document.entities.portfolio!.push({
      ...structuredClone(sourcePortfolio),
      id: OTHER_PORTFOLIO_ID,
      data: { ...sourcePortfolio.data, name: 'Other encrypted portfolio' },
    });
    const sync = createMutableTestSync(document, fixture.header);
    const engine = createVaultMoneyEngine(sync, createClientMoneyMarket().market, {
      now: () => NOW,
    });
    const selected = await engine.deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    const otherPortfolio = await engine.deriveTaxReport(OTHER_PORTFOLIO_ID, 2026);
    expect(selected.ok).toBe(true);
    expect(otherPortfolio.ok).toBe(true);
    if (!selected.ok || !otherPortfolio.ok) return;

    expect(
      createClientTaxCsv(sync, CLIENT_MONEY_IDS.portfolio, otherPortfolio.value),
    ).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });
    expect(
      createPrintableTaxReport(sync, CLIENT_MONEY_IDS.portfolio, otherPortfolio.value),
    ).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });

    const priorVaultSync = createMutableTestSync(document, {
      ...fixture.header,
      keyId: OTHER_VAULT_KEY_ID,
    });
    const priorVault = await createVaultMoneyEngine(
      priorVaultSync,
      createClientMoneyMarket().market,
      { now: () => NOW },
    ).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    expect(priorVault.ok).toBe(true);
    if (!priorVault.ok) return;
    expect(createClientTaxCsv(sync, CLIENT_MONEY_IDS.portfolio, priorVault.value)).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });
    expect(
      createPrintableTaxReport(sync, CLIENT_MONEY_IDS.portfolio, priorVault.value),
    ).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });

    const otherOwner = { ...selected.value, ownerUserId: OTHER_OWNER_ID };
    expect(createClientTaxCsv(sync, CLIENT_MONEY_IDS.portfolio, otherOwner)).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });
    expect(createPrintableTaxReport(sync, CLIENT_MONEY_IDS.portfolio, otherOwner)).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });

    sync.setDocument(document, false, OTHER_WRITE_ID);
    expect(createClientTaxCsv(sync, CLIENT_MONEY_IDS.portfolio, selected.value)).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });
    expect(
      createPrintableTaxReport(sync, CLIENT_MONEY_IDS.portfolio, selected.value),
    ).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });
  });

  it.each(['conflict', 'unresolved'] as const)(
    'hands off no cleartext or report bytes while sync is %s',
    async (status) => {
      const fixture = await decryptClientMoneyFixture();
      const sync = createMutableTestSync(fixture.document, fixture.header);
      const tax = await createVaultMoneyEngine(sync, createClientMoneyMarket().market, {
        now: () => NOW,
      }).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
      expect(tax.ok).toBe(true);
      if (!tax.ok) return;
      sync.setStatus(status);

      expect(createClientTaxCsv(sync, CLIENT_MONEY_IDS.portfolio, tax.value)).toMatchObject({
        ok: false,
        error: { code: 'VAULT_DATA_UNAVAILABLE', retryable: true },
      });
      expect(createPrintableTaxReport(sync, CLIENT_MONEY_IDS.portfolio, tax.value)).toMatchObject({
        ok: false,
        error: { code: 'VAULT_DATA_UNAVAILABLE', retryable: true },
      });
      await expect(createClientCleartextExport(sync)).resolves.toMatchObject({
        ok: false,
        error: { code: 'VAULT_DATA_UNAVAILABLE', retryable: true },
      });
    },
  );

  it('returns no file when a lock, candidate change, or abort races generation', async () => {
    const fixture = await decryptClientMoneyFixture();
    const versionSync = createMutableTestSync(fixture.document, fixture.header);
    const tax = await createVaultMoneyEngine(versionSync, createClientMoneyMarket().market, {
      now: () => NOW,
    }).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    expect(tax.ok).toBe(true);
    if (!tax.ok) return;
    versionSync.setDocument(structuredClone(fixture.document));
    expect(createClientTaxCsv(versionSync, CLIENT_MONEY_IDS.portfolio, tax.value)).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });
    expect(
      createPrintableTaxReport(versionSync, CLIENT_MONEY_IDS.portfolio, tax.value),
    ).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });

    const lockSync = createMutableTestSync(fixture.document, fixture.header);
    const lockPromise = createClientCleartextExport(lockSync);
    globalThis.setTimeout(() => lockSync.setLocked(), 0);
    await expect(lockPromise).resolves.toMatchObject({
      ok: false,
      error: { code: 'VAULT_LOCKED' },
    });

    const replacementSync = createMutableTestSync(fixture.document, fixture.header);
    const replacementPromise = createClientCleartextExport(replacementSync);
    globalThis.setTimeout(
      () => replacementSync.setDocument(structuredClone(fixture.document), false, OTHER_WRITE_ID),
      0,
    );
    await expect(replacementPromise).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED', retryable: true },
    });

    const abortSync = createMutableTestSync(fixture.document, fixture.header);
    const controller = new AbortController();
    controller.abort();
    await expect(
      createClientCleartextExport(abortSync, { signal: controller.signal }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_ABORTED' },
    });
  });

  it('keeps empty tax exports truthful and rejects sensitive nested export material', async () => {
    const fixture = await decryptClientMoneyFixture();
    const emptyDocument = structuredClone(fixture.document);
    emptyDocument.entities.transaction = [];
    emptyDocument.entities.dividend = [];
    emptyDocument.entities.cashMovement = [];
    const emptySync = createMutableTestSync(emptyDocument, fixture.header);
    const emptyTax = await createVaultMoneyEngine(emptySync, createClientMoneyMarket().market, {
      now: () => NOW,
    }).deriveTaxReport(CLIENT_MONEY_IDS.portfolio, 2026);
    expect(emptyTax.ok).toBe(true);
    if (!emptyTax.ok) return;
    const printable = createPrintableTaxReport(
      emptySync,
      CLIENT_MONEY_IDS.portfolio,
      emptyTax.value,
      'en',
    );
    expect(printable).toMatchObject({ ok: true });
    if (printable.ok) {
      expect(printable.value.html).toContain('No sells or dividends in this year.');
    }
    const csv = createClientTaxCsv(emptySync, CLIENT_MONEY_IDS.portfolio, emptyTax.value, 'en');
    expect(csv).toMatchObject({ ok: true });
    if (csv.ok) {
      expect(csv.value.text).toContain('Section,Positions\r\nSymbol,Name');
      expect(csv.value.text).not.toContain('Section,Germany (Abgeltungsteuer)');
    }

    const sensitiveDocument = structuredClone(fixture.document);
    sensitiveDocument.entities.customAsset![0]!.data.meta = {
      recoveryKit: 'must-never-export',
    };
    const sensitiveSync = createMutableTestSync(sensitiveDocument, fixture.header);
    await expect(createClientCleartextExport(sensitiveSync)).resolves.toMatchObject({
      ok: false,
      error: { code: 'VAULT_CORRUPT' },
    });
  });
});

function serverCsvFixture(): string {
  return `${[
    'Section,Summary',
    'Year,Realized P/L (EUR),Dividends gross (EUR),Tax withheld (EUR),Tax refunded (EUR),Net tax (EUR)',
    '2026,37.00,30.00,10.00,0.00,0.00',
    '',
    'Section,Germany (Abgeltungsteuer)',
    'Allowance used (EUR),Allowance remaining (EUR),Share-loss pot in (EUR),Share-loss pot out (EUR),Other-loss pot in (EUR),Other-loss pot out (EUR),KapESt (EUR),Soli (EUR)',
    '67.00,933.00,0.00,0.00,0.00,0.00,0.00,0.00',
    '',
    'Section,Positions',
    'Symbol,Name,Realized P/L (EUR),Dividends gross (EUR),Tax (EUR)',
    'EURA,Euro Asset,37.00,30.00,0.00',
    '',
    'Section,Sells',
    'Symbol,Name,Date,Quantity,Proceeds (EUR),Cost basis (EUR),Realized P/L (EUR),Tax mode,Tax (EUR)',
    'EURA,Euro Asset,2026-07-24,2,238.00,201.00,37.00,,',
    '',
    'Section,Dividends',
    'Symbol,Name,Date,Gross (EUR),Tax mode,Tax (EUR)',
    'EURA,Euro Asset,2026-07-25,30.00,none,',
    '',
    'Section,Disclaimer',
    '"Estimates for your personal overview only — not tax advice, no guarantee of correctness, not a filing document."',
  ].join('\r\n')}\r\n`;
}
