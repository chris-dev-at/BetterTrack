import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ApiError } from '../../lib/apiClient';

vi.mock('../../lib/portfolioApi');
import * as portfolioApi from '../../lib/portfolioApi';

import { CashDialog } from './CashDialog';

import type { CashSource } from '@bettertrack/contracts';

function cashSource(over: Partial<CashSource>): CashSource {
  return {
    id: 'src-x',
    name: 'Source',
    type: 'cash',
    isMain: false,
    archivedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    balanceEur: 0,
    ...over,
  };
}

const MAIN = cashSource({ id: 'src-main', name: 'Main', isMain: true, balanceEur: 1000 });
const BANK = cashSource({ id: 'src-bank', name: 'Bank', type: 'bank', balanceEur: 500 });

function renderDialog(
  initialKind: 'deposit' | 'withdrawal' | 'fee' = 'deposit',
  extra: Partial<React.ComponentProps<typeof CashDialog>> = {},
) {
  const onClose = vi.fn();
  const onSubmitted = vi.fn();
  render(
    <CashDialog
      portfolioId="p1"
      initialKind={initialKind}
      onClose={onClose}
      onSubmitted={onSubmitted}
      today="2026-07-02"
      {...extra}
    />,
  );
  return { onClose, onSubmitted };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(portfolioApi.previewCash).mockResolvedValue({
    availableEur: 1000,
    afterEur: 1500,
    sufficient: true,
    shortfallEur: 0,
  });
});

describe('CashDialog', () => {
  test('opens on the requested kind (deposit or withdrawal)', () => {
    renderDialog('withdrawal');
    const dialog = screen.getByRole('dialog', { name: 'Cash balance' });
    expect(within(dialog).getByRole('button', { name: 'Withdraw' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: 'Withdraw cash' })).toBeInTheDocument();
  });

  test('deposits an amount and reports success', async () => {
    vi.mocked(portfolioApi.depositCash).mockResolvedValue({
      movement: {
        id: 'm1',
        kind: 'deposit',
        amountEur: 500,
        sourceId: 'src-main',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-02T00:00:00.000Z',
        note: null,
        source: 'manual',
        createdAt: '2026-07-02T00:00:00.000Z',
      },
      sourceBalanceEur: 1500,
      balanceEur: 1500,
    });
    const user = userEvent.setup();
    const { onClose, onSubmitted } = renderDialog();

    await user.type(screen.getByLabelText('Amount'), '500');
    await waitFor(() => expect(screen.getByText(/Available/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Deposit cash' }));

    await waitFor(() =>
      expect(portfolioApi.depositCash).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ amountEur: 500, executedAt: '2026-07-02T00:00:00.000Z' }),
      ),
    );
    expect(onSubmitted).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('blocks a withdrawal beyond the available balance via the live preview', async () => {
    vi.mocked(portfolioApi.previewCash).mockResolvedValue({
      availableEur: 100,
      afterEur: -400,
      sufficient: false,
      shortfallEur: 400,
    });
    const user = userEvent.setup();
    renderDialog('withdrawal');

    await user.type(screen.getByLabelText('Amount'), '500');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Withdraw cash' })).toBeDisabled(),
    );
    expect(screen.getByText(/short/i)).toBeInTheDocument();
    expect(portfolioApi.withdrawCash).not.toHaveBeenCalled();
  });

  test('keeps the source picker out of the way when only Main exists', () => {
    renderDialog('deposit', { sources: [MAIN] });
    expect(screen.queryByLabelText('Cash source')).not.toBeInTheDocument();
  });

  test('offers a source picker (default Main) and posts the chosen source', async () => {
    vi.mocked(portfolioApi.depositCash).mockResolvedValue({
      movement: {
        id: 'm1',
        kind: 'deposit',
        amountEur: 500,
        sourceId: 'src-bank',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-02T00:00:00.000Z',
        note: null,
        source: 'manual',
        createdAt: '2026-07-02T00:00:00.000Z',
      },
      sourceBalanceEur: 1000,
      balanceEur: 1500,
    });
    const user = userEvent.setup();
    renderDialog('deposit', { sources: [MAIN, BANK] });

    const picker = screen.getByLabelText('Cash source');
    expect(picker).toHaveValue('src-main');
    await user.selectOptions(picker, 'src-bank');
    await user.type(screen.getByLabelText('Amount'), '500');
    await user.click(screen.getByRole('button', { name: 'Deposit cash' }));

    await waitFor(() =>
      expect(portfolioApi.depositCash).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ amountEur: 500, sourceId: 'src-bank' }),
      ),
    );
  });

  test('records a fee through the fee endpoint, not the withdrawal one (§16 2026-07-30)', async () => {
    // The endpoint IS the classification: a fee posted to /cash/withdraw would be
    // stored as an external flow and divided back out of the performance curve.
    vi.mocked(portfolioApi.chargeCashFee).mockResolvedValue({
      movement: {
        id: 'm-fee',
        kind: 'fee',
        amountEur: -12.5,
        sourceId: 'src-main',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: '2026-07-02T00:00:00.000Z',
        note: null,
        source: 'manual',
        createdAt: '2026-07-02T00:00:00.000Z',
      },
      sourceBalanceEur: 987.5,
      balanceEur: 987.5,
    });
    const user = userEvent.setup();
    const { onClose, onSubmitted } = renderDialog('fee');

    const dialog = screen.getByRole('dialog', { name: 'Cash balance' });
    expect(within(dialog).getByRole('button', { name: 'Fee' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The hint explains WHY a fee is not a withdrawal — the whole user-facing point.
    expect(within(dialog).getByText(/lowers your performance/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Amount'), '12.5');
    await waitFor(() => expect(screen.getByText(/Available/)).toBeInTheDocument());
    // The preview is scoped to the fee kind, so the "after" figure is honest.
    expect(portfolioApi.previewCash).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ kind: 'fee', amountEur: 12.5 }),
      expect.anything(),
    );

    await user.click(screen.getByRole('button', { name: 'Record fee' }));
    await waitFor(() =>
      expect(portfolioApi.chargeCashFee).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ amountEur: 12.5, executedAt: '2026-07-02T00:00:00.000Z' }),
      ),
    );
    expect(portfolioApi.withdrawCash).not.toHaveBeenCalled();
    expect(portfolioApi.depositCash).not.toHaveBeenCalled();
    expect(onSubmitted).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('blocks a fee that would overdraw, exactly like a withdrawal', async () => {
    vi.mocked(portfolioApi.previewCash).mockResolvedValue({
      availableEur: 5,
      afterEur: -5,
      sufficient: false,
      shortfallEur: 5,
    });
    const user = userEvent.setup();
    renderDialog('fee');

    await user.type(screen.getByLabelText('Amount'), '10');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Record fee' })).toBeDisabled());
    expect(screen.getByText(/short/i)).toBeInTheDocument();
    expect(portfolioApi.chargeCashFee).not.toHaveBeenCalled();
  });

  test('a user who opened Deposit can switch to Fee without reopening the dialog', async () => {
    const user = userEvent.setup();
    renderDialog('deposit');
    const dialog = screen.getByRole('dialog', { name: 'Cash balance' });
    expect(within(dialog).getByRole('button', { name: 'Deposit cash' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Fee' }));
    expect(within(dialog).getByRole('button', { name: 'Record fee' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Fee' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('surfaces the server insufficient-cash error if a race lets a bad withdrawal through', async () => {
    vi.mocked(portfolioApi.withdrawCash).mockRejectedValue(
      new ApiError(400, 'INSUFFICIENT_CASH', 'Insufficient cash balance.'),
    );
    const user = userEvent.setup();
    renderDialog('withdrawal');

    await user.type(screen.getByLabelText('Amount'), '10');
    await waitFor(() => expect(screen.getByText(/Available/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Withdraw cash' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Insufficient cash balance/i);
  });
});
