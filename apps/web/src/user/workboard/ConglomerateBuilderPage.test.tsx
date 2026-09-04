import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/conglomerateApi', () => ({
  getConglomerate: vi.fn(),
  createConglomerate: vi.fn(),
  updateConglomerate: vi.fn(),
  replaceConglomeratePositions: vi.fn(),
  activateConglomerate: vi.fn(),
  listConglomerates: vi.fn(),
}));

vi.mock('../../lib/searchApi', () => ({
  searchAssets: vi.fn(),
}));

vi.mock('../../lib/aiApi', () => ({
  AI_CAPABILITY_QUERY_KEY: ['ai', 'capability'],
  useAiCapability: vi.fn(() => ({ data: undefined })),
  draftConglomerate: vi.fn(),
}));

// Recharts measures the DOM (0×0 in jsdom); hand the donut a fixed size.
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

import { I18nProvider, localizedMessage, useI18n } from '../../i18n';
import { draftConglomerate, useAiCapability } from '../../lib/aiApi';
import {
  activateConglomerate,
  createConglomerate,
  getConglomerate,
  listConglomerates,
  replaceConglomeratePositions,
  updateConglomerate,
} from '../../lib/conglomerateApi';
import { searchAssets } from '../../lib/searchApi';
import { ConglomerateBuilderPage } from './ConglomerateBuilderPage';

const CONGLOMERATE_ID = 'c1';

function detail(positions: Array<{ id: string; symbol: string; weightPct: number }>) {
  return {
    id: CONGLOMERATE_ID,
    name: 'My Basket',
    description: null,
    status: 'draft' as const,
    visibility: 'private' as const,
    positionCount: positions.length,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    positions: positions.map((p, i) => ({
      kind: 'asset' as const,
      assetId: p.id,
      weightPct: p.weightPct,
      sortOrder: i,
      asset: {
        symbol: p.symbol,
        name: `${p.symbol} Inc.`,
        currency: 'USD' as const,
        type: 'stock' as const,
      },
    })),
  };
}

/** One of the user's other blueprints, offered by the nest picker (V5-P6). */
function summary(id: string, name: string, positionCount = 2) {
  return {
    id,
    name,
    description: null,
    status: 'active' as const,
    visibility: 'private' as const,
    positionCount,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

const AAPL_RESULT = {
  id: 'a-aapl',
  providerId: 'yahoo',
  providerRef: 'AAPL',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  exchange: 'NASDAQ',
  type: 'stock' as const,
  currency: 'USD' as const,
  isCustom: false,
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

function renderBuilder(initialPath: string) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/workbench/blueprints" element={<div>Conglomerates list</div>} />
          <Route
            path="/workbench/blueprints/new"
            element={
              <>
                <ConglomerateBuilderPage />
                <LocationProbe />
              </>
            }
          />
          <Route path="/workbench/blueprints/:id" element={<div>Detail view</div>} />
          <Route path="/workbench/blueprints/:id/edit" element={<ConglomerateBuilderPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A language toggle rendered beside the Builder, sharing its provider. */
function LocaleSwitch() {
  const { setLocale } = useI18n();
  return (
    <button type="button" onClick={() => setLocale('de')}>
      Deutsch
    </button>
  );
}

/**
 * Like {@link renderEdit}, but under a real {@link I18nProvider} seeded to EN
 * with a switch to DE — `setLocale` rebuilds `t` without remounting the tree,
 * so this is what catches a callback that captured a stale translator.
 */
async function renderEditWithLocaleSwitch(
  positions: Array<{ id: string; symbol: string; weightPct: number }>,
) {
  vi.mocked(getConglomerate).mockResolvedValue(detail(positions));
  vi.mocked(updateConglomerate).mockResolvedValue(detail(positions));
  vi.mocked(replaceConglomeratePositions).mockResolvedValue(detail(positions));
  render(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={makeQueryClient()}>
        <MemoryRouter initialEntries={[`/workbench/blueprints/${CONGLOMERATE_ID}/edit`]}>
          <Routes>
            <Route path="/workbench/blueprints/:id/edit" element={<ConglomerateBuilderPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
      <LocaleSwitch />
    </I18nProvider>,
  );
  for (const p of positions) {
    await screen.findByLabelText(`Weight for ${p.symbol}`);
  }
}

/** Load the Builder in edit mode with the given positions and wait for the rows. */
async function renderEdit(positions: Array<{ id: string; symbol: string; weightPct: number }>) {
  vi.mocked(getConglomerate).mockResolvedValue(detail(positions));
  vi.mocked(updateConglomerate).mockResolvedValue(detail(positions));
  vi.mocked(replaceConglomeratePositions).mockResolvedValue(detail(positions));
  renderBuilder(`/workbench/blueprints/${CONGLOMERATE_ID}/edit`);
  for (const p of positions) {
    await screen.findByLabelText(`Weight for ${p.symbol}`);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: [] });
  // AI off by default — every AI surface is hidden unless a test configures one.
  vi.mocked(useAiCapability).mockReturnValue({ data: undefined } as never);
});

describe('ConglomerateBuilderPage', () => {
  test('renders the three-zone Builder full-screen', async () => {
    await renderEdit([{ id: 'a1', symbol: 'AAPL', weightPct: 60 }]);
    expect(screen.getByRole('heading', { name: /add assets/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^positions$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /live preview/i })).toBeInTheDocument();
    // A labelled placeholder stands in for the backtest chart (deferred). It
    // names the working alternative rather than implying backtests do not exist.
    expect(
      screen.getByText(/a backtest preview appears here in a later update/i),
    ).toBeInTheDocument();
  });

  test('searching and clicking a result adds a position at weight 0', async () => {
    vi.mocked(searchAssets).mockResolvedValue({ results: [AAPL_RESULT] });
    vi.mocked(createConglomerate).mockResolvedValue(detail([]));
    vi.mocked(replaceConglomeratePositions).mockResolvedValue(detail([]));
    const user = userEvent.setup();
    renderBuilder('/workbench/blueprints/new');

    await user.type(screen.getByRole('searchbox', { name: /search assets/i }), 'AAPL');
    const select = await screen.findByRole('button', { name: /select aapl/i });
    await user.click(select);

    const weightInput = await screen.findByLabelText('Weight for AAPL');
    expect(weightInput).toHaveValue(0);
    expect(screen.getByLabelText('Weight slider for AAPL')).toHaveValue('0');
  });

  test('the New idea intent is consumed on arrival and waits for a complete allocation', async () => {
    vi.mocked(searchAssets).mockResolvedValue({ results: [AAPL_RESULT] });
    vi.mocked(createConglomerate).mockResolvedValue(detail([]));
    vi.mocked(replaceConglomeratePositions).mockResolvedValue(detail([]));
    const user = userEvent.setup();
    renderBuilder('/workbench/blueprints/new?create=idea&keep=1');

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('?keep=1'));
    expect(screen.queryByRole('dialog', { name: 'Save as idea' })).not.toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: /search assets/i }), 'AAPL');
    await user.click(await screen.findByRole('button', { name: /select aapl/i }));
    await user.clear(await screen.findByLabelText('Weight for AAPL'));
    await user.type(screen.getByLabelText('Weight for AAPL'), '50');
    expect(screen.queryByRole('dialog', { name: 'Save as idea' })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Weight for AAPL'));
    await user.type(screen.getByLabelText('Weight for AAPL'), '100');

    expect(await screen.findByRole('dialog', { name: 'Save as idea' })).toBeInTheDocument();
  });

  test('strips an unknown create intent without dropping unrelated query state', async () => {
    renderBuilder('/workbench/blueprints/new?create=retired-flow&keep=1');

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('?keep=1'));
    expect(screen.queryByRole('dialog', { name: 'Save as idea' })).not.toBeInTheDocument();
  });

  test('the nest picker lists other own blueprints (never itself) and adds one as a constituent (V5-P6)', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({
      conglomerates: [summary(CONGLOMERATE_ID, 'My Basket'), summary('c2', 'Tech Mix')],
    });
    await renderEdit([{ id: 'a1', symbol: 'AAPL', weightPct: 60 }]);
    const user = userEvent.setup();

    await user.click(screen.getByText('Nest a blueprint'));
    // The basket being edited is excluded from the picker.
    const addTechMix = await screen.findByRole('button', {
      name: 'Add Tech Mix as a constituent',
    });
    expect(
      screen.queryByRole('button', { name: 'Add My Basket as a constituent' }),
    ).not.toBeInTheDocument();

    await user.click(addTechMix);

    // The nested row appears at weight 0 with the badge…
    const weightInput = await screen.findByLabelText('Weight for Tech Mix');
    expect(weightInput).toHaveValue(0);
    expect(screen.getByText('Nested')).toBeInTheDocument();

    // …and once given weight, the autosave payload carries a childId row.
    fireEvent.change(weightInput, { target: { value: '40' } });
    await waitFor(
      () =>
        expect(replaceConglomeratePositions).toHaveBeenCalledWith(CONGLOMERATE_ID, [
          { assetId: 'a1', weightPct: 60 },
          { childId: 'c2', weightPct: 40 },
        ]),
      { timeout: 3000 },
    );
  });

  test('retries the nested-blueprint read instead of presenting a false empty list', async () => {
    vi.mocked(listConglomerates)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ conglomerates: [summary('c2', 'Tech Mix')] });
    await renderEdit([{ id: 'a1', symbol: 'AAPL', weightPct: 60 }]);
    const user = userEvent.setup();

    await user.click(screen.getByText('Nest a blueprint'));
    expect(await screen.findByText('Your blueprints could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('No other blueprints to nest yet.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('button', { name: 'Add Tech Mix as a constituent' }),
    ).toBeInTheDocument();
    expect(listConglomerates).toHaveBeenCalledTimes(2);
  });

  test('the slider and number input stay in sync', async () => {
    await renderEdit([{ id: 'a1', symbol: 'AAPL', weightPct: 20 }]);
    const numberInput = screen.getByLabelText('Weight for AAPL');
    const slider = screen.getByLabelText('Weight slider for AAPL');

    // Move the slider → the number input follows.
    fireEvent.change(slider, { target: { value: '45' } });
    await waitFor(() => expect(numberInput).toHaveValue(45));

    // Type in the number input → the slider follows.
    fireEvent.change(numberInput, { target: { value: '12.5' } });
    await waitFor(() => expect(slider).toHaveValue('12.5'));
  });

  test('the sum pill is amber below 100 and green at exactly 100', async () => {
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 60 },
      { id: 'a2', symbol: 'MSFT', weightPct: 27.5 },
    ]);
    // 87.5% total → amber with the "% left" readout (2 dp, de-AT default locale).
    expect(screen.getByText('87,50 % — 12,50 % left')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Weight for MSFT'), { target: { value: '40' } });
    await waitFor(() => expect(screen.getByText('100,00 %')).toBeInTheDocument());
  });

  test('auto-balance produces a Σ of exactly 100', async () => {
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 60 },
      { id: 'a2', symbol: 'MSFT', weightPct: 10 },
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /auto-balance/i }));

    await waitFor(() => expect(screen.getByText('100,00 %')).toBeInTheDocument());
    expect(screen.getByLabelText('Weight for AAPL')).toHaveValue(50);
    expect(screen.getByLabelText('Weight for MSFT')).toHaveValue(50);
  });

  test('normalize scales unlocked positions to Σ = 100', async () => {
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 30 },
      { id: 'a2', symbol: 'MSFT', weightPct: 10 },
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /normalize/i }));

    await waitFor(() => expect(screen.getByText('100,00 %')).toBeInTheDocument());
    expect(screen.getByLabelText('Weight for AAPL')).toHaveValue(75);
    expect(screen.getByLabelText('Weight for MSFT')).toHaveValue(25);
  });

  test('normalize errors when the locked positions alone total ≥ 100', async () => {
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 100 },
      { id: 'a2', symbol: 'MSFT', weightPct: 10 },
    ]);
    const user = userEvent.setup();
    // Lock AAPL (100%) so the locked total alone is ≥ 100.
    await user.click(screen.getByRole('button', { name: /lock aapl/i }));
    await user.click(screen.getByRole('button', { name: /normalize/i }));

    // The notice comes from the catalog now (#1745), not from an English
    // literal returned by `normalize()`.
    expect(
      await screen.findByText(
        localizedMessage('en', 'workboard.builder.errors.normalizeLockedFull'),
      ),
    ).toBeInTheDocument();
  });

  test('the normalize notice follows an in-session language switch', async () => {
    await renderEditWithLocaleSwitch([
      { id: 'a1', symbol: 'AAPL', weightPct: 100 },
      { id: 'a2', symbol: 'MSFT', weightPct: 10 },
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /lock aapl/i }));
    // Grab the button while its label is still English; the DOM node survives
    // the re-render that the language switch triggers.
    const normalize = screen.getByRole('button', { name: /normalize/i });

    await user.click(screen.getByRole('button', { name: 'Deutsch' }));
    await user.click(normalize);

    const de = localizedMessage('de', 'workboard.builder.errors.normalizeLockedFull');
    expect(await screen.findByText(de)).toBeInTheDocument();
    expect(
      screen.queryByText(localizedMessage('en', 'workboard.builder.errors.normalizeLockedFull')),
    ).not.toBeInTheDocument();
    // The provider persists the choice; keep it out of the other tests.
    localStorage.removeItem('bettertrack.locale');
  });

  test('activate is blocked until Σ = 100 ± 0.01, then flips to active', async () => {
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 60 },
      { id: 'a2', symbol: 'MSFT', weightPct: 30 },
    ]);
    vi.mocked(activateConglomerate).mockResolvedValue({
      ...detail([
        { id: 'a1', symbol: 'AAPL', weightPct: 60 },
        { id: 'a2', symbol: 'MSFT', weightPct: 40 },
      ]),
      status: 'active',
    });
    const user = userEvent.setup();

    // 90% total → Activate disabled, with a reason an owner-naive user can read.
    expect(screen.getByRole('button', { name: /^activate$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^activate$/i })).toHaveAttribute(
      'title',
      expect.stringContaining('must sum to 100%'),
    );

    fireEvent.change(screen.getByLabelText('Weight for MSFT'), { target: { value: '40' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^activate$/i })).toBeEnabled());
    expect(screen.getByRole('button', { name: /^activate$/i })).toHaveAttribute(
      'title',
      expect.stringContaining('used by the calculator'),
    );

    await user.click(screen.getByRole('button', { name: /^activate$/i }));
    await waitFor(() => expect(activateConglomerate).toHaveBeenCalledWith(CONGLOMERATE_ID));
    await waitFor(() => expect(screen.getByText('Detail view')).toBeInTheDocument());
  });

  test('an AI draft writes NOTHING until the user confirms it (regression)', async () => {
    vi.mocked(useAiCapability).mockReturnValue({
      data: { available: true, model: 'llama3.1:8b', dailyCap: 5, used: 0, remaining: 5 },
    } as never);
    vi.mocked(draftConglomerate).mockResolvedValue({
      model: 'llama3.1:8b',
      lines: [
        {
          query: 'nasdaq',
          weightPct: 100,
          asset: { id: 'a-qqq', symbol: 'QQQ', name: 'Nasdaq 100', type: 'etf', currency: 'USD' },
        },
      ],
    });
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 60 },
      { id: 'a2', symbol: 'MSFT', weightPct: 40 },
    ]);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Describe it with AI'), '100% nasdaq');
    await user.click(screen.getByRole('button', { name: 'Draft basket' }));
    const review = await screen.findByRole('group', { name: 'Review the AI draft' });

    // The confirmation names the blueprint and what applying costs…
    expect(review).toHaveTextContent('Applying replaces all 2 positions in “My Basket”.');
    // …and the saved basket is untouched: no create, no name update, and — well
    // past the 600 ms autosave debounce — no position replacement.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(createConglomerate).not.toHaveBeenCalled();
    expect(updateConglomerate).not.toHaveBeenCalled();
    expect(replaceConglomeratePositions).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Weight for AAPL')).toBeInTheDocument();

    // Dismissing is free too — still not a single write.
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(replaceConglomeratePositions).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Weight for MSFT')).toBeInTheDocument();

    // Only the explicit confirmation commits the drafted basket.
    await user.type(screen.getByLabelText('Describe it with AI'), '100% nasdaq');
    await user.click(screen.getByRole('button', { name: 'Draft basket' }));
    await screen.findByRole('group', { name: 'Review the AI draft' });
    await user.click(screen.getByRole('button', { name: 'Apply draft' }));

    await waitFor(
      () =>
        expect(replaceConglomeratePositions).toHaveBeenCalledWith(CONGLOMERATE_ID, [
          { assetId: 'a-qqq', weightPct: 100 },
        ]),
      { timeout: 3000 },
    );
  });

  test('surfaces a server validation error on activate', async () => {
    const { ApiError } = await import('../../lib/apiClient');
    await renderEdit([
      { id: 'a1', symbol: 'AAPL', weightPct: 60 },
      { id: 'a2', symbol: 'MSFT', weightPct: 40 },
    ]);
    vi.mocked(activateConglomerate).mockRejectedValue(
      new ApiError(400, 'ACTIVATION_INVALID', 'Weights must sum to 100%.'),
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /^activate$/i }));
    expect(await screen.findByText('Weights must sum to 100%.')).toBeInTheDocument();
  });
});
