import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  CashMovement,
  CashMovementsResponse,
  CashTag,
  PortfolioListResponse,
} from '@bettertrack/contracts';

vi.mock('../../../lib/portfolioApi');
vi.mock('../../../lib/cashApi', () => ({
  CASH_TAGS_QUERY_KEY: ['cash', 'tags'],
  listCashTags: vi.fn(),
  setCashMovementTags: vi.fn(),
  // The edit dialog previews which rules a note would fire; never the subject here.
  previewCashRules: vi.fn().mockResolvedValue({ tagIds: [] }),
}));

import {
  deleteCashMovement,
  getCashMovements,
  listCashSources,
  listPortfolios,
  updateCashMovement,
} from '../../../lib/portfolioApi';
import { listCashTags, setCashMovementTags } from '../../../lib/cashApi';

import { CashMovementsPage } from './CashMovementsPage';

const PORTFOLIOS: PortfolioListResponse = {
  portfolios: [
    {
      id: 'p1',
      name: 'Main',
      visibility: 'private',
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

const FOOD: CashTag = {
  id: 't-food',
  name: 'Food',
  color: '#22c55e',
  system: false,
  systemKey: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const RENT: CashTag = { ...FOOD, id: 't-rent', name: 'Rent', color: '#3987e5' };

function movement(over: Partial<CashMovement> = {}): CashMovement {
  return {
    id: 'm1',
    kind: 'withdrawal',
    amountEur: -50,
    sourceId: 'src-1',
    transactionId: null,
    transferId: null,
    counterpartSourceId: null,
    dividendId: null,
    taxYear: null,
    executedAt: '2026-07-10T00:00:00.000Z',
    note: 'a movement',
    source: 'manual',
    createdAt: '2026-07-10T00:00:00.000Z',
    tags: [],
    ...over,
  };
}

const TAGGED = movement({ id: 'm-tagged', note: 'REWE', tags: [FOOD.id, RENT.id] });
const PLAIN = movement({ id: 'm-plain', note: 'Landlord' });
/**
 * A DERIVED row — a trade's cash leg. It has no financial edit here (it follows
 * its transaction), so its row action stays "Edit tags" while a hand-entered row
 * gets the full editor.
 */
const DERIVED = movement({
  id: 'm-buy',
  kind: 'buy',
  note: 'Bought VWCE',
  transactionId: 'tx-1',
});

const LEDGER: CashMovementsResponse = {
  balanceEur: 1_000,
  movements: [TAGGED, PLAIN, DERIVED],
  sources: [],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CashMovementsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue(PORTFOLIOS);
  vi.mocked(getCashMovements).mockResolvedValue(LEDGER);
  vi.mocked(listCashTags).mockResolvedValue({ tags: [FOOD, RENT] });
});

describe('CashMovementsPage', () => {
  test('renders a movement’s tags as chips', async () => {
    renderPage();

    const row = (await screen.findByText('REWE')).closest('tr')!;
    expect(within(row).getByText('Food')).toBeInTheDocument();
    expect(within(row).getByText('Rent')).toBeInTheDocument();
  });

  test('shows "Untagged" for a movement carrying no tags', async () => {
    renderPage();

    const row = (await screen.findByText('Landlord')).closest('tr')!;
    expect(within(row).getByText('Untagged')).toBeInTheDocument();
  });

  test('shows a quiet marker for a movement carried over in a non-EUR currency', async () => {
    vi.mocked(getCashMovements).mockResolvedValue({
      ...LEDGER,
      movements: [movement({ id: 'm-usd', note: 'Foreign deposit', originalCurrency: 'USD' })],
    });
    renderPage();

    expect(await screen.findByText('orig. USD')).toBeInTheDocument();
  });

  test('filters the ledger down to one tag', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('REWE');
    expect(screen.getAllByRole('row')).toHaveLength(4); // header + 3 movements

    await user.selectOptions(screen.getByLabelText('Tag'), FOOD.id);
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + the one Food-tagged movement
    expect(screen.queryByText('Landlord')).not.toBeInTheDocument();
  });

  test('the tag editor PUTs the full selected set and invalidates the ledger', async () => {
    vi.mocked(setCashMovementTags).mockResolvedValue({ movementId: 'm-buy', tags: [FOOD] });
    const user = userEvent.setup();
    const client = renderPage();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    // A derived row: tags are the only thing about it this page may change.
    const derivedRow = (await screen.findByText('Bought VWCE')).closest('tr')!;

    await user.click(within(derivedRow).getByRole('button', { name: 'Edit tags' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit tags' });
    await user.click(within(dialog).getByText('Food'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(setCashMovementTags).toHaveBeenCalledWith('m-buy', [FOOD.id]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['cash'] });
  });

  test('a hand-entered movement opens the full editor, prefilled', async () => {
    vi.mocked(listCashSources).mockResolvedValue({
      sources: [
        {
          id: 'src-1',
          name: 'Main',
          type: 'bank',
          isMain: true,
          balanceEur: 1_000,
          archivedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const user = userEvent.setup();
    renderPage();
    const plainRow = (await screen.findByText('Landlord')).closest('tr')!;

    await user.click(within(plainRow).getByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit transaction' });
    // Prefilled from the row: the magnitude, not the stored negative amount.
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('50');
    expect(within(dialog).getByLabelText('What for')).toHaveValue('Landlord');
    expect(within(dialog).getByRole('button', { name: 'Money out' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a derived movement offers no financial edit', async () => {
    renderPage();
    const derivedRow = (await screen.findByText('Bought VWCE')).closest('tr')!;

    expect(within(derivedRow).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(derivedRow).getByRole('button', { name: 'Edit tags' })).toBeInTheDocument();
  });

  test('saving an edit PATCHes the movement and closes', async () => {
    vi.mocked(listCashSources).mockResolvedValue({ sources: [] });
    vi.mocked(updateCashMovement).mockResolvedValue({
      movement: { ...PLAIN, amountEur: -75 },
      sourceBalanceEur: 925,
      balanceEur: 925,
    });
    const user = userEvent.setup();
    renderPage();
    const plainRow = (await screen.findByText('Landlord')).closest('tr')!;
    await user.click(within(plainRow).getByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit transaction' });
    const amount = within(dialog).getByLabelText('Amount');
    await user.clear(amount);
    await user.type(amount, '75');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(updateCashMovement).toHaveBeenCalledWith(
      'p1',
      'm-plain',
      expect.objectContaining({ amountEur: 75, kind: 'withdrawal', note: 'Landlord' }),
    );
  });

  test('deleting asks first, then calls the API', async () => {
    vi.mocked(listCashSources).mockResolvedValue({ sources: [] });
    vi.mocked(deleteCashMovement).mockResolvedValue({
      sourceId: 'src-1',
      sourceBalanceEur: 1_050,
      balanceEur: 1_050,
    });
    const user = userEvent.setup();
    renderPage();
    const plainRow = (await screen.findByText('Landlord')).closest('tr')!;
    await user.click(within(plainRow).getByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit transaction' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    // One press arms it; nothing has been deleted yet.
    expect(deleteCashMovement).not.toHaveBeenCalled();

    expect(within(dialog).getByText('Delete this transaction?')).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole('button', { name: 'Delete' })[0]!);

    expect(deleteCashMovement).toHaveBeenCalledWith('p1', 'm-plain');
  });

  test('renders a load error when the ledger request fails', async () => {
    vi.mocked(getCashMovements).mockRejectedValue(new Error('offline'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the cash ledger.");
  });

  test('renders the designed empty state with no movements', async () => {
    vi.mocked(getCashMovements).mockResolvedValue({ balanceEur: 0, movements: [], sources: [] });
    renderPage();

    expect(await screen.findByText('No cash movements yet')).toBeInTheDocument();
  });
});
