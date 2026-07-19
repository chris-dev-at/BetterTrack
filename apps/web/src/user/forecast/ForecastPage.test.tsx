import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AnalyticsSeriesResponse,
  PortfolioListResponse,
  PortfolioResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  getPortfolio: vi.fn(),
}));

vi.mock('../../lib/analyticsApi', () => ({
  getAnalyticsSeries: vi.fn(),
}));

import { getAnalyticsSeries } from '../../lib/analyticsApi';
import { getPortfolio, listPortfolios } from '../../lib/portfolioApi';
import { ForecastPage } from './ForecastPage';

const PORTFOLIO_ID = '11111111-1111-1111-1111-111111111111';

const PORTFOLIO_LIST: PortfolioListResponse = {
  portfolios: [
    {
      id: PORTFOLIO_ID,
      name: 'Main',
      visibility: 'private',
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

const PORTFOLIO: PortfolioResponse = {
  baseCurrency: 'EUR',
  holdings: [],
  totals: {
    marketValueEur: 42000,
    investedEur: 40000,
    unrealizedPnlEur: 2000,
    unrealizedPnlPct: 5,
    dayChangeEur: 0,
    dayChangePct: 0,
    cashEur: 8000,
    totalValueEur: 50000,
  },
};

const ANALYTICS: AnalyticsSeriesResponse = {
  portfolioId: PORTFOLIO_ID,
  baseCurrency: 'EUR',
  mode: 'perf',
  from: '2020-01-01',
  to: '2026-01-01',
  inflation: null,
  inflationPresets: [],
  primary: {
    kind: 'portfolio',
    label: 'Main',
    points: [],
    stats: {
      totalReturnPct: 40,
      cagrPct: 7,
      maxDrawdownPct: -10,
      bestDay: null,
      worstDay: null,
    },
  },
  compare: null,
  contributions: [],
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderForecast() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <ForecastPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue(PORTFOLIO_LIST);
  vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO);
  vi.mocked(getAnalyticsSeries).mockResolvedValue(ANALYTICS);
});

test('the projection view slot renders with a clearly-marked empty state', async () => {
  renderForecast();
  const heading = await screen.findByRole('heading', { name: 'Net-worth projection' });
  const section = heading.closest('section');
  expect(section).not.toBeNull();
  // The slot carries the placeholder copy the projection engine will replace.
  expect(within(section!).getByText(/lands here/i)).toBeInTheDocument();
});

test('all four calculator cards render collapsed by default (anti-bloat)', async () => {
  renderForecast();

  // Every card's toggle button starts with aria-expanded=false; the body region
  // sits under aria-controls and is not in the DOM until the toggle flips.
  const titles = [
    'Compound interest',
    'Savings plan',
    'Dividend / yield projection',
    'Withdrawal plan',
  ];
  const toggles = await Promise.all(
    titles.map((label) => screen.findByRole('button', { name: new RegExp(label, 'i') })),
  );
  for (const toggle of toggles) {
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  }

  // The first calculator input should NOT be reachable while everything is folded.
  expect(screen.queryByLabelText('Starting principal (€)')).not.toBeInTheDocument();
});

test('opening a card exposes its inputs and computed result', async () => {
  const user = userEvent.setup();
  renderForecast();

  await user.click(await screen.findByRole('button', { name: /Compound interest/i }));

  // Expanded → the input is now rendered and the derived stat lands with it.
  expect(screen.getByLabelText('Starting principal (€)')).toBeInTheDocument();
  expect(screen.getByText('Final balance')).toBeInTheDocument();
});

test('prefill from portfolio fills current value + historical average return', async () => {
  const user = userEvent.setup();
  renderForecast();

  // Wait for the prefill fetches so the button is enabled (both queries settle).
  await waitFor(() => {
    expect(getPortfolio).toHaveBeenCalledWith(PORTFOLIO_ID, expect.anything());
    expect(getAnalyticsSeries).toHaveBeenCalledWith(
      PORTFOLIO_ID,
      { mode: 'perf' },
      expect.anything(),
    );
  });

  // Compound-interest card: prefill sets principal ← totalValueEur, rate ← cagrPct.
  await user.click(screen.getByRole('button', { name: /Compound interest/i }));
  const principal = screen.getByLabelText('Starting principal (€)') as HTMLInputElement;
  const rate = screen.getByLabelText('Annual return (%)') as HTMLInputElement;
  expect(principal.value).not.toBe('50000');
  await user.click(screen.getAllByRole('button', { name: 'Prefill from my portfolio' })[0]!);
  expect(principal.value).toBe('50000');
  expect(rate.value).toBe('7');
});

test('when the portfolio prefill has no data available, cards fall back to standalone', async () => {
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(getPortfolio).mockRejectedValue(new Error('no portfolio'));
  vi.mocked(getAnalyticsSeries).mockRejectedValue(new Error('no analytics'));

  const user = userEvent.setup();
  renderForecast();

  // Prefill notice renders explaining the calculators still run standalone,
  // and the prefill button inside every card body sits disabled.
  expect(await screen.findByText(/Add or open a portfolio to enable prefill/i)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Compound interest/i }));
  const button = screen.getAllByRole('button', { name: 'Prefill from my portfolio' })[0]!;
  expect(button).toBeDisabled();
});
