import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  CashMonthlySummaryResponse,
  CashTrendResponse,
  PortfolioListResponse,
} from '@bettertrack/contracts';

vi.mock('../../../lib/portfolioApi');
vi.mock('../../../lib/cashApi', () => ({
  cashSummaryQueryKey: (portfolioId: string, month?: string) => [
    'cash',
    'summary',
    portfolioId,
    month,
  ],
  cashTrendsQueryKey: (portfolioId: string, months?: number) => [
    'cash',
    'trends',
    portfolioId,
    months,
  ],
  getCashSummary: vi.fn(),
  getCashTrends: vi.fn(),
}));

import { getCashMovements, listCashSources, listPortfolios } from '../../../lib/portfolioApi';
import { getCashSummary, getCashTrends } from '../../../lib/cashApi';

import { CashOverviewPage } from './CashOverviewPage';

const PORTFOLIOS: PortfolioListResponse = {
  portfolios: [
    {
      id: 'p1',
      name: 'Main',
      visibility: 'private',
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

const EMPTY_TRENDS: CashTrendResponse = { portfolioId: 'p1', points: [] };

function summary(over: Partial<CashMonthlySummaryResponse> = {}): CashMonthlySummaryResponse {
  return {
    portfolioId: 'p1',
    month: '2026-07',
    totalInflow: 0,
    totalOutflow: 0,
    net: 0,
    tags: [],
    ...over,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CashOverviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue(PORTFOLIOS);
  vi.mocked(getCashTrends).mockResolvedValue(EMPTY_TRENDS);
  vi.mocked(getCashSummary).mockResolvedValue(summary());
  // The overview now also opens on the BALANCE, so it reads the portfolio's
  // cash sources and its ledger. Both are auto-mocked by `vi.mock` above; give
  // them empty-but-valid shapes so a case that does not care about them still
  // renders the rest of the page.
  vi.mocked(listCashSources).mockResolvedValue({ sources: [] });
  vi.mocked(getCashMovements).mockResolvedValue({
    balanceEur: 0,
    movements: [],
    sources: [],
  } as unknown as Awaited<ReturnType<typeof getCashMovements>>);
});

describe('CashOverviewPage', () => {
  test('renders in/out/net for the resolved portfolio', async () => {
    vi.mocked(getCashSummary).mockResolvedValue(
      summary({ totalInflow: 4_200, totalOutflow: 1_000, net: 3_200 }),
    );
    renderPage();

    // No I18nProvider wraps this render (mirrors CashSourcesPage.test.tsx), so
    // `formatMoney` renders under its de-AT module default: "1.234,56 €".
    // In/out sit together on the month line; the net reads as a change against
    // the balance above it ("… this month") rather than as a third bare figure,
    // so it is matched inside its sentence.
    expect(await screen.findByText(/4\.200,00/)).toBeInTheDocument();
    expect(screen.getByText(/1\.000,00/)).toBeInTheDocument();
    expect(screen.getByText(/3\.200,00.*this month/)).toBeInTheDocument();
  });

  test('states plainly that per-tag rows do not sum to the total', async () => {
    vi.mocked(getCashSummary).mockResolvedValue(
      summary({
        totalOutflow: 500,
        tags: [
          {
            tagId: 't1',
            name: 'Food',
            color: '#22c55e',
            system: false,
            outflow: 300,
            inflow: 0,
            movements: 2,
          },
          {
            tagId: 't2',
            name: 'Groceries',
            color: '#3987e5',
            system: false,
            outflow: 300,
            inflow: 0,
            movements: 2,
          },
        ],
      }),
    );
    renderPage();

    // Scoped to the ranked bars: the donut beside them carries the same labels.
    const bars = await screen.findByRole('list', { name: 'Spending by tag' });
    expect(within(bars).getByText('Food')).toBeInTheDocument();
    expect(within(bars).getByText('Groceries')).toBeInTheDocument();
    // 300 + 300 ≠ 500 — the note explaining why must be on screen, not just implied.
    expect(
      screen.getByText(
        "Tag totals overlap — a movement with two tags counts toward both, so they won't add up to the total above.",
      ),
    ).toBeInTheDocument();
  });

  test('labels the untagged bucket instead of rendering a blank tag chip', async () => {
    vi.mocked(getCashSummary).mockResolvedValue(
      summary({
        totalOutflow: 100,
        tags: [
          {
            tagId: null,
            name: null,
            color: null,
            system: false,
            outflow: 100,
            inflow: 0,
            movements: 1,
          },
        ],
      }),
    );
    renderPage();

    const bars = await screen.findByRole('list', { name: 'Spending by tag' });
    expect(within(bars).getByText('Untagged')).toBeInTheDocument();
  });

  test('omits the breakdown and its note when nothing happened this month', async () => {
    renderPage();

    expect(await screen.findByText('No cash movements recorded this month.')).toBeInTheDocument();
    expect(screen.queryByText(/Tag totals overlap/)).not.toBeInTheDocument();
  });

  test('renders a load error when the summary request fails', async () => {
    vi.mocked(getCashSummary).mockRejectedValue(new Error('offline'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the cash overview.");
  });
});
