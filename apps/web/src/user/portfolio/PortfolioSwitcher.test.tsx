import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  createPortfolio: vi.fn(),
  // The wizard renames instead of re-creating when the user goes Back (see
  // PortfolioWizard) — mocked so an accidental call is visible, not a network hit.
  updatePortfolio: vi.fn(),
}));

import { createPortfolio, listPortfolios } from '../../lib/portfolioApi';
import {
  ACTIVE_PORTFOLIO_PARAM,
  PortfolioSwitcher,
  rememberActivePortfolio,
  resolveActivePortfolio,
} from './PortfolioSwitcher';
import { resetPortfolioKindCache, setPortfolioKind } from './portfolioKinds';

type Summary = {
  id: string;
  name: string;
  visibility: 'private' | 'friends';
  sortOrder: number;
  isDefault: boolean;
  defaultPayFromCash: boolean;
  archivedAt: string | null;
  mirror?: {
    chainId: string;
    chainName: string;
    role: 'owner' | 'manager' | 'member';
    memberCount: number;
    sync: { appliedSeq: number; lastSeq: number; percent: number; synced: boolean };
  };
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

/** A synced copy of an active chain — the only group signal the contract carries. */
const HOUSEHOLD = summary({
  id: 'p3',
  name: 'Household',
  sortOrder: 2,
  mirror: {
    chainId: 'c1',
    chainName: 'Household',
    role: 'owner',
    memberCount: 3,
    sync: { appliedSeq: 9, lastSeq: 9, percent: 100, synced: true },
  },
});

/** Seven portfolios — one past SEARCH_THRESHOLD, so the search field appears. */
const MANY = [
  MAIN,
  TRADING,
  summary({ id: 'p4', name: 'Retirement', sortOrder: 3 }),
  summary({ id: 'p5', name: 'Crypto', sortOrder: 4 }),
  summary({ id: 'p6', name: 'Kids', sortOrder: 5 }),
  summary({ id: 'p7', name: 'Rentals', sortOrder: 6 }),
  summary({ id: 'p8', name: 'Side business', sortOrder: 7 }),
];

/** The glyph a row/trigger rendered, read off the inert `data-icon` marker. */
function iconOf(element: HTMLElement): string | null | undefined {
  return element.querySelector('svg[data-icon]')?.getAttribute('data-icon');
}

/**
 * The hue a row/trigger chip is tinted with, read off its `bt-pf-chip--<tint>`
 * class (the hues themselves live in origin.css, which jsdom does not load).
 */
function tintOf(element: HTMLElement): string | undefined {
  const chip = element.querySelector('.bt-pf-chip');
  return [...(chip?.classList ?? [])]
    .find((c) => c.startsWith('bt-pf-chip--') && c !== 'bt-pf-chip--lg')
    ?.slice('bt-pf-chip--'.length);
}

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
  sessionStorage.clear();
  localStorage.clear();
  resetPortfolioKindCache();
});

describe('resolveActivePortfolio session stickiness', () => {
  test('with no param, the portfolio remembered for the session wins over the default', () => {
    rememberActivePortfolio(TRADING.id);
    expect(resolveActivePortfolio([MAIN, TRADING], null)).toBe(TRADING);
  });

  test('an explicit param beats the remembered portfolio', () => {
    rememberActivePortfolio(TRADING.id);
    expect(resolveActivePortfolio([MAIN, TRADING], MAIN.id)).toBe(MAIN);
  });

  test('a remembered portfolio that no longer exists falls back to the default', () => {
    rememberActivePortfolio('gone');
    expect(resolveActivePortfolio([MAIN, TRADING], null)).toBe(MAIN);
  });

  test('forgetting (null) restores the default resolution', () => {
    rememberActivePortfolio(TRADING.id);
    rememberActivePortfolio(null);
    expect(resolveActivePortfolio([MAIN, TRADING], null)).toBe(MAIN);
  });
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

  test('Add portfolio opens the wizard, which creates and activates the new one', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    vi.mocked(createPortfolio).mockResolvedValue(summary({ id: 'p9', name: 'Retirement' }));
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Add portfolio' }));

    await userEvent.type(await screen.findByLabelText('Portfolio name'), 'Retirement');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' })); // → icon
    await userEvent.click(screen.getByRole('button', { name: 'Continue' })); // → book
    await userEvent.click(screen.getByRole('button', { name: 'Continue' })); // creates

    await waitFor(() => expect(createPortfolio).toHaveBeenCalledWith('Retirement'));
    await userEvent.click(await screen.findByRole('button', { name: 'Open portfolio' }));
    await waitFor(() => expect(screen.getByTestId('active-param')).toHaveTextContent('p9'));
  });

  test('the active row is checked, and only it', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    expect(await screen.findByRole('menuitemradio', { name: /Main/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: /Trading/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  // ── Icons (kinds, internally) ──────────────────────────────────────────────

  test('each row renders its stored icon glyph and hue, defaulting to private', async () => {
    setPortfolioKind(TRADING.id, 'business');
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    const trading = await screen.findByRole('menuitemradio', { name: /Trading/ });
    expect(iconOf(trading)).toBe('briefcase');
    expect(tintOf(trading)).toBe('business');
    // Main was never classified → the private default, glyph and hue together.
    const main = screen.getByRole('menuitemradio', { name: /Main/ });
    expect(iconOf(main)).toBe('user-lock');
    expect(tintOf(main)).toBe('private');
  });

  test('the trigger follows the active portfolio icon', async () => {
    setPortfolioKind(MAIN.id, 'savings');
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    await waitFor(() => expect(iconOf(trigger)).toBe('piggy-bank'));
    expect(tintOf(trigger)).toBe('savings');
  });

  test('before anything resolves the trigger chip claims no icon at all', async () => {
    // A pending list: tinting this "private" would assert a purpose the user
    // never picked, so the chip stays untinted until a portfolio is known.
    vi.mocked(listPortfolios).mockReturnValue(new Promise(() => {}));
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    expect(trigger).toHaveTextContent('Portfolio');
    expect(iconOf(trigger)).toBe('portfolios');
    expect(tintOf(trigger)).toBeUndefined();
  });

  test('the chips are garnish: they add no words to a row or the trigger', async () => {
    setPortfolioKind(TRADING.id, 'business');
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    // Exact-name lookups: a chip that leaked its icon name into the accessible
    // name (…"Trading Business") would fail these.
    expect(await screen.findByRole('menuitemradio', { name: 'Trading' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Main Default' })).toBeInTheDocument();
  });

  test('a group portfolio overrides both the glyph and the hue of its kind', async () => {
    setPortfolioKind(HOUSEHOLD.id, 'family');
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, HOUSEHOLD] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    const household = await screen.findByRole('menuitemradio', { name: /Household/ });
    expect(iconOf(household)).toBe('users');
    expect(tintOf(household)).toBe('group');
  });

  // ── Search ────────────────────────────────────────────────────────────────

  test('a single portfolio has nothing to filter, so it gets no search field', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await screen.findByRole('menuitemradio', { name: /Main/ });
    expect(screen.queryByLabelText('Search portfolios')).not.toBeInTheDocument();
  });

  test('a short list gets a search field that does not steal the keyboard', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    const search = await screen.findByLabelText('Search portfolios');
    // Present (it is the menu's grammar) but unfocused: two portfolios are one
    // click apart, and autofocus would swallow the click-through.
    expect(search).not.toHaveFocus();

    await userEvent.type(search, 'trad');
    expect(await screen.findByRole('menuitemradio', { name: /Trading/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /Main/ })).not.toBeInTheDocument();
  });

  test('a long list gets a focused search field that filters by name', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: MANY });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    const search = await screen.findByLabelText('Search portfolios');
    expect(search).toHaveFocus();

    await userEvent.type(search, 'ret');
    // "Retirement" matches; case-insensitive and anywhere in the name.
    expect(await screen.findByRole('menuitemradio', { name: /Retirement/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /Main/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /Crypto/ })).not.toBeInTheDocument();
  });

  test('a search matching nothing says so', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: MANY });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.type(await screen.findByLabelText('Search portfolios'), 'zzz');

    expect(await screen.findByText('No matches.')).toBeInTheDocument();
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
  });

  test('the filter resets between openings', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: MANY });
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    await userEvent.click(trigger);
    await userEvent.type(await screen.findByLabelText('Search portfolios'), 'crypto');
    expect(screen.queryByRole('menuitemradio', { name: /Main/ })).not.toBeInTheDocument();

    await userEvent.click(trigger); // close
    await userEvent.click(trigger); // reopen
    expect(await screen.findByLabelText('Search portfolios')).toHaveValue('');
    expect(screen.getByRole('menuitemradio', { name: /Main/ })).toBeInTheDocument();
  });

  test('Escape closes the menu', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: MANY });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await screen.findByRole('menu', { name: 'Portfolios' });

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Portfolios' })).not.toBeInTheDocument(),
    );
  });

  // ── The menu is a selector, not a management surface ──────────────────────

  test('links to the settings tab of the active portfolio', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Trading/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));

    expect(await screen.findByRole('menuitem', { name: 'Portfolio settings' })).toHaveAttribute(
      'href',
      '/portfolio/settings?portfolio=p2',
    );
  });

  test('rename / archive / delete / archived are gone from the menu', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await screen.findByRole('menu', { name: 'Portfolios' });

    for (const gone of ['Rename current', 'Archive current', 'Delete current', 'Archived…']) {
      expect(screen.queryByRole('menuitem', { name: gone })).not.toBeInTheDocument();
    }
  });

  test('creating is ONE entry point: the old pair of menu items is gone', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    expect(await screen.findByRole('menuitem', { name: 'Add portfolio' })).toBeInTheDocument();
    for (const gone of ['+ New portfolio', '+ New group portfolio']) {
      expect(screen.queryByRole('menuitem', { name: gone })).not.toBeInTheDocument();
    }
    // …and the settings row still sits beside it.
    expect(screen.getByRole('menuitem', { name: 'Portfolio settings' })).toBeInTheDocument();
  });

  test('the wizard shared-book branch reaches the untouched group-create flow', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Add portfolio' }));
    await userEvent.type(await screen.findByLabelText('Portfolio name'), 'Household');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' })); // → icon
    await userEvent.click(screen.getByRole('button', { name: 'Continue' })); // → book
    await userEvent.click(screen.getByRole('radio', { name: /Shared with people/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // The §11 CreateChainDialog, exactly as the retired menu item opened it —
    // and no plain portfolio was created on the way.
    expect(await screen.findByRole('dialog', { name: 'New group portfolio' })).toBeInTheDocument();
    expect(createPortfolio).not.toHaveBeenCalled();
  });
});
