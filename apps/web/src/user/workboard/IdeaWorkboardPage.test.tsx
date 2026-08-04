import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ConglomerateResolvedResponse, Idea, IdeaResponse } from '@bettertrack/contracts';

vi.mock('../../lib/ideasApi', () => ({ getIdea: vi.fn(), updateIdea: vi.fn() }));
vi.mock('../../lib/conglomerateApi', () => ({ getResolvedConglomerate: vi.fn() }));

// Capture what the panel is seeded with — the "exact reopen" is exactly these props.
const panelProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('./BacktestPanel', () => ({
  BacktestPanel: (props: unknown) => {
    panelProps.current = props;
    return <div data-testid="backtest-panel" />;
  },
}));

import { getResolvedConglomerate } from '../../lib/conglomerateApi';
import { getIdea, updateIdea } from '../../lib/ideasApi';
import { setViewportWidth } from '../../test/viewport';
import { ApiError } from '../../lib/apiClient';
import { IdeaWorkboardPage } from './IdeaWorkboardPage';

const IDEA_ID = '00000000-0000-0000-0000-0000000000a1';
const ASSET_ID = '00000000-0000-0000-0000-0000000000b1';
const CONGLOMERATE_ID = '00000000-0000-0000-0000-0000000000c1';

function adhocIdea(): Idea {
  return {
    id: IDEA_ID,
    name: 'Momentum basket',
    thesis: 'Ride the trend.',
    state: {
      source: { kind: 'adhoc', positions: [{ assetId: ASSET_ID, weight: 60 }] },
      range: '3Y',
      benchmark: { preset: '^GSPC' },
      mode: 'cash',
      rebalance: 'monthly',
    },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function conglomerateIdea(): Idea {
  return {
    ...adhocIdea(),
    thesis: null,
    state: {
      source: { kind: 'conglomerate', conglomerateId: CONGLOMERATE_ID },
      range: '1Y',
      benchmark: null,
      mode: 'clip',
      rebalance: 'none',
    },
  };
}

function resolvedConglomerate(): ConglomerateResolvedResponse {
  return {
    conglomerateId: CONGLOMERATE_ID,
    nested: false,
    positions: [{ assetId: ASSET_ID, weightPct: 70, asset: { symbol: 'A', name: 'A' } }],
  } as unknown as ConglomerateResolvedResponse;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/workbench/ideas/${IDEA_ID}`]}>
        <Routes>
          <Route path="/workbench/ideas/:ideaId" element={<IdeaWorkboardPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  panelProps.current = null;
});

describe('IdeaWorkboardPage', () => {
  test('reopens an ad-hoc idea with the exact saved positions, params, and thesis', async () => {
    vi.mocked(getIdea).mockResolvedValue({ idea: adhocIdea() });
    renderPage();

    expect(await screen.findByText('Momentum basket')).toBeInTheDocument();
    expect(screen.getByText('Ride the trend.')).toBeInTheDocument();
    await screen.findByTestId('backtest-panel');

    expect(panelProps.current).toMatchObject({
      positions: [{ assetId: ASSET_ID, weight: 60 }],
      source: { kind: 'adhoc', positions: [{ assetId: ASSET_ID, weight: 60 }] },
      initialParams: {
        range: '3Y',
        benchmark: { preset: '^GSPC' },
        mode: 'cash',
        rebalance: 'monthly',
      },
    });
    // The ad-hoc set resolves inline — no conglomerate lookup.
    expect(getResolvedConglomerate).not.toHaveBeenCalled();
  });

  test('reopens a blueprint-sourced idea by resolving the referenced basket', async () => {
    const idea = conglomerateIdea();
    vi.mocked(getIdea).mockResolvedValue({ idea });
    // The resolved view (V5-P6): effective asset weights — nested baskets and
    // weight-0 rows are already flattened away server-side.
    vi.mocked(getResolvedConglomerate).mockResolvedValue(resolvedConglomerate());
    renderPage();

    await screen.findByTestId('backtest-panel');
    expect(getResolvedConglomerate).toHaveBeenCalledWith(CONGLOMERATE_ID, expect.anything());
    // The source pointer is preserved verbatim.
    expect(panelProps.current).toMatchObject({
      positions: [{ assetId: ASSET_ID, weight: 70 }],
      source: { kind: 'conglomerate', conglomerateId: CONGLOMERATE_ID },
      initialParams: { range: '1Y', benchmark: null, mode: 'clip', rebalance: 'none' },
    });
  });

  test('shows an error with a retry button when the idea cannot be loaded', async () => {
    vi.mocked(getIdea).mockRejectedValueOnce(new Error('nope'));
    renderPage();
    expect(await screen.findByText("Couldn't load this idea.")).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Try again' });

    // Retry refetches the idea query — this time succeed.
    vi.mocked(getIdea).mockResolvedValueOnce({ idea: adhocIdea() } satisfies IdeaResponse);
    await userEvent.click(retry);
    expect(await screen.findByText('Momentum basket')).toBeInTheDocument();
  });

  test('shows a skeleton placeholder while the idea query is loading', () => {
    let resolve!: (value: IdeaResponse) => void;
    vi.mocked(getIdea).mockReturnValue(
      new Promise<IdeaResponse>((r) => {
        resolve = r;
      }),
    );
    renderPage();
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    resolve({ idea: adhocIdea() });
  });

  test('retries a transient blueprint resolution failure in place', async () => {
    vi.mocked(getIdea).mockResolvedValue({ idea: conglomerateIdea() });
    vi.mocked(getResolvedConglomerate)
      .mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'offline'))
      .mockResolvedValueOnce(resolvedConglomerate());
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText("Could not load this idea's blueprint. Please try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('backtest-panel')).toBeInTheDocument();
    expect(getResolvedConglomerate).toHaveBeenCalledTimes(2);
  });

  test('keeps a confirmed missing blueprint terminal and non-retryable', async () => {
    vi.mocked(getIdea).mockResolvedValue({ idea: conglomerateIdea() });
    vi.mocked(getResolvedConglomerate).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'missing'));
    renderPage();

    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  test('at 390 px edits an idea in a bottom sheet and refreshes its heading', async () => {
    setViewportWidth(390);
    const original = adhocIdea();
    const updated = { ...original, name: 'Edited momentum' };
    vi.mocked(getIdea).mockResolvedValue({ idea: original });
    vi.mocked(updateIdea).mockResolvedValue({ idea: updated });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Edit idea' })).toHaveClass(
      'bt-dialog__panel--phone-sheet',
    );
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Edited momentum');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(updateIdea).toHaveBeenCalledWith(IDEA_ID, {
      name: 'Edited momentum',
      thesis: 'Ride the trend.',
    });
    expect(await screen.findByRole('heading', { name: 'Edited momentum' })).toBeInTheDocument();
  });
});
