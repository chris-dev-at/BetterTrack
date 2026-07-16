import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { SharedWithMeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/socialApi', () => ({ listSharedWithMe: vi.fn() }));
vi.mock('../../lib/ideasApi', () => ({ cloneIdea: vi.fn() }));

import { cloneIdea } from '../../lib/ideasApi';
import { listSharedWithMe } from '../../lib/socialApi';
import { SharedIdeaPage } from './SharedIdeaPage';

const IDEA_ID = '00000000-0000-0000-0000-0000000000a1';
const CLONE_ID = '00000000-0000-0000-0000-0000000000ff';
const OWNER = { id: '00000000-0000-0000-0000-0000000000b1', username: 'alice' };

const EMPTY: SharedWithMeResponse = {
  portfolios: [],
  conglomerates: [],
  watchlists: [],
  ideas: [],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/social/shared-with-me/ideas/${IDEA_ID}`]}>
        <Routes>
          <Route path="/social/shared-with-me/ideas/:ideaId" element={<SharedIdeaPage />} />
          <Route path="/workboard/ideas/:ideaId" element={<div>Cloned idea open</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('SharedIdeaPage', () => {
  test('shows the read-only idea (name, owner, thesis note) with a Clone action', async () => {
    vi.mocked(listSharedWithMe).mockResolvedValue({
      ...EMPTY,
      ideas: [
        {
          ideaId: IDEA_ID,
          name: 'Momentum basket',
          owner: OWNER,
          hasThesis: true,
          activityAlertsEnabled: false,
        },
      ],
    });
    renderPage();

    expect(await screen.findByText('Momentum basket')).toBeInTheDocument();
    expect(screen.getByText('Shared by alice')).toBeInTheDocument();
    expect(screen.getByText('Includes a thesis note.')).toBeInTheDocument();
    // Read-only: no edit affordance, only the clone action.
    expect(screen.getByRole('button', { name: 'Clone to my ideas' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  });

  test('Clone creates an own private copy and opens it', async () => {
    vi.mocked(listSharedWithMe).mockResolvedValue({
      ...EMPTY,
      ideas: [
        {
          ideaId: IDEA_ID,
          name: 'Momentum basket',
          owner: OWNER,
          hasThesis: false,
          activityAlertsEnabled: false,
        },
      ],
    });
    vi.mocked(cloneIdea).mockResolvedValue({
      idea: {
        id: CLONE_ID,
        name: 'Momentum basket',
        thesis: null,
        state: {
          source: { kind: 'adhoc', positions: [{ assetId: OWNER.id, weight: 1 }] },
          range: '5Y',
          benchmark: null,
          mode: 'clip',
          rebalance: 'none',
        },
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    });
    renderPage();
    await screen.findByText('Momentum basket');

    await userEvent.click(screen.getByRole('button', { name: 'Clone to my ideas' }));
    await waitFor(() => expect(cloneIdea).toHaveBeenCalledWith(IDEA_ID));
    expect(await screen.findByText('Cloned idea open')).toBeInTheDocument();
  });

  test('an idea not shared with the caller shows a calm not-available state', async () => {
    vi.mocked(listSharedWithMe).mockResolvedValue(EMPTY);
    renderPage();
    expect(await screen.findByText('Idea not available')).toBeInTheDocument();
    expect(cloneIdea).not.toHaveBeenCalled();
  });

  test('shows a designed error state with a retry button when the query fails', async () => {
    vi.mocked(listSharedWithMe).mockRejectedValueOnce(new Error('boom'));
    renderPage();
    expect(await screen.findByText("Couldn't load this idea.")).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Try again' });

    // Retry refetches — this time succeed.
    vi.mocked(listSharedWithMe).mockResolvedValueOnce({
      ...EMPTY,
      ideas: [
        {
          ideaId: IDEA_ID,
          name: 'Momentum basket',
          owner: OWNER,
          hasThesis: true,
          activityAlertsEnabled: false,
        },
      ],
    });
    await userEvent.click(retry);
    expect(await screen.findByText('Momentum basket')).toBeInTheDocument();
  });

  test('shows a skeleton placeholder while the shared-with-me query is loading', () => {
    let resolve!: (value: SharedWithMeResponse) => void;
    vi.mocked(listSharedWithMe).mockReturnValue(
      new Promise<SharedWithMeResponse>((r) => {
        resolve = r;
      }),
    );
    renderPage();
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    resolve(EMPTY);
  });
});
