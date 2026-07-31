import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../lib/portfolioApi', () => ({
  createPortfolio: vi.fn(),
  updatePortfolio: vi.fn(),
}));

import { ApiError } from '../../../lib/apiClient';
import { createPortfolio, updatePortfolio } from '../../../lib/portfolioApi';
import { getPortfolioKind, resetPortfolioKindCache } from '../portfolioKinds';
import { PortfolioWizard } from './PortfolioWizard';

/**
 * ONE SCREEN (owner, 2026-07-31). This file used to walk four steps; the wizard
 * now asks its three questions on one panel and creates on the single primary.
 * What survives from the old suite is everything that was about BEHAVIOUR
 * rather than chrome: the name rule, exactly-once creation (including the
 * two-clicks-in-one-tick window), the name-clash retry, the shared handoff, the
 * icon reaching the same store the Settings picker writes, and the focus trap.
 */

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

const CREATED = summary({ id: 'p9', name: 'Retirement' });

function renderWizard(props: { allowShared?: boolean } = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const onSharedBook = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PortfolioWizard
          onClose={onClose}
          onCreated={onCreated}
          onSharedBook={onSharedBook}
          {...props}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onClose, onCreated, onSharedBook };
}

const primary = () => screen.getByRole('button', { name: 'Create portfolio' });

async function nameIt(name = 'Retirement') {
  await userEvent.type(await screen.findByLabelText('Portfolio name'), name);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetPortfolioKindCache();
});

describe('PortfolioWizard — one screen', () => {
  test('asks name, icon and book together, with no stepper to walk', async () => {
    renderWizard();

    expect(await screen.findByText('New portfolio')).toBeInTheDocument();
    expect(screen.getByLabelText('Portfolio name')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Private' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Just me/ })).toBeInTheDocument();

    // The journey chrome is gone with the journey.
    expect(screen.queryByText(/Step \d of \d/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  test('the name is required before anything can be created', async () => {
    renderWizard();

    const cta = await screen.findByRole('button', { name: 'Create portfolio' });
    expect(cta).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Portfolio name'), '   ');
    expect(cta).toBeDisabled(); // whitespace is not a name

    await userEvent.type(screen.getByLabelText('Portfolio name'), 'Retirement');
    expect(cta).toBeEnabled();
    expect(screen.getByLabelText('Portfolio name')).toHaveAttribute('maxLength', '120');
  });

  test('the name field takes focus, and Enter creates', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    const field = await screen.findByLabelText('Portfolio name');
    await waitFor(() => expect(field).toHaveFocus());

    await userEvent.type(field, 'Retirement{Enter}');
    await waitFor(() => expect(createPortfolio).toHaveBeenCalledWith('Retirement'));
  });

  test('Escape closes without creating anything', async () => {
    renderWizard();
    await nameIt();

    await userEvent.keyboard('{Escape}');
    expect(createPortfolio).not.toHaveBeenCalled();
  });

  test('parks what the API cannot do yet, as prose and not as a control', async () => {
    renderWizard();

    for (const parked of [
      'Its own base currency',
      'Start from a template',
      'Opening balances',
      'Import a broker file',
    ]) {
      expect(await screen.findByText(parked)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: parked })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: parked })).not.toBeInTheDocument();
    }
  });

  test('hides the book choice where a group book is not on the table', async () => {
    renderWizard({ allowShared: false });
    await screen.findByLabelText('Portfolio name');

    expect(screen.queryByRole('radio', { name: /Just me/ })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Private' })).toBeInTheDocument();
  });
});

describe('PortfolioWizard — icon', () => {
  test('the picked icon is stored for the created portfolio', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    await nameIt();
    await userEvent.click(await screen.findByRole('radio', { name: 'Savings' }));
    expect(screen.getByRole('radio', { name: 'Savings' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(primary());

    await waitFor(() => expect(getPortfolioKind('p9')).toBe('savings'));
    // …through the same store the Settings picker writes, so it survives a reload.
    resetPortfolioKindCache();
    expect(getPortfolioKind('p9')).toBe('savings');
  });

  test('an untouched icon still stores the private default', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    await nameIt();
    await userEvent.click(primary());

    await waitFor(() => expect(getPortfolioKind('p9')).toBe('private'));
  });
});

describe('PortfolioWizard — book', () => {
  test('solo creates the portfolio itself', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    const { onSharedBook } = renderWizard();

    await nameIt();
    expect(screen.getByRole('radio', { name: /Just me/ })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(primary());

    await waitFor(() => expect(createPortfolio).toHaveBeenCalledWith('Retirement'));
    expect(onSharedBook).not.toHaveBeenCalled();
  });

  test('shared hands off to the group-create flow and creates nothing itself', async () => {
    const { onSharedBook } = renderWizard();

    await nameIt('Household');
    await userEvent.click(screen.getByRole('radio', { name: /Shared with people/ }));
    await userEvent.click(primary());

    expect(onSharedBook).toHaveBeenCalledWith('Household');
    expect(createPortfolio).not.toHaveBeenCalled();
    expect(updatePortfolio).not.toHaveBeenCalled();
  });
});

describe('PortfolioWizard — creation', () => {
  test('creates once, hands the portfolio over and closes', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    const { onClose, onCreated } = renderWizard();

    await nameIt();
    await userEvent.click(primary());

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED));
    expect(createPortfolio).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('two presses inside one tick cannot POST twice', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    await nameIt();
    const cta = primary();

    // Both presses dispatched before React re-renders: this is the exact window
    // where the mutation's `isPending` is still false, so only the synchronous
    // latch in the frame can stop the second POST. Remove that latch and this
    // test reports two calls.
    await act(async () => {
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(createPortfolio).toHaveBeenCalled());
    expect(createPortfolio).toHaveBeenCalledTimes(1);
  });

  test('a name clash stays on the panel with the message, and the retry creates', async () => {
    vi.mocked(createPortfolio)
      .mockRejectedValueOnce(new ApiError(409, 'PORTFOLIO_NAME_TAKEN', 'taken'))
      .mockResolvedValue(summary({ id: 'p9', name: 'Pension' }));
    const { onClose } = renderWizard();

    await nameIt();
    await userEvent.click(primary());

    expect(await screen.findByText('You already have a portfolio with that name.')).toBeVisible();
    // Still here — a refused create must not close the thing that can fix it.
    expect(onClose).not.toHaveBeenCalled();

    const field = screen.getByLabelText('Portfolio name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Pension');
    await userEvent.click(primary());

    await waitFor(() => expect(createPortfolio).toHaveBeenLastCalledWith('Pension'));
    expect(createPortfolio).toHaveBeenCalledTimes(2); // one refusal + one success
  });

  test('a generic failure surfaces the generic error', async () => {
    vi.mocked(createPortfolio).mockRejectedValue(new ApiError(500, 'BOOM', 'boom'));
    const { onClose } = renderWizard();

    await nameIt();
    await userEvent.click(primary());

    expect(
      await screen.findByText('Could not create the portfolio. Please try again.'),
    ).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('the trimmed name is what gets created', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    await nameIt('   Retirement   ');
    await userEvent.click(primary());

    await waitFor(() => expect(createPortfolio).toHaveBeenCalledWith('Retirement'));
  });
});

describe('PortfolioWizard — focus', () => {
  test('Tab stays inside the dialog', async () => {
    renderWizard();
    const dialog = await screen.findByRole('dialog', { name: 'Add portfolio' });
    await screen.findByLabelText('Portfolio name');

    for (let i = 0; i < 8; i += 1) {
      await userEvent.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  test('every portfolio icon is offered', async () => {
    renderWizard();
    await screen.findByRole('radio', { name: 'Private' });

    const picker = screen.getByRole('radiogroup', { name: 'Portfolio icon' });
    expect(within(picker).getAllByRole('radio')).toHaveLength(5);
  });
});
