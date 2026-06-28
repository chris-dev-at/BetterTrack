import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConglomerateDetail, SearchResultItem } from '@bettertrack/contracts';

vi.mock('../../lib/conglomerateApi', () => ({
  activateConglomerate: vi.fn(),
  createConglomerateDraft: vi.fn(),
  getConglomerate: vi.fn(),
  previewBacktest: vi.fn(),
  saveConglomeratePositions: vi.fn(),
}));

vi.mock('../components/AssetSearchBox', () => ({
  AssetSearchBox: ({ onSelect }: { onSelect: (item: SearchResultItem) => void }) => (
    <div>
      <button type="button" onClick={() => onSelect(SEARCH_A)}>
        Add AAPL
      </button>
      <button type="button" onClick={() => onSelect(SEARCH_B)}>
        Add MSFT
      </button>
    </div>
  ),
}));

vi.mock('../../ui/charts', () => ({
  AllocationDonut: ({ data }: { data: Array<{ label: string; value: number }> }) => (
    <div aria-label="Allocation donut">
      {data.map((item) => `${item.label}:${item.value}`).join('|')}
    </div>
  ),
  PriceChart: ({ onRangeChange }: { onRangeChange?: (range: string) => void }) => (
    <button type="button" onClick={() => onRangeChange?.('3Y')}>
      Backtest chart
    </button>
  ),
}));

import {
  activateConglomerate,
  createConglomerateDraft,
  previewBacktest,
  saveConglomeratePositions,
} from '../../lib/conglomerateApi';
import { ConglomeratesPage } from './ConglomerateBuilderPage';

const SEARCH_A: SearchResultItem = {
  id: '10000000-0000-0000-0000-000000000001',
  providerId: 'yahoo',
  providerRef: 'AAPL',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  exchange: 'NASDAQ',
  type: 'stock',
  currency: 'USD',
  isCustom: false,
};

const SEARCH_B: SearchResultItem = {
  id: '10000000-0000-0000-0000-000000000002',
  providerId: 'yahoo',
  providerRef: 'MSFT',
  symbol: 'MSFT',
  name: 'Microsoft Corporation',
  exchange: 'NASDAQ',
  type: 'stock',
  currency: 'USD',
  isCustom: false,
};

const EMPTY_DETAIL: ConglomerateDetail = {
  id: '20000000-0000-0000-0000-000000000001',
  name: 'Draft 2026-06-28',
  description: null,
  status: 'draft',
  updatedAt: '2026-06-28T00:00:00.000Z',
  positions: [],
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderBuilder() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={['/conglomerates/new']}>
        <Routes>
          <Route path="/conglomerates/*" element={<ConglomeratesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createConglomerateDraft).mockResolvedValue(EMPTY_DETAIL);
  vi.mocked(saveConglomeratePositions).mockResolvedValue(EMPTY_DETAIL);
  vi.mocked(activateConglomerate).mockResolvedValue({ ...EMPTY_DETAIL, status: 'active' });
  vi.mocked(previewBacktest).mockResolvedValue({
    range: '1Y',
    series: [
      { date: '2026-01-01', value: 100 },
      { date: '2026-06-28', value: 120 },
    ],
    stats: {
      totalReturnPct: 20,
      cagrPct: 40,
      maxDrawdownPct: -5,
      volatilityPct: 12,
      bestDay: { date: '2026-01-02', returnPct: 2 },
      worstDay: { date: '2026-01-03', returnPct: -1 },
    },
    notice: null,
  });
});

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe('ConglomerateBuilderPage', () => {
  it('autosaves every position change and debounces preview by 500 ms', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await waitFor(() =>
      expect(createConglomerateDraft).toHaveBeenCalledWith(
        expect.stringMatching(/^Draft \d{4}-\d{2}-\d{2}$/),
      ),
    );
    await screen.findByText('Draft — saved');

    await user.click(screen.getByRole('button', { name: 'Add AAPL' }));
    await waitFor(() =>
      expect(saveConglomeratePositions).toHaveBeenLastCalledWith(EMPTY_DETAIL.id, [
        { assetId: SEARCH_A.id, weightPct: 0 },
      ]),
    );

    const input = screen.getByRole('spinbutton', { name: 'AAPL weight input' });
    await user.clear(input);
    await user.type(input, '60');
    expect(screen.getByRole('slider', { name: 'AAPL weight slider' })).toHaveValue('60');

    await waitFor(() =>
      expect(saveConglomeratePositions).toHaveBeenLastCalledWith(EMPTY_DETAIL.id, [
        { assetId: SEARCH_A.id, weightPct: 60 },
      ]),
    );

    await wait(550);
    vi.mocked(previewBacktest).mockClear();
    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: '61' } });
    await vi.advanceTimersByTimeAsync(499);
    expect(previewBacktest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(previewBacktest).toHaveBeenCalledWith(
      '1Y',
      [{ assetId: SEARCH_A.id, weightPct: 61 }],
      expect.any(AbortSignal),
    );
  });

  it('locks, auto-balances unlocked rows, updates sum state, and activates valid drafts', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await screen.findByText('Draft — saved');

    await user.click(screen.getByRole('button', { name: 'Add AAPL' }));
    await user.click(screen.getByRole('button', { name: 'Add MSFT' }));
    await user.clear(screen.getByRole('spinbutton', { name: 'AAPL weight input' }));
    await user.type(screen.getByRole('spinbutton', { name: 'AAPL weight input' }), '60');
    await user.click(screen.getByRole('button', { name: 'Lock AAPL' }));
    await user.click(screen.getByRole('button', { name: 'Auto-balance' }));

    expect(screen.getByRole('spinbutton', { name: 'MSFT weight input' })).toHaveValue(40);
    expect(screen.getByText('100.0%')).toBeInTheDocument();

    await waitFor(() =>
      expect(saveConglomeratePositions).toHaveBeenLastCalledWith(EMPTY_DETAIL.id, [
        { assetId: SEARCH_A.id, weightPct: 60 },
        { assetId: SEARCH_B.id, weightPct: 40 },
      ]),
    );

    await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(activateConglomerate).toHaveBeenCalledWith(EMPTY_DETAIL.id);
  });

  it('shows the locked >= 100 normalize error without changing weights', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await screen.findByText('Draft — saved');

    await user.click(screen.getByRole('button', { name: 'Add AAPL' }));
    await user.click(screen.getByRole('button', { name: 'Add MSFT' }));
    await user.clear(screen.getByRole('spinbutton', { name: 'AAPL weight input' }));
    await user.type(screen.getByRole('spinbutton', { name: 'AAPL weight input' }), '100');
    await user.click(screen.getByRole('button', { name: 'Lock AAPL' }));
    await user.click(screen.getByRole('button', { name: 'Normalize' }));

    expect(screen.getByText(/Locked weights are already 100% or more/i)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'AAPL weight input' })).toHaveValue(100);
    expect(screen.getByRole('spinbutton', { name: 'MSFT weight input' })).toHaveValue(0);
  });
});
