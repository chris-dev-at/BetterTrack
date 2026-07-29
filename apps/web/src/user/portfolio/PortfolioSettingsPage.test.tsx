import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  updatePortfolio: vi.fn(),
  archivePortfolio: vi.fn(),
  restorePortfolio: vi.fn(),
  deletePortfolio: vi.fn(),
}));

import { ApiError } from '../../lib/apiClient';
import {
  archivePortfolio,
  deletePortfolio,
  listPortfolios,
  restorePortfolio,
  updatePortfolio,
} from '../../lib/portfolioApi';
import { PortfolioSettingsPage } from './PortfolioSettingsPage';
import { ACTIVE_PORTFOLIO_PARAM } from './PortfolioSwitcher';
import { getPortfolioKind, resetPortfolioKindCache, setPortfolioKind } from './portfolioKinds';

type Summary = {
  id: string;
  name: string;
  visibility: 'private' | 'friends';
  sortOrder: number;
  isDefault: boolean;
  defaultPayFromCash: boolean;
  archivedAt: string | null;
  mirror?: {
    chainId: string;
    chainName: string;
    role: 'owner' | 'manager' | 'member';
    memberCount: number;
    sync: { appliedSeq: number; lastSeq: number; percent: number; synced: boolean };
  };
};

function summary(over: Partial<Summary> & { id: string; name: string }): Summary {
  return {
    visibility: 'private',
    sortOrder: 0,
    isDefault: false,
    defaultPayFromCash: false,
    archivedAt: null,
    ...over,
  };
}

const MAIN = summary({ id: 'p1', name: 'Main', isDefault: true });
const TRADING = summary({ id: 'p2', name: 'Trading', sortOrder: 1 });
const OLD = summary({
  id: 'p3',
  name: 'Old',
  sortOrder: 2,
  archivedAt: '2026-01-01T00:00:00.000Z',
});
const HOUSEHOLD = summary({
  id: 'p4',
  name: 'Household',
  sortOrder: 3,
  mirror: {
    chainId: 'c1',
    chainName: 'Household',
    role: 'owner',
    memberCount: 3,
    sync: { appliedSeq: 9, lastSeq: 9, percent: 100, synced: true },
  },
});

/** Serve the active list and the `includeArchived` list from one fixture set. */
function mockLists(active: Summary[], archived: Summary[] = []) {
  vi.mocked(listPortfolios).mockImplementation((_signal, includeArchived) =>
    Promise.resolve({ portfolios: includeArchived ? [...active, ...archived] : active }),
  );
}

function ActiveProbe() {
  const [params] = useSearchParams();
  return <div data-testid="active-param">{params.get(ACTIVE_PORTFOLIO_PARAM) ?? ''}</div>;
}

function renderSettings(portfolioId = 'p2') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/portfolio/settings?portfolio=${portfolioId}`]}>
      <QueryClientProvider client={client}>
        <PortfolioSettingsPage />
        <ActiveProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  resetPortfolioKindCache();
});

describe('PortfolioSettingsPage — general', () => {
  test('resolves the portfolio from the routing param and seeds the name field', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    expect(await screen.findByLabelText('Name')).toHaveValue('Trading');
  });

  test('save stays disabled until the name actually changes', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Name'), ' desk');
    expect(save).toBeEnabled();
  });

  test('renaming calls the API with the trimmed name', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(updatePortfolio).mockResolvedValue({ ...TRADING, name: 'Trading desk' });
    renderSettings('p2');

    const field = await screen.findByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, '  Trading desk  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updatePortfolio).toHaveBeenCalledWith('p2', { name: 'Trading desk' }),
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  test('a taken name surfaces the specific error, not the generic one', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(updatePortfolio).mockRejectedValue(
      new ApiError(409, 'PORTFOLIO_NAME_TAKEN', 'taken'),
    );
    renderSettings('p2');

    const field = await screen.findByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Main');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('You already have a portfolio with that name.'),
    ).toBeInTheDocument();
  });
});

describe('PortfolioSettingsPage — kind', () => {
  test('defaults to private and marks exactly one kind checked', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    expect(await screen.findByRole('radio', { name: 'Private' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Business' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  test('picking a kind persists it for that portfolio only', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('radio', { name: 'Property' }));

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Property' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(getPortfolioKind('p2')).toBe('property');
    // Untouched portfolios keep the default.
    expect(getPortfolioKind('p1')).toBe('private');
    // …and it survives a reload of the store from localStorage.
    resetPortfolioKindCache();
    expect(getPortfolioKind('p2')).toBe('property');
  });

  test('shows the stored kind on mount', async () => {
    setPortfolioKind('p2', 'savings');
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    expect(await screen.findByRole('radio', { name: 'Savings' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

describe('PortfolioSettingsPage — group portfolio', () => {
  test('a non-group portfolio offers the convert entry point', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Make this a group portfolio' }),
    );

    // The existing ConvertChainDialog, wired exactly as the overview header did.
    expect(
      await screen.findByRole('dialog', { name: 'Make this a group portfolio' }),
    ).toBeInTheDocument();
  });

  test('a group portfolio manages its chain instead of converting again', async () => {
    mockLists([MAIN, HOUSEHOLD]);
    renderSettings('p4');

    expect(await screen.findByRole('button', { name: 'Manage group' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Make this a group portfolio' }),
    ).not.toBeInTheDocument();
  });
});

describe('PortfolioSettingsPage — archived', () => {
  test('lists archived portfolios and restores one', async () => {
    mockLists([MAIN, TRADING], [OLD]);
    vi.mocked(restorePortfolio).mockResolvedValue({ ...OLD, archivedAt: null });
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restorePortfolio).toHaveBeenCalledWith('p3'));
  });

  test('says so when nothing is archived', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    expect(await screen.findByText('No archived portfolios.')).toBeInTheDocument();
  });
});

describe('PortfolioSettingsPage — danger zone', () => {
  test('archive and delete are disabled on the only active portfolio', async () => {
    mockLists([MAIN]);
    renderSettings('p1');

    expect(await screen.findByRole('button', { name: 'Archive this portfolio' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete this portfolio' })).toBeDisabled();
  });

  test('archiving goes through the confirm dialog and forgets the active portfolio', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(archivePortfolio).mockResolvedValue({
      ...TRADING,
      archivedAt: '2026-02-01T00:00:00.000Z',
    });
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('button', { name: 'Archive this portfolio' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(archivePortfolio).toHaveBeenCalledWith('p2'));
    // The archived portfolio was active → the param AND the session memory go.
    await waitFor(() => expect(screen.getByTestId('active-param')).toHaveTextContent(''));
    expect(sessionStorage.getItem('bt.portfolio.last')).toBeNull();
  });

  test('the delete button stays disabled until the exact portfolio name is typed', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete this portfolio' }));

    const del = await screen.findByRole('button', { name: 'Delete permanently' });
    expect(del).toBeDisabled();

    const field = screen.getByLabelText('Portfolio name confirmation');
    await userEvent.type(field, 'Tradin'); // not yet the full name
    expect(del).toBeDisabled();
    await userEvent.type(field, 'g'); // now exactly "Trading"
    expect(del).toBeEnabled();
  });

  test('deletes the active portfolio and navigates away on success', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(deletePortfolio).mockResolvedValue(undefined);
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete this portfolio' }));
    await userEvent.type(screen.getByLabelText('Portfolio name confirmation'), 'Trading');
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(deletePortfolio).toHaveBeenCalledWith('p2'));
    await waitFor(() => expect(screen.getByTestId('active-param')).toHaveTextContent(''));
  });

  test('names the auto-promoted default when deleting the current default', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p1');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete this portfolio' }));

    expect(
      await screen.findByText('"Trading" will become your new default portfolio.'),
    ).toBeInTheDocument();
  });

  test("the API's last-active refusal is surfaced verbatim", async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(deletePortfolio).mockRejectedValue(
      new ApiError(400, 'LAST_ACTIVE_PORTFOLIO', 'You need at least one active portfolio.'),
    );
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete this portfolio' }));
    await userEvent.type(screen.getByLabelText('Portfolio name confirmation'), 'Trading');
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    expect(await screen.findByText('You need at least one active portfolio.')).toBeInTheDocument();
  });
});
