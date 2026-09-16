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
const C_ID = '00000000-0000-0000-0000-00000000000c';

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

/**
 * The SAME basket after the owner re-weighted it 60/40 → 90/10. Nothing else
 * about it moved, so a sandbox that still shows 60/40 is showing the viewer a
 * basket that no longer exists (#1659 defect 1).
 */
const reweightedDetail: SharedConglomerateDetailResponse = {
  ...detail,
  positions: [
    { ...detail.positions[0]!, weightPct: 90 },
    { ...detail.positions[1]!, weightPct: 10 },
  ],
};

/**
 * The owner re-weighted AAA to exactly the 80 the viewer had already tweaked to
 * (and BBB to the 20 that balances it). Every cell on the page now agrees.
 */
const convergedDetail: SharedConglomerateDetailResponse = {
  ...detail,
  positions: [
    { ...detail.positions[0]!, weightPct: 80 },
    { ...detail.positions[1]!, weightPct: 20 },
  ],
};

/** The same converged basket again, as a distinct payload (the owner edited the blurb). */
const convergedAgainDetail: SharedConglomerateDetailResponse = {
  ...convergedDetail,
  description: 'Rebalanced.',
};

/** The owner moved BOTH weights while the viewer held a tweak on each. */
const bothMovedDetail: SharedConglomerateDetailResponse = {
  ...detail,
  positions: [
    { ...detail.positions[0]!, weightPct: 55 },
    { ...detail.positions[1]!, weightPct: 45 },
  ],
};

/** The owner moved a constituent the viewer did NOT tweak (BBB 40 → 45). */
const bbbMovedDetail: SharedConglomerateDetailResponse = {
  ...detail,
  positions: [detail.positions[0]!, { ...detail.positions[1]!, weightPct: 45 }],
};

/** AAA left the basket and CCC joined it. */
const swappedDetail: SharedConglomerateDetailResponse = {
  ...detail,
  positions: [
    { ...detail.positions[1]!, weightPct: 50, sortOrder: 0 },
    {
      kind: 'asset',
      assetId: C_ID,
      weightPct: 50,
      sortOrder: 1,
      asset: { symbol: 'CCC', name: 'Asset C', currency: 'EUR', type: 'stock' },
    },
  ],
};

/** …and then the owner put AAA back, at a weight of its own. */
const aaaBackDetail: SharedConglomerateDetailResponse = {
  ...detail,
  positions: [
    { ...detail.positions[0]!, weightPct: 25 },
    { ...detail.positions[1]!, weightPct: 75 },
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
  // The aggregate (nested) variant states the share that resolved to no asset
  // (#1832); this fixture's basket resolves completely.
  unresolvedPct: 0,
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

/** Force the shared-detail query to run again, as a focus/reconnect/invalidation would. */
async function refetchShared(queryClient: QueryClient): Promise<void> {
  await act(async () => {
    await queryClient.refetchQueries({
      queryKey: ['social', 'shared', 'conglomerate', CONGLOMERATE_ID],
    });
  });
}

/** The number input of one sandbox row. */
function weightInput(symbol: string): HTMLInputElement {
  return screen.getByLabelText(`Weight for ${symbol}`) as HTMLInputElement;
}

async function openSandbox(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /What-if sandbox/i }));
  await waitFor(() => expect(previewSharedConglomerateSandbox).toHaveBeenCalled());
}

const MOVED_NOTICE = /while you were experimenting/i;

describe('SharedConglomeratePage — the sandbox resyncs to refetched shared weights (#1659)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (previewSharedConglomerateSandbox as unknown as Mock).mockResolvedValue(previewResponse);
  });

  test('an un-tweaked sandbox follows the owner’s re-weight instead of freezing at mount', async () => {
    (getSharedConglomerate as unknown as Mock)
      .mockResolvedValueOnce(detail)
      .mockResolvedValue(reweightedDetail);
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await screen.findByText('Duo');
    await openSandbox(user);
    expect(lastPreviewPositions()).toEqual([
      { id: A_ID, weight: 60 },
      { id: B_ID, weight: 40 },
    ]);

    await refetchShared(queryClient);

    // The sandbox rows equal the read-only position list again…
    await waitFor(() => expect(weightInput('AAA').value).toBe('90'));
    expect(weightInput('BBB').value).toBe('10');
    // …the viewer never touched anything, so the sandbox is still pristine…
    expect(screen.getByRole('button', { name: /Reset to shared/i })).toBeDisabled();
    // …nothing claims their work was disturbed…
    expect(screen.queryByText(MOVED_NOTICE)).toBeNull();
    // …and the curve under the rows is the NEW shared basket's, not the old one.
    await waitFor(() =>
      expect(lastPreviewPositions()).toEqual([
        { id: A_ID, weight: 90 },
        { id: B_ID, weight: 10 },
      ]),
    );
  });

  test('a refetch that does not move the tweaked constituent keeps the tweak, silently', async () => {
    (getSharedConglomerate as unknown as Mock)
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(detail)
      .mockResolvedValue(bbbMovedDetail);
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await screen.findByText('Duo');
    await openSandbox(user);

    const inputA = weightInput('AAA');
    await user.clear(inputA);
    await user.type(inputA, '80');
    await waitFor(() => expect(lastPreviewPositions()).toContainEqual({ id: A_ID, weight: 80 }));

    // (a) A refetch that changes NOTHING must not disturb the edit or nag.
    await refetchShared(queryClient);
    expect(weightInput('AAA').value).toBe('80');
    expect(weightInput('BBB').value).toBe('40');
    expect(screen.queryByText(MOVED_NOTICE)).toBeNull();

    // (b) A refetch that moves a DIFFERENT row leaves the in-progress tweak be,
    //     and still says nothing — the viewer's own value was never at risk.
    await refetchShared(queryClient);
    await waitFor(() => expect(weightInput('BBB').value).toBe('45'));
    expect(weightInput('AAA').value).toBe('80');
    expect(screen.queryByText(MOVED_NOTICE)).toBeNull();
    expect(screen.getByRole('button', { name: /Reset to shared/i })).toBeEnabled();
    await waitFor(() =>
      expect(lastPreviewPositions()).toEqual([
        { id: A_ID, weight: 80 },
        { id: B_ID, weight: 45 },
      ]),
    );
  });

  test('a re-weight UNDER a live tweak keeps the edit and names the row whose baseline moved', async () => {
    (getSharedConglomerate as unknown as Mock)
      .mockResolvedValueOnce(detail)
      .mockResolvedValue(reweightedDetail);
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await screen.findByText('Duo');
    await openSandbox(user);

    const inputA = weightInput('AAA');
    await user.clear(inputA);
    await user.type(inputA, '80');
    await waitFor(() => expect(lastPreviewPositions()).toContainEqual({ id: A_ID, weight: 80 }));

    await refetchShared(queryClient);

    // The untouched row follows the new shared weight…
    await waitFor(() => expect(weightInput('BBB').value).toBe('10'));
    // …the viewer's own edit is NOT thrown away…
    expect(weightInput('AAA').value).toBe('80');
    // …and the notice names the row whose shared baseline moved, and only it.
    const notice = screen.getByText(MOVED_NOTICE);
    expect(notice).toHaveTextContent('AAA');
    expect(notice).not.toHaveTextContent('BBB');

    // "Reset to shared" adopts the NEW shared weights and retires the notice.
    await user.click(screen.getByRole('button', { name: /Reset to shared/i }));
    await waitFor(() => expect(weightInput('AAA').value).toBe('90'));
    expect(weightInput('BBB').value).toBe('10');
    expect(screen.queryByText(MOVED_NOTICE)).toBeNull();
    expect(screen.getByRole('button', { name: /Reset to shared/i })).toBeDisabled();
  });

  test('a row typed back to its shared weight follows the owner again', async () => {
    (getSharedConglomerate as unknown as Mock)
      .mockResolvedValueOnce(detail)
      .mockResolvedValue(reweightedDetail);
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await screen.findByText('Duo');
    await openSandbox(user);

    // Away from the shared weight…
    const inputA = weightInput('AAA');
    await user.clear(inputA);
    await user.type(inputA, '80');
    await waitFor(() => expect(lastPreviewPositions()).toContainEqual({ id: A_ID, weight: 80 }));
    // …and back onto it: the sandbox is pristine again, with no held opinion.
    await user.clear(weightInput('AAA'));
    await user.type(weightInput('AAA'), '60');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Reset to shared/i })).toBeDisabled(),
    );

    await refetchShared(queryClient);

    await waitFor(() => expect(weightInput('AAA').value).toBe('90'));
    expect(screen.queryByText(MOVED_NOTICE)).toBeNull();
    expect(screen.getByRole('button', { name: /Reset to shared/i })).toBeDisabled();
  });

  test('an owner who lands ON the viewer’s value leaves nothing to warn about', async () => {
    (getSharedConglomerate as unknown as Mock)
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(convergedDetail)
      .mockResolvedValue(convergedAgainDetail);
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await screen.findByText('Duo');
    await openSandbox(user);

    const inputA = weightInput('AAA');
    await user.clear(inputA);
    await user.type(inputA, '80');
    await waitFor(() => expect(lastPreviewPositions()).toContainEqual({ id: A_ID, weight: 80 }));

    // The owner re-weights AAA to the very 80 the viewer chose. The baseline
    // moved, but the viewer's opinion and the shared basket now AGREE — every
    // cell matches, `isPristine` is true and Reset is disabled, so a notice
    // telling the reader to press Reset would contradict the page it sits on.
    await refetchShared(queryClient);
    await waitFor(() => expect(weightInput('BBB').value).toBe('20'));
    expect(weightInput('AAA').value).toBe('80');
    expect(screen.getByRole('button', { name: /Reset to shared/i })).toBeDisabled();
    expect(screen.queryByText(MOVED_NOTICE)).toBeNull();

    // …and it stays clean: a converged row holds no opinion to re-flag later.
    await refetchShared(queryClient);
    expect(await screen.findByText('Rebalanced.')).toBeInTheDocument();
    expect(screen.queryByText(MOVED_NOTICE)).toBeNull();
    expect(screen.getByRole('button', { name: /Reset to shared/i })).toBeDisabled();
  });

  test('the notice counts the rows it names — singular for one, plural for two', async () => {
    (getSharedConglomerate as unknown as Mock)
      .mockResolvedValueOnce(detail)
      .mockResolvedValue(bothMovedDetail);
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await screen.findByText('Duo');
    await openSandbox(user);

    await user.clear(weightInput('AAA'));
    await user.type(weightInput('AAA'), '70');
    await user.clear(weightInput('BBB'));
    await user.type(weightInput('BBB'), '30');
    await waitFor(() =>
      expect(lastPreviewPositions()).toEqual([
        { id: A_ID, weight: 70 },
        { id: B_ID, weight: 30 },
      ]),
    );

    await refetchShared(queryClient);

    // Two rows moved: the plural sentence, naming both, and counted.
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('AAA');
    expect(notice).toHaveTextContent('BBB');
    expect(notice).toHaveTextContent('2');
    expect(notice.textContent).toMatch(/weights/);
    expect(notice.textContent).not.toMatch(/\bweight\b/);

    // Acknowledging one of them leaves the singular sentence for the other.
    await user.clear(weightInput('AAA'));
    await user.type(weightInput('AAA'), '65');
    const single = await screen.findByRole('status');
    expect(single).toHaveTextContent('BBB');
    expect(single).not.toHaveTextContent('AAA');
    expect(single.textContent).toMatch(/\bweight\b/);
    expect(single.textContent).not.toMatch(/weights/);
  });

  test('a constituent that leaves stops contributing, a new one joins at its shared weight, and a returning id does not resurrect the old tweak', async () => {
    (getSharedConglomerate as unknown as Mock)
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(swappedDetail)
      .mockResolvedValue(aaaBackDetail);
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    await screen.findByText('Duo');
    await openSandbox(user);

    const inputA = weightInput('AAA');
    await user.clear(inputA);
    await user.type(inputA, '80');
    await waitFor(() => expect(lastPreviewPositions()).toContainEqual({ id: A_ID, weight: 80 }));

    // AAA leaves, CCC joins: the request covers exactly the new shared set, at
    // the new shared weights — the server's exact-set guard keeps passing.
    await refetchShared(queryClient);
    await waitFor(() => expect(screen.queryByLabelText('Weight for AAA')).toBeNull());
    expect(weightInput('CCC').value).toBe('50');
    await waitFor(() =>
      expect(lastPreviewPositions()).toEqual([
        { id: B_ID, weight: 50 },
        { id: C_ID, weight: 50 },
      ]),
    );

    // AAA comes back at 25: it is the SHARED weight that shows, never the tweak
    // the viewer made against a basket that no longer contained this row.
    await refetchShared(queryClient);
    await waitFor(() => expect(weightInput('AAA').value).toBe('25'));
    expect(weightInput('BBB').value).toBe('75');
    await waitFor(() =>
      expect(lastPreviewPositions()).toEqual([
        { id: A_ID, weight: 25 },
        { id: B_ID, weight: 75 },
      ]),
    );
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
