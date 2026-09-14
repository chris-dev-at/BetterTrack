import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { backtestPreviewRequestSchema } from '@bettertrack/contracts';

vi.mock('../../lib/conglomerateApi', () => ({
  getConglomerate: vi.fn(),
  getResolvedConglomerate: vi.fn(),
  deleteConglomerate: vi.fn(),
  allocateConglomerate: vi.fn(),
}));

vi.mock('../../lib/socialApi', () => ({
  getAudience: vi.fn(),
  listFriends: vi.fn(),
  listGroups: vi.fn(),
  setAudience: vi.fn(),
}));

vi.mock('../../lib/backtestApi', () => ({
  previewBacktest: vi.fn(),
}));

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  createTransactions: vi.fn(),
}));

// Mock the canvas-backed charting lib the backtest panel's PriceChart drives;
// jsdom can't draw (mirrors PriceChart.test.tsx).
vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({ setData: vi.fn(), applyOptions: vi.fn() })),
    applyOptions: vi.fn(),
    timeScale: () => ({ fitContent: vi.fn() }),
    remove: vi.fn(),
  })),
  AreaSeries: 'AreaSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));

// Recharts measures the DOM (0×0 in jsdom); hand the donut a fixed size (mirrors
// AllocationDonut.test.tsx / PortfolioPage.test.tsx).
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            width: 200,
            height: 200,
          })
        : children,
  };
});

import { ApiError } from '../../lib/apiClient';
import { previewBacktest } from '../../lib/backtestApi';
import {
  deleteConglomerate,
  getConglomerate,
  getResolvedConglomerate,
} from '../../lib/conglomerateApi';
import { listPortfolios } from '../../lib/portfolioApi';
import { getAudience, listFriends, listGroups, setAudience } from '../../lib/socialApi';
import { ConglomerateDetailPage } from './ConglomerateDetailPage';

const CONGLOMERATE_ID = 'c1';

const AAPL = {
  symbol: 'AAPL',
  name: 'Apple Inc.',
  currency: 'USD' as const,
  type: 'stock' as const,
};
const MSFT = {
  symbol: 'MSFT',
  name: 'Microsoft Corp.',
  currency: 'USD' as const,
  type: 'stock' as const,
};

const DETAIL = {
  id: CONGLOMERATE_ID,
  name: 'Core Growth',
  description: 'My steady basket',
  status: 'active' as const,
  visibility: 'private' as const,
  positionCount: 2,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  positions: [
    { kind: 'asset' as const, assetId: 'a1', weightPct: 60, sortOrder: 0, asset: AAPL },
    { kind: 'asset' as const, assetId: 'a2', weightPct: 40, sortOrder: 1, asset: MSFT },
  ],
};

/** The flat basket's resolved view: its own weights, no nesting. */
const RESOLVED = {
  conglomerateId: CONGLOMERATE_ID,
  nested: false,
  positions: [
    { assetId: 'a1', weightPct: 60, asset: AAPL },
    { assetId: 'a2', weightPct: 40, asset: MSFT },
  ],
  unresolvedPct: 0,
};

/** A nested basket (V5-P6): 50% child "Tech Mix" + 50% AAPL, resolved to 20/30/50. */
const NESTED_DETAIL = {
  ...DETAIL,
  positions: [
    { kind: 'asset' as const, assetId: 'a1', weightPct: 50, sortOrder: 0, asset: AAPL },
    {
      kind: 'conglomerate' as const,
      childId: 'c2',
      weightPct: 50,
      sortOrder: 1,
      child: { id: 'c2', name: 'Tech Mix', status: 'active' as const, positionCount: 2 },
    },
  ],
};

const NESTED_RESOLVED = {
  conglomerateId: CONGLOMERATE_ID,
  nested: true,
  positions: [
    { assetId: 'a1', weightPct: 50, asset: AAPL },
    { assetId: 'a2', weightPct: 20, asset: MSFT },
    {
      assetId: 'a3',
      weightPct: 30,
      asset: {
        symbol: 'NVDA',
        name: 'NVIDIA Corp.',
        currency: 'USD' as const,
        type: 'stock' as const,
      },
    },
  ],
  unresolvedPct: 0,
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPage(id = CONGLOMERATE_ID) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[`/workbench/blueprints/${id}`]}>
        <Routes>
          <Route path="/workbench/blueprints" element={<div>Blueprints list</div>} />
          <Route path="/workbench/blueprints/:id" element={<ConglomerateDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getResolvedConglomerate).mockResolvedValue(RESOLVED);
  vi.mocked(getAudience).mockResolvedValue({
    kind: 'conglomerate',
    subjectId: CONGLOMERATE_ID,
    audience: 'private',
    friendIds: [],
    groupId: null,
    link: { active: false, createdAt: null },
  });
  vi.mocked(listFriends).mockResolvedValue({ friends: [] });
  vi.mocked(listGroups).mockResolvedValue({ groups: [] });
  vi.mocked(listPortfolios).mockResolvedValue({
    portfolios: [
      {
        id: 'p1',
        name: 'Default',
        visibility: 'private' as const,
        sortOrder: 0,
        isDefault: true,
        defaultPayFromCash: false,
        archivedAt: null,
      },
    ],
  });
  vi.mocked(previewBacktest).mockResolvedValue({
    startDate: '2020-01-01',
    endDate: '2025-01-01',
    series: [
      { date: '2020-01-01', value: 100 },
      { date: '2025-01-01', value: 142.5 },
    ],
    stats: {
      totalReturnPct: 42.5,
      cagrPct: 7.3,
      maxDrawdownPct: -9.1,
      volatilityPct: 14.6,
      bestDay: { date: '2020-03-24', returnPct: 3.2 },
      worstDay: { date: '2020-03-16', returnPct: -2.8 },
    },
    contributions: [],
    notice: null,
    benchmark: null,
    mode: 'clip',
    rebalance: 'none',
    entryEvents: [],
    rebalanceEvents: [],
    idleCashAvgPct: null,
  });
});

describe('ConglomerateDetailPage', () => {
  test('renders header, positions table and allocation donut', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('2 positions')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('AAPL')).toBeInTheDocument();
    expect(within(table).getByText('MSFT')).toBeInTheDocument();
    expect(within(table).getByText('60,00 %')).toBeInTheDocument();
    expect(within(table).getByText('40,00 %')).toBeInTheDocument();

    // Cold lazy boundary: this is the first mount of the donut chunk, and its
    // `recharts` mock pulls the real module through `importOriginal`. Vitest
    // transforms that on first use, which outruns the default 1 s wait on a
    // loaded CI worker (see the note in `src/test/setup.ts`).
    const donut = await screen.findByRole(
      'img',
      { name: /blueprint allocation/i },
      { timeout: 10_000 },
    );
    expect(donut).toBeInTheDocument();
  });

  test('renders the backtest panel and the Invest Calculator', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Backtest' })).toBeInTheDocument();
    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        {
          positions: [
            { assetId: 'a1', weight: 60 },
            { assetId: 'a2', weight: 40 },
          ],
          range: '5Y',
          benchmark: null,
          mode: 'clip',
          rebalance: 'none',
        },
        expect.anything(),
      ),
    );
    expect(screen.getByRole('heading', { name: 'Calculator' })).toBeInTheDocument();
    expect(screen.getByLabelText('Budget in EUR')).toBeInTheDocument();
  });

  test('delete confirm flow calls DELETE and navigates back to the list', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    vi.mocked(deleteConglomerate).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: /delete blueprint/i });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteConglomerate).toHaveBeenCalledWith(CONGLOMERATE_ID));
    await waitFor(() => expect(screen.getByText('Blueprints list')).toBeInTheDocument());
  });

  test('a nested basket shows the badge and the resolved-view toggle flips to effective weights (V5-P6)', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(NESTED_DETAIL);
    vi.mocked(getResolvedConglomerate).mockResolvedValue(NESTED_RESOLVED);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());

    // Stored view: the child row renders with its name + the nesting badge.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Tech Mix')).toBeInTheDocument();
    expect(within(table).getByText('Nested')).toBeInTheDocument();

    // Toggle to the resolved view: flattened effective asset weights.
    await user.click(screen.getByRole('button', { name: 'Resolved' }));
    const resolvedTable = screen.getByRole('table');
    expect(within(resolvedTable).getByText('NVDA')).toBeInTheDocument();
    expect(within(resolvedTable).getByText('20,00 %')).toBeInTheDocument();
    expect(within(resolvedTable).getByText('30,00 %')).toBeInTheDocument();
    expect(within(resolvedTable).queryByText('Tech Mix')).not.toBeInTheDocument();
  });

  test('says how much of a nested basket resolved to nothing, so the donut and the calculator agree (#1755)', async () => {
    // "Core" = 60 % AAPL + 40 % an empty nested blueprint. The flatten drops the
    // child and normalizes AAPL to 100, so the table, the donut and the backtest
    // below all show a fully-invested basket — while the Invest Calculator on
    // this same screen withholds 40 % of any budget and says so.
    vi.mocked(getConglomerate).mockResolvedValue(NESTED_DETAIL);
    vi.mocked(getResolvedConglomerate).mockResolvedValue({
      conglomerateId: CONGLOMERATE_ID,
      nested: true,
      positions: [{ assetId: 'a1', weightPct: 100, asset: AAPL }],
      unresolvedPct: 40,
    });
    renderPage();

    expect(
      await screen.findByText(
        /40,00 % of this blueprint is a nested blueprint that holds no assets/,
      ),
    ).toBeInTheDocument();
  });

  test('an EMPTY blueprint is not reported as a nested one that holds no assets (#1877)', async () => {
    // A blueprint whose only constituent was a deleted custom asset flattens to
    // `{ positions: [], nested: false, unresolvedPct: 100 }` — there is nothing
    // for the remainder to be normalized against. The empty state below is the
    // honest message; the nested-blueprint alert would be a claim the same
    // payload contradicts.
    vi.mocked(getConglomerate).mockResolvedValue({
      ...DETAIL,
      positionCount: 0,
      positions: [],
    });
    vi.mocked(getResolvedConglomerate).mockResolvedValue({
      conglomerateId: CONGLOMERATE_ID,
      nested: false,
      positions: [],
      unresolvedPct: 100,
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    expect(screen.queryByText(/holds no assets/)).not.toBeInTheDocument();
  });

  test('backtests a nested basket that resolves past the 50-position write cap (#1877)', async () => {
    // The server activates a basket that resolves to up to MAX_FLATTENED_POSITIONS
    // assets; the detail page posts that whole resolved vector. While the preview
    // contract was bounded at the §6.5 write cap of 50, this request was a
    // permanent 400 VALIDATION_ERROR on a blueprint the server calls `active`.
    const positions = Array.from({ length: 200 }, (_, i) => ({
      assetId: `018f0000-0000-7000-8000-${(i + 1).toString(16).padStart(12, '0')}`,
      weightPct: 0.5,
      asset: AAPL,
    }));
    vi.mocked(getConglomerate).mockResolvedValue(NESTED_DETAIL);
    vi.mocked(getResolvedConglomerate).mockResolvedValue({
      conglomerateId: CONGLOMERATE_ID,
      nested: true,
      positions,
      unresolvedPct: 0,
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        expect.objectContaining({
          positions: positions.map((p) => ({ assetId: p.assetId, weight: p.weightPct })),
        }),
        expect.anything(),
      ),
    );
    const sent = vi.mocked(previewBacktest).mock.calls[0]![0];
    expect(backtestPreviewRequestSchema.safeParse(sent).success).toBe(true);
  });

  test('a fully-resolved basket says nothing about an unresolved share', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(NESTED_DETAIL);
    vi.mocked(getResolvedConglomerate).mockResolvedValue(NESTED_RESOLVED);
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    expect(screen.queryByText(/holds no assets/)).not.toBeInTheDocument();
  });

  test('the backtest panel consumes the RESOLVED weights of a nested basket', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(NESTED_DETAIL);
    vi.mocked(getResolvedConglomerate).mockResolvedValue(NESTED_RESOLVED);
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    await waitFor(() =>
      expect(previewBacktest).toHaveBeenCalledWith(
        expect.objectContaining({
          positions: [
            { assetId: 'a1', weight: 50 },
            { assetId: 'a2', weight: 20 },
            { assetId: 'a3', weight: 30 },
          ],
        }),
        expect.anything(),
      ),
    );
  });

  test('a delete blocked by parents (409 CONGLOMERATE_IN_USE) names them in the dialog', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    vi.mocked(deleteConglomerate).mockRejectedValue(
      new ApiError(409, 'CONGLOMERATE_IN_USE', 'This blueprint is a constituent of World Mix.', {
        parents: [{ id: 'c9', name: 'World Mix' }],
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: /delete blueprint/i });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(within(dialog).getByText(/constituent of World Mix/i)).toBeInTheDocument(),
    );
  });

  test('shows an error message when the Blueprint fails to load', async () => {
    vi.mocked(getConglomerate)
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(DETAIL);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load this Blueprint/i)).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Core Growth')).toBeInTheDocument();
    expect(getConglomerate).toHaveBeenCalledTimes(2);
  });

  test('retries a failed resolved-weight read in place', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(NESTED_DETAIL);
    vi.mocked(getResolvedConglomerate)
      .mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'offline'))
      .mockResolvedValueOnce(NESTED_RESOLVED);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(/resolved view could not be loaded/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(getResolvedConglomerate).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/resolved view could not be loaded/i)).not.toBeInTheDocument();
  });

  test('requires the shared audience confirmation before replacing a narrower audience', async () => {
    vi.mocked(getConglomerate).mockResolvedValue(DETAIL);
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'conglomerate',
      subjectId: CONGLOMERATE_ID,
      audience: 'specific_friends',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'conglomerate',
        subjectId: CONGLOMERATE_ID,
        audience: 'all_friends',
        friendIds: [],
        groupId: null,
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Share with friends' }));
    await user.click(await screen.findByRole('radio', { name: /all friends/i }));
    expect(
      screen.getByText(/change access from specific friends to all friends/i),
    ).toBeInTheDocument();
    expect(setAudience).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(setAudience).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Share with friends' }));
    await user.click(await screen.findByRole('radio', { name: /all friends/i }));
    await user.click(screen.getByRole('checkbox', { name: /this change widens access/i }));
    // The server mirrors any non-private audience into the visibility column.
    vi.mocked(getConglomerate).mockResolvedValue({ ...DETAIL, visibility: 'friends' });
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('conglomerate', CONGLOMERATE_ID, {
      audience: 'all_friends',
      friendIds: undefined,
      acknowledgePublic: undefined,
      confirmWiden: true,
    });
    // The picker only invalidates ['social'] + ['workboard']; this page wires
    // its own key, so the header label must not stay stale after a save.
    expect(await screen.findByRole('button', { name: 'Shared with friends' })).toBeInTheDocument();
  });
});
