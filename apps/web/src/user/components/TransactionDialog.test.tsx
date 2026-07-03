import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Transaction, TransactionInput } from '@bettertrack/contracts';

vi.mock('../../lib/portfolioApi');
import * as portfolioApi from '../../lib/portfolioApi';
import {
  DERIVED_QUANTITY_DECIMALS,
  deriveQuantityFromAmount,
  formatDerivedQuantity,
  TransactionDialog,
  type TransactionDialogAsset,
} from './TransactionDialog';

const BTC: TransactionDialogAsset = {
  id: 'asset-btc',
  symbol: 'BTC',
  name: 'Bitcoin',
  currency: 'EUR',
};

function renderDialog(props: Partial<React.ComponentProps<typeof TransactionDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onSubmitted = vi.fn();
  const { unmount } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TransactionDialog
          portfolioId="p1"
          onClose={onClose}
          onSubmitted={onSubmitted}
          asset={BTC}
          today="2026-07-02"
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose, onSubmitted, unmount };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure derivation --------------------------------------------------------

describe('deriveQuantityFromAmount', () => {
  test('rounds 1000 / 54000 to 8 decimals (0.01851852)', () => {
    const d = deriveQuantityFromAmount(54000, 1000);
    expect(d).not.toBeNull();
    expect(d!.quantity).toBe(0.01851852);
    expect(formatDerivedQuantity(d!.quantity)).toBe('0.01851852');
  });

  test('recorded amount = quantity * price, residual is the disclosed rounding gap', () => {
    const d = deriveQuantityFromAmount(54000, 1000)!;
    // 0.01851852 * 54000 = 1000.00008 → residual +0.00008 within a satoshi*price.
    expect(d.recordedAmount).toBeCloseTo(1000.00008, 5);
    expect(d.residual).toBeCloseTo(d.recordedAmount - 1000, 10);
    expect(Math.abs(d.residual)).toBeLessThan(
      (54000 * 0.5) / 10 ** DERIVED_QUANTITY_DECIMALS + 1e-9,
    );
  });

  test('round-half-up at the 8th decimal', () => {
    // 1 / 3 = 0.333333333... → 8 decimals rounds the 9th (3) down.
    expect(deriveQuantityFromAmount(3, 1)!.quantity).toBe(0.33333333);
    // 5 / 8 = 0.625 exact.
    expect(deriveQuantityFromAmount(8, 5)!.quantity).toBe(0.625);
  });

  test('rejects non-positive and non-finite inputs (never NaN/Infinity)', () => {
    expect(deriveQuantityFromAmount(0, 1000)).toBeNull();
    expect(deriveQuantityFromAmount(54000, 0)).toBeNull();
    expect(deriveQuantityFromAmount(-1, 1000)).toBeNull();
    expect(deriveQuantityFromAmount(54000, -1)).toBeNull();
    expect(deriveQuantityFromAmount(Number.NaN, 1000)).toBeNull();
    expect(deriveQuantityFromAmount(Infinity, 1000)).toBeNull();
    expect(deriveQuantityFromAmount(54000, Infinity)).toBeNull();
  });

  test('a tiny amount against a huge price rounds to 0 → rejected, not submitted', () => {
    // 0.0001 / 1_000_000 = 1e-10 → rounds to 0 at 8 decimals.
    expect(deriveQuantityFromAmount(1_000_000, 0.0001)).toBeNull();
  });
});

// --- Dialog: amount-entry mode ---------------------------------------------

describe('TransactionDialog — amount entry mode', () => {
  test('switching to "By amount" and entering price + amount previews the derived quantity', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /by amount/i }));
    await user.type(screen.getByLabelText(/price for btc/i), '54000');
    await user.type(screen.getByLabelText(/amount invested for btc/i), '1000');

    const status = screen.getByRole('status', { name: /derived quantity for btc/i });
    expect(status).toHaveTextContent('0.01851852');
    expect(status).toHaveTextContent(/records 1000\.00 EUR/i);
  });

  test('submits a canonical (quantity, price) record with the derived quantity', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    const { onSubmitted } = renderDialog();

    await user.click(screen.getByRole('button', { name: /by amount/i }));
    await user.type(screen.getByLabelText(/price for btc/i), '54000');
    await user.type(screen.getByLabelText(/amount invested for btc/i), '1000');
    await user.click(screen.getByRole('button', { name: /^record$/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const inputs = vi.mocked(portfolioApi.createTransactions).mock.calls[0]![1];
    const submitted = inputs as TransactionInput[];
    expect(submitted).toEqual([
      {
        assetId: 'asset-btc',
        side: 'buy',
        quantity: 0.01851852,
        price: 54000,
        fee: 0,
        executedAt: '2026-07-02T00:00:00.000Z',
        note: null,
      },
    ]);
    expect(onSubmitted).toHaveBeenCalledOnce();
  });

  test('amount-entered payload is identical to the equivalent quantity-entered payload', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);

    // Quantity mode: enter the derived quantity directly.
    const first = renderDialog();
    let user = userEvent.setup();
    await user.type(screen.getByLabelText(/quantity for btc/i), '0.01851852');
    await user.type(screen.getByLabelText(/price for btc/i), '54000');
    await user.click(screen.getByRole('button', { name: /^record$/i }));
    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const byQuantity = vi.mocked(portfolioApi.createTransactions).mock.calls[0]![1];
    first.unmount();
    vi.clearAllMocks();
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);

    // Amount mode: enter price + amount, derive the same quantity.
    renderDialog();
    user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /by amount/i }));
    await user.type(screen.getByLabelText(/price for btc/i), '54000');
    await user.type(screen.getByLabelText(/amount invested for btc/i), '1000');
    await user.click(screen.getByRole('button', { name: /^record$/i }));
    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const byAmount = vi.mocked(portfolioApi.createTransactions).mock.calls[0]![1];

    expect(byAmount).toEqual(byQuantity);
  });

  test('rejects amount mode with a zero/blank price (would divide by zero) — nothing submitted', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /by amount/i }));
    await user.type(screen.getByLabelText(/amount invested for btc/i), '1000');
    await user.type(screen.getByLabelText(/price for btc/i), '0');
    await user.click(screen.getByRole('button', { name: /^record$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/price must be greater than 0/i);
    expect(portfolioApi.createTransactions).not.toHaveBeenCalled();
  });

  test('rejects amount mode with a zero/blank amount — nothing submitted', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /by amount/i }));
    await user.type(screen.getByLabelText(/price for btc/i), '54000');
    await user.click(screen.getByRole('button', { name: /^record$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/amount must be greater than 0/i);
    expect(portfolioApi.createTransactions).not.toHaveBeenCalled();
  });

  test('sell in amount mode derives quantity sold and labels the field "Amount received"', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(screen.getByLabelText(/side for btc/i), 'sell');
    await user.click(screen.getByRole('button', { name: /by amount/i }));
    await user.type(screen.getByLabelText(/price for btc/i), '54000');
    await user.type(screen.getByLabelText(/amount received for btc/i), '1000');
    await user.click(screen.getByRole('button', { name: /^record$/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const inputs = vi.mocked(portfolioApi.createTransactions).mock.calls[0]![1];
    expect((inputs as TransactionInput[])[0]).toMatchObject({
      side: 'sell',
      quantity: 0.01851852,
      price: 54000,
    });
  });

  test('toggling modes preserves entered values (quantity ⇄ amount via price)', async () => {
    const user = userEvent.setup();
    renderDialog();

    // Quantity mode → enter quantity + price.
    await user.type(screen.getByLabelText(/quantity for btc/i), '2');
    await user.type(screen.getByLabelText(/price for btc/i), '100');

    // Switch to amount → amount is filled from quantity * price = 200.
    await user.click(screen.getByRole('button', { name: /by amount/i }));
    expect(screen.getByLabelText(/amount invested for btc/i)).toHaveValue(200);

    // Switch back to quantity → quantity is restored from the derived value.
    await user.click(screen.getByRole('button', { name: /by quantity/i }));
    expect(screen.getByLabelText(/quantity for btc/i)).toHaveValue(2);
  });
});

// --- Dialog: quantity mode still works (regression) -------------------------

describe('TransactionDialog — quantity entry mode (regression)', () => {
  test('quantity mode allows a zero price (e.g. airdrop) and submits it', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/quantity for btc/i), '5');
    await user.type(screen.getByLabelText(/price for btc/i), '0');
    await user.click(screen.getByRole('button', { name: /^record$/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const inputs = vi.mocked(portfolioApi.createTransactions).mock.calls[0]![1];
    expect((inputs as TransactionInput[])[0]).toMatchObject({ quantity: 5, price: 0 });
  });

  test('edit mode opens in quantity mode with the existing quantity + price', () => {
    const transaction: Transaction = {
      id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      assetId: 'asset-btc',
      asset: {
        id: 'asset-btc',
        symbol: 'BTC',
        name: 'Bitcoin',
        exchange: null,
        currency: 'EUR',
        type: 'crypto',
        isCustom: false,
      },
      side: 'buy',
      quantity: 0.5,
      price: 42000,
      fee: 0,
      executedAt: '2026-06-01T00:00:00.000Z',
      note: null,
    };
    renderDialog({ transaction, asset: undefined });

    expect(screen.getByLabelText(/quantity for btc/i)).toHaveValue(0.5);
    expect(screen.getByLabelText(/price for btc/i)).toHaveValue(42000);
    expect(screen.getByRole('button', { name: /by quantity/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
