import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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
// Keep the real query-key helpers (the section imports the scoped one).
vi.mock('../../lib/marketIntelApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/marketIntelApi')>()),
  getPortfolioDividendProjectionFor: vi.fn(),
}));

// Deploy-time market intel (§13.5 V5-P5) vs. a projection this portfolio could
// not resolve (#1681) are separate states, and the dividend factor renders them
// differently — absent vs. present-but-disabled. Drive the capability directly.
const deployCapabilities = vi.hoisted(() => ({ marketIntel: true }));
vi.mock('../../lib/featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/featureFlags')>()),
  useDeployCapability: (key: string) =>
    key === 'marketIntel' ? deployCapabilities.marketIntel : true,
}));

import { getAnalyticsSeries } from '../../lib/analyticsApi';
import { ApiError } from '../../lib/apiClient';
import { formatMoney, setMoneyCurrency } from '../../lib/format';
import { getPortfolioDividendProjectionFor } from '../../lib/marketIntelApi';
import { getPortfolio, getPortfolioHistory } from '../../lib/portfolioApi';
import { listStandingOrders } from '../../lib/standingOrdersApi';
import {
  STANDING_ORDER_SCHEDULE_TZ,
  calendarDayInTimezone,
} from '../vault/standingOrders/schedule';
import { ResolvedPrivacyModeProvider } from '../vault/usePrivacyMode';
import {
  monthlyRateFromAnnualPct,
  normalizeStandingOrders,
  projectNetWorth,
  type ForecastResult,
} from './projection';
import { ProjectionSection } from './ProjectionSection';

const PORTFOLIO_ID = '11111111-1111-1111-1111-111111111111';
/** The return factor's accessible name — it now says what it measures (#1759). */
const RETURN_FACTOR = 'Average return (excluding deposits)';
const RETURN_RATE = 'Return rate (%)';
// The section anchors its sampling window on "today" in the schedule's timezone
// (`todayIso()`), not in UTC, and the paranoid branch trims the history envelope
// to `today − 5Y` itself. Anchoring this fixture in UTC instead put its first
// point one day OUTSIDE that window whenever Vienna had already rolled over and
// UTC had not — between 22:00 and 24:00 UTC in summer — which left the curve
// with a single point, no statable CAGR and an empty rate field. Resolve the
// fixture's "today" the same way the component does so the window holds at
// every hour of the day.
const HISTORY_END_ISO = calendarDayInTimezone(new Date(), STANDING_ORDER_SCHEDULE_TZ);
const HISTORY_START = new Date(`${HISTORY_END_ISO}T00:00:00Z`);
HISTORY_START.setUTCFullYear(HISTORY_START.getUTCFullYear() - 5);
const HISTORY_START_ISO = HISTORY_START.toISOString().slice(0, 10);

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
    { date: HISTORY_START_ISO, valueEur: 100 },
    { date: HISTORY_END_ISO, valueEur: 127.628 },
  ],
  // The vault's own time-weighted curve — what a PARANOID account samples.
  // +27,628 % over five years is 5,00 %/yr.
  performance: [
    { date: HISTORY_START_ISO, pct: 0 },
    { date: HISTORY_END_ISO, pct: 27.628 },
  ],
};

/**
 * The server's window. `twr` is the flow-neutral return the section samples
 * (#1759); `primary.stats.cagrPct` is the value curve's contribution-inflated
 * one and is left as a loud decoy — sampling it again must fail here.
 */
function analytics(twrCagrPct: number, valueCagrPct = 99): AnalyticsSeriesResponse {
  return {
    portfolioId: PORTFOLIO_ID,
    baseCurrency: 'EUR',
    mode: 'value',
    from: HISTORY_START_ISO,
    to: HISTORY_END_ISO,
    inflation: null,
    inflationPresets: [],
    primary: {
      kind: 'portfolio',
      label: 'Main',
      points: [],
      stats: {
        totalReturnPct: 300,
        cagrPct: valueCagrPct,
        maxDrawdownPct: -8,
        bestDay: null,
        worstDay: null,
      },
    },
    compare: null,
    twr: { totalReturnPct: 30, cagrPct: twrCagrPct },
    contributions: [],
  };
}

const DIVIDENDS_OFF: ProjectedDividendIncomeResponse = {
  available: false,
  currency: 'EUR',
  monthlyTotalBase: 0,
  yearlyTotalBase: 0,
  basis: null,
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

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderSection(
  portfolios = PORTFOLIOS,
  mode: 'normal' | 'paranoid' = 'normal',
  client = makeClient(),
) {
  return render(
    <QueryClientProvider client={client}>
      <ResolvedPrivacyModeProvider mode={mode}>
        <ProjectionSection portfolios={portfolios} />
      </ResolvedPrivacyModeProvider>
    </QueryClientProvider>,
  );
}

/** The final projected value of a run — the figure the headline stat shows. */
function last(result: ForecastResult): number {
  return result.base[result.base.length - 1]!.value;
}

/** The card whose label names the horizon, so label and value are read together. */
function projectedStat(): HTMLElement {
  return screen.getByText(/^Projected in /).parentElement!;
}

/**
 * The engine's own answer for a horizon, on the same factors the section runs
 * with in these tests (50 000 € start, 5 %/yr, no orders, no dividends). `asOf`
 * is irrelevant without standing orders — nothing is booked on a calendar day.
 */
function engineFinalValue(horizonYears: number, monthlyDividend = 0): number {
  const result = projectNetWorth({
    asOf: '2026-01-01',
    startingNetWorth: 50000,
    horizonYears,
    annualReturnPct: 5,
    standingOrders: [],
    monthlyDividend,
    whatIfPlans: [],
  });
  return result.base[result.base.length - 1]!.value;
}

/**
 * The same run with the RETURN factor off — the one state in which projected
 * dividend income is a flow of its own (#1892). With a return assumption in
 * play the sampled TWR already contains the distributions, so the engine does
 * not add them a second time and this is where the income is observable.
 */
function engineIncomeOnlyValue(horizonYears: number, monthlyDividend: number): number {
  const result = projectNetWorth({
    asOf: '2026-01-01',
    startingNetWorth: 50000,
    horizonYears,
    annualReturnPct: null,
    standingOrders: [],
    monthlyDividend,
    whatIfPlans: [],
  });
  return result.base[result.base.length - 1]!.value;
}

/** Untick the return factor, so the dividend factor becomes the live one. */
async function switchOffReturnFactor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('checkbox', { name: RETURN_FACTOR }));
}

beforeEach(() => {
  vi.clearAllMocks();
  deployCapabilities.marketIntel = true;
  vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO);
  vi.mocked(getPortfolioHistory).mockResolvedValue(HISTORY);
  vi.mocked(getAnalyticsSeries).mockResolvedValue(analytics(5));
  vi.mocked(listStandingOrders).mockResolvedValue({ orders: [] } as StandingOrderListResponse);
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue(DIVIDENDS_OFF);
});

test('renders the base projection series and headline stats', async () => {
  renderSection();
  expect(await screen.findByTestId('projection-series-base')).toHaveTextContent('Projection');
  expect(screen.getByText('Starting net worth')).toBeInTheDocument();
  // The sampled historical return prefills the editable rate field.
  await waitFor(() =>
    expect((screen.getByLabelText(RETURN_RATE) as HTMLInputElement).value).toBe('5'),
  );
});

test('renders a prefill read failure without hiding the projection', async () => {
  vi.mocked(getAnalyticsSeries).mockRejectedValue(new Error('analytics unavailable'));
  renderSection();

  expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
  expect(screen.getByTestId('projection-series-base')).toBeInTheDocument();
});

test('a normal account samples the server’s time-weighted return, not the value CAGR', async () => {
  // 9,5 % time-weighted against a 99 % value-curve CAGR — the number a monthly
  // saver's own deposits produce. The field must show the former (#1759).
  vi.mocked(getAnalyticsSeries).mockResolvedValue(analytics(9.5, 99));
  renderSection();

  await waitFor(() =>
    expect((screen.getByLabelText(RETURN_RATE) as HTMLInputElement).value).toBe('9.5'),
  );
  expect((screen.getByLabelText(RETURN_RATE) as HTMLInputElement).value).not.toBe('99');
  expect(getAnalyticsSeries).toHaveBeenCalledWith(
    PORTFOLIO_ID,
    expect.objectContaining({ mode: 'value' }),
    expect.anything(),
  );
  expect(getPortfolioHistory).not.toHaveBeenCalled();
});

test('a normal account states no return when the server cannot state one', async () => {
  vi.mocked(getAnalyticsSeries).mockResolvedValue({ ...analytics(5), twr: null });
  renderSection();

  await screen.findByTestId('projection-series-base');
  await waitFor(() =>
    expect((screen.getByLabelText(RETURN_RATE) as HTMLInputElement).value).toBe(''),
  );
});

test('a paranoid account samples its decrypted time-weighted curve instead', async () => {
  renderSection(PORTFOLIOS, 'paranoid');

  await waitFor(() =>
    expect((screen.getByLabelText(RETURN_RATE) as HTMLInputElement).value).toBe('5'),
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
  vi.mocked(getPortfolioDividendProjectionFor).mockRejectedValue(new Error('dividends offline'));
  renderSection([]);

  expect(screen.getByText('No portfolio to project yet')).toBeInTheDocument();
  expect(getPortfolio).not.toHaveBeenCalled();
  expect(listStandingOrders).not.toHaveBeenCalled();
  expect(getAnalyticsSeries).not.toHaveBeenCalled();
  expect(getPortfolioHistory).not.toHaveBeenCalled();
  expect(getPortfolioDividendProjectionFor).not.toHaveBeenCalled();
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
  vi.mocked(getPortfolioDividendProjectionFor).mockRejectedValue(
    new ApiError(503, 'UNAVAILABLE', 'down'),
  );
  renderSection();

  const retry = await screen.findByRole('button', { name: 'Try again' });
  await user.click(retry);

  await waitFor(() => expect(getPortfolioDividendProjectionFor).toHaveBeenCalledTimes(2));
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

  expect(screen.getByLabelText(RETURN_RATE)).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: RETURN_FACTOR }));
  expect(screen.queryByLabelText(RETURN_RATE)).not.toBeInTheDocument();
});

test('clamps an out-of-range return rate instead of rendering NaN', async () => {
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');

  const returnRate = screen.getByLabelText(RETURN_RATE);
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

test('an integer horizon reproduces the hand-computed compounded figure', async () => {
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');
  await waitFor(() =>
    expect((screen.getByLabelText(RETURN_RATE) as HTMLInputElement).value).toBe('5'),
  );

  // 50 000 € compounded at the prefilled 5 %/yr (monthly steps at the annual
  // rate's 12th root): 50 000·1,05² = 55 125,00 and 50 000·1,05³ = 57 881,25.
  expect(engineFinalValue(2)).toBeCloseTo(55125, 2);
  expect(engineFinalValue(3)).toBeCloseTo(57881.25, 2);

  const horizon = screen.getByLabelText('Horizon (years)');
  await user.clear(horizon);
  await user.type(horizon, '2');
  await waitFor(() => expect(projectedStat()).toHaveTextContent('Projected in 2 years'));
  expect(projectedStat()).toHaveTextContent(formatMoney(55125));

  await user.clear(horizon);
  await user.type(horizon, '3');
  await waitFor(() => expect(projectedStat()).toHaveTextContent('Projected in 3 years'));
  expect(projectedStat()).toHaveTextContent(formatMoney(57881.25));
});

test('a fractional horizon labels the integer horizon the engine actually projects', async () => {
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');
  await waitFor(() =>
    expect((screen.getByLabelText(RETURN_RATE) as HTMLInputElement).value).toBe('5'),
  );

  const horizon = screen.getByLabelText('Horizon (years)');
  await user.clear(horizon);
  await user.type(horizon, '2.5');
  // The field is a bare number input with no enclosing form, so the fractional
  // value does reach state — the bounding is what has to hold.
  await waitFor(() => expect(horizon).toHaveValue(2.5));

  // The engine projects whole years, and the label now names that same year:
  // never "2.5 years" over a curve the engine never modelled.
  const projected = engineFinalValue(2.5);
  expect(projected).toBeCloseTo(57881.25, 2);
  await waitFor(() => expect(projectedStat()).toHaveTextContent('Projected in 3 years'));
  expect(screen.queryByText(/Projected in 2\.5 years/)).not.toBeInTheDocument();
  // Label, headline stat and the chart's last point all state the same figure.
  expect(projectedStat()).toHaveTextContent(formatMoney(projected));
  expect(screen.getByTestId('projection-series-base')).toHaveTextContent(formatMoney(projected));
});

const DIVIDENDS_UNRESOLVED_NOTE =
  "We couldn't work out a projected dividend total for this portfolio just now — part of the data it needs didn't come back, so this factor stays out of the projection.";

test('the dividend factor toggle is absent when this deployment has no market intel', async () => {
  deployCapabilities.marketIntel = false;
  // The projection would answer — the capability alone removes the control.
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue({
    available: true,
    currency: 'EUR',
    monthlyTotalBase: 100,
    yearlyTotalBase: 1200,
    basis: 'forward-annualized',
    holdings: [],
  });
  renderSection();
  await screen.findByTestId('projection-series-base');

  expect(screen.queryByRole('checkbox', { name: 'Projected dividends' })).not.toBeInTheDocument();
  expect(screen.queryByText(DIVIDENDS_UNRESOLVED_NOTE)).not.toBeInTheDocument();
  expect(getPortfolioDividendProjectionFor).not.toHaveBeenCalled();
});

test('an unresolved projection leaves the dividend factor visible but disabled', async () => {
  // Market intel is configured; this portfolio's total came back unavailable
  // (#1616 is all-or-nothing). The control must explain the missing income
  // rather than vanish and leave a lower curve unexplained.
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue(DIVIDENDS_OFF);
  renderSection();
  await screen.findByTestId('projection-series-base');

  const toggle = await screen.findByRole('checkbox', { name: 'Projected dividends' });
  expect(toggle).toBeDisabled();
  expect(toggle).not.toBeChecked();
  expect(screen.getByText(DIVIDENDS_UNRESOLVED_NOTE)).toBeInTheDocument();
});

const DIVIDENDS_TRUNCATED_NOTE =
  'You hold more assets than we project in one pass, so this factor stays out of the projection.';

test('an over-cap projection names the fan-out budget, not the unresolvable-holding reason', async () => {
  // #1690 refuses a book past MARKET_INTEL_ROLLUP_MAX_ASSETS before spending any
  // provider budget, so `available:false` arrives with `truncated:true`. The two
  // refusals are different answers and must not share copy.
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue({
    ...DIVIDENDS_OFF,
    truncated: true,
  });
  renderSection();
  await screen.findByTestId('projection-series-base');

  const toggle = await screen.findByRole('checkbox', { name: 'Projected dividends' });
  expect(toggle).toBeDisabled();
  expect(screen.getByText(DIVIDENDS_TRUNCATED_NOTE)).toBeInTheDocument();
  expect(screen.queryByText(DIVIDENDS_UNRESOLVED_NOTE)).not.toBeInTheDocument();
});

test('a resolved dividend factor says which basis its income came from (#1790)', async () => {
  // The Forecast adds this figure to a net-worth curve. A `trailing-12m` total
  // is the realized last twelve months, so a special dividend is inside it and
  // the curve promises income the schedule does not — the factor names it.
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue({
    available: true,
    currency: 'EUR',
    monthlyTotalBase: 100,
    yearlyTotalBase: 1200,
    basis: 'trailing-12m',
    holdings: [],
  });
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');
  // The basis is what a LIVE factor's number is made of, so read it in the
  // state where the factor contributes: with no return assumption (#1892).
  await switchOffReturnFactor(user);

  const toggle = await screen.findByRole('checkbox', { name: 'Projected dividends' });
  expect(toggle).toBeEnabled();
  expect(
    screen.getByText(
      'Dividends come from the last 12 months of payouts, so any special dividend is still counted in.',
    ),
  ).toBeInTheDocument();
});

test('a disabled dividend factor contributes nothing to the projected curve', async () => {
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue(DIVIDENDS_OFF);
  renderSection();
  await screen.findByTestId('projection-series-base');
  await screen.findByRole('checkbox', { name: 'Projected dividends' });

  // Same fixture, same engine answer as a run with no dividend factor at all:
  // making the control visible changed the explanation, not the money.
  await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(engineFinalValue(20))));
  expect(screen.getByTestId('projection-series-base')).toHaveTextContent(
    formatMoney(engineFinalValue(20)),
  );
});

test('the dividend factor toggle appears when the provider is configured', async () => {
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue({
    available: true,
    currency: 'EUR',
    monthlyTotalBase: 100,
    yearlyTotalBase: 1200,
    basis: 'forward-annualized',
    holdings: [],
  });
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');

  const toggle = await screen.findByRole('checkbox', { name: 'Projected dividends' });
  expect(toggle).toBeInTheDocument();

  // With no return assumption the income is this factor's own contribution, so
  // the toggle moves the line (#1892); under a return factor it is already in it.
  await switchOffReturnFactor(user);
  const before = screen.getByTestId('projection-series-base').textContent;
  await user.click(await screen.findByRole('checkbox', { name: 'Projected dividends' }));
  await waitFor(() =>
    expect(screen.getByTestId('projection-series-base').textContent).not.toBe(before),
  );
});

// ─── Dividend factor scope (#1662) ───────────────────────────────────────────
//
// The projection's starting value is ONE portfolio's `totalValueEur`, so its
// dividend factor may only carry that portfolio's income. The read was user-wide
// and its query key carried no portfolio, so a second portfolio's dividends were
// added to the first one's curve — and then served from cache to the next.

const SECOND_PORTFOLIO_ID = '33333333-3333-3333-3333-333333333333';
const SECOND_PORTFOLIOS: PortfolioSummary[] = [
  { ...PORTFOLIOS[0]!, id: SECOND_PORTFOLIO_ID, name: 'Second' },
];

/** Monthly income per portfolio — the two must never be summed into one curve. */
const INCOME_BY_PORTFOLIO: Record<string, number> = {
  [PORTFOLIO_ID]: 100,
  [SECOND_PORTFOLIO_ID]: 900,
};

function projectionFor(portfolioId: string): ProjectedDividendIncomeResponse {
  const monthlyTotalBase = INCOME_BY_PORTFOLIO[portfolioId] ?? 0;
  return {
    available: true,
    currency: 'EUR',
    monthlyTotalBase,
    yearlyTotalBase: monthlyTotalBase * 12,
    basis: 'forward-annualized',
    holdings: [],
  };
}

test('the dividend factor carries only the shown portfolio’s income', async () => {
  vi.mocked(getPortfolioDividendProjectionFor).mockImplementation(async (portfolioId: string) =>
    projectionFor(portfolioId),
  );
  const user = userEvent.setup();
  renderSection();
  await screen.findByRole('checkbox', { name: 'Projected dividends' });
  await switchOffReturnFactor(user);

  expect(getPortfolioDividendProjectionFor).toHaveBeenCalledWith(PORTFOLIO_ID, expect.anything());
  expect(getPortfolioDividendProjectionFor).not.toHaveBeenCalledWith(
    SECOND_PORTFOLIO_ID,
    expect.anything(),
  );
  // 100 €/mo (this portfolio) — never 1 000 €/mo (both portfolios summed).
  await waitFor(() =>
    expect(projectedStat()).toHaveTextContent(formatMoney(engineIncomeOnlyValue(20, 100))),
  );
  expect(projectedStat()).not.toHaveTextContent(formatMoney(engineIncomeOnlyValue(20, 1000)));
});

test('switching portfolios refetches rather than serving the other one’s figure', async () => {
  vi.mocked(getPortfolioDividendProjectionFor).mockImplementation(async (portfolioId: string) =>
    projectionFor(portfolioId),
  );
  // One cache across both renders: only a portfolio-scoped query key can tell
  // the two answers apart here.
  const client = makeClient();
  const user = userEvent.setup();
  const view = renderSection(PORTFOLIOS, 'normal', client);
  await screen.findByRole('checkbox', { name: 'Projected dividends' });
  // Off, so the two portfolios' income figures are distinguishable on the curve.
  await switchOffReturnFactor(user);
  await waitFor(() =>
    expect(projectedStat()).toHaveTextContent(formatMoney(engineIncomeOnlyValue(20, 100))),
  );

  view.rerender(
    <QueryClientProvider client={client}>
      <ResolvedPrivacyModeProvider mode="normal">
        <ProjectionSection portfolios={SECOND_PORTFOLIOS} />
      </ResolvedPrivacyModeProvider>
    </QueryClientProvider>,
  );

  await waitFor(() =>
    expect(getPortfolioDividendProjectionFor).toHaveBeenCalledWith(
      SECOND_PORTFOLIO_ID,
      expect.anything(),
    ),
  );
  await waitFor(() =>
    expect(projectedStat()).toHaveTextContent(formatMoney(engineIncomeOnlyValue(20, 900))),
  );
});

// ─── Denomination (#1741) ────────────────────────────────────────────────────
//
// `totals.totalValueEur` is denominated in the user's BASE despite its name, and
// the dividend projection used to arrive pinned to EUR. The section added the
// two and rendered the sum with the base's symbol, so a USD user's curve mixed
// two currencies under one label. The projection now names its own denomination
// and the section only spends it when it matches the balance it is added to —
// the base that travels in the portfolio payload, not the display global.

afterEach(() => setMoneyCurrency('EUR'));

/** The same portfolio, denominated in another base (what its payload declares). */
function portfolioInBase(baseCurrency: PortfolioResponse['baseCurrency']): PortfolioResponse {
  return { ...PORTFOLIO, baseCurrency };
}

test('a USD-base curve spends the USD projection and renders it as USD', async () => {
  setMoneyCurrency('USD');
  vi.mocked(getPortfolio).mockResolvedValue(portfolioInBase('USD'));
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue({
    available: true,
    currency: 'USD',
    monthlyTotalBase: 100,
    yearlyTotalBase: 1200,
    basis: 'forward-annualized',
    holdings: [],
  });
  const user = userEvent.setup();
  renderSection();
  await screen.findByRole('checkbox', { name: 'Projected dividends' });
  // Read the income where it is the factor's own contribution (#1892).
  await switchOffReturnFactor(user);

  // $50,000 start + $100/month — one denomination end to end.
  const projected = formatMoney(engineIncomeOnlyValue(20, 100));
  expect(projected).toContain('$');
  await waitFor(() => expect(projectedStat()).toHaveTextContent(projected));
  expect(screen.getByTestId('projection-series-base')).toHaveTextContent(projected);
  // And it is genuinely the dividend-bearing curve, not the bare one.
  expect(projectedStat()).not.toHaveTextContent(formatMoney(engineIncomeOnlyValue(20, 0)));
});

test('a projection in another denomination is not summed into the curve', async () => {
  // A USD account holding a EUR-denominated projection (a cached response from
  // before a base change). Adding €100/mo to a $50,000 balance is precisely the
  // defect #1741 closes, so the factor stays out and says so.
  setMoneyCurrency('USD');
  vi.mocked(getPortfolio).mockResolvedValue(portfolioInBase('USD'));
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue({
    available: true,
    currency: 'EUR',
    monthlyTotalBase: 100,
    yearlyTotalBase: 1200,
    basis: 'forward-annualized',
    holdings: [],
  });
  renderSection();
  await screen.findByTestId('projection-series-base');

  const toggle = await screen.findByRole('checkbox', { name: 'Projected dividends' });
  expect(toggle).toBeDisabled();
  expect(screen.getByText(DIVIDENDS_UNRESOLVED_NOTE)).toBeInTheDocument();
  await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(engineFinalValue(20))));
});

test('a stale portfolio payload does not let a fresh-base projection through', async () => {
  // The narrow window the guard exists for, with the two responses landing on
  // opposite sides of a base change: the display global and the projection have
  // both moved to USD, the portfolio payload is still the cached EUR one. The
  // balance being added to is EUR, so the USD projection is still a mix —
  // comparing the projection to the display label alone would miss it.
  setMoneyCurrency('USD');
  vi.mocked(getPortfolio).mockResolvedValue(portfolioInBase('EUR'));
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue({
    available: true,
    currency: 'USD',
    monthlyTotalBase: 100,
    yearlyTotalBase: 1200,
    basis: 'forward-annualized',
    holdings: [],
  });
  renderSection();
  await screen.findByTestId('projection-series-base');

  const toggle = await screen.findByRole('checkbox', { name: 'Projected dividends' });
  expect(toggle).toBeDisabled();
  expect(screen.getByText(DIVIDENDS_UNRESOLVED_NOTE)).toBeInTheDocument();
  await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(engineFinalValue(20))));
});

// ─── Standing-order denomination (#1759) ─────────────────────────────────────
//
// A cash standing order's `amount` is a EUR magnitude by contract — the server
// derives its currency and books the leg into the EUR cash ledger — while the
// balance it would join is `totals.totalValueEur` converted into the user's
// base. The section used to add the two 1:1, so a CHF-base user with a 3.000 €
// salary saw 3.000 CHF/month added to a CHF curve, every month, compounded for
// up to thirty years.

const ORDERS_UNCONVERTIBLE_NOTE =
  "Your standing orders are recorded in EUR, but this projection is in CHF. We don't convert between currencies here, so this factor stays out of the projection.";

test('a EUR standing order is not added 1:1 to a CHF curve', async () => {
  setMoneyCurrency('CHF');
  vi.mocked(getPortfolio).mockResolvedValue(portfolioInBase('CHF'));
  vi.mocked(listStandingOrders).mockResolvedValue({
    orders: [makeOrder({ kind: 'cash-add', amount: 3000, currency: 'EUR' })],
  } as StandingOrderListResponse);
  renderSection();
  expect(await screen.findByText(ORDERS_UNCONVERTIBLE_NOTE)).toBeInTheDocument();

  const toggle = screen.getByRole('checkbox', { name: 'Standing orders' });
  expect(toggle).toBeDisabled();
  expect(toggle).not.toBeChecked();

  // The curve is the bare one — never the one 3.000 a month builds.
  await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(engineFinalValue(20))));
  expect(screen.getByTestId('projection-series-base')).toHaveTextContent(
    formatMoney(engineFinalValue(20)),
  );
});

test('a base-matching standing order is still projected, and says nothing', async () => {
  setMoneyCurrency('CHF');
  vi.mocked(getPortfolio).mockResolvedValue(portfolioInBase('CHF'));
  vi.mocked(listStandingOrders).mockResolvedValue({
    orders: [makeOrder({ kind: 'cash-add', amount: 3000, currency: 'CHF' })],
  } as StandingOrderListResponse);
  renderSection();
  await screen.findByTestId('projection-series-base');

  // An open-ended monthly order books once per projected month whatever the
  // anchor day is, so the expected curve is asOf-independent.
  const withOrders = last(
    projectNetWorth({
      asOf: '2026-03-01',
      startingNetWorth: 50000,
      horizonYears: 20,
      annualReturnPct: 5,
      standingOrders: [
        {
          amount: 3000,
          cadence: 'monthly',
          anchorDay: 1,
          startDate: '2020-01-01',
          endDate: null,
        },
      ],
      monthlyDividend: 0,
      whatIfPlans: [],
    }),
  );
  await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(withOrders)));

  const toggle = screen.getByRole('checkbox', { name: 'Standing orders' });
  expect(toggle).toBeEnabled();
  expect(toggle).toBeChecked();
  expect(screen.queryByText(ORDERS_UNCONVERTIBLE_NOTE)).not.toBeInTheDocument();
});

// ─── Month-0 anchor (#1759) ──────────────────────────────────────────────────
//
// The anchor was `new Date().toISOString()` — UTC — while the scan, the DTO's
// `nextRunDate` and the vault materializer all resolve "today" in Europe/Vienna.
// Loaded at 00:30 Vienna on the 1st, UTC still said the previous month's last
// day, so the engine re-projected an occurrence the scheduler books TODAY.

test('resolves month 0 in the schedule’s timezone, not UTC', async () => {
  // 2026-03-01, 00:30 in Vienna (UTC+1) — 2026-02-28, 23:30 in UTC.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-02-28T23:30:00.000Z'));
  try {
    // One 500 € occurrence left in the order's window: 2026-03-01, which the
    // scan books today and which the starting net worth therefore already
    // contains. A March anchor projects nothing more; the February one books it
    // a second time.
    const order = makeOrder({
      kind: 'cash-add',
      amount: 500,
      anchorDay: 1,
      startDate: '2020-01-01',
      endDate: '2026-03-31',
    });
    vi.mocked(listStandingOrders).mockResolvedValue({
      orders: [order],
    } as StandingOrderListResponse);
    renderSection();
    await screen.findByTestId('projection-series-base');
    await waitFor(() =>
      expect((screen.getByLabelText(RETURN_RATE) as HTMLInputElement).value).toBe('5'),
    );

    // A cash order needs no price map — only a buy is priced (#1892).
    const normalized = normalizeStandingOrders([order], 'EUR', new Map()).orders;
    const factors = {
      startingNetWorth: 50000,
      horizonYears: 20,
      annualReturnPct: 5,
      standingOrders: normalized,
      monthlyDividend: 0,
      whatIfPlans: [],
    };
    const vienna = projectNetWorth({ asOf: '2026-03-01', ...factors });
    const utc = projectNetWorth({ asOf: '2026-02-28', ...factors });
    // The two really do disagree — one extra 500 € booking, compounded.
    expect(last(vienna)).not.toBeCloseTo(last(utc), 2);
    expect(last(utc) - last(vienna)).toBeGreaterThan(500);

    // Month 0 is the Vienna day, and so is the first emitted point.
    expect(vienna.base[0]!.date).toBe('2026-03-01');
    await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(last(vienna))));
    expect(projectedStat()).not.toHaveTextContent(formatMoney(last(utc)));
  } finally {
    vi.useRealTimers();
  }
});

// ─── Factor composition: return × dividends (#1892) ──────────────────────────
//
// The base rate is sampled from the portfolio's own TWR and a `dividend` is
// internal to that curve by design, so the projected income was ALREADY in the
// line the return factor drew — and was added on top of it as a second monthly
// contribution, with both factors shipping ON.

const DIVIDENDS_IN_RETURN_NOTE =
  'Your average return already contains the dividends your holdings paid, so counting them here ' +
  'would count the same money twice. Switch the return factor off to project the income on its own.';

/** A resolved €100/month projection for this portfolio. */
const DIVIDENDS_100: ProjectedDividendIncomeResponse = {
  available: true,
  currency: 'EUR',
  monthlyTotalBase: 100,
  yearlyTotalBase: 1200,
  basis: 'forward-annualized',
  holdings: [],
};

test('the default state does not add income the sampled return already carries', async () => {
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue(DIVIDENDS_100);
  renderSection();
  await screen.findByTestId('projection-series-base');
  await waitFor(() =>
    expect((screen.getByLabelText(RETURN_RATE) as HTMLInputElement).value).toBe('5'),
  );

  const toggle = await screen.findByRole('checkbox', { name: 'Projected dividends' });
  expect(toggle).toBeDisabled();
  expect(toggle).not.toBeChecked();
  expect(screen.getByText(DIVIDENDS_IN_RETURN_NOTE)).toBeInTheDocument();

  // The curve is the return factor's own — never that curve plus the same
  // income compounded a second time.
  await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(engineFinalValue(20))));
  expect(projectedStat()).not.toHaveTextContent(formatMoney(doubleCountedValue(20, 100)));
});

/**
 * What the additive composition produced: the sampled-return curve PLUS the
 * same income compounded on top of it. Computed here because the engine will no
 * longer produce it — that is the point.
 */
function doubleCountedValue(horizonYears: number, monthlyDividend: number): number {
  const rate = monthlyRateFromAnnualPct(5);
  let accumulation = 0;
  for (let step = 0; step < horizonYears * 12; step++) {
    accumulation = accumulation * (1 + rate) + monthlyDividend;
  }
  return engineFinalValue(horizonYears) + accumulation;
}

test('switching the return factor off hands the income back to its own factor', async () => {
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue(DIVIDENDS_100);
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');
  await switchOffReturnFactor(user);

  const toggle = await screen.findByRole('checkbox', { name: 'Projected dividends' });
  expect(toggle).toBeEnabled();
  expect(toggle).toBeChecked();
  expect(screen.queryByText(DIVIDENDS_IN_RETURN_NOTE)).not.toBeInTheDocument();
  await waitFor(() =>
    expect(projectedStat()).toHaveTextContent(formatMoney(engineIncomeOnlyValue(20, 100))),
  );
});

// A rate that could not be sampled is NOT a 0 % assumption. `safeNumber('')` is
// 0, so reading the blank field as a rate disabled the dividend factor with copy
// naming an average return that was never sampled — and took the only factor
// that moved a fresh portfolio's line off it.

test('a return the history cannot state is not read as a 0 % assumption', async () => {
  // `twr: null` — a portfolio with no elapsed history — prefills an EMPTY rate
  // field while the return factor stays ON.
  vi.mocked(getAnalyticsSeries).mockResolvedValue({ ...analytics(5), twr: null });
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue(DIVIDENDS_100);
  renderSection();
  await screen.findByTestId('projection-series-base');
  await waitFor(() =>
    expect((screen.getByLabelText(RETURN_RATE) as HTMLInputElement).value).toBe(''),
  );

  const toggle = await screen.findByRole('checkbox', { name: 'Projected dividends' });
  expect(toggle).toBeEnabled();
  expect(toggle).toBeChecked();
  expect(screen.queryByText(DIVIDENDS_IN_RETURN_NOTE)).not.toBeInTheDocument();
  // The return factor is still ticked and still projects 0 %/yr; what the blank
  // changes is only that the €100/month is a flow of its own again.
  expect(screen.getByRole('checkbox', { name: RETURN_FACTOR })).toBeChecked();
  await waitFor(() =>
    expect(projectedStat()).toHaveTextContent(formatMoney(engineIncomeOnlyValue(20, 100))),
  );
});

test('clearing the rate with the factor on hands the income back the same way', async () => {
  vi.mocked(getPortfolioDividendProjectionFor).mockResolvedValue(DIVIDENDS_100);
  const user = userEvent.setup();
  renderSection();
  await screen.findByTestId('projection-series-base');
  // The sampled 5 %/yr first: the income is inside that curve and is disabled.
  await waitFor(() => expect(screen.getByLabelText(RETURN_RATE)).toHaveValue(5));
  expect(await screen.findByRole('checkbox', { name: 'Projected dividends' })).toBeDisabled();

  await user.clear(screen.getByLabelText(RETURN_RATE));

  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Projected dividends' })).toBeEnabled(),
  );
  expect(screen.queryByText(DIVIDENDS_IN_RETURN_NOTE)).not.toBeInTheDocument();
  await waitFor(() =>
    expect(projectedStat()).toHaveTextContent(formatMoney(engineIncomeOnlyValue(20, 100))),
  );
});

// ─── A recurring buy is money the schedule books (#1892) ─────────────────────
//
// Both booking engines write a `buy-asset` occurrence as a BUY transaction with
// no cash leg, so recorded net worth rises by the full purchase value. The
// factor used to drop those orders entirely: a €500/month plan moved the curve
// by nothing at all.

const BUY_ASSET_ID = '66666666-6666-6666-6666-666666666666';

/** The same portfolio, holding the asset a recurring buy names, priced. */
function portfolioHolding(price: number | null, currency = 'EUR'): PortfolioResponse {
  return {
    ...PORTFOLIO,
    holdings: [
      {
        asset: {
          id: BUY_ASSET_ID,
          symbol: 'VWCE',
          name: 'Vanguard FTSE All-World',
          exchange: 'XETRA',
          currency,
          type: 'etf',
          isCustom: false,
        },
        quantity: 10,
        avgCost: 100,
        realizedPnl: 0,
        price,
        marketValueEur: price === null ? null : price * 10,
        costBasisEur: 1000,
        unrealizedPnlEur: null,
        unrealizedPnlPct: null,
        dayChangeEur: null,
        dayChangePct: null,
      },
    ],
  };
}

/** A monthly buy of 5 units of {@link BUY_ASSET_ID}. */
function buyOrder(over: Partial<StandingOrder> = {}): StandingOrder {
  return makeOrder({
    kind: 'buy-asset',
    assetId: BUY_ASSET_ID,
    assetSymbol: 'VWCE',
    assetName: 'Vanguard FTSE All-World',
    amount: 5,
    label: 'savings plan',
    ...over,
  });
}

test('a recurring buy is projected at the price the portfolio states', async () => {
  vi.mocked(getPortfolio).mockResolvedValue(portfolioHolding(120));
  vi.mocked(listStandingOrders).mockResolvedValue({
    orders: [buyOrder()],
  } as StandingOrderListResponse);
  renderSection();
  await screen.findByTestId('projection-series-base');

  // 5 units × €120 = €600 booked every month, on the same 50 000 € start.
  const withBuy = last(
    projectNetWorth({
      asOf: '2026-03-01',
      startingNetWorth: 50000,
      horizonYears: 20,
      annualReturnPct: 5,
      standingOrders: [
        { amount: 600, cadence: 'monthly', anchorDay: 1, startDate: '2020-01-01', endDate: null },
      ],
      monthlyDividend: 0,
      whatIfPlans: [],
    }),
  );
  await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(withBuy)));
  // Not the €0 the excluded version projected for the same plan.
  expect(projectedStat()).not.toHaveTextContent(formatMoney(engineFinalValue(20)));

  const toggle = screen.getByRole('checkbox', { name: 'Standing orders' });
  expect(toggle).toBeEnabled();
  expect(toggle).toBeChecked();
});

const ORDERS_UNPRICED_NOTE =
  "We have no current price for VWCE, so we can't say what its recurring buy adds. " +
  'This factor stays out of the projection until it can be priced.';

test('a buy the portfolio cannot price refuses the factor and names the asset', async () => {
  // All-or-nothing, like a foreign order: the salary beside it stays out too,
  // because a quietly smaller curve is the defect this rule exists for.
  vi.mocked(getPortfolio).mockResolvedValue(portfolioHolding(null));
  vi.mocked(listStandingOrders).mockResolvedValue({
    orders: [buyOrder(), makeOrder({ kind: 'cash-add', amount: 500 })],
  } as StandingOrderListResponse);
  renderSection();
  expect(await screen.findByText(ORDERS_UNPRICED_NOTE)).toBeInTheDocument();

  const toggle = screen.getByRole('checkbox', { name: 'Standing orders' });
  expect(toggle).toBeDisabled();
  expect(toggle).not.toBeChecked();
  await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(engineFinalValue(20))));
});

test('two unpriced buys read as two, not as one', async () => {
  // The assets are joined into one sentence, so the sentence has to agree with
  // its own length — "its recurring buy" over two named assets is a copy bug.
  // The second order also names an asset the portfolio does not hold at all,
  // which is how a brand-new savings plan arrives (the dialog picks from the
  // global search, not from holdings).
  vi.mocked(getPortfolio).mockResolvedValue(portfolioHolding(null));
  vi.mocked(listStandingOrders).mockResolvedValue({
    orders: [
      buyOrder(),
      buyOrder({
        id: '77777777-7777-7777-7777-777777777777',
        assetId: '88888888-8888-8888-8888-888888888888',
        assetSymbol: 'IWDA',
        assetName: 'iShares Core MSCI World',
      }),
    ],
  } as StandingOrderListResponse);
  renderSection();

  expect(
    await screen.findByText(
      "We have no current price for IWDA, VWCE, so we can't say what their recurring buys add. " +
        'This factor stays out of the projection until they can be priced.',
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(ORDERS_UNPRICED_NOTE)).not.toBeInTheDocument();
  await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(engineFinalValue(20))));
});

test('a foreign-priced buy is refused through the currency path, not the price one', async () => {
  setMoneyCurrency('EUR');
  vi.mocked(getPortfolio).mockResolvedValue(portfolioHolding(180, 'USD'));
  vi.mocked(listStandingOrders).mockResolvedValue({
    orders: [buyOrder({ currency: 'USD' })],
  } as StandingOrderListResponse);
  renderSection();

  expect(
    await screen.findByText(
      'Your standing orders are recorded in USD, but this projection is in EUR. ' +
        "We don't convert between currencies here, so this factor stays out of the projection.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText(ORDERS_UNPRICED_NOTE)).not.toBeInTheDocument();
  await waitFor(() => expect(projectedStat()).toHaveTextContent(formatMoney(engineFinalValue(20))));
});
