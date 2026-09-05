import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';

import type {
  SharedConglomerateDetailResponse,
  SharedSandboxPreviewResponse,
} from '@bettertrack/contracts';

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
import { ApiError } from '../../lib/apiClient';
import { defaultProfileIconIdFor } from '../components/profileIcons';
import { SharedConglomeratePage } from './SharedConglomeratePage';

const CONGLOMERATE_ID = '00000000-0000-0000-0000-000000000010';
const CHILD_ID = '00000000-0000-0000-0000-000000000011';
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

const nestedDetail: SharedConglomerateDetailResponse = {
  ...detail,
  name: 'Nested duo',
  positions: [
    {
      kind: 'conglomerate',
      childId: CHILD_ID,
      weightPct: 70,
      sortOrder: 0,
      child: { id: CHILD_ID, name: 'Core basket', status: 'active', positionCount: 2 },
    },
    {
      kind: 'asset',
      assetId: A_ID,
      weightPct: 30,
      sortOrder: 1,
      asset: { symbol: 'AAA', name: 'Asset A', currency: 'EUR', type: 'stock' },
    },
  ],
};

const previewResponse: SharedSandboxPreviewResponse = {
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
  mode: 'clip',
  rebalance: 'none',
  rebalanceEvents: [],
  idleCashAvgPct: null,
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/social/shared/conglomerate/${CONGLOMERATE_ID}`]}>
        <Routes>
          <Route path="/social/shared/conglomerate/:id" element={<SharedConglomeratePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
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

  test('retries an outage without weakening confirmed audience privacy', async () => {
    (getSharedConglomerate as unknown as Mock)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(detail);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Duo')).toBeInTheDocument();
    expect(getSharedConglomerate).toHaveBeenCalledTimes(2);
  });

  test('replaces stale shared data after a confirmed audience rejection', async () => {
    (getSharedConglomerate as unknown as Mock)
      .mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'not found'));
    const { queryClient } = renderPage();

    expect(await screen.findByText('Duo')).toBeInTheDocument();
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: ['social', 'shared', 'conglomerate', CONGLOMERATE_ID],
      });
    });

    expect(await screen.findByText("This blueprint isn't available")).toBeInTheDocument();
    expect(screen.queryByText('Duo')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(getSharedConglomerate).toHaveBeenCalledTimes(2);
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

  test('a nested child renders as one re-weightable top-level sandbox row', async () => {
    const user = userEvent.setup();
    const untouchedSharedDetail = structuredClone(nestedDetail);
    (getSharedConglomerate as unknown as Mock).mockResolvedValue(nestedDetail);

    renderPage();
    await screen.findByText('Nested duo');

    const toggle = screen.getByRole('button', { name: /What-if sandbox/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    const childWeight = await screen.findByLabelText('Weight for Core basket');
    await waitFor(() => expect(previewSharedConglomerateSandbox).toHaveBeenCalled());
    expect(lastPreviewPositions()).toEqual([
      { id: CHILD_ID, weight: 70 },
      { id: A_ID, weight: 30 },
    ]);

    await user.clear(childWeight);
    await user.type(childWeight, '80');
    await waitFor(() =>
      expect(lastPreviewPositions()).toContainEqual({ id: CHILD_ID, weight: 80 }),
    );

    await user.click(screen.getByRole('button', { name: /Reset to shared/i }));
    await waitFor(() =>
      expect((screen.getByLabelText('Weight for Core basket') as HTMLInputElement).value).toBe(
        '70',
      ),
    );
    expect(nestedDetail).toEqual(untouchedSharedDetail);
    expect(getSharedConglomerate).toHaveBeenCalledTimes(1);
  });
});

/** The curated icon a rendered avatar actually painted (inert `data-icon-id`). */
function avatarIconId(container: HTMLElement): string | null | undefined {
  return container.querySelector('.bt-avatar svg[data-icon-id]')?.getAttribute('data-icon-id');
}

describe('SharedConglomeratePage — the owner has a face (§6.9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (previewSharedConglomerateSandbox as unknown as Mock).mockResolvedValue(previewResponse);
  });

  test('renders the owner’s curated icon beside the title', async () => {
    (getSharedConglomerate as unknown as Mock).mockResolvedValue({
      ...detail,
      owner: { ...detail.owner, profileIcon: 'crown' as const },
    });
    const { container } = renderPage();

    expect(await screen.findByText(detail.name)).toBeInTheDocument();
    expect(avatarIconId(container)).toBe('crown');
  });

  test('falls back to the deterministic default when the owner never picked one', async () => {
    (getSharedConglomerate as unknown as Mock).mockResolvedValue(detail);
    const { container } = renderPage();

    expect(await screen.findByText(detail.name)).toBeInTheDocument();
    expect(avatarIconId(container)).toBe(defaultProfileIconIdFor('alice'));
  });
});
