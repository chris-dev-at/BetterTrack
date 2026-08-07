import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  AnalyticsContributionRow,
  AnalyticsSeriesResponse,
  PortfolioAsset,
  PortfolioResponse,
} from '@bettertrack/contracts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../../lib/analyticsApi', () => ({ getAnalyticsSeries: vi.fn() }));
vi.mock('../../../lib/portfolioApi', () => ({
  getPortfolio: vi.fn(),
  getPortfolioHistory: vi.fn(),
  listPortfolios: vi.fn(),
}));
vi.mock('../../../lib/conglomerateApi', () => ({ listConglomerates: vi.fn() }));

// Stub the (separately-tested) asset search box down to a single pick button so
// the compare-vs-asset flow is deterministic (no debounce / network).
vi.mock('../../components/AssetSearchBox', () => ({
  AssetSearchBox: ({ onSelect }: { onSelect: (item: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onSelect({
          id: 'cmp-asset',
          symbol: 'VOO',
          name: 'Vanguard S&P 500',
          currency: 'USD',
          type: 'etf',
          exchange: 'NYSE',
        })
      }
    >
      pick-compare-asset
    </button>
  ),
}));

// Canvas-backed chart lib — jsdom can't draw it (mirrors the PortfolioPage tests).
const chartMocks = vi.hoisted(() => {
  const setData = vi.fn();
  const addSeries = vi.fn(() => ({ setData, applyOptions: vi.fn() }));
  const subscribeCrosshairMove = vi.fn();
  return {
    setData,
    addSeries,
    subscribeCrosshairMove,
    createChart: vi.fn(() => ({
      addSeries,
      applyOptions: vi.fn(),
      timeScale: () => ({ fitContent: vi.fn() }),
      subscribeCrosshairMove,
      remove: vi.fn(),
    })),
  };
});
vi.mock('lightweight-charts', () => ({
  createChart: chartMocks.createChart,
  AreaSeries: 'AreaSeries',
  BaselineSeries: 'BaselineSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));

import { getAnalyticsSeries } from '../../../lib/analyticsApi';
import { listConglomerates } from '../../../lib/conglomerateApi';
import { DISCREET_MASK, formatDate, setDiscreetMode } from '../../../lib/format';
import { getPortfolio, getPortfolioHistory, listPortfolios } from '../../../lib/portfolioApi';
import { ResolvedPrivacyModeProvider } from '../../vault/usePrivacyMode';
import { AnalyticsPage } from './AnalyticsPage';
import { setViewportWidth } from '../../../test/viewport';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const asset = (id: string, symbol: string, type: PortfolioAsset['type']): PortfolioAsset => ({
  id,
  symbol,
  name: `${symbol} Inc.`,
  exchange: 'NASDAQ',
  currency: 'USD',
  type,
  isCustom: false,
});

const AAPL = asset('a1', 'AAPL', 'stock');
const MSFT = asset('a2', 'MSFT', 'stock');
const BTC = asset('a3', 'BTC', 'crypto');

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
    {
      id: 'p2',
      name: 'Savings',
      visibility: 'private' as const,
      sortOrder: 1,
      isDefault: false,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

const PORTFOLIO = {
  holdings: [{ asset: AAPL }, { asset: MSFT }, { asset: BTC }],
  totals: {},
} as unknown as PortfolioResponse;

function contribRow(a: PortfolioAsset, contributionPct: number): AnalyticsContributionRow {
  return { asset: a, value: 100, cost: 80, pnl: 20, weight: 0.5, contributionPct };
}

function stats(totalReturnPct: number, cagrPct: number) {
  return {
    totalReturnPct,
    cagrPct,
    maxDrawdownPct: -5,
    bestDay: { date: '2024-03-01', returnPct: 3 },
    worstDay: { date: '2024-04-01', returnPct: -2 },
  };
}

const RESP_FULL: AnalyticsSeriesResponse = {
  portfolioId: 'p1',
  baseCurrency: 'EUR',
  mode: 'value',
  from: '2024-01-01',
  to: '2024-06-30',
  inflation: null,
  // V4-P0: static preset headline rates travel on every response so the
  // picker can label each preset with its effective annualised %/yr.
  inflationPresets: [
    { id: 'hicp-at', pctPerYear: 3.2 },
    { id: 'hicp-eu', pctPerYear: 2.5 },
    { id: 'cpi-us', pctPerYear: 3.1 },
  ],
  primary: {
    kind: 'portfolio',
    label: 'Main',
    points: [
      { date: '2024-01-01', value: 1000 },
      { date: '2024-06-30', value: 1200 },
    ],
    stats: stats(20, 12),
  },
  compare: null,
  // contributionPct values kept distinct from the stat figures asserted below,
  // so a per-asset row never collides with a total-return / CAGR readout.
  contributions: [contribRow(AAPL, 14), contribRow(MSFT, 11), contribRow(BTC, 2)],
};

/**
 * The same window read as performance-% — the shape `mode: 'perf'` returns.
 * Its points are the % twins of RESP_FULL's € ones, at the same dates, which is
 * what the scrub tooltip pairs up (board #68 item 4).
 */
const RESP_PERF: AnalyticsSeriesResponse = {
  ...RESP_FULL,
  mode: 'perf',
  primary: {
    ...RESP_FULL.primary,
    points: [
      { date: '2024-01-01', value: 0 },
      { date: '2024-06-30', value: 20 },
    ],
  },
};

const RESP_HIDDEN: AnalyticsSeriesResponse = {
  ...RESP_FULL,
  primary: { ...RESP_FULL.primary, stats: stats(8, 6) },
  contributions: [contribRow(MSFT, 11), contribRow(BTC, 2)],
};

const RESP_NO_CRYPTO: AnalyticsSeriesResponse = {
  ...RESP_FULL,
  primary: { ...RESP_FULL.primary, stats: stats(15, 9) },
  contributions: [contribRow(AAPL, 14), contribRow(MSFT, 11)],
};

const RESP_COMPARE_PORTFOLIO: AnalyticsSeriesResponse = {
  ...RESP_FULL,
  compare: {
    kind: 'portfolio',
    label: 'Savings',
    points: [
      { date: '2024-01-01', value: 1000 },
      { date: '2024-06-30', value: 1100 },
    ],
    stats: stats(10, 7),
  },
};

const RESP_COMPARE_ASSET: AnalyticsSeriesResponse = {
  ...RESP_FULL,
  compare: {
    kind: 'asset',
    label: 'VOO',
    points: [
      { date: '2024-01-01', value: 400 },
      { date: '2024-06-30', value: 440 },
    ],
    stats: stats(9, 5),
  },
};

const RESP_INFLATION: AnalyticsSeriesResponse = {
  ...RESP_FULL,
  mode: 'perf',
  inflation: { id: 'flat', pctPerYear: 10 },
  primary: {
    kind: 'portfolio',
    label: 'Main',
    points: [
      { date: '2024-01-01', value: 0 },
      { date: '2024-06-30', value: 4 },
    ],
    stats: stats(4, 3),
  },
};

const HISTORY_WITH_ASSETS = {
  range: 'MAX' as const,
  baseCurrency: 'EUR' as const,
  points: [{ date: '2024-01-01', valueEur: 1000 }],
  performance: [{ date: '2024-01-01', pct: 0 }],
  assets: [
    {
      assetId: 'a1',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      currency: 'USD' as const,
      points: [
        { date: '2024-01-01', close: 150 },
        { date: '2024-06-30', close: 165 },
      ],
    },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPage(mode: 'normal' | 'paranoid' = 'normal') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/portfolio/analytics']}>
        <ResolvedPrivacyModeProvider mode={mode}>
          <AnalyticsPage />
        </ResolvedPrivacyModeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The display mode is a per-surface device preference (board #68 item 4):
  // every case starts from a browser that has never expressed one.
  localStorage.clear();
  setDiscreetMode(false);
  vi.mocked(listPortfolios).mockResolvedValue(PORTFOLIO_LIST);
  vi.mocked(getPortfolio).mockResolvedValue(PORTFOLIO);
  vi.mocked(getPortfolioHistory).mockResolvedValue(
    HISTORY_WITH_ASSETS as unknown as Awaited<ReturnType<typeof getPortfolioHistory>>,
  );
  vi.mocked(getAnalyticsSeries).mockImplementation((_id, params = {}) => {
    if (params.compareKind === 'portfolio') return Promise.resolve(RESP_COMPARE_PORTFOLIO);
    if (params.compareKind === 'asset') return Promise.resolve(RESP_COMPARE_ASSET);
    if (params.inflation === 'flat') return Promise.resolve(RESP_INFLATION);
    if (params.hideGroups?.includes('crypto')) return Promise.resolve(RESP_NO_CRYPTO);
    if (params.hide?.includes('a1')) return Promise.resolve(RESP_HIDDEN);
    // Last, so every filter case above keeps answering exactly as before: the
    // endpoint returns ONE series per request, % or €, per the asked-for mode.
    if (params.mode === 'perf') return Promise.resolve(RESP_PERF);
    return Promise.resolve(RESP_FULL);
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AnalyticsPage — main graph, stats & contribution table', () => {
  test('uses Analysis as the page heading', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Analysis' })).toBeInTheDocument();
  });

  test('390px contains controls and keeps the contribution identity column sticky', async () => {
    setViewportWidth(390);
    renderPage();

    await screen.findAllByText('AAPL');
    const surface = document.querySelector('.bt-money-surface');
    expect(surface).not.toBeNull();
    const scroller = surface!.querySelector('.bt-phone-scroll-table');
    expect(scroller).not.toBeNull();
    expect(scroller!.querySelectorAll('.bt-phone-scroll-table__lead')).not.toHaveLength(0);
    expect(surface!.querySelector('input, select')).toBeInTheDocument();
  });

  test('retries a failed analytics read without leaving the page', async () => {
    vi.mocked(getAnalyticsSeries)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(RESP_FULL);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(getAnalyticsSeries).toHaveBeenCalledTimes(2);
  });

  test('retries a failed portfolio bootstrap', async () => {
    vi.mocked(listPortfolios)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(PORTFOLIO_LIST);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(listPortfolios).toHaveBeenCalledTimes(2);
  });

  test('shows a create-portfolio empty state when the portfolio list succeeds empty', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
    renderPage();

    expect(await screen.findByText('No portfolio to analyze yet')).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load analytics for this portfolio."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New portfolio' })).toHaveAttribute(
      'href',
      '/portfolios?create=1',
    );
    expect(getPortfolio).not.toHaveBeenCalled();
  });

  test('renders the primary curve, per-series stats, contribution rows and the locale-formatted window', async () => {
    renderPage();

    const table = await screen.findByRole('table');
    // Contribution rows for the visible set.
    expect(within(table).getByText('AAPL')).toBeInTheDocument();
    expect(within(table).getByText('MSFT')).toBeInTheDocument();
    expect(within(table).getByText('BTC')).toBeInTheDocument();

    // The primary curve is drawn (value mode → raw EUR points).
    await waitFor(() =>
      expect(chartMocks.setData).toHaveBeenCalledWith([
        { time: '2024-01-01', value: 1000 },
        { time: '2024-06-30', value: 1200 },
      ]),
    );

    // Per-series stats (total return distinct from CAGR).
    expect(screen.getByText('+20,00 %')).toBeInTheDocument();
    expect(screen.getByText('+12,00 %')).toBeInTheDocument();

    // Resolved window, formatted through the locale-aware date formatter.
    expect(
      within(screen.getByRole('region', { name: 'Date range' })).getByText(
        (content) =>
          content.includes(formatDate('2024-01-01')) && content.includes(formatDate('2024-06-30')),
      ),
    ).toBeInTheDocument();
  });

  test('hiding an asset re-requests with hide= and recomputes stats + the table live', async () => {
    const user = userEvent.setup();
    renderPage();

    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getByText('AAPL')).toBeInTheDocument());
    expect(screen.getByText('+20,00 %')).toBeInTheDocument();

    // The per-asset visibility toggle (a filter chip, not the table cell).
    await user.click(screen.getByRole('button', { name: 'Toggle AAPL' }));

    await waitFor(() =>
      expect(vi.mocked(getAnalyticsSeries)).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ hide: ['a1'] }),
        expect.anything(),
      ),
    );

    // Stats recompute and the hidden asset drops out of the contribution table.
    await waitFor(() => expect(screen.getByText('+8,00 %')).toBeInTheDocument());
    expect(screen.queryByText('+20,00 %')).not.toBeInTheDocument();
    expect(within(await screen.findByRole('table')).queryByText('AAPL')).not.toBeInTheDocument();
  });

  test('excluding a category/type re-requests with hideGroups=', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Toggle Crypto' }));

    await waitFor(() =>
      expect(vi.mocked(getAnalyticsSeries)).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ hideGroups: ['crypto'] }),
        expect.anything(),
      ),
    );
    await waitFor(() => expect(screen.getByText('+15,00 %')).toBeInTheDocument());
    expect(within(await screen.findByRole('table')).queryByText('BTC')).not.toBeInTheDocument();
  });
});

describe('AnalyticsPage — compare mode', () => {
  test('compare vs a second portfolio renders both series overlaid + side-by-side stats', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Portfolio' }));
    const select = await screen.findByRole('combobox', { name: 'Choose a portfolio to compare' });
    await user.selectOptions(select, 'p2');

    await waitFor(() =>
      expect(vi.mocked(getAnalyticsSeries)).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ compareKind: 'portfolio', compareId: 'p2' }),
        expect.anything(),
      ),
    );

    // Two stats blocks: the portfolio + the comparison (its own total-return).
    expect(await screen.findByText('Comparison')).toBeInTheDocument();
    expect(screen.getByText('+10,00 %')).toBeInTheDocument();
    // The compare overlay is drawn as a second series.
    await waitFor(() =>
      expect(chartMocks.setData).toHaveBeenCalledWith([
        { time: '2024-01-01', value: 1000 },
        { time: '2024-06-30', value: 1100 },
      ]),
    );
  });

  test('a failing compare-target list shows an error, not the "none yet" empty label', async () => {
    vi.mocked(listConglomerates)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ conglomerates: [] });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Blueprint' }));

    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText("You don't have any blueprints yet.")).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("You don't have any blueprints yet.")).toBeInTheDocument();
    expect(listConglomerates).toHaveBeenCalledTimes(2);
  });

  test('compare vs an asset/index renders both series overlaid + side-by-side stats', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Asset / index' }));
    await user.click(await screen.findByRole('button', { name: 'pick-compare-asset' }));

    await waitFor(() =>
      expect(vi.mocked(getAnalyticsSeries)).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ compareKind: 'asset', compareId: 'cmp-asset' }),
        expect.anything(),
      ),
    );

    expect(await screen.findByText('Comparison')).toBeInTheDocument();
    expect(screen.getByText('+9,00 %')).toBeInTheDocument();
    await waitFor(() =>
      expect(chartMocks.setData).toHaveBeenCalledWith([
        { time: '2024-01-01', value: 400 },
        { time: '2024-06-30', value: 440 },
      ]),
    );
  });
});

describe('AnalyticsPage — display mode: % curve with a € scrub (board #68 item 4)', () => {
  /** Drive the crosshair the way lightweight-charts does, from the real subscription. */
  async function scrub(date: string) {
    await waitFor(() => expect(chartMocks.subscribeCrosshairMove).toHaveBeenCalled());
    const onCrosshair = chartMocks.subscribeCrosshairMove.mock.calls.at(-1)?.[0] as (
      param: unknown,
    ) => void;
    act(() => onCrosshair({ time: date, point: { x: 140, y: 90 }, seriesData: new Map() }));
  }

  const chartRegion = () => screen.getByRole('region', { name: 'Portfolio analytics chart' });

  test('opens on the € curve and never subscribes a tooltip there', async () => {
    renderPage();
    await screen.findByRole('table');

    expect(screen.getByRole('button', { name: 'Value €' })).toHaveAttribute('aria-pressed', 'true');
    expect(vi.mocked(getAnalyticsSeries)).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ mode: 'value' }),
      expect.anything(),
    );
    expect(chartMocks.subscribeCrosshairMove).not.toHaveBeenCalled();
  });

  test('% mode draws the baseline curve and reads the € balance out of the SAME filtered window', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    // Hide an asset first: the money twin must answer for the visible set, not
    // for the whole portfolio, or the tooltip would quote a different balance.
    await user.click(screen.getByRole('button', { name: 'Performance %' }));

    await waitFor(() =>
      expect(chartMocks.addSeries).toHaveBeenCalledWith('BaselineSeries', expect.anything()),
    );
    // The % curve is the server's own perf series — nothing recomputed here.
    await waitFor(() => {
      const points = chartMocks.setData.mock.calls.at(-1)?.[0] as Array<{ value: number }>;
      expect(points.map((point) => point.value)).toEqual([0, 20]);
    });
    // The money twin is the identical request with mode: 'value'.
    await waitFor(() =>
      expect(vi.mocked(getAnalyticsSeries)).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ mode: 'value', from: expect.any(String) }),
        expect.anything(),
      ),
    );

    await scrub('2024-06-30');
    expect(within(chartRegion()).getByText('1.200,00 €')).toBeInTheDocument();
    expect(within(chartRegion()).getByText('+20,00 %')).toBeInTheDocument();
  });

  test('discreet mode masks the € in the tooltip and keeps the % readable', async () => {
    setDiscreetMode(true);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Performance %' }));
    await scrub('2024-06-30');

    expect(within(chartRegion()).getByText(DISCREET_MASK)).toBeInTheDocument();
    expect(within(chartRegion()).queryByText('1.200,00 €')).not.toBeInTheDocument();
    expect(within(chartRegion()).getByText('+20,00 %')).toBeInTheDocument();
  });

  test('remembers the mode for Analysis alone, without touching the overview’s', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Performance %' }));
    expect(localStorage.getItem('bettertrack.chartDisplayMode.portfolio-analysis')).toBe('perf');
    // The overview is a separate surface and keeps its own (still unset) mode.
    expect(localStorage.getItem('bettertrack.chartDisplayMode.portfolio-overview')).toBeNull();
    first.unmount();

    renderPage();
    expect(await screen.findByRole('button', { name: 'Performance %' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // A restored % mode requests the % series on the very first read.
    await waitFor(() =>
      expect(vi.mocked(getAnalyticsSeries)).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ mode: 'perf' }),
        expect.anything(),
      ),
    );
  });
});

describe('AnalyticsPage — inflation real-terms mode', () => {
  test('custom flat rate sends the payload, labels real-terms, and composes with performance-%', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Inflation adjustment' }),
      'flat',
    );
    await user.type(
      screen.getByRole('spinbutton', { name: 'Inflation rate, percent per year' }),
      '10',
    );
    // Compose with performance-% mode.
    await user.click(screen.getByRole('button', { name: 'Performance %' }));

    await waitFor(() =>
      expect(vi.mocked(getAnalyticsSeries)).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ inflation: 'flat', inflationRate: 10, mode: 'perf' }),
        expect.anything(),
      ),
    );
    // The chart is clearly labelled real-terms.
    expect(await screen.findByText('Real terms')).toBeInTheDocument();
  });
});

describe('AnalyticsPage — range & overlay', () => {
  test('a custom date range sends from/to', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2024-02-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2024-05-31' } });

    await waitFor(() =>
      expect(vi.mocked(getAnalyticsSeries)).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ from: '2024-02-01', to: '2024-05-31' }),
        expect.anything(),
      ),
    );
  });

  test('the relocated overlay-assets toggle fetches the per-asset history (overlay=true)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    // The overview never requests this; the deep-dive does, only when toggled.
    expect(vi.mocked(getPortfolioHistory)).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Overlay assets' }));

    await waitFor(() =>
      expect(vi.mocked(getPortfolioHistory)).toHaveBeenCalledWith(
        'p1',
        '1Y',
        true,
        expect.anything(),
      ),
    );
  });

  test('retries a failed asset-overlay history read', async () => {
    vi.mocked(getPortfolioHistory)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        HISTORY_WITH_ASSETS as unknown as Awaited<ReturnType<typeof getPortfolioHistory>>,
      );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Overlay assets' }));
    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(getPortfolioHistory).toHaveBeenCalledTimes(2));
  });
});

describe('AnalyticsPage — paranoid account', () => {
  // The client substitute answers with the server's own quantities or with
  // nothing; it never relabels a different metric (§16 2026-07-30).
  const PARANOID_PORTFOLIO = {
    baseCurrency: 'EUR',
    holdings: [
      {
        asset: AAPL,
        quantity: 10,
        avgCost: 80,
        realizedPnl: 0,
        price: 100,
        marketValueEur: 1000,
        costBasisEur: 800,
        unrealizedPnlEur: 200,
        unrealizedPnlPct: 25,
        dayChangeEur: 10,
        dayChangePct: 1,
      },
    ],
    totals: {},
  } as unknown as PortfolioResponse;

  // The default range preset is the last 12 months of the REAL clock, so the
  // window has to be anchored to today or every point filters out.
  const localDay = (daysAgo: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  };
  const WINDOW_START = localDay(30);
  const WINDOW_END = localDay(0);

  const PARANOID_HISTORY = {
    range: '1Y' as const,
    baseCurrency: 'EUR' as const,
    points: [
      { date: WINDOW_START, valueEur: 1000 },
      { date: WINDOW_END, valueEur: 1200 },
    ],
    // TWR says +5 % over the same window (money flowed in); the value-normalized
    // curve says +20 %. Performance mode must render the latter, like the server.
    performance: [
      { date: WINDOW_START, pct: 0 },
      { date: WINDOW_END, pct: 5 },
    ],
  };

  beforeEach(() => {
    vi.mocked(getPortfolio).mockResolvedValue(PARANOID_PORTFOLIO);
    vi.mocked(getPortfolioHistory).mockResolvedValue(
      PARANOID_HISTORY as unknown as Awaited<ReturnType<typeof getPortfolioHistory>>,
    );
  });

  test('never calls the server endpoint and drops the period-contribution column', async () => {
    renderPage('paranoid');

    const table = await screen.findByRole('table');
    expect(vi.mocked(getAnalyticsSeries)).not.toHaveBeenCalled();
    expect(within(table).getByText('AAPL')).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: 'Contribution' })).toBeNull();
    expect(
      screen.getByText(/Contribution over the period is not shown for encrypted accounts/),
    ).toBeInTheDocument();
  });

  test('performance mode plots the value-normalized curve, not the TWR series', async () => {
    const user = userEvent.setup();
    renderPage('paranoid');
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Performance %' }));

    await waitFor(() => {
      const points = chartMocks.setData.mock.calls.at(-1)?.[0] as Array<{
        time: string;
        value: number;
      }>;
      expect(points.map((point) => point.time)).toEqual([WINDOW_START, WINDOW_END]);
      // 1000 → 1200 rebased = +20 %, NOT the 5 % the TWR series carries.
      expect(points[1]!.value).toBeCloseTo(20, 6);
    });
  });

  test('a leading zero point is trimmed like the server, not used as the base', async () => {
    // A window that opens before the first held day: the server trims the 0
    // edge, so the curve anchors at 1000 and rebases to +20 %. Keeping the zero
    // would zero every stat and flatten the whole perf curve.
    vi.mocked(getPortfolioHistory).mockResolvedValue({
      ...PARANOID_HISTORY,
      points: [{ date: localDay(45), valueEur: 0 }, ...PARANOID_HISTORY.points],
    } as unknown as Awaited<ReturnType<typeof getPortfolioHistory>>);

    const user = userEvent.setup();
    renderPage('paranoid');
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Performance %' }));

    await waitFor(() => {
      const points = chartMocks.setData.mock.calls.at(-1)?.[0] as Array<{
        time: string;
        value: number;
      }>;
      expect(points.map((point) => point.time)).toEqual([WINDOW_START, WINDOW_END]);
      expect(points[1]!.value).toBeCloseTo(20, 6);
    });
  });
});
