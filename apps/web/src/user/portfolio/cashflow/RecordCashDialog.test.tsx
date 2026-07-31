import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { CashTag } from '@bettertrack/contracts';

vi.mock('../../../lib/portfolioApi');
vi.mock('../../../lib/cashApi', () => ({
  CASH_TAGS_QUERY_KEY: ['cash', 'tags'],
  listCashTags: vi.fn(),
  previewCashRules: vi.fn(),
  setCashMovementTags: vi.fn(),
}));

import { ApiError } from '../../../lib/apiClient';
import { listCashTags, previewCashRules, setCashMovementTags } from '../../../lib/cashApi';
import {
  chargeCashFee,
  listCashSources,
  previewCash,
  withdrawCash,
} from '../../../lib/portfolioApi';

import { RecordCashDialog } from './RecordCashDialog';

/**
 * The fast entry path. What matters here is not that a form submits — it is the
 * three promises the dialog makes: money out is the default so a spend is two
 * fields, the tag the rules will apply is visible BEFORE committing, and the
 * "counts against performance" choice reaches the `fee` endpoint rather than
 * quietly becoming a withdrawal.
 */

const GROCERIES: CashTag = {
  id: 't-groceries',
  name: 'Groceries',
  color: '#3987e5',
  system: false,
  systemKey: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const MAIN = {
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

function renderDialog(props: Partial<React.ComponentProps<typeof RecordCashDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RecordCashDialog onClose={vi.fn()} portfolioId="p1" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listCashSources).mockResolvedValue({
    sources: [MAIN],
  } as unknown as Awaited<ReturnType<typeof listCashSources>>);
  vi.mocked(listCashTags).mockResolvedValue({ tags: [GROCERIES] });
  vi.mocked(previewCashRules).mockResolvedValue({ tagIds: [] });
  vi.mocked(previewCash).mockResolvedValue({
    availableEur: 500,
    afterEur: 200,
    sufficient: true,
    shortfallEur: 0,
  } as unknown as Awaited<ReturnType<typeof previewCash>>);
});

test('renders a source read failure without hiding the cash-entry form', async () => {
  vi.mocked(listCashSources).mockRejectedValue(new Error('sources unavailable'));
  renderDialog();

  expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
  expect(screen.getByLabelText('Amount')).toBeInTheDocument();
});

// Sources and tags are two independent reads. Collapsing them with `??` let
// declaration order classify both at once, so each order is pinned: the
// recoverable read keeps its Retry and the confirmed one is never re-run.
test('retries only the source read when it is the outage', async () => {
  vi.mocked(listCashSources).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'down'));
  vi.mocked(listCashTags).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'secret'));
  const user = userEvent.setup();
  renderDialog();

  await user.click(await screen.findByRole('button', { name: 'Try again' }));

  await waitFor(() => expect(listCashSources).toHaveBeenCalledTimes(2));
  expect(listCashTags).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('secret')).not.toBeInTheDocument();
});

test('keeps recovery for a tag outage behind a confirmed source rejection', async () => {
  vi.mocked(listCashSources).mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'secret'));
  vi.mocked(listCashTags).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'down'));
  const user = userEvent.setup();
  renderDialog();

  await user.click(await screen.findByRole('button', { name: 'Try again' }));

  await waitFor(() => expect(listCashTags).toHaveBeenCalledTimes(2));
  expect(listCashSources).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('secret')).not.toBeInTheDocument();
});

test.each([
  ['pending', () => new Promise<never>(() => undefined)],
  ['failed', () => Promise.reject(new Error('sources unavailable'))],
])('keeps a quick action scoped to its source while the source read is %s', async (_, read) => {
  vi.mocked(listCashSources).mockReturnValue(read());
  vi.mocked(withdrawCash).mockResolvedValue({
    movement: { id: 'm-scoped', tags: [] },
  } as unknown as Awaited<ReturnType<typeof withdrawCash>>);
  const user = userEvent.setup();
  renderDialog({ sourceId: 's-savings' });

  await user.type(screen.getByLabelText('Amount'), '25');
  await user.click(screen.getByRole('button', { name: 'Record' }));

  await waitFor(() =>
    expect(withdrawCash).toHaveBeenCalledWith('p1', {
      amountEur: 25,
      sourceId: 's-savings',
    }),
  );
});

test('a spend is two fields — amount, what for, record', async () => {
  vi.mocked(withdrawCash).mockResolvedValue({
    movement: { id: 'm1', tags: [] },
  } as unknown as Awaited<ReturnType<typeof withdrawCash>>);
  const user = userEvent.setup();
  renderDialog();

  await user.type(await screen.findByLabelText('Amount'), '300');
  await user.type(screen.getByLabelText('What for'), 'SPAR MARKT 4021');
  await user.click(screen.getByRole('button', { name: 'Record' }));

  // No date, no account, no direction click: money out is the default and today
  // is the date, so neither is sent.
  await waitFor(() =>
    expect(withdrawCash).toHaveBeenCalledWith('p1', {
      amountEur: 300,
      sourceId: 's1',
      note: 'SPAR MARKT 4021',
    }),
  );
});

test('shows the tag the rules WOULD apply, while you are still typing', async () => {
  vi.mocked(previewCashRules).mockResolvedValue({ tagIds: [GROCERIES.id] });
  const user = userEvent.setup();
  renderDialog();

  await user.type(await screen.findByLabelText('What for'), 'SPAR');

  // The chip appears from the server's own answer — nothing was submitted.
  expect(await screen.findByText('Will be tagged')).toBeInTheDocument();
  expect(screen.getByText('Groceries')).toBeInTheDocument();
  expect(withdrawCash).not.toHaveBeenCalled();
});

test('"counts against performance" books a FEE, not a withdrawal', async () => {
  vi.mocked(chargeCashFee).mockResolvedValue({
    movement: { id: 'm2', tags: [] },
  } as unknown as Awaited<ReturnType<typeof chargeCashFee>>);
  const user = userEvent.setup();
  renderDialog();

  await user.type(await screen.findByLabelText('Amount'), '30');
  await user.click(screen.getByRole('button', { name: /Details/ }));
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Record' }));

  // The whole point of the checkbox: this drags the return curve instead of
  // being divided back out of it (§16 2026-07-30).
  await waitFor(() =>
    expect(chargeCashFee).toHaveBeenCalledWith('p1', { amountEur: 30, sourceId: 's1' }),
  );
  expect(withdrawCash).not.toHaveBeenCalled();
});

test('money IN cannot be a cost of holding — the choice is not even offered', async () => {
  const user = userEvent.setup();
  renderDialog();

  await user.click(await screen.findByRole('button', { name: 'Money in' }));
  await user.click(screen.getByRole('button', { name: /Details/ }));

  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

test('hand-picked tags are MERGED onto what the rules earned, never replacing them', async () => {
  vi.mocked(withdrawCash).mockResolvedValue({
    // The booking already stamped the kind's own tag.
    movement: { id: 'm3', tags: ['sys-withdrawal'] },
  } as unknown as Awaited<ReturnType<typeof withdrawCash>>);
  const user = userEvent.setup();
  renderDialog();

  await user.type(await screen.findByLabelText('Amount'), '12');
  await user.click(screen.getByRole('button', { name: /Details/ }));
  await user.click(screen.getByRole('button', { name: 'Groceries' }));
  await user.click(screen.getByRole('button', { name: 'Record' }));

  // `setCashMovementTags` REPLACES the set, so the system tag has to be carried
  // forward or the movement would lose the label it was just given.
  await waitFor(() =>
    expect(setCashMovementTags).toHaveBeenCalledWith('m3', ['sys-withdrawal', GROCERIES.id]),
  );
});

test('sends no tag write at all when nothing was hand-picked', async () => {
  vi.mocked(withdrawCash).mockResolvedValue({
    movement: { id: 'm4', tags: ['sys-withdrawal'] },
  } as unknown as Awaited<ReturnType<typeof withdrawCash>>);
  const user = userEvent.setup();
  renderDialog();

  await user.type(await screen.findByLabelText('Amount'), '9');
  await user.click(screen.getByRole('button', { name: 'Record' }));

  await waitFor(() => expect(withdrawCash).toHaveBeenCalled());
  expect(setCashMovementTags).not.toHaveBeenCalled();
});

test('an empty amount never reaches the server', async () => {
  const user = userEvent.setup();
  renderDialog();

  await user.click(await screen.findByRole('button', { name: 'Record' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Enter an amount greater than 0.');
  expect(withdrawCash).not.toHaveBeenCalled();
});
