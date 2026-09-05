import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import { cloneElement, isValidElement } from 'react';

import type {
  AnalyticsSeriesResponse,
  PortfolioHistoryResponse,
  PortfolioListResponse,
  PortfolioResponse,
  ProjectedDividendIncomeResponse,
} from '@bettertrack/contracts';

// Recharts' ResponsiveContainer measures the DOM (0×0 under jsdom); hand its
// child fixed dimensions so the projection chart renders without warnings.
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
  listPortfolios: vi.fn(),
  getPortfolio: vi.fn(),
  getPortfolioHistory: vi.fn(),
}));

vi.mock('../../lib/analyticsApi', () => ({
  getAnalyticsSeries: vi.fn(),
}));

// Preserve query keys + other exports the standing-orders surfaces import.
vi.mock('../../lib/standingOrdersApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/standingOrdersApi')>()),
  listStandingOrders: vi.fn(),
}));

vi.mock('../../lib/marketIntelApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/marketIntelApi')>()),
  getPortfolioDividendProjection: vi.fn(),
  getPortfolioDividendProjectionFor: vi.fn(),
}));

import { getAnalyticsSeries } from '../../lib/analyticsApi';
import { EM_DASH, formatMoney, formatPercent } from '../../lib/format';
import {
  getPortfolioDividendProjection,
  getPortfolioDividendProjectionFor,
} from '../../lib/marketIntelApi';
import { getPortfolio, getPortfolioHistory, listPortfolios } from '../../lib/portfolioApi';
import { listStandingOrders } from '../../lib/standingOrdersApi';
import { ResolvedPrivacyModeProvider } from '../vault/usePrivacyMode';
import {
  dividendPlan,
  savingsPlanYears,
  withdrawalHorizon,
  withdrawalRate,
  FORECAST_CALC_MAX_YEARS,
  FORECAST_CALC_MIN_YEARS,
  FORECAST_RETURN_MAX_PCT,
  FORECAST_RETURN_MIN_PCT,
} from './calc';
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

// Net worth (holdings + cash) over six years, with the vault's own time-weighted
// curve beside it: +50,073035 % is a 7,00 %/yr TWR. Only a paranoid account
// samples this curve.
const HISTORY: PortfolioHistoryResponse = {
  range: 'MAX',
  interval: '1d',
  baseCurrency: 'EUR',
  points: [
    { date: '2020-01-01', valueEur: 100 },
    { date: '2026-01-01', valueEur: 150.073035 },
  ],
  performance: [
    { date: '2020-01-01', pct: 0 },
    { date: '2026-01-01', pct: 50.073035 },
  ],
};

// The server's analytics series — what a NORMAL account prefills. `twr` is the
// flow-neutral return it samples (#1759); the value curve's own `cagrPct` is a
// loud decoy, so a surface reading the wrong statistic fails the assertion.
// Both differ from the net-worth TWR above, so does reading the wrong source.
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
      totalReturnPct: 600,
      cagrPct: 99,
      maxDrawdownPct: -10,
      bestDay: null,
      worstDay: null,
    },
  },
  compare: null,
  twr: { totalReturnPct: 60, cagrPct: 9.5 },
  contributions: [],
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function renderForecast(mode: 'normal' | 'paranoid' = 'normal') {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <ResolvedPrivacyModeProvider mode={mode}>
          <ForecastPage />
        </ResolvedPrivacyModeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue(PORTFOLIO_LIST);
  vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO);
  vi.mocked(getPortfolioHistory).mockResolvedValue(HISTORY);
  vi.mocked(getAnalyticsSeries).mockResolvedValue(ANALYTICS);
  vi.mocked(listStandingOrders).mockResolvedValue({ orders: [] });
  const noProjection: ProjectedDividendIncomeResponse = {
    available: false,
    currency: 'EUR',
    monthlyTotalBase: 0,
    yearlyTotalBase: 0,
    holdings: [],
  };
  vi.mocked(getPortfolioDividendProjection).mockResolvedValue(noProjection);
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue(noProjection);
});

test('shows prefill progress without hiding the standalone calculators', async () => {
  const read = deferred<PortfolioListResponse>();
  vi.mocked(listPortfolios).mockReturnValue(read.promise);
  renderForecast();

  expect(await screen.findByText('Loading portfolio data for forecasts…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Compound interest/i })).toBeInTheDocument();
  expect(screen.queryByText(/Add or open a portfolio to enable prefill/i)).not.toBeInTheDocument();

  await act(async () => {
    read.resolve(PORTFOLIO_LIST);
  });

  expect(await screen.findByRole('heading', { name: 'Net-worth projection' })).toBeInTheDocument();
});

test('retries a failed portfolio-list prefill read while calculators remain usable', async () => {
  vi.mocked(listPortfolios)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(PORTFOLIO_LIST);
  const user = userEvent.setup();
  renderForecast();

  expect(
    await screen.findByText(
      'Could not load the portfolio data used by forecasts. Please try again.',
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Compound interest/i })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByRole('heading', { name: 'Net-worth projection' })).toBeInTheDocument();
  expect(listPortfolios).toHaveBeenCalledTimes(2);
});

test('retries failed portfolio-detail and analytics prefill reads together', async () => {
  vi.mocked(getPortfolio)
    .mockRejectedValueOnce(new Error('portfolio offline'))
    .mockResolvedValueOnce(PORTFOLIO);
  vi.mocked(getAnalyticsSeries)
    .mockRejectedValueOnce(new Error('analytics offline'))
    .mockResolvedValueOnce(ANALYTICS);
  const user = userEvent.setup();
  renderForecast();

  expect(
    await screen.findByText(
      'Could not load the portfolio data used by forecasts. Please try again.',
    ),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(getPortfolio).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(getAnalyticsSeries).mock.calls.filter(([, params]) => params?.mode === 'perf'),
    ).toHaveLength(1);
  });
  expect(screen.getByRole('heading', { name: 'Net-worth projection' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Standing orders' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Try again' }));

  await waitFor(() => {
    expect(getPortfolio).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(getAnalyticsSeries).mock.calls.filter(([, params]) => params?.mode === 'perf'),
    ).toHaveLength(2);
  });
  expect(
    screen.queryByText('Could not load the portfolio data used by forecasts. Please try again.'),
  ).not.toBeInTheDocument();
});

test('an analytics-only prefill outage keeps projections and standing orders available', async () => {
  let perfReads = 0;
  vi.mocked(getAnalyticsSeries).mockImplementation((_portfolioId, params) => {
    if (params?.mode === 'perf' && perfReads++ === 0) {
      return Promise.reject(new Error('analytics offline'));
    }
    return Promise.resolve(ANALYTICS);
  });
  const user = userEvent.setup();
  renderForecast();

  expect(
    await screen.findByText(
      'Could not load the portfolio data used by forecasts. Please try again.',
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Net-worth projection' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Standing orders' })).toBeInTheDocument();
  expect(await screen.findByText('No standing orders yet')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Try again' }));

  await waitFor(() =>
    expect(
      screen.queryByText('Could not load the portfolio data used by forecasts. Please try again.'),
    ).not.toBeInTheDocument(),
  );
  expect(perfReads).toBe(2);
});

test('retries the encrypted-history prefill read in paranoid mode', async () => {
  let maxReads = 0;
  vi.mocked(getPortfolioHistory).mockImplementation((_portfolioId, range) => {
    if (range === 'MAX' && maxReads++ === 0) {
      return Promise.reject(new Error('history offline'));
    }
    return Promise.resolve(HISTORY);
  });
  const user = userEvent.setup();
  renderForecast('paranoid');

  expect(
    await screen.findByText(
      'Could not load the portfolio data used by forecasts. Please try again.',
    ),
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByRole('heading', { name: 'Net-worth projection' })).toBeInTheDocument();
  expect(
    vi.mocked(getPortfolioHistory).mock.calls.filter(([, range]) => range === 'MAX'),
  ).toHaveLength(2);
  expect(maxReads).toBe(2);
});

test('the projection engine fills the net-worth projection slot', async () => {
  renderForecast();
  const heading = await screen.findByRole('heading', { name: 'Net-worth projection' });
  const section = heading.closest('section');
  expect(section).not.toBeNull();
  // The engine (not a placeholder) fills the slot: its base series legend + stat.
  expect(await within(section!).findByTestId('projection-series-base')).toBeInTheDocument();
  expect(within(section!).getByText('Starting net worth')).toBeInTheDocument();
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

test('the dividend card bounds its Years field, so no stat degrades to an em-dash', async () => {
  const user = userEvent.setup();
  renderForecast();

  await user.click(await screen.findByRole('button', { name: /Dividend \/ yield projection/i }));
  const years = screen.getByLabelText('Years');
  expect(years).toHaveAttribute('min', String(FORECAST_CALC_MIN_YEARS));
  expect(years).toHaveAttribute('max', String(FORECAST_CALC_MAX_YEARS));

  await user.clear(years);
  await user.type(years, '1000000000');
  expect(years).toHaveValue(1000000000);

  // The card is capped at the bounded horizon rather than compounding a
  // billion years into Infinity (which formatMoney/formatPercent render as
  // an em-dash) — every stat stays a real figure.
  const bounded = dividendPlan({
    positionValue: 10000,
    yieldPctPerYear: 3,
    growthPctPerYear: 5,
    years: 1_000_000_000,
  });
  expect(screen.getByText('Total dividends').parentElement).toHaveTextContent(
    formatMoney(bounded.totalDividends),
  );
  expect(screen.getByText('Yield on cost, final year').parentElement).toHaveTextContent(
    formatPercent(bounded.yieldOnCostFinalPct),
  );
  for (const label of ['Total dividends', 'Year 1 dividend', 'Yield on cost, final year']) {
    expect(screen.getByText(label).parentElement).not.toHaveTextContent(EM_DASH);
  }
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
  // The server's time-weighted return — never the value curve's 99 % (which is
  // mostly the user's own deposits), and never the vault-only 7 %.
  expect(rate.value).toBe('9.5');
});

test('a normal account never samples the net-worth history for its return prefill', async () => {
  renderForecast();

  await waitFor(() => expect(getAnalyticsSeries).toHaveBeenCalled());
  // `getPortfolioHistory` is the holdings+cash series; sampling it here would
  // silently dilute every existing account's prefilled return with idle cash.
  expect(getPortfolioHistory).not.toHaveBeenCalledWith(
    PORTFOLIO_ID,
    'MAX',
    false,
    expect.anything(),
  );
});

test('a paranoid account prefills from its own decrypted net-worth curve', async () => {
  const user = userEvent.setup();
  renderForecast('paranoid');

  await waitFor(() =>
    expect(getPortfolioHistory).toHaveBeenCalledWith(PORTFOLIO_ID, 'MAX', false, expect.anything()),
  );
  // The analytics endpoint does not exist for an encrypted account.
  expect(getAnalyticsSeries).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: /Compound interest/i }));
  const rate = screen.getByLabelText('Annual return (%)') as HTMLInputElement;
  await user.click(screen.getAllByRole('button', { name: 'Prefill from my portfolio' })[0]!);
  expect(rate.value).toBe('7');
});

test('when the portfolio prefill has no data available, cards fall back to standalone', async () => {
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(getPortfolio).mockRejectedValue(new Error('no portfolio'));
  vi.mocked(getPortfolioHistory).mockRejectedValue(new Error('no history'));
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

test('the withdrawal card renders a bounded horizon for an absurd rate, never "NaN months"', async () => {
  const user = userEvent.setup();
  renderForecast();

  await user.click(await screen.findByRole('button', { name: /Withdrawal plan/i }));
  const rate = screen.getByLabelText('Expected annual return (%)');
  expect(rate).toHaveAttribute('min', String(FORECAST_RETURN_MIN_PCT));
  expect(rate).toHaveAttribute('max', String(FORECAST_RETURN_MAX_PCT));

  await user.clear(rate);
  await user.type(rate, '-2000');
  // The field is a bare number input with no enclosing form, so -2000 does reach
  // state — the math is what has to bound it.
  expect(rate).toHaveValue(-2000);

  // The horizon stat used to interpolate a raw NaN into its copy (it does not
  // route through formatMoney, so not even an em-dash covered for it).
  const horizon = screen.getByText('Depletion horizon').parentElement!;
  expect(horizon).not.toHaveTextContent('NaN');
  expect(horizon).not.toHaveTextContent('Infinity');
  // What it shows instead is the answer for the bounded rate.
  const bounded = withdrawalHorizon({
    balance: 100000,
    monthlyWithdrawal: 500,
    annualReturnPct: FORECAST_RETURN_MIN_PCT,
  });
  expect(horizon).toHaveTextContent(`≈ ${Math.round(bounded.months! * 10) / 10} months`);
  // …and the card says the rate was bounded rather than quietly answering a
  // different question.
  expect(
    within(document.getElementById('forecast-withdrawal-region')!).getByRole('alert'),
  ).toHaveTextContent(
    'Rates are limited to -100% to 100%. The nearest value is used for this calculation.',
  );
});

test('every calculator rate field states the clamp range', async () => {
  const user = userEvent.setup();
  renderForecast();

  const rateFields: Array<[RegExp, string[]]> = [
    [/Compound interest/i, ['Annual return (%)']],
    [/Savings plan/i, ['Annual return (%)']],
    [/Dividend \/ yield projection/i, ['Current dividend yield (%)', 'Annual dividend growth (%)']],
    [/Withdrawal plan/i, ['Expected annual return (%)']],
  ];
  for (const [card, labels] of rateFields) {
    const toggle = await screen.findByRole('button', { name: card });
    await user.click(toggle);
    for (const label of labels) {
      const field = screen.getByLabelText(label);
      expect(field, label).toHaveAttribute('min', String(FORECAST_RETURN_MIN_PCT));
      expect(field, label).toHaveAttribute('max', String(FORECAST_RETURN_MAX_PCT));
    }
    // Fold the card again before the next one: the compound and savings cards
    // share the label "Annual return (%)", and `TextField` derives the input id
    // from the label, so two open cards would collide on it.
    await user.click(toggle);
  }
});

// ─── §6.14's two inverted solve targets (savings years, sustainable rate) ─────

/** The savings card's body region, once the card is expanded. */
function savingsRegion() {
  return within(document.getElementById('forecast-savings-region')!);
}

/** The withdrawal card's body region, once the card is expanded. */
function withdrawalRegion() {
  return within(document.getElementById('forecast-withdrawal-region')!);
}

test('the savings card solves for the years needed, not only the contribution', async () => {
  const user = userEvent.setup();
  renderForecast();

  await user.click(await screen.findByRole('button', { name: /Savings plan/i }));
  // Default target: the contribution, exactly as before.
  expect(savingsRegion().getByLabelText('Years')).toBeInTheDocument();
  expect(savingsRegion().getByText('Required monthly contribution')).toBeInTheDocument();
  expect(savingsRegion().queryByText('Years needed')).not.toBeInTheDocument();

  await user.click(savingsRegion().getByRole('button', { name: 'Years' }));

  // The horizon becomes the ANSWER, so its field gives way to the contribution
  // the solver needs instead.
  expect(savingsRegion().queryByLabelText('Years')).not.toBeInTheDocument();
  expect(savingsRegion().getByLabelText('Monthly contribution (€)')).toHaveValue(500);

  const expected = savingsPlanYears({
    target: 100000,
    principal: 10000,
    monthlyContribution: 500,
    ratePctPerYear: 5,
    compoundingPerYear: 12,
  });
  expect(expected.years).not.toBeNull();
  const stat = savingsRegion().getByText('Years needed').parentElement!;
  expect(stat).toHaveTextContent(`≈ ${Math.round(expected.years! * 10) / 10} years`);
  // A real figure, never the "we could not compute this" fallbacks.
  expect(stat).not.toHaveTextContent(EM_DASH);
  expect(stat).not.toHaveTextContent('NaN');
  expect(savingsRegion().getByText('Reachable').parentElement).toHaveTextContent('Yes');
});

test('an unreachable savings target says so rather than blanking the stat', async () => {
  const user = userEvent.setup();
  renderForecast();

  await user.click(await screen.findByRole('button', { name: /Savings plan/i }));
  await user.click(savingsRegion().getByRole('button', { name: 'Years' }));

  // No return and no contribution: the target above the principal is never met,
  // which `savingsPlanYears` reports as `{ years: null, feasible: false }`.
  const rate = savingsRegion().getByLabelText('Annual return (%)');
  await user.clear(rate);
  await user.type(rate, '0');
  const contribution = savingsRegion().getByLabelText('Monthly contribution (€)');
  await user.clear(contribution);
  await user.type(contribution, '0');

  const stat = savingsRegion().getByText('Years needed').parentElement!;
  expect(stat).toHaveTextContent('Not reachable with these inputs.');
  expect(stat).not.toHaveTextContent(EM_DASH);
  expect(savingsRegion().getByText('Reachable').parentElement).toHaveTextContent('No');
});

test('the withdrawal card solves for the sustainable rate, not only the horizon', async () => {
  const user = userEvent.setup();
  renderForecast();

  await user.click(await screen.findByRole('button', { name: /Withdrawal plan/i }));
  expect(withdrawalRegion().getByText('Depletion horizon')).toBeInTheDocument();

  await user.click(withdrawalRegion().getByRole('button', { name: 'Safe withdrawal' }));

  // The monthly draw becomes the ANSWER; the horizon it has to last takes its
  // place, bounded by the same years range the rest of the suite uses.
  expect(withdrawalRegion().queryByLabelText('Monthly withdrawal (€)')).not.toBeInTheDocument();
  const horizon = withdrawalRegion().getByLabelText('Payout horizon (years)');
  expect(horizon).toHaveValue(20);
  expect(horizon).toHaveAttribute('min', String(FORECAST_CALC_MIN_YEARS));
  expect(horizon).toHaveAttribute('max', String(FORECAST_CALC_MAX_YEARS));

  const expected = withdrawalRate({ balance: 100000, months: 240, annualReturnPct: 5 });
  const stat = withdrawalRegion().getByText('Sustainable monthly withdrawal').parentElement!;
  expect(stat).toHaveTextContent(formatMoney(expected.monthlyWithdrawal));
  expect(stat).not.toHaveTextContent(EM_DASH);
  expect(stat).not.toHaveTextContent('NaN');

  // The horizon is bounded before it reaches the annuity factor, so even an
  // absurd payout period stays a figure rather than Infinity/Infinity = NaN.
  await user.clear(horizon);
  await user.type(horizon, '1000000000');
  const bounded = withdrawalRate({
    balance: 100000,
    months: FORECAST_CALC_MAX_YEARS * 12,
    annualReturnPct: 5,
  });
  const boundedStat = withdrawalRegion().getByText('Sustainable monthly withdrawal').parentElement!;
  expect(boundedStat).toHaveTextContent(formatMoney(bounded.monthlyWithdrawal));
  expect(boundedStat).not.toHaveTextContent('NaN');
});

test('both new solve targets prefill from the real portfolio', async () => {
  const user = userEvent.setup();
  renderForecast();

  await waitFor(() => {
    expect(getPortfolio).toHaveBeenCalledWith(PORTFOLIO_ID, expect.anything());
    expect(getAnalyticsSeries).toHaveBeenCalledWith(
      PORTFOLIO_ID,
      { mode: 'perf' },
      expect.anything(),
    );
  });

  const savingsToggle = screen.getByRole('button', { name: /Savings plan/i });
  await user.click(savingsToggle);
  await user.click(savingsRegion().getByRole('button', { name: 'Years' }));
  await user.click(savingsRegion().getByRole('button', { name: 'Prefill from my portfolio' }));
  expect(savingsRegion().getByLabelText('Starting principal (€)')).toHaveValue(50000);
  expect(savingsRegion().getByLabelText('Annual return (%)')).toHaveValue(9.5);
  // Fold it again: both cards label a rate field "Annual return (%)" and
  // `TextField` derives the input id from the label.
  await user.click(savingsToggle);

  await user.click(screen.getByRole('button', { name: /Withdrawal plan/i }));
  await user.click(withdrawalRegion().getByRole('button', { name: 'Safe withdrawal' }));
  await user.click(withdrawalRegion().getByRole('button', { name: 'Prefill from my portfolio' }));
  expect(withdrawalRegion().getByLabelText('Starting balance (€)')).toHaveValue(50000);
  expect(withdrawalRegion().getByLabelText('Expected annual return (%)')).toHaveValue(9.5);

  const prefilled = withdrawalRate({ balance: 50000, months: 240, annualReturnPct: 9.5 });
  expect(
    withdrawalRegion().getByText('Sustainable monthly withdrawal').parentElement,
  ).toHaveTextContent(formatMoney(prefilled.monthlyWithdrawal));
});

test('both new solve targets still compute with no portfolio at all', async () => {
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
  vi.mocked(getPortfolio).mockRejectedValue(new Error('no portfolio'));
  vi.mocked(getPortfolioHistory).mockRejectedValue(new Error('no history'));
  vi.mocked(getAnalyticsSeries).mockRejectedValue(new Error('no analytics'));

  const user = userEvent.setup();
  renderForecast();

  expect(await screen.findByText(/Add or open a portfolio to enable prefill/i)).toBeInTheDocument();

  const savingsToggle = screen.getByRole('button', { name: /Savings plan/i });
  await user.click(savingsToggle);
  await user.click(savingsRegion().getByRole('button', { name: 'Years' }));
  expect(savingsRegion().getByRole('button', { name: 'Prefill from my portfolio' })).toBeDisabled();
  const standaloneYears = savingsPlanYears({
    target: 100000,
    principal: 10000,
    monthlyContribution: 500,
    ratePctPerYear: 5,
    compoundingPerYear: 12,
  });
  expect(savingsRegion().getByText('Years needed').parentElement).toHaveTextContent(
    `≈ ${Math.round(standaloneYears.years! * 10) / 10} years`,
  );
  await user.click(savingsToggle);

  await user.click(screen.getByRole('button', { name: /Withdrawal plan/i }));
  await user.click(withdrawalRegion().getByRole('button', { name: 'Safe withdrawal' }));
  expect(
    withdrawalRegion().getByRole('button', { name: 'Prefill from my portfolio' }),
  ).toBeDisabled();
  const standaloneRate = withdrawalRate({ balance: 100000, months: 240, annualReturnPct: 5 });
  expect(
    withdrawalRegion().getByText('Sustainable monthly withdrawal').parentElement,
  ).toHaveTextContent(formatMoney(standaloneRate.monthlyWithdrawal));
});

test('the five calculator modes still fold into four top-level cards (anti-bloat)', async () => {
  const user = userEvent.setup();
  renderForecast();

  const calculators = await screen.findByRole('region', { name: 'Calculators' });
  const cardCount = () => calculators.querySelectorAll(':scope > section').length;
  // Every top-level card is a section with one expand toggle; the solve switch
  // inside a card is a pressable button, never another expandable card.
  expect(cardCount()).toBe(4);
  expect(calculators.querySelectorAll('[aria-expanded]')).toHaveLength(4);

  const savingsToggle = screen.getByRole('button', { name: /Savings plan/i });
  await user.click(savingsToggle);
  await user.click(savingsRegion().getByRole('button', { name: 'Years' }));
  await user.click(savingsToggle);
  await user.click(screen.getByRole('button', { name: /Withdrawal plan/i }));
  await user.click(withdrawalRegion().getByRole('button', { name: 'Safe withdrawal' }));

  expect(cardCount()).toBe(4);
  expect(calculators.querySelectorAll('[aria-expanded]')).toHaveLength(4);
});
