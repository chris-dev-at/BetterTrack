import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

import type { BacktestResponse, SharedConglomerateDetailResponse } from '@bettertrack/contracts';

vi.mock('../../lib/socialApi', () => ({
  getSharedConglomerate: vi.fn(),
  previewSharedConglomerateSandbox: vi.fn(),
}));

// Child surfaces that make their own network calls — out of scope for this page's
// sandbox test, stubbed to inert nodes (mirrors the other shared-page tests).
vi.mock('./CommentThread', () => ({ CommentThread: () => null }));
vi.mock('./ItemFollowButton', () => ({ ItemFollowButton: () => null }));
vi.mock('../workboard/ConglomeratesListPage', () => ({ NestedBadge: () => null }));

// lightweight-charts uses a canvas API jsdom doesn't implement (same shape as the
// other chart-bearing page tests).
const chartMocks = vi.hoisted(() => {
  const setData = vi.fn();
  const addSeries = vi.fn(() => ({ setData, applyOptions: vi.fn() }));
  const createChart = vi.fn(() => ({
    addSeries,
    applyOptions: vi.fn(),
    timeScale: () => ({ fitContent: vi.fn() }),
    remove: vi.fn(),
  }));
  return { createChart };
});

vi.mock('lightweight-charts', () => ({
  createChart: chartMocks.createChart,
  AreaSeries: 'AreaSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));

import { getSharedConglomerate, previewSharedConglomerateSandbox } from '../../lib/socialApi';
import { SharedConglomeratePage } from './SharedConglomeratePage';

const CONGLOMERATE_ID = '00000000-0000-0000-0000-000000000010';
const A_ID = '00000000-0000-0000-0000-00000000000a';
const B_ID = '00000000-0000-0000-0000-00000000000b';

const detail: SharedConglomerateDetailResponse = {
  conglomerateId: CONGLOMERATE_ID,
  name: 'Duo',
  description: null,
  status: 'active',
  owner: { id: '00000000-0000-0000-0000-000000000001', username: 'alice', profileIcon: null },
  positions: [
    {
      kind: 'asset',
      assetId: A_ID,
      weightPct: 60,
      sortOrder: 0,
      asset: { symbol: 'AAA', name: 'Asset A', currency: 'EUR', type: 'stock' },
    },
    {
      kind: 'asset',
      assetId: B_ID,
      weightPct: 40,
      sortOrder: 1,
      asset: { symbol: 'BBB', name: 'Asset B', currency: 'EUR', type: 'stock' },
    },
  ],
};

const previewResponse: BacktestResponse = {
  startDate: '2020-01-01',
  endDate: '2021-01-01',
  series: [
    { date: '2020-01-01', value: 100 },
    { date: '2021-01-01', value: 120 },
  ],
  stats: {
    totalReturnPct: 20,
    cagrPct: 20,
    maxDrawdownPct: -5,
    volatilityPct: 12,
    bestDay: null,
    worstDay: null,
  },
  contributions: [],
  notice: null,
  benchmark: null,
  mode: 'clip',
  rebalance: 'none',
  entryEvents: [],
  rebalanceEvents: [],
  idleCashAvgPct: null,
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/social/shared/conglomerate/${CONGLOMERATE_ID}`]}>
        <Routes>
          <Route path="/social/shared/conglomerate/:id" element={<SharedConglomeratePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The `positions` array of the most recent sandbox preview call. */
function lastPreviewPositions(): Array<{ id: string; weight: number }> {
  const calls = (previewSharedConglomerateSandbox as unknown as Mock).mock.calls;
  return calls.at(-1)![1].positions;
}

describe('SharedConglomeratePage — what-if sandbox (V5-P6 arc c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getSharedConglomerate as unknown as Mock).mockResolvedValue(detail);
    (previewSharedConglomerateSandbox as unknown as Mock).mockResolvedValue(previewResponse);
  });

  test('the sandbox is collapsed by default — no preview runs and no weight editor is shown', async () => {
    renderPage();
    await screen.findByText('Duo');

    expect(screen.getByRole('button', { name: /What-if sandbox/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByLabelText('Weight for AAA')).toBeNull();
    expect(previewSharedConglomerateSandbox).not.toHaveBeenCalled();
  });

  test('opening previews at the shared weights; a tweak recomputes locally; reset restores exactly', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Duo');

    // Expand the sandbox.
    await user.click(screen.getByRole('button', { name: /What-if sandbox/i }));

    // The first preview runs at the SHARED weights, covering exactly both
    // constituents — nothing beyond the share is ever requested.
    await waitFor(() => expect(previewSharedConglomerateSandbox).toHaveBeenCalled());
    expect(lastPreviewPositions()).toEqual([
      { id: A_ID, weight: 60 },
      { id: B_ID, weight: 40 },
    ]);

    // Tweak AAA locally to 80 %: the preview recomputes with the new weight.
    const inputA = screen.getByLabelText('Weight for AAA');
    await user.clear(inputA);
    await user.type(inputA, '80');
    await waitFor(() => expect(lastPreviewPositions()).toContainEqual({ id: A_ID, weight: 80 }));

    // "Reset to shared" restores the shared weights EXACTLY in the editor; the
    // preview reverts to its cached shared curve (the 60/40 key is memoised, so
    // no refetch is needed — that reversion is itself proof the tweak was local).
    await user.click(screen.getByRole('button', { name: /Reset to shared/i }));
    await waitFor(() =>
      expect((screen.getByLabelText('Weight for AAA') as HTMLInputElement).value).toBe('60'),
    );
    expect((screen.getByLabelText('Weight for BBB') as HTMLInputElement).value).toBe('40');

    // The shared object was only ever READ once — a sandbox tweak issues no write
    // and never refetches, let alone mutates, the shared basket.
    expect(getSharedConglomerate).toHaveBeenCalledTimes(1);
  });
});
