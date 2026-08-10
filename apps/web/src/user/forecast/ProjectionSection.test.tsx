import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AnalyticsSeriesResponse,
  PortfolioHistoryResponse,
  PortfolioResponse,
  PortfolioSummary,
  ProjectedDividendIncomeResponse,
  StandingOrder,
  StandingOrderListResponse,
} from '@bettertrack/contracts';

// Give Recharts' ResponsiveContainer real dimensions under jsdom (0×0 otherwise).
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            width: 600,
            height: 320,
          })
        : children,
  };
});

vi.mock('../../lib/portfolioApi', () => ({
  getPortfolio: vi.fn(),
  getPortfolioHistory: vi.fn(),
}));
vi.mock('../../lib/analyticsApi', () => ({ getAnalyticsSeries: vi.fn() }));
vi.mock('../../lib/standingOrdersApi', () => ({ listStandingOrders: vi.fn() }));
vi.mock('../../lib/marketIntelApi', () => ({ getPortfolioDividendProjection: vi.fn() }));

import { getAnalyticsSeries } from '../../lib/analyticsApi';
import { ApiError } from '../../lib/apiClient';
import { getPortfolioDividendProjection } from '../../lib/marketIntelApi';
import { getPortfolio, getPortfolioHistory } from '../../lib/portfolioApi';
import { listStandingOrders } from '../../lib/standingOrdersApi';
import { ResolvedPrivacyModeProvider } from '../vault/usePrivacyMode';
import { ProjectionSection } from './ProjectionSection';

const PORTFOLIO_ID = '11111111-1111-1111-1111-111111111111';
const HISTORY_END = new Date();
const HISTORY_START = new Date(HISTORY_END);
HISTORY_START.setUTCFullYear(HISTORY_START.getUTCFullYear() - 5);

const PORTFOLIOS: PortfolioSummary[] = [
  {
    id: PORTFOLIO_ID,
    name: 'Main',
    visibility: 'private',
    sortOrder: 0,
    isDefault: true,
    defaultPayFromCash: false,
    archivedAt: null,
  },
];

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

// Net worth (holdings + cash) — the curve only a paranoid account samples;
// 100 → 127.628 over five years is 5,00 %/yr.
const HISTORY: PortfolioHistoryResponse = {
  range: '5Y',
  interval: '1d',
  baseCurrency: 'EUR',
  points: [
    { date: HISTORY_START.toISOString().slice(0, 10), valueEur: 100 },
    { date: HISTORY_END.toISOString().slice(0, 10), valueEur: 127.628 },
  ],
  performance: [],
};

/** The server's holdings-only window — what a NORMAL account samples. */
function analytics(cagrPct: number): AnalyticsSeriesResponse {
  return {
    portfolioId: PORTFOLIO_ID,
    baseCurrency: 'EUR',
    mode: 'value',
    from: HISTORY_START.toISOString().slice(0, 10),
    to: HISTORY_END.toISOString().slice(0, 10),
    inflation: null,
    inflationPresets: [],
    primary: {
      kind: 'portfolio',
      label: 'Main',
      points: [],
      stats: {
        totalReturnPct: 30,
        cagrPct,
        maxDrawdownPct: -8,
        bestDay: null,
        worstDay: null,
      },
    },
    compare: null,
    contributions: [],
  };
}

const DIVIDENDS_OFF: ProjectedDividendIncomeResponse = {
  available: false,
  currency: 'EUR',
  monthlyTotalEur: 0,
  yearlyTotalEur: 0,
  holdings: [],
};

function makeOrder(over: Partial<StandingOrder>): StandingOrder {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    portfolioId: PORTFOLIO_ID,
    kind: 'cash-add',
    assetId: null,
    assetSymbol: null,
    assetName: null,
    amount: 500,
    currency: 'EUR',
    label: 'salary',
    cadence: 'monthly',
    anchorDay: 1,
    startDate: '2020-01-01',
    endDate: null,
    status: 'active',
    lastRunAt: null,
    lastPeriodKey: null,
    nextRunDate: '2026-02-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function renderSection(portfolios = PORTFOLIOS, mode: 'normal' | 'paranoid' = 'normal') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ResolvedPrivacyModeProvider mode={mode}>
        <ProjectionSection portfolios={portfolios} />
      </ResolvedPrivacyModeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO);
  vi.mocked(getPortfolioHistory).mockResolvedValue(HISTORY);
  vi.mocked(getAnalyticsSeries).mockResolvedValue(analytics(5));
  vi.mocked(listStandingOrders).mockResolvedValue({ orders: [] } as StandingOrderListResponse);
  vi.mocked(getPortfolioDividendProjection).mockResolvedValue(DIVIDENDS_OFF);
});

test('renders the base projection series and headline stats', async () => {
  renderSection();
  expect(await screen.findByTestId('projection-series-base')).toHaveTextContent('Projection');
  expect(screen.getByText('Starting net worth')).toBeInTheDocument();
  // The sampled historical return prefills the editable rate field.
  await waitFor(() =>
    expect((screen.getByLabelText('Return rate (%)') as HTMLInputElement).value).toBe('5'),
  );
});

test('renders a prefill read failure without hiding the projection', async () => {
  vi.mocked(getAnalyticsSeries).mockRejectedValue(new Error('analytics unavailable'));
  renderSection();

  expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
  expect(screen.getByTestId('projection-series-base')).toBeInTheDocument();
});

test('a normal account samples the holdings-only analytics window, not net worth', async () => {
  // 9,5 % on the server's series vs 5 % on the net-worth curve: the field must
  // show the former, and the net-worth read must not happen at all.
  vi.mocked(getAnalyticsSeries).mockResolvedValue(analytics(9.5));
  renderSection();

  await waitFor(() =>
    expect((screen.getByLabelText('Return rate (%)') as HTMLInputElement).value).toBe('9.5'),
  );
  expect(getAnalyticsSeries).toHaveBeenCalledWith(
    PORTFOLIO_ID,
    expect.objectContaining({ mode: 'value' }),
    expect.anything(),
  );
  expect(getPortfolioHistory).not.toHaveBeenCalled();
});

test('a paranoid account samples its decrypted net-worth curve instead', async () => {
  renderSection(PORTFOLIOS, 'paranoid');

  await waitFor(() =>
    expect((screen.getByLabelText('Return rate (%)') as HTMLInputElement).value).toBe('5'),
  );
  expect(getPortfolioHistory).toHaveBeenCalledWith(PORTFOLIO_ID, '5Y', false, expect.anything());
  expect(getAnalyticsSeries).not.toHaveBeenCalled();
});

test('renders an empty state when there is no portfolio to project', () => {
  renderSection([]);
  expect(screen.getByText('No portfolio to project yet')).toBeInTheDocument();
  expect(screen.queryByTestId('projection-series-base')).not.toBeInTheDocument();
});

test('does not start portfolio-scoped reads for an empty account when dividends are offline', () => {
  vi.mocked(getPortfolioDividendProjection).mockRejectedValue(new Error('dividends offline'));
  renderSection([]);

  expect(screen.getByText('No portfolio to project yet')).toBeInTheDocument();
  expect(getPortfolio).not.toHaveBeenCalled();
  expect(listStandingOrders).not.toHaveBeenCalled();
  expect(getAnalyticsSeries).not.toHaveBeenCalled();
  expect(getPortfolioHistory).not.toHaveBeenCalled();
  expect(getPortfolioDividendProjection).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});

// The prefill reads are handed to `AsyncReadState` as a group so each is
// classified on its own. Collapsing them with `??` made declaration order pick
// the class for all of them, so both orders are pinned here.
test('an outage declared before a confirmed rejection retries only the outage read', async () => {
  const user = userEvent.setup();
  vi.mocked(getPortfolio).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'down'));
  vi.mocked(getAnalyticsSeries).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'secret'));
  renderSection();

  const retry = await screen.findByRole('button', { name: 'Try again' });
  expect(getPortfolio).toHaveBeenCalledTimes(1);
  expect(getAnalyticsSeries).toHaveBeenCalledTimes(1);

  await user.click(retry);

  await waitFor(() => expect(getPortfolio).toHaveBeenCalledTimes(2));
  // The confirmed rejection is never re-run on another read's behalf, and the
  // healthy reads are left alone.
  expect(getAnalyticsSeries).toHaveBeenCalledTimes(1);
  expect(listStandingOrders).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('secret')).not.toBeInTheDocument();
});

test('an outage declared after a confirmed rejection keeps its own recovery', async () => {
  const user = userEvent.setup();
  vi.mocked(getAnalyticsSeries).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'secret'));
  vi.mocked(getPortfolioDividendProjection).mockRejectedValue(
    new ApiError(503, 'UNAVAILABLE', 'down'),
  );
  renderSection();

  const retry = await screen.findByRole('button', { name: 'Try again' });
  await user.click(retry);

  await waitFor(() => expect(getPortfolioDividendProjection).toHaveBeenCalledTimes(2));
  expect(getAnalyticsSeries).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('secret')).not.toBeInTheDocument();
});

test('what-if plans render as separate overlay series and can be added and removed', async () => {
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');

  // Only the base line to begin with.
  expect(screen.getAllByTestId(/^projection-series-/)).toHaveLength(1);
  expect(screen.queryByText('What-if 1')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Add what-if plan' }));

  // The overlay appears both as a plan row and a second legend series.
  expect(await screen.findByText('What-if 1')).toBeInTheDocument();
  expect(screen.getAllByTestId(/^projection-series-/)).toHaveLength(2);

  await user.click(screen.getByRole('button', { name: 'Remove' }));

  expect(screen.queryByText('What-if 1')).not.toBeInTheDocument();
  expect(screen.getAllByTestId(/^projection-series-/)).toHaveLength(1);
});

test('the base line responds when the standing-orders factor is toggled off', async () => {
  vi.mocked(listStandingOrders).mockResolvedValue({
    orders: [makeOrder({ kind: 'cash-add', amount: 500 })],
  } as StandingOrderListResponse);
  const user = userEvent.setup();
  renderSection();

  const base = await screen.findByTestId('projection-series-base');
  await waitFor(() => expect(base).toHaveTextContent(/\d/));
  const withOrders = base.textContent;

  await user.click(screen.getByRole('checkbox', { name: 'Standing orders' }));

  await waitFor(() =>
    expect(screen.getByTestId('projection-series-base').textContent).not.toBe(withOrders),
  );
});

test('the return factor toggle hides the sampling controls', async () => {
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');

  expect(screen.getByLabelText('Return rate (%)')).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'Average return' }));
  expect(screen.queryByLabelText('Return rate (%)')).not.toBeInTheDocument();
});

test('clamps an out-of-range return rate instead of rendering NaN', async () => {
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');

  const returnRate = screen.getByLabelText('Return rate (%)');
  expect(returnRate).toHaveAttribute('min', '-100');
  expect(returnRate).toHaveAttribute('max', '100');

  await waitFor(() => expect(returnRate).toHaveValue(5));

  await user.clear(returnRate);
  await user.type(returnRate, '-200');

  await waitFor(() => expect(returnRate).toHaveValue(-200));
  await waitFor(() =>
    expect(screen.getByTestId('projection-series-base')).toHaveTextContent('0,00 €'),
  );
  expect(screen.getByTestId('projection-series-base')).not.toHaveTextContent('NaN');
  expect(screen.getByRole('alert')).toHaveTextContent(
    'The return rate is limited to -100% to 100%. The nearest value is used for this projection.',
  );
});

test('the dividend factor toggle is hidden when the provider is unconfigured', async () => {
  renderSection();
  await screen.findByTestId('projection-series-base');
  // Provider off ⇒ no dividend toggle, and the surface still renders cleanly.
  expect(screen.queryByRole('checkbox', { name: 'Projected dividends' })).not.toBeInTheDocument();
});

test('the dividend factor toggle appears when the provider is configured', async () => {
  vi.mocked(getPortfolioDividendProjection).mockResolvedValue({
    available: true,
    currency: 'EUR',
    monthlyTotalEur: 100,
    yearlyTotalEur: 1200,
    holdings: [],
  });
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');

  const toggle = await screen.findByRole('checkbox', { name: 'Projected dividends' });
  expect(toggle).toBeInTheDocument();

  // Turning dividends off changes the projected base line.
  const before = screen.getByTestId('projection-series-base').textContent;
  await user.click(toggle);
  await waitFor(() =>
    expect(screen.getByTestId('projection-series-base').textContent).not.toBe(before),
  );
});
