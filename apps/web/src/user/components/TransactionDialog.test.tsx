import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Transaction, TransactionInput } from '@bettertrack/contracts';

vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/assetApi');
import type { DailyClosesResponse, PricePoint } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as assetApi from '../../lib/assetApi';
import * as portfolioApi from '../../lib/portfolioApi';
import {
  DERIVED_QUANTITY_DECIMALS,
  deriveQuantityFromAmount,
  formatDerivedQuantity,
  TransactionDialog,
  type TransactionDialogAsset,
} from './TransactionDialog';

/** Wire the daily-close series the linked date ↔ price fields read from (#226). */
function mockDailyCloses(points: PricePoint[]): void {
  const res: DailyClosesResponse = { points, stale: false, asOf: '2026-07-02T00:00:00.000Z' };
  vi.mocked(assetApi.getAssetDailyCloses).mockResolvedValue(res);
}

const day = (date: string, close: number): PricePoint => ({
  time: `${date}T00:00:00.000Z`,
  close,
});

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
  // Default: no series → the link assist stays inert, so the existing
  // amount/quantity specs behave exactly as before. Linking specs override this.
  mockDailyCloses([]);
  vi.mocked(portfolioApi.previewCash).mockResolvedValue({
    availableEur: 1000,
    afterEur: 900,
    sufficient: true,
    shortfallEur: 0,
  });
  vi.mocked(portfolioApi.updatePortfolio).mockResolvedValue({
    id: 'p1',
    name: 'Main',
    visibility: 'private',
    sortOrder: 0,
    isDefault: true,
    defaultPayFromCash: false,
    archivedAt: null,
  });
  // Default: this portfolio's effective tax mode is `none` → the manual per-trade
  // tax field stays hidden, so the existing specs behave exactly as before.
  // Manual-tax specs override this (issue #636: the dialog reads the portfolio's
  // resolved tax view, not the user-level default).
  vi.mocked(portfolioApi.getPortfolioTaxSettings).mockResolvedValue({
    effective: { mode: 'none', country: null },
    override: null,
    userDefault: { mode: 'none', country: null },
    source: 'system',
  });
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
    // Display quantity + money now flow through the shared locale-aware kit
    // (de-AT default): "0,01851852" and "1.000,00 €", symbol-last (§7.1).
    expect(status).toHaveTextContent('0,01851852');
    expect(status).toHaveTextContent(/records 1\.000,00 €/);
  });

  test('submits a canonical (quantity, price) record with the derived quantity', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    const { onSubmitted } = renderDialog();

    await user.click(screen.getByRole('button', { name: /by amount/i }));
    await user.type(screen.getByLabelText(/price for btc/i), '54000');
    await user.type(screen.getByLabelText(/amount invested for btc/i), '1000');
    await user.click(screen.getByRole('button', { name: /record buy/i }));

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
    await user.click(screen.getByRole('button', { name: /record buy/i }));
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
    await user.click(screen.getByRole('button', { name: /record buy/i }));
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
    await user.click(screen.getByRole('button', { name: /record buy/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/price must be greater than 0/i);
    expect(portfolioApi.createTransactions).not.toHaveBeenCalled();
  });

  test('rejects amount mode with a zero/blank amount — nothing submitted', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /by amount/i }));
    await user.type(screen.getByLabelText(/price for btc/i), '54000');
    await user.click(screen.getByRole('button', { name: /record buy/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/amount must be greater than 0/i);
    expect(portfolioApi.createTransactions).not.toHaveBeenCalled();
  });

  test('sell in amount mode derives quantity sold and labels the field "Amount received"', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Sell' }));
    await user.click(screen.getByRole('button', { name: /by amount/i }));
    await user.type(screen.getByLabelText(/price for btc/i), '54000');
    await user.type(screen.getByLabelText(/amount received for btc/i), '1000');
    await user.click(screen.getByRole('button', { name: /record sell/i }));

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
    await user.click(screen.getByRole('button', { name: /record buy/i }));

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
      allowUncovered: false,
      uncoveredEntryPrice: null,
      source: 'manual',
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

// --- Dialog: edit mode — diff patch + cash-linked rejection (#300) -----------

describe('TransactionDialog — edit mode patches only what changed', () => {
  const EDIT_TXN: Transaction = {
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
    fee: 1,
    // A stored time-of-day: an untouched date must not clobber it to midnight.
    executedAt: '2026-06-01T14:30:00.000Z',
    note: null,
    allowUncovered: false,
    uncoveredEntryPrice: null,
    source: 'manual',
  };

  test('a note-only edit sends just the note — the server allows it on cash-linked txns', async () => {
    vi.mocked(portfolioApi.updateTransaction).mockResolvedValue({ ...EDIT_TXN, note: 'DCA' });
    const user = userEvent.setup();
    const { onSubmitted } = renderDialog({ transaction: EDIT_TXN, asset: undefined });

    await user.type(screen.getByLabelText(/note for btc/i), 'DCA');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(portfolioApi.updateTransaction).toHaveBeenCalledOnce());
    expect(vi.mocked(portfolioApi.updateTransaction).mock.calls[0]![2]).toEqual({ note: 'DCA' });
    expect(onSubmitted).toHaveBeenCalled();
  });

  test('editing an imported row surfaces its source badge; a manual row stays quiet (V5-P0c)', () => {
    const { unmount } = renderDialog({
      transaction: { ...EDIT_TXN, source: 'import:trade_republic' },
      asset: undefined,
    });
    expect(screen.getByText('Imported · Trade Republic')).toBeInTheDocument();
    unmount();

    // A manual edit shows no source marker at all — anti-bloat.
    renderDialog({ transaction: EDIT_TXN, asset: undefined });
    expect(screen.queryByText(/Imported ·/)).not.toBeInTheDocument();
  });

  test('saving with nothing changed skips the PATCH entirely and just closes', async () => {
    const user = userEvent.setup();
    const { onSubmitted, onClose } = renderDialog({ transaction: EDIT_TXN, asset: undefined });

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(portfolioApi.updateTransaction).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  test('a cash-linked rejection shows the server guidance, not a generic retry', async () => {
    vi.mocked(portfolioApi.updateTransaction).mockRejectedValue(
      new ApiError(
        400,
        'TRANSACTION_CASH_LINKED',
        'This transaction is funded from (or pays into) your cash balance. Delete and re-add it to change the amount.',
      ),
    );
    const user = userEvent.setup();
    renderDialog({ transaction: EDIT_TXN, asset: undefined });

    const quantity = screen.getByLabelText(/quantity for btc/i);
    await user.clear(quantity);
    await user.type(quantity, '0.75');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByText(/funded from \(or pays into\) your cash balance/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not save/i)).not.toBeInTheDocument();
  });

  // --- V5-P7 M5: baseSeq stale-edit guard (design §3) ------------------------

  const CHAIN_TXN: Transaction = {
    ...EDIT_TXN,
    // The chain row carries the mirror overlay the API adds via
    // `overlayForPortfolio`. `version` is the seq of the last op on this
    // mirrorId — the client sends it as `baseSeq` to detect concurrent edits.
    mirror: {
      mirrorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      version: 42,
      addedBy: {
        userId: '00000000-0000-4000-8000-000000000001',
        username: 'alice',
        profileIcon: null,
      },
    },
  };

  test('a chain row PATCH carries `baseSeq: mirror.version` on the wire (§3 stale-edit guard)', async () => {
    vi.mocked(portfolioApi.updateTransaction).mockResolvedValue({ ...CHAIN_TXN, note: 'DCA' });
    const user = userEvent.setup();
    renderDialog({ transaction: CHAIN_TXN, asset: undefined });

    await user.type(screen.getByLabelText(/note for btc/i), 'DCA');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(portfolioApi.updateTransaction).toHaveBeenCalledOnce());
    // The note-only diff + baseSeq guard — the field carries the row's seq
    // verbatim so the server compares against the latest op and refuses if a
    // co-member wrote in the meantime.
    expect(vi.mocked(portfolioApi.updateTransaction).mock.calls[0]![2]).toEqual({
      note: 'DCA',
      baseSeq: 42,
    });
  });

  test('a non-chain row PATCH omits `baseSeq` (guard skipped for the vast majority)', async () => {
    vi.mocked(portfolioApi.updateTransaction).mockResolvedValue({ ...EDIT_TXN, note: 'DCA' });
    const user = userEvent.setup();
    renderDialog({ transaction: EDIT_TXN, asset: undefined });

    await user.type(screen.getByLabelText(/note for btc/i), 'DCA');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(portfolioApi.updateTransaction).toHaveBeenCalledOnce());
    expect(vi.mocked(portfolioApi.updateTransaction).mock.calls[0]![2]).toEqual({ note: 'DCA' });
    expect(vi.mocked(portfolioApi.updateTransaction).mock.calls[0]![2]).not.toHaveProperty(
      'baseSeq',
    );
  });

  test('a MIRROR_CONFLICT 409 surfaces the i18n stale-edit copy (not the generic saveError)', async () => {
    vi.mocked(portfolioApi.updateTransaction).mockRejectedValue(
      new ApiError(
        409,
        'MIRROR_CONFLICT',
        'Another member changed this entry in the meantime. Refresh and re-apply your edit.',
      ),
    );
    const user = userEvent.setup();
    renderDialog({ transaction: CHAIN_TXN, asset: undefined });

    await user.type(screen.getByLabelText(/note for btc/i), 'DCA');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // The dedicated MIRROR_CONFLICT copy is what the M5 guard surface promises —
    // NOT the generic "Could not save. Please try again." fallback.
    expect(await screen.findByText(/another member changed this entry/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not save/i)).not.toBeInTheDocument();
  });

  test('a MIRROR_ROW_DELETED 409 surfaces the deleted-row copy', async () => {
    vi.mocked(portfolioApi.updateTransaction).mockRejectedValue(
      new ApiError(
        409,
        'MIRROR_ROW_DELETED',
        'This entry was deleted by another member. Refresh and try again.',
      ),
    );
    const user = userEvent.setup();
    renderDialog({ transaction: CHAIN_TXN, asset: undefined });

    await user.type(screen.getByLabelText(/note for btc/i), 'DCA');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/another member deleted this entry/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not save/i)).not.toBeInTheDocument();
  });
});

// --- Dialog: linked date ↔ price fields (#226) ------------------------------

// Ascending daily closes with a weekend gap (Fri 06-05 → next point 06-30) and a
// clear "recent" level (120) vs an "old" level (90) for the price → date jump.
const LINK_SERIES = [
  day('2026-06-01', 100),
  day('2026-06-02', 110),
  day('2026-06-03', 90),
  day('2026-06-05', 105), // Friday
  day('2026-06-30', 120), // latest available close
];

describe('TransactionDialog — linked date ↔ price fields', () => {
  test('default on open: price auto-fills the latest close and is marked "auto"', async () => {
    mockDailyCloses(LINK_SERIES);
    renderDialog();

    const price = screen.getByLabelText(/price for btc/i);
    await waitFor(() => expect(price).toHaveValue(120));
    expect(screen.getByLabelText(/date for btc/i)).toHaveValue('2026-07-02');
    // The auto marker distinguishes the fetched price from a typed one.
    expect(screen.getByText('auto')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink date and price' })).toBeInTheDocument();
  });

  test('default on open: the latest close is cut to cents before it fills the price (owner directive 2026-07-12)', async () => {
    mockDailyCloses([day('2026-06-30', 187.499)]);
    renderDialog();

    // 187.499 auto-fills as 187.49 — truncated DOWN, not rounded to 187.50.
    await waitFor(() => expect(screen.getByLabelText(/price for btc/i)).toHaveValue(187.49));
  });

  test('Record with no edits books at the auto-filled current price', async () => {
    mockDailyCloses(LINK_SERIES);
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => expect(screen.getByLabelText(/price for btc/i)).toHaveValue(120));
    await user.type(screen.getByLabelText(/quantity for btc/i), '3');
    await user.click(screen.getByRole('button', { name: /record buy/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    expect(vi.mocked(portfolioApi.createTransactions).mock.calls[0]![1][0]).toMatchObject({
      price: 120,
      executedAt: '2026-07-02T00:00:00.000Z',
    });
  });

  test('date drives price: picking a trading day loads that day close', async () => {
    mockDailyCloses(LINK_SERIES);
    renderDialog();
    const price = screen.getByLabelText(/price for btc/i);
    await waitFor(() => expect(price).toHaveValue(120));

    fireEvent.change(screen.getByLabelText(/date for btc/i), { target: { value: '2026-06-03' } });
    expect(price).toHaveValue(90);
  });

  test('date drives price: the price-at-date quote is cut to cents (owner directive 2026-07-12)', async () => {
    mockDailyCloses([...LINK_SERIES, day('2026-06-04', 231.499320001)]);
    renderDialog();
    const price = screen.getByLabelText(/price for btc/i);
    await waitFor(() => expect(price).toHaveValue(120)); // latest close, on open

    // Picking 06-04 looks up the raw close 231.499320001 → cents, not 231.50.
    fireEvent.change(screen.getByLabelText(/date for btc/i), { target: { value: '2026-06-04' } });
    expect(price).toHaveValue(231.49);
  });

  test('a non-trading day falls back to the last trading close, with an inline note', async () => {
    mockDailyCloses(LINK_SERIES);
    renderDialog();
    const price = screen.getByLabelText(/price for btc/i);
    await waitFor(() => expect(price).toHaveValue(120));

    // Saturday 2026-06-06 → Friday 2026-06-05 close (105).
    fireEvent.change(screen.getByLabelText(/date for btc/i), { target: { value: '2026-06-06' } });
    expect(price).toHaveValue(105);
    expect(screen.getByText(/market closed — using fri close/i)).toBeInTheDocument();
  });

  test('price drives date: a typed old price jumps the date to the last day at it', async () => {
    mockDailyCloses(LINK_SERIES);
    const user = userEvent.setup();
    renderDialog();
    const price = screen.getByLabelText(/price for btc/i);
    await waitFor(() => expect(price).toHaveValue(120));

    await user.clear(price);
    await user.type(price, '90');
    fireEvent.blur(price);

    // 90 was the 06-03 close; the date jumps back to it.
    expect(screen.getByLabelText(/date for btc/i)).toHaveValue('2026-06-03');
  });

  test('a price never reached leaves the date unchanged and says so', async () => {
    mockDailyCloses(LINK_SERIES);
    const user = userEvent.setup();
    renderDialog();
    const price = screen.getByLabelText(/price for btc/i);
    await waitFor(() => expect(price).toHaveValue(120));

    await user.clear(price);
    await user.type(price, '5');
    fireEvent.blur(price);

    expect(screen.getByLabelText(/date for btc/i)).toHaveValue('2026-07-02');
    expect(screen.getByText(/never at this price in available history/i)).toBeInTheDocument();
  });

  test('unlinking makes the fields independent — a date change no longer moves price', async () => {
    mockDailyCloses(LINK_SERIES);
    const user = userEvent.setup();
    renderDialog();
    const price = screen.getByLabelText(/price for btc/i);
    await waitFor(() => expect(price).toHaveValue(120));

    await user.click(screen.getByRole('button', { name: 'Unlink date and price' }));
    fireEvent.change(screen.getByLabelText(/date for btc/i), { target: { value: '2026-06-03' } });

    expect(price).toHaveValue(120); // untouched
    expect(screen.queryByText('auto')).not.toBeInTheDocument();
  });

  test('no assist for a bulk prefill (prices at market by design)', async () => {
    renderDialog({
      asset: undefined,
      prefill: [{ asset: BTC, quantity: 1, price: 42 }],
    });

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /Unlink date and price/i }),
      ).not.toBeInTheDocument(),
    );
    expect(assetApi.getAssetDailyCloses).not.toHaveBeenCalled();
  });

  test('bulk prefill: a market price is cut to cents in the row (owner directive 2026-07-12)', async () => {
    renderDialog({
      asset: undefined,
      prefill: [{ asset: BTC, quantity: 1, price: 231.499320001 }],
    });

    await waitFor(() => expect(screen.getByLabelText(/price for btc/i)).toHaveValue(231.49));
  });
});

// --- Dialog: cash-linked buy/sell (§14, #220) --------------------------------

describe('TransactionDialog — pay from cash / add proceeds to cash', () => {
  test('the checkbox is unchecked by default, labeled for a buy, and shows the cash-after preview', async () => {
    const user = userEvent.setup();
    renderDialog();

    const checkbox = screen.getByRole('checkbox', { name: 'Pay from cash balance' });
    expect(checkbox).not.toBeChecked();

    await user.type(screen.getByLabelText(/quantity for btc/i), '1');
    await user.type(screen.getByLabelText(/price for btc/i), '100');
    await user.click(checkbox);

    expect(await screen.findByText(/cash after/i)).toBeInTheDocument();
    expect(vi.mocked(portfolioApi.previewCash)).toHaveBeenCalledWith(
      'p1',
      { kind: 'buy', amountEur: 100 },
      expect.anything(),
    );
  });

  test('switching to sell relabels the checkbox to "Add proceeds to cash balance"', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Sell' }));
    expect(
      screen.getByRole('checkbox', { name: 'Add proceeds to cash balance' }),
    ).toBeInTheDocument();
  });

  test('no cash-link option for a bulk prefill or an edit', async () => {
    renderDialog({ asset: undefined, prefill: [{ asset: BTC, quantity: 1, price: 42 }] });
    expect(
      screen.queryByRole('checkbox', { name: /pay from cash|add proceeds/i }),
    ).not.toBeInTheDocument();
  });

  test('preselects the checkbox from the sticky per-portfolio default, still shown and uncheckable', async () => {
    const user = userEvent.setup();
    renderDialog({ defaultPayFromCash: true });

    const checkbox = screen.getByRole('checkbox', { name: 'Pay from cash balance' });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  test('an amount exceeding available cash blocks Record and surfaces the shortfall', async () => {
    vi.mocked(portfolioApi.previewCash).mockResolvedValue({
      availableEur: 50,
      afterEur: -50,
      sufficient: false,
      shortfallEur: 50,
    });
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/quantity for btc/i), '1');
    await user.type(screen.getByLabelText(/price for btc/i), '100');
    await user.click(screen.getByRole('checkbox', { name: 'Pay from cash balance' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /record buy/i })).toBeDisabled());
    expect(screen.getByText(/short/i)).toBeInTheDocument();
    expect(portfolioApi.createTransactions).not.toHaveBeenCalled();
  });

  test('submits payFromCash on a buy and persists the new sticky default', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog({ defaultPayFromCash: false });

    await user.type(screen.getByLabelText(/quantity for btc/i), '1');
    await user.type(screen.getByLabelText(/price for btc/i), '100');
    await user.click(screen.getByRole('checkbox', { name: 'Pay from cash balance' }));
    await waitFor(() => expect(screen.getByText(/cash after/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /record buy/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const inputs = vi.mocked(portfolioApi.createTransactions).mock.calls[0]![1];
    expect((inputs as TransactionInput[])[0]).toMatchObject({ payFromCash: true });
    await waitFor(() =>
      expect(portfolioApi.updatePortfolio).toHaveBeenCalledWith('p1', { defaultPayFromCash: true }),
    );
  });

  test('submits addProceedsToCash on a sell', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Sell' }));
    await user.type(screen.getByLabelText(/quantity for btc/i), '1');
    await user.type(screen.getByLabelText(/price for btc/i), '100');
    await user.click(screen.getByRole('checkbox', { name: 'Add proceeds to cash balance' }));
    await waitFor(() => expect(screen.getByText(/cash after/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /record sell/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const inputs = vi.mocked(portfolioApi.createTransactions).mock.calls[0]![1];
    expect((inputs as TransactionInput[])[0]).toMatchObject({ addProceedsToCash: true });
  });

  test('not persisting the sticky default when the checkbox matches it already', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog({ defaultPayFromCash: false });

    await user.type(screen.getByLabelText(/quantity for btc/i), '1');
    await user.type(screen.getByLabelText(/price for btc/i), '100');
    await user.click(screen.getByRole('button', { name: /record buy/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    expect(portfolioApi.updatePortfolio).not.toHaveBeenCalled();
  });
});

// --- Dialog: redesign — segmented side, header, Max chip (#378 Part B) -------

describe('TransactionDialog — redesigned form (#378 Part B)', () => {
  test('shows the "New transaction" title and the portfolio name subtitle', () => {
    renderDialog({ portfolioName: 'Main' });
    expect(screen.getByText('New transaction')).toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
  });

  test('the Buy/Sell segmented toggle switches side and flips the CTA label', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByRole('button', { name: 'Buy' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /record buy/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sell' }));
    expect(screen.getByRole('button', { name: 'Sell' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /record sell/i })).toBeInTheDocument();
  });

  test('Max on a sell fills the held quantity', async () => {
    const user = userEvent.setup();
    renderDialog({ heldQuantity: 2.5 });

    await user.click(screen.getByRole('button', { name: 'Sell' }));
    await user.click(screen.getByRole('button', { name: /fill the maximum for btc/i }));
    expect(screen.getByLabelText(/quantity for btc/i)).toHaveValue(2.5);
  });

  test('Max on a pay-from-cash buy fills the affordable quantity (cash ÷ price)', async () => {
    const user = userEvent.setup();
    renderDialog({ availableCashEur: 1000 });

    await user.type(screen.getByLabelText(/price for btc/i), '100');
    await user.click(screen.getByRole('checkbox', { name: 'Pay from cash balance' }));
    await user.click(screen.getByRole('button', { name: /fill the maximum for btc/i }));
    // 1000 € / 100 € = 10 shares.
    expect(screen.getByLabelText(/quantity for btc/i)).toHaveValue(10);
  });
});

// --- Dialog: backdated pay-from-cash warning (#378 Part A) -------------------

describe('TransactionDialog — backdated pay-from-cash (#378 Part A)', () => {
  test('warns when short at the buy date, defaults "deduct as of today" on, and submits the flag', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    // Affordable today (500 covers 400) but €0 as of the 2025 buy date.
    vi.mocked(portfolioApi.previewCash).mockResolvedValue({
      availableEur: 500,
      afterEur: 100,
      sufficient: true,
      shortfallEur: 0,
      asOfDate: '2025-06-01',
      asOfAvailableEur: 0,
      asOfAfterEur: -400,
      asOfSufficient: false,
    });
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(screen.getByLabelText(/date for btc/i), { target: { value: '2025-06-01' } });
    await user.type(screen.getByLabelText(/quantity for btc/i), '4');
    await user.type(screen.getByLabelText(/price for btc/i), '100');
    await user.click(screen.getByRole('checkbox', { name: 'Pay from cash balance' }));

    // The date-aware warning appears and the settle-as-of-today opt-in defaults on.
    expect(await screen.findByText(/deducted as of today/i)).toBeInTheDocument();
    const deduct = screen.getByRole('checkbox', { name: /deduct from today’s cash instead/i });
    await waitFor(() => expect(deduct).toBeChecked());

    // The preview was asked for the balance AS OF the buy date.
    expect(vi.mocked(portfolioApi.previewCash)).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ kind: 'buy', asOfDate: '2025-06-01' }),
      expect.anything(),
    );

    await user.click(screen.getByRole('button', { name: /record buy/i }));
    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const inputs = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(inputs[0]).toMatchObject({ payFromCash: true, settleCashAsOfToday: true });
  });

  test('opting out of "deduct as of today" blocks Record (short back then)', async () => {
    vi.mocked(portfolioApi.previewCash).mockResolvedValue({
      availableEur: 500,
      afterEur: 100,
      sufficient: true,
      shortfallEur: 0,
      asOfDate: '2025-06-01',
      asOfAvailableEur: 0,
      asOfAfterEur: -400,
      asOfSufficient: false,
    });
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(screen.getByLabelText(/date for btc/i), { target: { value: '2025-06-01' } });
    await user.type(screen.getByLabelText(/quantity for btc/i), '4');
    await user.type(screen.getByLabelText(/price for btc/i), '100');
    await user.click(screen.getByRole('checkbox', { name: 'Pay from cash balance' }));

    const deduct = await screen.findByRole('checkbox', {
      name: /deduct from today’s cash instead/i,
    });
    await waitFor(() => expect(deduct).toBeChecked());
    await user.click(deduct); // opt out
    await waitFor(() => expect(screen.getByRole('button', { name: /record buy/i })).toBeDisabled());
    expect(portfolioApi.createTransactions).not.toHaveBeenCalled();
  });
});

// --- Dialog: uncovered sell (issue #369) ------------------------------------

describe('TransactionDialog — uncovered sell', () => {
  async function fillSell(
    user: ReturnType<typeof userEvent.setup>,
    quantity: string,
    price: string,
  ) {
    await user.click(screen.getByRole('button', { name: 'Sell' }));
    await user.type(screen.getByLabelText(/quantity for btc/i), quantity);
    await user.type(screen.getByLabelText(/price for btc/i), price);
  }

  test('warns and blocks Record until acknowledged, then sends allowUncovered (option A)', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog({ heldQuantity: 2 });

    await fillSell(user, '10', '100');

    // The warning shows the shortfall; Record is disabled without the ack.
    expect(screen.getByRole('alert')).toHaveTextContent(/only hold 2/i);
    const record = screen.getByRole('button', { name: /record sell/i });
    expect(record).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /continue anyway/i }));
    expect(record).toBeEnabled();
    await user.click(record);

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const submitted = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(submitted[0]).toMatchObject({
      side: 'sell',
      quantity: 10,
      price: 100,
      allowUncovered: true,
    });
    // Option A (default) sends no entry price → the server basises at sale price.
    expect(submitted[0]!.uncoveredEntryPrice).toBeUndefined();
  });

  test('option B sends the supplied buy-in price as uncoveredEntryPrice', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog({ heldQuantity: 0 });

    await fillSell(user, '5', '100');
    await user.click(screen.getByRole('checkbox', { name: /continue anyway/i }));
    await user.click(screen.getByRole('button', { name: /enter buy-in price/i }));
    await user.type(screen.getByLabelText(/original buy-in price/i), '60');
    await user.click(screen.getByRole('button', { name: /record sell/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const submitted = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(submitted[0]).toMatchObject({
      side: 'sell',
      quantity: 5,
      allowUncovered: true,
      uncoveredEntryPrice: 60,
    });
  });

  test('a covered sell shows no warning and carries no uncovered flag', async () => {
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog({ heldQuantity: 20 });

    await fillSell(user, '10', '100');
    expect(screen.queryByRole('checkbox', { name: /continue anyway/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /record sell/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const submitted = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(submitted[0]!.allowUncovered).toBeUndefined();
  });
});

// --- Dialog: manual per-trade tax (V3-P4, #431) ----------------------------

describe('TransactionDialog — manual per-trade tax', () => {
  function useManualMode() {
    vi.mocked(portfolioApi.getPortfolioTaxSettings).mockResolvedValue({
      effective: { mode: 'manual_per_trade', country: null },
      override: { mode: 'manual_per_trade', country: null },
      userDefault: { mode: 'none', country: null },
      source: 'portfolio',
    });
  }

  async function sellWithPrice(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Sell' }));
    await user.type(screen.getByLabelText(/quantity for btc/i), '10');
    await user.type(screen.getByLabelText(/price for btc/i), '100');
  }

  test('offers the tax field on a SELL in manual mode and submits an absolute € amount', async () => {
    useManualMode();
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await sellWithPrice(user);
    const taxInput = await screen.findByLabelText(/manual tax for this sale/i);
    await user.type(taxInput, '250');
    await user.click(screen.getByRole('button', { name: /record sell/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const submitted = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(submitted[0]!.taxAmountEur).toBe(250);
    expect(submitted[0]!.taxRatePct).toBeUndefined();
  });

  test('switching the unit to "% of gain" submits a rate instead of an amount', async () => {
    useManualMode();
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await sellWithPrice(user);
    await screen.findByLabelText(/manual tax for this sale/i);
    await user.click(screen.getByRole('button', { name: /% of gain/i }));
    await user.type(screen.getByLabelText(/manual tax for this sale/i), '30');
    await user.click(screen.getByRole('button', { name: /record sell/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const submitted = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(submitted[0]!.taxRatePct).toBe(30);
    expect(submitted[0]!.taxAmountEur).toBeUndefined();
  });

  test('a blank tax field records no tax (neither field on the payload)', async () => {
    useManualMode();
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await sellWithPrice(user);
    await screen.findByLabelText(/manual tax for this sale/i);
    await user.click(screen.getByRole('button', { name: /record sell/i }));

    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const submitted = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(submitted[0]!.taxAmountEur).toBeUndefined();
    expect(submitted[0]!.taxRatePct).toBeUndefined();
  });

  test('never offered on a BUY — only once the row is a SELL', async () => {
    useManualMode();
    const user = userEvent.setup();
    renderDialog();

    // The default side is BUY: even after the tax mode resolves, no field shows.
    await waitFor(() => expect(portfolioApi.getPortfolioTaxSettings).toHaveBeenCalled());
    expect(screen.queryByLabelText(/manual tax for this sale/i)).toBeNull();

    // Switching to Sell reveals it (the gate is side-based, not just mode-based).
    await user.click(screen.getByRole('button', { name: 'Sell' }));
    expect(await screen.findByLabelText(/manual tax for this sale/i)).toBeInTheDocument();
  });

  test('no tax UI at all when the mode is `none` (default)', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Sell' }));
    await waitFor(() => expect(portfolioApi.getPortfolioTaxSettings).toHaveBeenCalled());
    expect(screen.queryByLabelText(/manual tax for this sale/i)).toBeNull();
  });
});

// --- Manual default prefill (V5-P4c, #584) ----------------------------------

describe('TransactionDialog — manual default prefill (V5-P4c)', () => {
  function useManualDefault(defaults: {
    manualDefaultAmountEur?: number;
    manualDefaultRatePct?: number;
  }) {
    vi.mocked(portfolioApi.getPortfolioTaxSettings).mockResolvedValue({
      effective: { mode: 'manual_per_trade', country: null, ...defaults },
      override: { mode: 'manual_per_trade', country: null, ...defaults },
      userDefault: { mode: 'none', country: null },
      source: 'portfolio',
    });
  }

  async function sellWithPrice(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Sell' }));
    await user.type(screen.getByLabelText(/quantity for btc/i), '10');
    await user.type(screen.getByLabelText(/price for btc/i), '100');
  }

  test('an amount default prefills the tax field and submits as-is', async () => {
    useManualDefault({ manualDefaultAmountEur: 5 });
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await sellWithPrice(user);
    const taxInput = await screen.findByLabelText(/manual tax for this sale/i);
    expect(taxInput).toHaveValue(5);
    // The card explains the value came from the configurable default.
    expect(screen.getByText(/prefilled from your default/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /record sell/i }));
    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const submitted = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(submitted[0]!.taxAmountEur).toBe(5);
    expect(submitted[0]!.taxRatePct).toBeUndefined();
  });

  test('a rate default prefills with the % unit active and submits a rate', async () => {
    useManualDefault({ manualDefaultRatePct: 10 });
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await sellWithPrice(user);
    const taxInput = await screen.findByLabelText(/manual tax for this sale/i);
    expect(taxInput).toHaveValue(10);
    expect(screen.getByRole('button', { name: /% of gain/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: /record sell/i }));
    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const submitted = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(submitted[0]!.taxRatePct).toBe(10);
    expect(submitted[0]!.taxAmountEur).toBeUndefined();
  });

  test('the prefill stays editable per trade — an explicit 0 submits 0', async () => {
    useManualDefault({ manualDefaultAmountEur: 5 });
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await sellWithPrice(user);
    const taxInput = await screen.findByLabelText(/manual tax for this sale/i);
    expect(taxInput).toHaveValue(5);
    await user.clear(taxInput);
    await user.type(taxInput, '0');

    await user.click(screen.getByRole('button', { name: /record sell/i }));
    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const submitted = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(submitted[0]!.taxAmountEur).toBe(0);
  });

  test('a cleared prefill is never re-seeded and submits no tax entry', async () => {
    useManualDefault({ manualDefaultAmountEur: 5 });
    vi.mocked(portfolioApi.createTransactions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderDialog();

    await sellWithPrice(user);
    const taxInput = await screen.findByLabelText(/manual tax for this sale/i);
    expect(taxInput).toHaveValue(5);
    await user.clear(taxInput);
    expect(taxInput).toHaveValue(null);

    await user.click(screen.getByRole('button', { name: /record sell/i }));
    await waitFor(() => expect(portfolioApi.createTransactions).toHaveBeenCalledOnce());
    const submitted = vi.mocked(portfolioApi.createTransactions).mock
      .calls[0]![1] as TransactionInput[];
    expect(submitted[0]!.taxAmountEur).toBeUndefined();
    expect(submitted[0]!.taxRatePct).toBeUndefined();
  });

  test('no default keeps the tax field empty (byte-identical manual behavior)', async () => {
    vi.mocked(portfolioApi.getPortfolioTaxSettings).mockResolvedValue({
      effective: { mode: 'manual_per_trade', country: null },
      override: { mode: 'manual_per_trade', country: null },
      userDefault: { mode: 'none', country: null },
      source: 'portfolio',
    });
    const user = userEvent.setup();
    renderDialog();

    await sellWithPrice(user);
    const taxInput = await screen.findByLabelText(/manual tax for this sale/i);
    expect(taxInput).toHaveValue(null);
  });
});
