import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/conglomerateApi', () => ({
  listConglomerates: vi.fn(),
}));

import { listConglomerates } from '../../lib/conglomerateApi';
import { ConglomeratesListPage } from './ConglomeratesListPage';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPage() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <ConglomeratesListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const CONGLOMERATES = [
  {
    id: 'c1',
    name: 'Core Growth',
    description: null,
    status: 'active' as const,
    visibility: 'private' as const,
    positionCount: 13,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'c2',
    name: 'Dividend Draft',
    description: null,
    status: 'draft' as const,
    visibility: 'private' as const,
    positionCount: 3,
    createdAt: '2024-02-01T00:00:00.000Z',
    updatedAt: '2024-02-01T00:00:00.000Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConglomeratesListPage', () => {
  test('renders a card per Blueprint with name, position count and status', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: CONGLOMERATES });
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    expect(screen.getByText('13 positions')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();

    expect(screen.getByText('Dividend Draft')).toBeInTheDocument();
    expect(screen.getByText('3 positions')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  test('the status badge explains what Active/Draft means to an owner-naive user', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: CONGLOMERATES });
    renderPage();

    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(screen.getByText('Active')).toHaveAttribute(
      'title',
      expect.stringContaining('used by the calculator'),
    );
    expect(screen.getByText('Draft')).toHaveAttribute(
      'title',
      expect.stringContaining('Activate once weights sum to 100%'),
    );
  });

  test('renders a "New Blueprint" card linking to /workbench/blueprints/new', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: CONGLOMERATES });
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    const newCard = screen.getByText('New Blueprint').closest('a');
    expect(newCard).toHaveAttribute('href', '/workbench/blueprints/new');
  });

  test('links each card to its detail page', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: CONGLOMERATES });
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    const card = screen.getByText('Core Growth').closest('a');
    expect(card).toHaveAttribute('href', '/workbench/blueprints/c1');
  });

  test('shows a designed empty state when the user has none', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: [] });
    renderPage();

    await waitFor(() => expect(screen.getByText('No Blueprints yet')).toBeInTheDocument());
    expect(screen.getByText('New Blueprint →')).toBeInTheDocument();
  });

  test('shows an error message when the list fails to load', async () => {
    vi.mocked(listConglomerates)
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ conglomerates: [] });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load your Blueprints/i)).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No Blueprints yet')).toBeInTheDocument();
    expect(listConglomerates).toHaveBeenCalledTimes(2);
  });
});
