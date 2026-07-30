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

function renderWizard() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const onSharedBook = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PortfolioWizard onClose={onClose} onCreated={onCreated} onSharedBook={onSharedBook} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onClose, onCreated, onSharedBook };
}

const primary = () => screen.getByRole('button', { name: /Continue|Open portfolio/ });

/** Fill the name and walk to the book step — the state every branch starts from. */
async function walkToBook(name = 'Retirement') {
  await userEvent.type(await screen.findByLabelText('Portfolio name'), name);
  await userEvent.click(primary()); // name → icon
  await userEvent.click(primary()); // icon → book
  await screen.findByRole('radio', { name: /Just me/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetPortfolioKindCache();
});

describe('PortfolioWizard — steps', () => {
  test('walks name → icon → book → done, one question at a time', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    expect(await screen.findByText('Step 1 of 4 · Name')).toBeInTheDocument();
    expect(screen.getByText('What is this portfolio called?')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Portfolio name'), 'Retirement');
    await userEvent.click(primary());
    expect(await screen.findByText('Step 2 of 4 · Icon')).toBeInTheDocument();

    await userEvent.click(primary());
    expect(await screen.findByText('Step 3 of 4 · Book')).toBeInTheDocument();

    await userEvent.click(primary());
    expect(await screen.findByText('Step 4 of 4 · Done')).toBeInTheDocument();
    // Terminal step: the primary leaves, and there is nothing left to go back to.
    expect(screen.getByRole('button', { name: 'Open portfolio' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  test('the name is required before the wizard will advance', async () => {
    renderWizard();

    const cta = await screen.findByRole('button', { name: 'Continue' });
    expect(cta).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Portfolio name'), '   ');
    expect(cta).toBeDisabled(); // whitespace is not a name

    await userEvent.type(screen.getByLabelText('Portfolio name'), 'Retirement');
    expect(cta).toBeEnabled();
    expect(screen.getByLabelText('Portfolio name')).toHaveAttribute('maxLength', '120');
  });

  test('the name field takes focus, and Enter advances', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    const field = await screen.findByLabelText('Portfolio name');
    await waitFor(() => expect(field).toHaveFocus());

    await userEvent.type(field, 'Retirement{Enter}');
    expect(await screen.findByText('Step 2 of 4 · Icon')).toBeInTheDocument();
  });

  test('Escape closes without creating anything', async () => {
    renderWizard();
    await userEvent.type(await screen.findByLabelText('Portfolio name'), 'Retirement');

    await userEvent.keyboard('{Escape}');
    expect(createPortfolio).not.toHaveBeenCalled();
  });

  test('each step parks what the API cannot do yet, as prose and not as a control', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    // Step 1 — the two portfolio-shaped things that do not exist yet.
    for (const parked of ['Its own base currency', 'Start from a template']) {
      expect(screen.getByText(parked)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: parked })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: parked })).not.toBeInTheDocument();
    }

    await walkToBook();
    await userEvent.click(primary()); // creates → done

    for (const parked of ['Opening balances', 'Import a broker file']) {
      expect(await screen.findByText(parked)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: parked })).not.toBeInTheDocument();
    }
  });
});

describe('PortfolioWizard — icon', () => {
  test('the picked icon is stored for the created portfolio', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    await userEvent.type(await screen.findByLabelText('Portfolio name'), 'Retirement');
    await userEvent.click(primary());
    await userEvent.click(await screen.findByRole('radio', { name: 'Savings' }));
    expect(screen.getByRole('radio', { name: 'Savings' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(primary()); // → book
    await userEvent.click(primary()); // creates

    await waitFor(() => expect(getPortfolioKind('p9')).toBe('savings'));
    // …through the same store the Settings picker writes, so it survives a reload.
    resetPortfolioKindCache();
    expect(getPortfolioKind('p9')).toBe('savings');
  });

  test('an untouched icon step still stores the private default', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    await walkToBook();
    await userEvent.click(primary());

    await waitFor(() => expect(getPortfolioKind('p9')).toBe('private'));
  });
});

describe('PortfolioWizard — book', () => {
  test('solo creates the portfolio itself', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    const { onSharedBook } = renderWizard();

    await walkToBook();
    expect(screen.getByRole('radio', { name: /Just me/ })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(primary());

    await waitFor(() => expect(createPortfolio).toHaveBeenCalledWith('Retirement'));
    expect(onSharedBook).not.toHaveBeenCalled();
  });

  test('shared hands off to the group-create flow and creates nothing itself', async () => {
    const { onSharedBook } = renderWizard();

    await walkToBook('Household');
    await userEvent.click(screen.getByRole('radio', { name: /Shared with people/ }));
    await userEvent.click(primary());

    expect(onSharedBook).toHaveBeenCalledTimes(1);
    expect(createPortfolio).not.toHaveBeenCalled();
    expect(updatePortfolio).not.toHaveBeenCalled();
  });
});

describe('PortfolioWizard — creation', () => {
  test('walking the steps back and forward still POSTs exactly once', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    await walkToBook();
    // Back to the icon, back to the name, then forward again — the draft is
    // carried, and nothing has been created yet at any point.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Portfolio name')).toHaveValue('Retirement');
    expect(createPortfolio).not.toHaveBeenCalled();

    await userEvent.click(primary()); // → icon
    await userEvent.click(primary()); // → book
    await userEvent.click(primary()); // creates
    await waitFor(() => expect(createPortfolio).toHaveBeenCalledTimes(1));

    // Terminal: no Back to walk into a second create.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(createPortfolio).toHaveBeenCalledTimes(1);
  });

  test('two Continue presses inside one tick cannot POST twice', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    await walkToBook();
    const cta = primary();

    // Both presses dispatched before React re-renders: this is the exact window
    // where the mutation's `isPending` is still false, so only the synchronous
    // latch in the frame can stop the second POST. Remove that latch and this
    // test reports two calls.
    await act(async () => {
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      cta.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open portfolio' })).toBeVisible(),
    );
    expect(createPortfolio).toHaveBeenCalledTimes(1);
  });

  test('a name clash comes back on the name step, and the retry creates', async () => {
    vi.mocked(createPortfolio)
      .mockRejectedValueOnce(new ApiError(409, 'PORTFOLIO_NAME_TAKEN', 'taken'))
      .mockResolvedValue(summary({ id: 'p9', name: 'Pension' }));
    renderWizard();

    await walkToBook();
    await userEvent.click(primary());

    expect(await screen.findByText('You already have a portfolio with that name.')).toBeVisible();
    expect(await screen.findByText('Step 1 of 4 · Name')).toBeInTheDocument();

    const field = screen.getByLabelText('Portfolio name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Pension');
    await userEvent.click(primary()); // → icon
    await userEvent.click(primary()); // → book
    await userEvent.click(primary()); // creates, second and last time

    await waitFor(() => expect(createPortfolio).toHaveBeenLastCalledWith('Pension'));
    expect(createPortfolio).toHaveBeenCalledTimes(2); // one refusal + one success
    expect(await screen.findByText('Step 4 of 4 · Done')).toBeInTheDocument();
  });

  test('a generic failure surfaces the generic error on the name step', async () => {
    vi.mocked(createPortfolio).mockRejectedValue(new ApiError(500, 'BOOM', 'boom'));
    renderWizard();

    await walkToBook();
    await userEvent.click(primary());

    expect(
      await screen.findByText('Could not create the portfolio. Please try again.'),
    ).toBeVisible();
    expect(await screen.findByText('Step 1 of 4 · Name')).toBeInTheDocument();
  });

  test('the summary reads back what was made, and the primary activates it', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    const { onClose, onCreated } = renderWizard();

    await userEvent.type(await screen.findByLabelText('Portfolio name'), 'Retirement');
    await userEvent.click(primary());
    await userEvent.click(await screen.findByRole('radio', { name: 'Property' }));
    await userEvent.click(primary()); // → book
    await userEvent.click(primary()); // creates

    const summaryRow = await screen.findByText('Retirement');
    expect(summaryRow).toBeInTheDocument();
    expect(screen.getByText('Property')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Open portfolio' }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'p9' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('the trimmed name is what gets created', async () => {
    vi.mocked(createPortfolio).mockResolvedValue(CREATED);
    renderWizard();

    await walkToBook('   Retirement   ');
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

  test('the checked icon keeps focus when the step opens', async () => {
    renderWizard();
    await userEvent.type(await screen.findByLabelText('Portfolio name'), 'Retirement');
    await userEvent.click(primary());

    const picked = await screen.findByRole('radio', { name: 'Private' });
    await waitFor(() => expect(picked).toHaveFocus());
    expect(within(screen.getByRole('radiogroup')).getAllByRole('radio')).toHaveLength(5);
  });
});
