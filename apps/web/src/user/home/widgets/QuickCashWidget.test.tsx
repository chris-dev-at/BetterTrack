import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { PortfolioSummary } from '@bettertrack/contracts';

vi.mock('../../../lib/portfolioApi');

import { depositCash, listCashSources, withdrawCash } from '../../../lib/portfolioApi';

import { QuickCashWidget } from './QuickCashWidget';
import type { WidgetProps } from './types';

/**
 * The Home quick-entry form (owner, 2026-07-31). It WRITES MONEY from a board
 * tile with no confirmation step, so what is pinned here is which endpoint each
 * direction reaches, that a bad amount never leaves the client, and that it
 * refuses to guess a destination when the board is not scoped to one portfolio.
 */

const PORTFOLIO: PortfolioSummary = {
  id: 'p1',
  name: 'Main',
  visibility: 'private',
  sortOrder: 0,
  isDefault: true,
  defaultPayFromCash: false,
  archivedAt: null,
};

const MAIN_SOURCE = {
  id: 's1',
  portfolioId: 'p1',
  name: 'Main',
  kind: 'cash' as const,
  balanceEur: 500,
  isMain: true,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderWidget(over: Partial<WidgetProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props: WidgetProps = {
    settings: { scope: 'p1' },
    onSettingsChange: vi.fn(),
    portfolios: [PORTFOLIO],
    scopedPortfolios: [PORTFOLIO],
    scopedPortfolio: PORTFOLIO,
    portfoliosLoading: false,
    size: 'm',
    ...over,
  };
  render(
    <QueryClientProvider client={client}>
      <QuickCashWidget {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listCashSources).mockResolvedValue({
    sources: [MAIN_SOURCE],
  } as unknown as Awaited<ReturnType<typeof listCashSources>>);
});

test('records money in against the scoped portfolio without opening anything', async () => {
  vi.mocked(depositCash).mockResolvedValue({
    balanceEur: 600,
  } as unknown as Awaited<ReturnType<typeof depositCash>>);
  const user = userEvent.setup();
  renderWidget();

  await user.click(await screen.findByRole('button', { name: 'Money in' }));
  await user.type(screen.getByRole('textbox', { name: 'Amount' }), '100');
  await user.click(screen.getByRole('button', { name: 'Record' }));

  expect(depositCash).toHaveBeenCalledWith('p1', { amountEur: 100, sourceId: 's1' });
  expect(withdrawCash).not.toHaveBeenCalled();
});

test('defaults to money OUT — spending is what gets recorded constantly', async () => {
  vi.mocked(withdrawCash).mockResolvedValue({
    balanceEur: 480,
  } as unknown as Awaited<ReturnType<typeof withdrawCash>>);
  const user = userEvent.setup();
  renderWidget();

  // No direction pressed: straight to an amount and Record.
  await user.type(await screen.findByRole('textbox', { name: 'Amount' }), '20');
  await user.click(screen.getByRole('button', { name: 'Record' }));

  expect(withdrawCash).toHaveBeenCalledWith('p1', { amountEur: 20, sourceId: 's1' });
  expect(depositCash).not.toHaveBeenCalled();
});

test('offers no fee choice — that is a considered call, made in the full dialog', async () => {
  renderWidget();

  await screen.findByRole('button', { name: 'Money out' });
  expect(screen.queryByRole('button', { name: 'Fee' })).not.toBeInTheDocument();
});

test('carries a note through when one is given', async () => {
  vi.mocked(withdrawCash).mockResolvedValue({
    balanceEur: 460,
  } as unknown as Awaited<ReturnType<typeof withdrawCash>>);
  const user = userEvent.setup();
  renderWidget();

  await user.type(await screen.findByRole('textbox', { name: 'Amount' }), '40');
  await user.type(screen.getByRole('textbox', { name: 'Note' }), 'SPAR MARKT');
  await user.click(screen.getByRole('button', { name: 'Record' }));

  expect(withdrawCash).toHaveBeenCalledWith('p1', {
    amountEur: 40,
    sourceId: 's1',
    note: 'SPAR MARKT',
  });
});

test('a zero or empty amount never reaches the server', async () => {
  const user = userEvent.setup();
  renderWidget();

  await user.click(await screen.findByRole('button', { name: 'Record' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter an amount greater than 0.');

  await user.type(screen.getByRole('textbox', { name: 'Amount' }), '0');
  await user.click(screen.getByRole('button', { name: 'Record' }));

  expect(depositCash).not.toHaveBeenCalled();
});

test('refuses to guess a destination when the board is not scoped to one portfolio', async () => {
  renderWidget({ scopedPortfolio: null, settings: { scope: 'all' } });

  expect(await screen.findByText(/Pick one portfolio for this widget/)).toBeInTheDocument();
  expect(listCashSources).not.toHaveBeenCalled();
});

test('names the account it will land in, and what is in it', async () => {
  renderWidget();

  expect(await screen.findByText('Into Main')).toBeInTheDocument();
  expect(screen.getByText('500,00 €')).toBeInTheDocument();
});
