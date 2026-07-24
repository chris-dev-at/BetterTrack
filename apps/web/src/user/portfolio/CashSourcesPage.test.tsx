import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/portfolioApi');
import * as portfolioApi from '../../lib/portfolioApi';

import { CashSourcesPage } from './CashSourcesPage';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PORTFOLIO_LIST = {
  portfolios: [
    {
      id: 'p1',
      name: 'Main',
      visibility: 'private' as const,
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

function source(over: Partial<import('@bettertrack/contracts').CashSource>) {
  return {
    id: 'src-x',
    name: 'Source',
    type: 'cash' as const,
    isMain: false,
    archivedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    balanceEur: 0,
    ...over,
  };
}

const MAIN = source({ id: 'src-main', name: 'Main', type: 'cash', isMain: true, balanceEur: 5000 });
const BANK = source({
  id: 'src-bank',
  name: 'Bank',
  type: 'bank',
  balanceEur: 1000,
  createdAt: '2024-02-01T00:00:00.000Z',
});
const SAVINGS = source({
  id: 'src-save',
  name: 'Savings',
  type: 'retirement',
  balanceEur: 0,
  createdAt: '2024-03-01T00:00:00.000Z',
});

function movement(over: Partial<import('@bettertrack/contracts').CashMovement>) {
  return {
    id: 'm-x',
    kind: 'deposit' as const,
    amountEur: 0,
    sourceId: 'src-main',
    transactionId: null,
    transferId: null,
    counterpartSourceId: null,
    dividendId: null,
    taxYear: null,
    executedAt: '2024-04-01T00:00:00.000Z',
    note: null,
    source: 'manual',
    createdAt: '2024-04-01T00:00:00.000Z',
    ...over,
  };
}

const TRANSFER_OUT = movement({
  id: 'm-out',
  kind: 'transfer_out',
  amountEur: -200,
  sourceId: 'src-main',
  counterpartSourceId: 'src-bank',
  transferId: 'tr1',
  executedAt: '2024-04-03T00:00:00.000Z',
});
const TRANSFER_IN = movement({
  id: 'm-in',
  kind: 'transfer_in',
  amountEur: 200,
  sourceId: 'src-bank',
  counterpartSourceId: 'src-main',
  transferId: 'tr1',
  executedAt: '2024-04-03T00:00:00.000Z',
});
const DEPOSIT = movement({ id: 'm-dep', kind: 'deposit', amountEur: 300, sourceId: 'src-main' });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CashSourcesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The `<tr>` for a source, found via its bold name cell. Names can collide with
 * a type label or the "Main" badge, so match the name span carrying the row's
 * name styling rather than any occurrence.
 */
function rowFor(name: string): HTMLElement {
  const cell = screen
    .getAllByText(name)
    .find((el) => el.className.includes('font-medium text-neutral-100'));
  const row = cell?.closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return row as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(portfolioApi.listPortfolios).mockResolvedValue(PORTFOLIO_LIST);
  vi.mocked(portfolioApi.listCashSources).mockResolvedValue({ sources: [MAIN, BANK, SAVINGS] });
  vi.mocked(portfolioApi.getCashMovements).mockResolvedValue({
    balanceEur: 6000,
    movements: [TRANSFER_OUT, TRANSFER_IN, DEPOSIT],
    sources: [MAIN, BANK, SAVINGS],
  });
});

describe('CashSourcesPage', () => {
  test('lists every source with balance, type label and liquidity share', async () => {
    renderPage();
    // Roll-up sums all active sources (5000 + 1000).
    await waitFor(() => expect(screen.getByText('6.000,00 €')).toBeInTheDocument());

    const bank = rowFor('Bank');
    // Name + type both read "Bank" in the row — proves the type label renders.
    expect(within(bank).getAllByText('Bank')).toHaveLength(2);
    expect(within(bank).getByText('1.000,00 €')).toBeInTheDocument();
    // Per-source share of the 6 000 total (liquidity split): 1000 / 6000 ≈ 16,67 %.
    expect(within(bank).getByText('16,67 %')).toBeInTheDocument();

    // A distinct type label on another row.
    expect(within(rowFor('Savings')).getByText('Retirement')).toBeInTheDocument();

    const main = rowFor('Main');
    expect(within(main).getByText('83,33 %')).toBeInTheDocument();
  });

  test('attributes a chain cash source without changing non-chain source rows (V5-P7 M5)', async () => {
    const CHAINED = source({
      id: 'src-chain',
      name: 'Chain',
      type: 'bank',
      balanceEur: 100,
      mirror: {
        mirrorId: '00000000-0000-0000-0000-0000000000e0',
        version: 41,
        addedBy: {
          userId: '00000000-0000-0000-0000-0000000000a1',
          username: 'alice',
          profileIcon: null,
        },
      },
    });
    vi.mocked(portfolioApi.listCashSources).mockResolvedValue({
      sources: [MAIN, BANK, CHAINED],
    });

    renderPage();
    await screen.findByText('Chain');

    expect(within(rowFor('Chain')).getByTitle('Added by alice')).toBeInTheDocument();
    expect(within(rowFor('Bank')).queryByTitle(/^Added by /)).not.toBeInTheDocument();
  });

  test('attributes a chain cash movement without changing non-chain movement rows (V5-P7 M5)', async () => {
    const CHAINED_DEPOSIT = movement({
      id: 'm-chain',
      kind: 'deposit',
      amountEur: 125,
      sourceId: 'src-bank',
      executedAt: '2024-04-04T00:00:00.000Z',
      mirror: {
        mirrorId: '00000000-0000-0000-0000-0000000000e0',
        version: 43,
        addedBy: {
          userId: null,
          username: 'group member',
          profileIcon: null,
        },
      },
    });
    vi.mocked(portfolioApi.getCashMovements).mockResolvedValue({
      balanceEur: 6125,
      movements: [CHAINED_DEPOSIT, DEPOSIT],
      sources: [MAIN, BANK, SAVINGS],
    });

    renderPage();
    await screen.findAllByText('Deposit');

    const chainedRow = screen.getByText(/\+125,00\s*€/).closest('tr');
    const nonChainRow = screen.getByText(/\+300,00\s*€/).closest('tr');
    if (!chainedRow || !nonChainRow) throw new Error('cash movement row missing');

    expect(within(chainedRow).getByTitle('Added by Group member')).toBeInTheDocument();
    expect(within(chainedRow).getByText('Group member')).toBeInTheDocument();
    expect(within(nonChainRow).queryByTitle(/^Added by /)).not.toBeInTheDocument();
  });

  test('creates a named source', async () => {
    vi.mocked(portfolioApi.createCashSource).mockResolvedValue(
      source({ id: 'src-new', name: 'Broker', type: 'bank' }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Bank');

    await user.click(screen.getByRole('button', { name: 'Add source' }));
    const dialog = screen.getByRole('dialog', { name: 'Add cash source' });
    await user.type(within(dialog).getByLabelText('Name'), 'Broker');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'bank');
    await user.click(within(dialog).getByRole('button', { name: 'Create source' }));

    await waitFor(() =>
      expect(portfolioApi.createCashSource).toHaveBeenCalledWith('p1', {
        name: 'Broker',
        type: 'bank',
      }),
    );
  });

  test('renames a source', async () => {
    vi.mocked(portfolioApi.updateCashSource).mockResolvedValue(source({ id: 'src-bank' }));
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Bank');

    await user.click(within(rowFor('Bank')).getByRole('button', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit cash source' });
    const nameInput = within(dialog).getByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Bank AT');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(portfolioApi.updateCashSource).toHaveBeenCalledWith(
        'p1',
        'src-bank',
        expect.objectContaining({ name: 'Bank AT' }),
      ),
    );
  });

  test('archives a zero-balance source through the confirm step', async () => {
    vi.mocked(portfolioApi.archiveCashSource).mockResolvedValue(
      source({ id: 'src-save', archivedAt: '2024-05-01T00:00:00.000Z' }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Savings');

    const savings = rowFor('Savings');
    await user.click(within(savings).getByRole('button', { name: 'Archive' }));
    await user.click(within(savings).getByRole('button', { name: 'Yes' }));

    await waitFor(() =>
      expect(portfolioApi.archiveCashSource).toHaveBeenCalledWith('p1', 'src-save', {
        baseSeq: undefined,
      }),
    );
  });

  test('archives a chain-attached source with its baseSeq guard (V5-P7 M5)', async () => {
    // A synced-copy source carries a `mirror` overlay (design §3/§11) — archive
    // must send `baseSeq = mirror.version` so the server can refuse `409
    // MIRROR_CONFLICT` when another member changed the source first.
    const CHAINED = source({
      id: 'src-chain',
      name: 'Chain',
      type: 'bank',
      balanceEur: 0,
      mirror: {
        mirrorId: '00000000-0000-0000-0000-0000000000e1',
        version: 42,
        addedBy: { userId: null, username: 'group member', profileIcon: null },
      },
    });
    vi.mocked(portfolioApi.listCashSources).mockResolvedValue({ sources: [MAIN, CHAINED] });
    vi.mocked(portfolioApi.archiveCashSource).mockResolvedValue({
      ...CHAINED,
      archivedAt: '2024-06-02T00:00:00.000Z',
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Chain');

    const chain = rowFor('Chain');
    await user.click(within(chain).getByRole('button', { name: 'Archive' }));
    await user.click(within(chain).getByRole('button', { name: 'Yes' }));

    await waitFor(() =>
      expect(portfolioApi.archiveCashSource).toHaveBeenCalledWith('p1', 'src-chain', {
        baseSeq: 42,
      }),
    );
  });

  test('surfaces MIRROR_CONFLICT on archive so the user knows to refresh (V5-P7 M5)', async () => {
    const CHAINED = source({
      id: 'src-chain',
      name: 'Chain',
      type: 'bank',
      balanceEur: 0,
      mirror: {
        mirrorId: '00000000-0000-0000-0000-0000000000e2',
        version: 7,
        addedBy: { userId: null, username: 'group member', profileIcon: null },
      },
    });
    vi.mocked(portfolioApi.listCashSources).mockResolvedValue({ sources: [MAIN, CHAINED] });
    const { ApiError } = await import('../../lib/apiClient');
    vi.mocked(portfolioApi.archiveCashSource).mockRejectedValue(
      new ApiError(409, 'MIRROR_CONFLICT', 'stale'),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Chain');

    const chain = rowFor('Chain');
    await user.click(within(chain).getByRole('button', { name: 'Archive' }));
    await user.click(within(chain).getByRole('button', { name: 'Yes' }));

    await waitFor(() =>
      expect(
        screen.getByText(/another member changed this source in the meantime/i),
      ).toBeInTheDocument(),
    );
  });

  test('a transfer between two sources posts both paired legs into the history', async () => {
    vi.mocked(portfolioApi.transferCash).mockResolvedValue({
      outgoing: TRANSFER_OUT,
      incoming: TRANSFER_IN,
      fromBalanceEur: 4800,
      toBalanceEur: 1200,
      balanceEur: 6000,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Bank');

    // Both legs of the existing transfer show in the movement history — the
    // out-leg under Main and the in-leg under Bank (double-entry).
    expect(screen.getByText('Transfer out')).toBeInTheDocument();
    expect(screen.getByText('Transfer in')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    const dialog = screen.getByRole('dialog', { name: 'Transfer between sources' });
    await user.selectOptions(within(dialog).getByLabelText('From'), 'src-main');
    await user.selectOptions(within(dialog).getByLabelText('To'), 'src-bank');
    await user.type(within(dialog).getByLabelText('Amount (EUR)'), '200');
    await user.click(within(dialog).getByRole('button', { name: 'Transfer' }));

    await waitFor(() =>
      expect(portfolioApi.transferCash).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          fromSourceId: 'src-main',
          toSourceId: 'src-bank',
          amountEur: 200,
        }),
      ),
    );
  });

  test('set-balance shows the app-computed delta before recording the movement', async () => {
    vi.mocked(portfolioApi.setCashBalance).mockResolvedValue({
      movement: DEPOSIT,
      deltaEur: 300,
      sourceBalanceEur: 5300,
      balanceEur: 6300,
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText('Main');

    await user.click(within(rowFor('Main')).getByRole('button', { name: 'Set balance' }));
    const dialog = screen.getByRole('dialog', { name: 'Set balance' });
    await user.type(within(dialog).getByLabelText('New balance'), '5300');

    // The UI shows the signed delta (5300 − 5000 = +300) before confirming.
    expect(within(dialog).getByText(/Records a deposit of 300,00\s*€/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Set balance' }));
    await waitFor(() =>
      expect(portfolioApi.setCashBalance).toHaveBeenCalledWith(
        'p1',
        'src-main',
        expect.objectContaining({ balanceEur: 5300 }),
      ),
    );
  });

  test('deposit/withdraw/set-balance/transfer actions render an icon alongside the label (V4-P0)', async () => {
    renderPage();
    await screen.findAllByText('Main');

    // The icons are decorative (aria-hidden), so the accessible name stays the
    // label text — the button still resolves via getByRole/name for a11y…
    const bank = rowFor('Bank');
    const depositBtn = within(bank).getByRole('button', { name: 'Deposit' });
    const withdrawBtn = within(bank).getByRole('button', { name: 'Withdraw' });
    const setBalanceBtn = within(bank).getByRole('button', { name: 'Set balance' });
    const transferBtn = screen.getByRole('button', { name: 'Transfer' });

    // …and every action button visibly renders an `aria-hidden` svg alongside.
    for (const btn of [depositBtn, withdrawBtn, setBalanceBtn, transferBtn]) {
      const svg = btn.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
