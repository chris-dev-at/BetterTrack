import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CLIENT_MONEY_IDS,
  createMutableTestSync,
  decryptClientMoneyFixture,
  withTaxSettings,
} from './clientMoney.testSupport';
import { clientTaxYears } from './taxEngine';

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

/** Add one sell of the EUR asset at an arbitrary instant to the fixture document. */
function withSellAt(
  document: Awaited<ReturnType<typeof decryptClientMoneyFixture>>['document'],
  id: string,
  executedAt: string,
) {
  const next = structuredClone(document);
  next.entities.transaction = [
    ...(next.entities.transaction ?? []),
    {
      id,
      rev: 0,
      editedAt: executedAt,
      editedBy: CLIENT_MONEY_IDS.device,
      deletedAt: null,
      data: {
        portfolioId: CLIENT_MONEY_IDS.portfolio,
        assetId: CLIENT_MONEY_IDS.eurAsset,
        side: 'sell',
        quantity: '1',
        price: '10',
        fee: '0',
        executedAt,
        note: null,
        taxMode: null,
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        allowUncovered: true,
        uncoveredEntryPrice: '5',
        source: 'manual',
      },
    },
  ];
  return next;
}

describe('clientTaxYears', () => {
  it('lists Vienna activity years newest-first with the vault-held mode', async () => {
    const fixture = await decryptClientMoneyFixture();
    const document = withSellAt(
      withTaxSettings(fixture.document, 'country_specific', 'AT', null),
      '018f0000-0000-7000-8000-0000000001a1',
      '2024-03-05T10:00:00.000Z',
    );
    const sync = createMutableTestSync(document, fixture.header, fixture.envelope);

    const overview = clientTaxYears(sync, CLIENT_MONEY_IDS.portfolio);

    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.value.mode).toBe('country_specific');
    expect(overview.value.years).toEqual([2026, 2024]);
  });

  it('assigns a New-Year-boundary sell to its Vienna calendar year', async () => {
    const fixture = await decryptClientMoneyFixture();
    // 2024-12-31T23:30:00Z is already 2025-01-01 00:30 in Europe/Vienna.
    const document = withSellAt(
      withTaxSettings(fixture.document, 'country_specific', 'AT', null),
      '018f0000-0000-7000-8000-0000000001a2',
      '2024-12-31T23:30:00.000Z',
    );
    const sync = createMutableTestSync(document, fixture.header, fixture.envelope);

    const overview = clientTaxYears(sync, CLIENT_MONEY_IDS.portfolio);

    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.value.years).toEqual([2026, 2025]);
  });

  it('fails closed with PORTFOLIO_NOT_FOUND for a portfolio absent from the vault', async () => {
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header, fixture.envelope);

    const overview = clientTaxYears(sync, '018f0000-0000-7000-8000-00000000ffff');

    expect(overview.ok).toBe(false);
    if (overview.ok) return;
    expect(overview.error.code).toBe('PORTFOLIO_NOT_FOUND');
  });

  it('fails closed while the vault is locked', async () => {
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header, fixture.envelope);
    sync.setLocked();

    const overview = clientTaxYears(sync, CLIENT_MONEY_IDS.portfolio);

    expect(overview.ok).toBe(false);
    if (overview.ok) return;
    expect(overview.error.code).toBe('VAULT_LOCKED');
    expect(overview.error.retryable).toBe(true);
  });
});
