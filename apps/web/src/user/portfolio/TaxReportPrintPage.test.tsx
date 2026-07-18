import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { TaxYearReportResponse } from '@bettertrack/contracts';

vi.mock('../../lib/portfolioApi');
import * as portfolioApi from '../../lib/portfolioApi';

import { TaxReportPrintPage } from './TaxReportPrintPage';

const PORTFOLIO_LIST = {
  portfolios: [
    {
      id: 'p1',
      name: 'Main',
      visibility: 'private' as const,
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

const APPLE = {
  id: 'a1',
  symbol: 'AAPL',
  name: 'Apple',
  exchange: 'NASDAQ',
  currency: 'USD',
  type: 'stock' as const,
  isCustom: false,
};

const AT_REPORT: TaxYearReportResponse = {
  year: 2026,
  summary: {
    year: 2026,
    realizedPnlEur: 350,
    dividendsGrossEur: 40,
    taxWithheldEur: 123.75,
    taxRefundedEur: 27.5,
    taxNetEur: 96.25,
  },
  positions: [
    {
      asset: APPLE,
      realizedPnlEur: 350,
      dividendsGrossEur: 40,
      taxEur: 107.25,
      sells: [
        {
          transactionId: 't1',
          executedAt: '2026-03-04T10:00:00.000Z',
          quantity: 5,
          proceedsEur: 1000,
          costBasisEur: 650,
          realizedPnlEur: 350,
          taxMode: 'country_specific',
          taxAmountEur: 96.25,
        },
      ],
      dividends: [
        {
          dividendId: 'd1',
          executedAt: '2026-06-01T00:00:00.000Z',
          grossAmountEur: 40,
          taxMode: 'country_specific',
          taxAmountEur: 11,
        },
      ],
    },
  ],
};

const DE_REPORT: TaxYearReportResponse = {
  year: 2025,
  summary: {
    year: 2025,
    realizedPnlEur: 1250,
    dividendsGrossEur: 0,
    taxWithheldEur: 263.75,
    taxRefundedEur: 197.82,
    taxNetEur: 65.93,
    de: {
      allowanceUsedEur: 1000,
      allowanceRemainingEur: 0,
      aktienPotInEur: 800,
      aktienPotOutEur: 0,
      sonstigePotInEur: 0,
      sonstigePotOutEur: 300,
      kapestEur: 62.5,
      soliEur: 3.43,
    },
  },
  positions: [
    {
      asset: APPLE,
      realizedPnlEur: 1250,
      dividendsGrossEur: 0,
      taxEur: 65.93,
      sells: [],
      dividends: [],
    },
  ],
};

function renderPrint(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <TaxReportPrintPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.print = vi.fn();
  vi.mocked(portfolioApi.listPortfolios).mockResolvedValue(PORTFOLIO_LIST);
  vi.mocked(portfolioApi.getTaxYearReport).mockResolvedValue(AT_REPORT);
});

describe('TaxReportPrintPage', () => {
  test('renders the full year report — same numbers as the on-screen report — and opens print', async () => {
    renderPrint('/portfolio/tax/print?portfolio=p1&year=2026');

    // Summary numbers (realized appears in the summary, the position total and
    // the sell row — all the same value, so match all).
    expect((await screen.findAllByText('350,00 €')).length).toBeGreaterThan(0); // realized
    expect(screen.getByText('123,75 €')).toBeInTheDocument(); // withheld
    expect(screen.getAllByText('96,25 €').length).toBeGreaterThan(0); // net + sell tax
    // The sell + dividend drill-down.
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('650,00 €')).toBeInTheDocument(); // cost basis
    expect(screen.getAllByText('40,00 €').length).toBeGreaterThan(0); // dividend gross

    // The whole point of the route: the print dialog is opened once loaded.
    expect(window.print).toHaveBeenCalled();
  });

  test('renders the German year-end block for a DE year', async () => {
    vi.mocked(portfolioApi.getTaxYearReport).mockResolvedValue(DE_REPORT);
    renderPrint('/portfolio/tax/print?portfolio=p1&year=2025');

    expect(await screen.findByText('Germany (Abgeltungsteuer)')).toBeInTheDocument();
    expect(screen.getByText('1.000,00 €')).toBeInTheDocument(); // allowance used
    expect(screen.getByText('62,50 €')).toBeInTheDocument(); // KapESt
    expect(screen.getByText('3,43 €')).toBeInTheDocument(); // Soli
  });

  test('an empty year prints a graceful, labeled document', async () => {
    vi.mocked(portfolioApi.getTaxYearReport).mockResolvedValue({
      year: 2019,
      summary: {
        year: 2019,
        realizedPnlEur: 0,
        dividendsGrossEur: 0,
        taxWithheldEur: 0,
        taxRefundedEur: 0,
        taxNetEur: 0,
      },
      positions: [],
    });
    renderPrint('/portfolio/tax/print?portfolio=p1&year=2019');

    expect(
      await screen.findByText(/No taxable sells or dividends recorded in this year/i),
    ).toBeInTheDocument();
    // Still a real, labeled report (the title + summary render).
    expect(screen.getByRole('heading', { name: /Tax report/i })).toBeInTheDocument();
  });

  test('missing params render a hint instead of querying', async () => {
    renderPrint('/portfolio/tax/print');
    expect(await screen.findByText(/Choose a portfolio and year to print/i)).toBeInTheDocument();
    expect(portfolioApi.getTaxYearReport).not.toHaveBeenCalled();
  });
});
