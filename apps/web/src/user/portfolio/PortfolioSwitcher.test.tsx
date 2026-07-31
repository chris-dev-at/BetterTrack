import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// The group-create flow the wizard hands off to talks to the chain API; only
// the two calls that flow makes are stubbed.
vi.mock('../../lib/mirrorApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/mirrorApi')>()),
  createMirrorChain: vi.fn(),
  getMirrorMembers: vi.fn(),
}));
vi.mock('../../lib/socialApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/socialApi')>()),
  listFriends: vi.fn(),
}));

import { MIRROR_MAX_MEMBERS } from '@bettertrack/contracts';

import { createMirrorChain, getMirrorMembers } from '../../lib/mirrorApi';
import { createPortfolio, listPortfolios } from '../../lib/portfolioApi';
import { listFriends } from '../../lib/socialApi';
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

/**
 * The switcher is a disclosure, not an ARIA menu (#977): its popover is a
 * labelled group and its rows are ordinary buttons in natural tab order. These
 * two helpers name that contract once so the assertions below read as intent.
 */
function findPopover() {
  return screen.findByRole('group', { name: 'Portfolios' });
}

function findRow(name: RegExp | string) {
  return screen.findByRole('button', { name });
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
    const menu = await findPopover();
    expect(within(menu).getByRole('button', { name: /Main/ })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: /Trading/ })).toBeInTheDocument();
  });

  test('is a disclosure, not a menu: no menu roles, natural tab order, aria-current', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    const user = userEvent.setup();
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    await user.click(trigger);
    const menu = await findPopover();

    // A filterable picker cannot wear menu semantics: `role="menu"` admits no
    // textbox descendant, and the roving single tab stop fights the field.
    expect(trigger).not.toHaveAttribute('aria-haspopup');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
    // AskDock treats `.bt-popover` (not the menu role) as "something the app put
    // on screen", so dropping the role does not turn clicks in here into
    // outside clicks for it — see askdock/AskDock.tsx OVERLAY_SELECTOR.
    expect(menu).toHaveClass('bt-popover');

    // Selection is stated with `aria-current`, on the active row and only it.
    const main = within(menu).getByRole('button', { name: /Main/ });
    const trading = within(menu).getByRole('button', { name: /Trading/ });
    expect(main).toHaveAttribute('aria-current', 'true');
    expect(trading).not.toHaveAttribute('aria-current');

    // Natural tab order: the trigger keeps the caret on open, then Tab walks
    // search → rows → actions, every stop reachable without arrow keys.
    expect(trigger).toHaveFocus();
    await user.tab();
    expect(within(menu).getByLabelText('Search portfolios')).toHaveFocus();
    await user.tab();
    expect(main).toHaveFocus();
    await user.tab();
    expect(trading).toHaveFocus();
    await user.tab();
    expect(within(menu).getByRole('button', { name: 'Add portfolio' })).toHaveFocus();
    await user.tab();
    expect(within(menu).getByRole('link', { name: 'Portfolio settings' })).toHaveFocus();

    // Escape closes from wherever focus sits inside, and the trigger gets it back.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Portfolios' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test('Escape still closes and restores focus when focus has left the menu', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    const user = userEvent.setup();
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    await user.click(trigger);
    await findPopover();
    trigger.focus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('group', { name: 'Portfolios' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test('outside mousedown closes the menu and restores its trigger', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    const user = userEvent.setup();
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    await user.click(trigger);
    const menu = await findPopover();
    // A row holds the caret (the user tabbed to it) — dismissing from outside
    // must not unmount it and leave focus on `<body>`.
    const main = within(menu).getByRole('button', { name: /Main/ });
    main.focus();
    expect(main).toHaveFocus();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('group', { name: 'Portfolios' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test('switching a portfolio sets the routing param', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    await userEvent.click(trigger);
    await userEvent.click(await findRow(/Trading/));

    await waitFor(() => expect(screen.getByTestId('active-param')).toHaveTextContent('p2'));
    expect(trigger).toHaveFocus();
  });

  test('Add portfolio opens the wizard, which creates and activates the new one', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    vi.mocked(createPortfolio).mockResolvedValue(summary({ id: 'p9', name: 'Retirement' }));
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.click(await findRow('Add portfolio'));

    await userEvent.type(await screen.findByLabelText('Portfolio name'), 'Retirement');
    // One screen, one press (owner, 2026-07-31): the wizard creates and hands
    // the portfolio straight to the switcher, which activates it.
    await userEvent.click(screen.getByRole('button', { name: 'Create portfolio' }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalledWith('Retirement'));
    await waitFor(() => expect(screen.getByTestId('active-param')).toHaveTextContent('p9'));
  });

  test('the active row is the current one, and only it', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    expect(await findRow(/Main/)).toHaveAttribute('aria-current', 'true');
    // Not `aria-current="false"`: absence is how a list states "not this one".
    expect(screen.getByRole('button', { name: /Trading/ })).not.toHaveAttribute('aria-current');
  });

  // ── Icons (kinds, internally) ──────────────────────────────────────────────

  test('each row renders its stored icon glyph and hue, defaulting to private', async () => {
    setPortfolioKind(TRADING.id, 'business');
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    const trading = await findRow(/Trading/);
    expect(iconOf(trading)).toBe('briefcase');
    expect(tintOf(trading)).toBe('business');
    // Main was never classified → the private default, glyph and hue together.
    const main = screen.getByRole('button', { name: /Main/ });
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
    expect(await findRow('Trading')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Main Default' })).toBeInTheDocument();
  });

  test('a group portfolio keeps its chosen Icon and wears the shared marker', async () => {
    setPortfolioKind(HOUSEHOLD.id, 'family');
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, HOUSEHOLD] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    const household = await findRow(/Household/);
    // The kind the user picked still shows; "shared" is a separate marker, so
    // the Icon setting is not silently overridden for group portfolios (owner).
    expect(iconOf(household)).toBe('family');
    expect(tintOf(household)).toBe('family');
    expect(household.querySelector('[data-group="true"]')).not.toBeNull();
    const main = screen.getByRole('button', { name: /Main/ });
    expect(main.querySelector('[data-group="true"]')).toBeNull();
  });

  // ── Search ────────────────────────────────────────────────────────────────

  test('a single portfolio has nothing to filter, so it gets no search field', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await findRow(/Main/);
    expect(screen.queryByLabelText('Search portfolios')).not.toBeInTheDocument();
  });

  test('a short list gets a search field that does not steal the keyboard', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    await userEvent.click(trigger);
    const search = await screen.findByLabelText('Search portfolios');
    // Present (it is the picker's grammar) but unfocused: two portfolios are one
    // click apart, and autofocus would swallow the click-through.
    expect(search).not.toHaveFocus();
    expect(trigger).toHaveFocus();

    await userEvent.type(search, 'trad');
    expect(await findRow(/Trading/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Main/ })).not.toBeInTheDocument();

    // Home is the caret's, not a list shortcut — the disclosure runs no roving
    // key handler for it to be stolen by.
    await userEvent.keyboard('{Home}');
    expect(search).toHaveFocus();
  });

  test('a long list gets a focused search field that filters by name', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: MANY });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    const search = await screen.findByLabelText('Search portfolios');
    // Legal now that the popover is a disclosure: a textbox is no longer sitting
    // inside a `role="menu"`, and it is the first stop in natural tab order.
    expect(search).toHaveFocus();

    await userEvent.type(search, 'ret');
    // "Retirement" matches; case-insensitive and anywhere in the name.
    expect(await findRow(/Retirement/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Main/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Crypto/ })).not.toBeInTheDocument();
  });

  test('a search matching nothing says so', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: MANY });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.type(await screen.findByLabelText('Search portfolios'), 'zzz');

    expect(await screen.findByText('No matches.')).toBeInTheDocument();
    for (const portfolio of MANY) {
      expect(
        screen.queryByRole('button', { name: new RegExp(portfolio.name) }),
      ).not.toBeInTheDocument();
    }
  });

  test('the filter resets between openings', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: MANY });
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    await userEvent.click(trigger);
    await userEvent.type(await screen.findByLabelText('Search portfolios'), 'crypto');
    expect(screen.queryByRole('button', { name: /Main/ })).not.toBeInTheDocument();

    await userEvent.click(trigger); // close
    await userEvent.click(trigger); // reopen
    expect(await screen.findByLabelText('Search portfolios')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Main/ })).toBeInTheDocument();
  });

  test('Escape closes the menu', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: MANY });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await findPopover();

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Portfolios' })).not.toBeInTheDocument(),
    );
  });

  // ── The menu is a selector, not a management surface ──────────────────────

  test('links to the settings tab of the active portfolio', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.click(await findRow(/Trading/));
    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));

    expect(await screen.findByRole('link', { name: 'Portfolio settings' })).toHaveAttribute(
      'href',
      '/portfolio/settings?portfolio=p2',
    );
  });

  test('rename / archive / delete / archived are gone from the menu', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN, TRADING] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await findPopover();

    for (const gone of ['Rename current', 'Archive current', 'Delete current', 'Archived…']) {
      expect(screen.queryByRole('button', { name: gone })).not.toBeInTheDocument();
    }
  });

  test('creating is ONE entry point: the old pair of menu items is gone', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    expect(await findRow('Add portfolio')).toBeInTheDocument();
    for (const gone of ['+ New portfolio', '+ New group portfolio']) {
      expect(screen.queryByRole('button', { name: gone })).not.toBeInTheDocument();
    }
    // …and the settings row still sits beside it.
    expect(screen.getByRole('link', { name: 'Portfolio settings' })).toBeInTheDocument();
  });

  test('the wizard shared-book branch reaches the untouched group-create flow', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    renderSwitcher();

    await userEvent.click(await screen.findByRole('button', { name: 'Switch portfolio' }));
    await userEvent.click(await findRow('Add portfolio'));
    await userEvent.type(await screen.findByLabelText('Portfolio name'), 'Household');
    await userEvent.click(screen.getByRole('radio', { name: /Shared with people/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create portfolio' }));

    // The §11 CreateChainDialog, exactly as the retired menu item opened it —
    // and no plain portfolio was created on the way.
    expect(await screen.findByRole('dialog', { name: 'New group portfolio' })).toBeInTheDocument();
    expect(createPortfolio).not.toHaveBeenCalled();
  });

  test('the create → invite handoff still returns focus to the switcher trigger', async () => {
    vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [MAIN] });
    vi.mocked(createMirrorChain).mockResolvedValue({
      chainId: 'c1',
      name: 'Household',
      status: 'active',
      role: 'owner',
      memberCount: 1,
      portfolioId: 'p9',
      createdAt: '2026-07-30T00:00:00.000Z',
      sync: { appliedSeq: 0, lastSeq: 0, percent: 100, synced: true },
    });
    vi.mocked(getMirrorMembers).mockResolvedValue({
      chainId: 'c1',
      name: 'Household',
      status: 'active',
      role: 'owner',
      memberCap: MIRROR_MAX_MEMBERS,
      members: [],
    });
    vi.mocked(listFriends).mockResolvedValue({ friends: [] });
    const user = userEvent.setup();
    renderSwitcher();

    const trigger = await screen.findByRole('button', { name: 'Switch portfolio' });
    await user.click(trigger);
    await user.click(await findRow('Add portfolio'));
    await user.type(await screen.findByLabelText('Portfolio name'), 'Household');
    await user.click(screen.getByRole('radio', { name: /Shared with people/ }));
    await user.click(screen.getByRole('button', { name: 'Create portfolio' }));

    await screen.findByRole('dialog', { name: 'New group portfolio' });
    await user.click(screen.getByRole('button', { name: 'Create' }));

    // The create dialog unmounts as the invite step mounts, so the invite
    // dialog's own opener is already detached — the stable trigger is what it
    // has to come back to.
    await screen.findByRole('dialog', { name: 'Invite a friend' });
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
