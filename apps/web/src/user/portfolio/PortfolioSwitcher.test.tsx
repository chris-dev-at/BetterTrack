import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  createPortfolio: vi.fn(),
  archivePortfolio: vi.fn(),
  restorePortfolio: vi.fn(),
  updatePortfolio: vi.fn(),
}));

import {
  archivePortfolio,
  createPortfolio,
  listPortfolios,
  restorePortfolio,
} from '../../lib/portfolioApi';
import { ACTIVE_PORTFOLIO_PARAM, PortfolioSwitcher } from './PortfolioSwitcher';

type Summary = {
  id: string;
  name: string;
  visibility: 'private' | 'friends';
  sortOrder: number;
  isDefault: boolean;
  defaultPayFromCash: boolean;
  archivedAt: string | null;
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

/** Surfaces the current `?portfolio=` param so tests can assert routing. */
function ActiveProbe() {
  const [params] = useSearchParams();
  return <div data-testid="active-param">{params.get(ACTIVE_PORTFOLIO_PARAM) ?? ''}</div>;
}

function renderSwitcher() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/portfolio']}>
      <QueryClientProvider client={client}>
        <PortfolioSwitcher />
        <ActiveProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PortfolioSwitcher', () => {
  test('shows the active default and lists active portfolios', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    await waitFor(() => expect(trigger).toHaveTextContent('Main'));

    await userEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Portfolios' });
    expect(within(menu).getByRole('menuitemradio', { name: /Main/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: /Trading/ })).toBeInTheDocument();
  });

  test('switching a portfolio sets the routing param', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Trading/ }));

    await waitFor(() => expect(screen.getByTestId('active-param')).toHaveTextContent('p2'));
  });

  test('creating a portfolio calls the API and activates the new one', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    vi.mocked(createPortfolio).mockResolvedValue(summary({ id: 'p9', name: 'Retirement' }));
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '+ New portfolio' }));

    await userEvent.type(await screen.findByLabelText('Portfolio name'), 'Retirement');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalledWith('Retirement'));
    await waitFor(() => expect(screen.getByTestId('active-param')).toHaveTextContent('p9'));
  });

  test('archive is disabled when only one active portfolio exists', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    expect(await screen.findByRole('menuitem', { name: 'Archive current' })).toBeDisabled();
  });

  test('archives the active portfolio through the API', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    vi.mocked(archivePortfolio).mockResolvedValue({
      ...TRADING,
      archivedAt: '2026-01-01T00:00:00.000Z',
    });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    // Switch to the non-default Trading, then archive it.
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Trading/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive current' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(archivePortfolio).toHaveBeenCalledWith('p2'));
  });

  test('restores an archived portfolio from the Archived dialog', async () => {
    vi.mocked(listPortfolios).mockImplementation((_signal, includeArchived) =>
      Promise.resolve({
        portfolios: includeArchived
          ? [MAIN, summary({ id: 'p3', name: 'Old', archivedAt: '2026-01-01T00:00:00.000Z' })]
          : [MAIN],
      }),
    );
    vi.mocked(restorePortfolio).mockResolvedValue(summary({ id: 'p3', name: 'Old' }));
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archived…' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restorePortfolio).toHaveBeenCalledWith('p3'));
  });
});
