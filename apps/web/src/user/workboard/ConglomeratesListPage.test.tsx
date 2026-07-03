import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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
    positionCount: 13,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'c2',
    name: 'Dividend Draft',
    description: null,
    status: 'draft' as const,
    positionCount: 3,
    createdAt: '2024-02-01T00:00:00.000Z',
    updatedAt: '2024-02-01T00:00:00.000Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConglomeratesListPage', () => {
  test('renders a card per Conglomerate with name, position count and status', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: CONGLOMERATES });
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    expect(screen.getByText('13 positions')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();

    expect(screen.getByText('Dividend Draft')).toBeInTheDocument();
    expect(screen.getByText('3 positions')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  test('renders a "New Conglomerate" card linking to /workboard/conglomerates/new', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: CONGLOMERATES });
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    const newCard = screen.getByText('New Conglomerate').closest('a');
    expect(newCard).toHaveAttribute('href', '/workboard/conglomerates/new');
  });

  test('links each card to its detail page', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: CONGLOMERATES });
    renderPage();

    await waitFor(() => expect(screen.getByText('Core Growth')).toBeInTheDocument());
    const card = screen.getByText('Core Growth').closest('a');
    expect(card).toHaveAttribute('href', '/workboard/conglomerates/c1');
  });

  test('shows a designed empty state when the user has none', async () => {
    vi.mocked(listConglomerates).mockResolvedValue({ conglomerates: [] });
    renderPage();

    await waitFor(() => expect(screen.getByText('No Conglomerates yet')).toBeInTheDocument());
    expect(screen.getByText('New Conglomerate →')).toBeInTheDocument();
  });

  test('shows an error message when the list fails to load', async () => {
    vi.mocked(listConglomerates).mockRejectedValue(new Error('nope'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Could not load your Conglomerates/i)).toBeInTheDocument(),
    );
  });
});
