import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { PortfolioAsset, TaxYearReportResponse, TaxYearSummary } from '@bettertrack/contracts';

vi.mock('../../lib/portfolioApi');

import * as portfolioApi from '../../lib/portfolioApi';
import { TaxReportPage } from './TaxReportPage';

// This portfolio's effective tax view (issue #636): the report reads the mode
// per portfolio, not the user-level default. AT is the default fixture.
const AT_TAX_VIEW = {
  effective: { mode: 'country_specific' as const, country: 'AT' as const },
  override: null,
  userDefault: { mode: 'country_specific' as const, country: 'AT' as const },
  source: 'user' as const,
};

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

// Owner's canonical year (§13.3 V3-P4): +450 taxed, −100 loss same year ⇒
// net tax = 27.5 % × 350 = 96.25, with a 27.50 refund line from the loss offset.
const YEAR_2026: TaxYearSummary = {
  year: 2026,
  realizedPnlEur: 350,
  dividendsGrossEur: 0,
  taxWithheldEur: 123.75,
  taxRefundedEur: 27.5,
  taxNetEur: 96.25,
};

const APPLE: PortfolioAsset = {
  id: 'a1',
  symbol: 'AAPL',
  name: 'Apple',
  exchange: 'NASDAQ',
  currency: 'USD',
  type: 'stock',
  isCustom: false,
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TaxReportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(portfolioApi.listPortfolios).mockResolvedValue(PORTFOLIO_LIST);
  vi.mocked(portfolioApi.getPortfolioTaxSettings).mockResolvedValue(AT_TAX_VIEW);
  vi.mocked(portfolioApi.getTaxYearReports).mockResolvedValue({ years: [YEAR_2026] });
  vi.mocked(portfolioApi.taxYearReportCsvUrl).mockImplementation(
    (pid, year, locale) =>
      `/api/v1/portfolios/${pid}/reports/tax-years/${year}/export.csv?locale=${locale}`,
  );
});

describe('TaxReportPage', () => {
  test('with this portfolio inheriting `none`, shows the off state + a default editor link, never queries the report', async () => {
    vi.mocked(portfolioApi.getPortfolioTaxSettings).mockResolvedValue({
      effective: { mode: 'none', country: null },
      override: null,
      userDefault: { mode: 'none', country: null },
      source: 'system',
    });
    renderPage();

    expect(await screen.findByText(/Tax tracking is off/i)).toBeInTheDocument();
    // The per-portfolio treatment control offers a link to edit the user default.
    expect(screen.getByRole('link', { name: /Edit the default/i })).toHaveAttribute(
      'href',
      '/settings/taxes',
    );
    // Wait a tick to be sure the (disabled) report query truly never fired.
    await waitFor(() => expect(portfolioApi.getPortfolioTaxSettings).toHaveBeenCalled());
    expect(portfolioApi.getTaxYearReports).not.toHaveBeenCalled();
  });

  test('renders a per-year row: realized P/L, tax withheld, the refund line, and the net total', async () => {
    renderPage();

    const yearRow = (await screen.findByRole('button', { name: /Show 2026 details/i })).closest(
      'tr',
    ) as HTMLElement;
    const cells = within(yearRow).getAllByRole('cell');
    // year | realized | dividends | withheld | refund | net
    expect(cells[1]).toHaveTextContent('350,00 €'); // realized P/L
    expect(cells[3]).toHaveTextContent('123,75 €'); // tax withheld
    expect(cells[4]).toHaveTextContent('27,50 €'); // loss-offset refund line
    expect(cells[5]).toHaveTextContent('96,25 €'); // net tax = 27.5 % × 350
  });

  test('empty history shows the empty state', async () => {
    vi.mocked(portfolioApi.getTaxYearReports).mockResolvedValue({ years: [] });
    renderPage();
    expect(await screen.findByText(/No tax activity yet/i)).toBeInTheDocument();
  });

  test('load failure shows the error state', async () => {
    vi.mocked(portfolioApi.getTaxYearReports).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(/Couldn’t load your tax report/i)).toBeInTheDocument();
  });

  test('a failing portfolio list shows the error state instead of an eternal skeleton', async () => {
    vi.mocked(portfolioApi.listPortfolios).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(/Couldn’t load your tax report/i)).toBeInTheDocument();
    expect(portfolioApi.getTaxYearReports).not.toHaveBeenCalled();
  });

  test('a failing tax-settings query shows the error state, not the "tax tracking off" state', async () => {
    // On a settings failure `mode` falls back to 'none'; the error must win over
    // the disabled gate so the user is not wrongly told tax is simply off.
    vi.mocked(portfolioApi.getPortfolioTaxSettings).mockRejectedValue(new Error('boom'));
    renderPage();
    // The error surfaces in both the treatment control and the report area.
    expect((await screen.findAllByText(/Couldn’t load your tax report/i)).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText(/Tax tracking is off/i)).not.toBeInTheDocument();
    expect(portfolioApi.getTaxYearReports).not.toHaveBeenCalled();
  });

  test('no portfolios at all shows the empty state instead of an eternal skeleton', async () => {
    vi.mocked(portfolioApi.listPortfolios).mockResolvedValue({ portfolios: [] });
    renderPage();
    expect(await screen.findByText(/No tax activity yet/i)).toBeInTheDocument();
    expect(portfolioApi.getTaxYearReports).not.toHaveBeenCalled();
  });

  test('an uncovered sell (#369) renders its real basis — no fabricated gain on the uncovered portion', async () => {
    const report: TaxYearReportResponse = {
      year: 2026,
      summary: YEAR_2026,
      positions: [
        {
          asset: APPLE,
          realizedPnlEur: 0,
          dividendsGrossEur: 0,
          taxEur: 0,
          sells: [
            {
              transactionId: 't1',
              executedAt: '2026-03-01T00:00:00.000Z',
              quantity: 5,
              proceedsEur: 500, // sold for 500…
              costBasisEur: 500, // …basised at the sale price (uncovered, option A)
              realizedPnlEur: 0, // …so realized is 0, NEVER a phantom 500 gain
              taxMode: 'country_specific',
              taxAmountEur: 0,
            },
          ],
          dividends: [],
        },
      ],
    };
    vi.mocked(portfolioApi.getTaxYearReport).mockResolvedValue(report);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Show 2026 details/i }));
    await screen.findByText('AAPL'); // drill-down loaded

    // The sell row is the only leaf (6-cell) row carrying the 500,00 € proceeds.
    const sellRow = screen.getAllByRole('row').find((r) => {
      const cells = within(r).queryAllByRole('cell');
      return cells.length === 6 && within(r).queryAllByText('500,00 €').length > 0;
    });
    expect(sellRow).toBeDefined();
    const cells = within(sellRow!).getAllByRole('cell');
    // date | qty | proceeds | costBasis | realized | tax
    expect(cells[2]).toHaveTextContent('500,00 €'); // proceeds
    expect(cells[3]).toHaveTextContent('500,00 €'); // cost basis (= proceeds)
    expect(cells[4]).toHaveTextContent('0,00 €'); // realized P/L — no fabricated gain
    expect(cells[4]).not.toHaveTextContent('500');
  });

  test('a DE year renders the compact Germany block — allowance, pots, KapESt/Soli split', async () => {
    // The S8-shaped DE year (V5-P4, #576): 1,250 net gain over an 800 pot,
    // allowance exhausted, 62.50 KapESt + 3.43 Soli, a 300 Sonstige pot out.
    const DE_YEAR: TaxYearSummary = {
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
    };
    vi.mocked(portfolioApi.getTaxYearReports).mockResolvedValue({ years: [DE_YEAR] });
    vi.mocked(portfolioApi.getTaxYearReport).mockResolvedValue({
      year: 2025,
      summary: DE_YEAR,
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
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Show 2025 details/i }));
    // "Germany (Abgeltungsteuer)" now also labels the per-portfolio tax picker, so
    // assert on DE-block-unique copy (issue #636).
    expect(await screen.findByText(/Allowance used/i)).toBeInTheDocument();
    expect(screen.getByText('1.000,00 €')).toBeInTheDocument(); // allowance used
    expect(screen.getByText('62,50 €')).toBeInTheDocument(); // KapESt
    expect(screen.getByText('3,43 €')).toBeInTheDocument(); // Soli (floored, statutory)
    expect(screen.getByText(/Share-loss pot/i)).toBeInTheDocument();
    expect(screen.getByText('800,00 €')).toBeInTheDocument(); // Aktien pot in
  });

  test('an AT year renders NO Germany block', async () => {
    vi.mocked(portfolioApi.getTaxYearReport).mockResolvedValue({
      year: 2026,
      summary: YEAR_2026,
      positions: [
        {
          asset: APPLE,
          realizedPnlEur: 350,
          dividendsGrossEur: 0,
          taxEur: 96.25,
          sells: [],
          dividends: [],
        },
      ],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Show 2026 details/i }));
    await screen.findByText('AAPL');
    // DE-block-unique copy (the "Germany (Abgeltungsteuer)" string also labels the
    // per-portfolio tax picker now, #636); the DE report block must be absent.
    expect(screen.queryByText(/Allowance used/i)).not.toBeInTheDocument();
  });

  test('an expanded year offers CSV export and a print/PDF link scoped to that year', async () => {
    vi.mocked(portfolioApi.getTaxYearReport).mockResolvedValue({
      year: 2026,
      summary: YEAR_2026,
      positions: [
        {
          asset: APPLE,
          realizedPnlEur: 350,
          dividendsGrossEur: 0,
          taxEur: 96.25,
          sells: [],
          dividends: [],
        },
      ],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Show 2026 details/i }));
    await screen.findByText('AAPL');

    const csv = screen.getByRole('link', { name: /Export CSV/i });
    expect(csv).toHaveAttribute(
      'href',
      '/api/v1/portfolios/p1/reports/tax-years/2026/export.csv?locale=en',
    );
    expect(csv).toHaveAttribute('download');
    expect(portfolioApi.taxYearReportCsvUrl).toHaveBeenCalledWith('p1', 2026, 'en');

    const print = screen.getByRole('link', { name: /Print \/ PDF/i });
    expect(print).toHaveAttribute('href', '/portfolio/tax/print?portfolio=p1&year=2026');
  });
});
