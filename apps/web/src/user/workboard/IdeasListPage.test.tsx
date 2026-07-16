import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Idea, IdeaListResponse, MySharedResponse } from '@bettertrack/contracts';

vi.mock('../../lib/ideasApi', () => ({ listIdeas: vi.fn(), deleteIdea: vi.fn() }));
vi.mock('../../lib/socialApi', () => ({
  listMyShared: vi.fn(),
  getAudience: vi.fn(),
  listFriends: vi.fn(),
  setAudience: vi.fn(),
}));

import { deleteIdea, listIdeas } from '../../lib/ideasApi';
import { getAudience, listFriends, listMyShared, setAudience } from '../../lib/socialApi';
import { IdeasListPage } from './IdeasListPage';

const IDEA_ID = '00000000-0000-0000-0000-0000000000a1';

function idea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: IDEA_ID,
    name: 'Momentum basket',
    thesis: 'Ride the trend.',
    state: {
      source: { kind: 'adhoc', positions: [{ assetId: IDEA_ID, weight: 50 }] },
      range: '5Y',
      benchmark: null,
      mode: 'clip',
      rebalance: 'none',
    },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const EMPTY_SHARED: MySharedResponse = {
  portfolios: [],
  conglomerates: [],
  watchlists: [],
  ideas: [],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IdeasListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMyShared).mockResolvedValue(EMPTY_SHARED);
  vi.mocked(listFriends).mockResolvedValue({ friends: [] });
  vi.mocked(getAudience).mockResolvedValue({
    kind: 'idea',
    subjectId: IDEA_ID,
    audience: 'private',
    friendIds: [],
    link: { active: false, createdAt: null },
  });
});

describe('IdeasListPage', () => {
  test('shows an empty state when there are no saved ideas', async () => {
    vi.mocked(listIdeas).mockResolvedValue({ ideas: [] });
    renderPage();
    expect(await screen.findByText('No saved ideas yet')).toBeInTheDocument();
  });

  test('shows a skeleton placeholder while the ideas query is loading', () => {
    let resolve!: (value: IdeaListResponse) => void;
    vi.mocked(listIdeas).mockReturnValue(
      new Promise<IdeaListResponse>((r) => {
        resolve = r;
      }),
    );
    renderPage();
    // The Skeleton primitive carries role="status" with a "Loading" aria-label.
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    // Cleanup so the pending query settles before the test file ends.
    resolve({ ideas: [] });
  });

  test('shows a designed error state with a retry button when the query fails', async () => {
    vi.mocked(listIdeas).mockRejectedValueOnce(new Error('boom'));
    renderPage();
    expect(await screen.findByText("Couldn't load your ideas.")).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Try again' });

    // Retry refetches the ideas query — this time succeed.
    vi.mocked(listIdeas).mockResolvedValueOnce({ ideas: [idea()] });
    await userEvent.click(retry);
    expect(await screen.findByText('Momentum basket')).toBeInTheDocument();
  });

  test('lists an idea with its thesis, audience badge, and an Open link', async () => {
    vi.mocked(listIdeas).mockResolvedValue({ ideas: [idea()] } satisfies IdeaListResponse);
    vi.mocked(listMyShared).mockResolvedValue({
      ...EMPTY_SHARED,
      ideas: [
        {
          ideaId: IDEA_ID,
          name: 'Momentum basket',
          hasThesis: true,
          audience: 'all_friends',
          friendCount: 0,
        },
      ],
    });
    renderPage();

    expect(await screen.findByText('Momentum basket')).toBeInTheDocument();
    expect(screen.getByText('Ride the trend.')).toBeInTheDocument();
    expect(screen.getByText('All friends')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      `/workboard/ideas/${IDEA_ID}`,
    );
  });

  test('opening Share surfaces the AudiencePicker friction ladder for the idea', async () => {
    vi.mocked(listIdeas).mockResolvedValue({ ideas: [idea()] });
    renderPage();
    await screen.findByText('Momentum basket');

    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    // Picker opened against the idea kind.
    await waitFor(() =>
      expect(getAudience).toHaveBeenCalledWith('idea', IDEA_ID, expect.anything()),
    );

    // public → strong acknowledgment; all-friends → light confirm (the §16 ladder).
    await userEvent.click(await screen.findByText('Public link'));
    expect(screen.getByText(/sees your holdings and net worth/i)).toBeInTheDocument();
    await userEvent.click(screen.getByText('All friends'));
    expect(screen.getByText(/shares a read-only view/i)).toBeInTheDocument();
  });

  test('deleting an idea confirms then calls the API', async () => {
    vi.mocked(listIdeas).mockResolvedValue({ ideas: [idea()] });
    vi.mocked(deleteIdea).mockResolvedValue(undefined);
    vi.mocked(setAudience).mockResolvedValue({} as never);
    renderPage();
    await screen.findByText('Momentum basket');

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteIdea).toHaveBeenCalledWith(IDEA_ID));
  });
});
