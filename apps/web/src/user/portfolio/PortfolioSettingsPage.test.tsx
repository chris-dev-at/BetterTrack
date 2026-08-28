import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  updatePortfolio: vi.fn(),
  archivePortfolio: vi.fn(),
  restorePortfolio: vi.fn(),
  deletePortfolio: vi.fn(),
  // Tax section (issue #636), moved here from the Tax tab.
  getPortfolioTaxSettings: vi.fn(),
  setPortfolioTaxOverride: vi.fn(),
  clearPortfolioTaxOverride: vi.fn(),
  // Read by the E6 move-capture engine reached through PortfolioVaultSection.
  getTaxYearReports: vi.fn(),
  getTaxYearReport: vi.fn(),
  listDividends: vi.fn(),
}));

import { ApiError } from '../../lib/apiClient';
import {
  archivePortfolio,
  clearPortfolioTaxOverride,
  deletePortfolio,
  getPortfolioTaxSettings,
  listPortfolios,
  restorePortfolio,
  setPortfolioTaxOverride,
  updatePortfolio,
} from '../../lib/portfolioApi';
import { PortfolioSettingsPage } from './PortfolioSettingsPage';
import { setViewportWidth } from '../../test/viewport';
import { ACTIVE_PORTFOLIO_PARAM } from './PortfolioSwitcher';
import { resetPortfolioKindCache, type PortfolioKind } from './portfolioKinds';

type Summary = {
  id: string;
  name: string;
  visibility: 'private' | 'friends';
  sortOrder: number;
  isDefault: boolean;
  defaultPayFromCash: boolean;
  archivedAt: string | null;
  kind: PortfolioKind | null;
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
    kind: null,
    ...over,
  };
}

const MAIN = summary({ id: 'p1', name: 'Main', isDefault: true });
const TRADING = summary({ id: 'p2', name: 'Trading', sortOrder: 1 });
const OLD = summary({
  id: 'p3',
  name: 'Old',
  sortOrder: 2,
  archivedAt: '2026-01-01T00:00:00.000Z',
});
const HOUSEHOLD = summary({
  id: 'p4',
  name: 'Household',
  sortOrder: 3,
  mirror: {
    chainId: 'c1',
    chainName: 'Household',
    role: 'owner',
    memberCount: 3,
    sync: { appliedSeq: 9, lastSeq: 9, percent: 100, synced: true },
  },
});

/** Serve the active list and the `includeArchived` list from one fixture set. */
function mockLists(active: Summary[], archived: Summary[] = []) {
  vi.mocked(listPortfolios).mockImplementation((_signal, includeArchived) =>
    Promise.resolve({ portfolios: includeArchived ? [...active, ...archived] : active }),
  );
}

/**
 * The hue a picker option's chip is tinted with, read off its
 * `bt-pf-chip--<tint>` class (origin.css holds the hues; jsdom loads no CSS).
 */
function chipTintOf(element: HTMLElement): string | undefined {
  const chip = element.querySelector('.bt-pf-chip');
  return [...(chip?.classList ?? [])]
    .find((c) => c.startsWith('bt-pf-chip--') && c !== 'bt-pf-chip--lg')
    ?.slice('bt-pf-chip--'.length);
}

function ActiveProbe() {
  const [params] = useSearchParams();
  return <div data-testid="active-param">{params.get(ACTIVE_PORTFOLIO_PARAM) ?? ''}</div>;
}

function renderSettings(portfolioId = 'p2') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/portfolio/settings?portfolio=${portfolioId}`]}>
      <QueryClientProvider client={client}>
        <PortfolioSettingsPage />
        <ActiveProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** This portfolio inherits the account default (AT) unless a test says otherwise. */
const INHERITED_AT = {
  effective: { mode: 'country_specific' as const, country: 'AT' as const },
  override: null,
  userDefault: { mode: 'country_specific' as const, country: 'AT' as const },
  source: 'user' as const,
};

/** …and here it carries its own override (DE), which the account default is not. */
const OVERRIDDEN_DE = {
  effective: { mode: 'country_specific' as const, country: 'DE' as const },
  override: { mode: 'country_specific' as const, country: 'DE' as const },
  userDefault: { mode: 'none' as const, country: null },
  source: 'portfolio' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  resetPortfolioKindCache();
  vi.mocked(getPortfolioTaxSettings).mockResolvedValue(INHERITED_AT);
});

describe('PortfolioSettingsPage — general', () => {
  test('390px contains settings and opens destructive confirmation as a sheet', async () => {
    setViewportWidth(390);
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    const name = await screen.findByLabelText('Name');
    expect(name.closest('.bt-money-surface')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Delete this portfolio' }));
    expect(screen.getByRole('dialog', { name: 'Delete portfolio' })).toHaveClass(
      'bt-dialog__panel--phone-sheet',
    );
  });

  test('resolves the portfolio from the routing param and seeds the name field', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Trading'));
  });

  test('save stays disabled until the name actually changes', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Name'), ' desk');
    expect(save).toBeEnabled();
  });

  test('renaming calls the API with the trimmed name', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(updatePortfolio).mockResolvedValue({ ...TRADING, name: 'Trading desk' });
    renderSettings('p2');

    const field = await screen.findByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, '  Trading desk  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updatePortfolio).toHaveBeenCalledWith('p2', { name: 'Trading desk' }),
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  test('a taken name surfaces the specific error, not the generic one', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(updatePortfolio).mockRejectedValue(
      new ApiError(409, 'PORTFOLIO_NAME_TAKEN', 'taken'),
    );
    renderSettings('p2');

    const field = await screen.findByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Main');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('You already have a portfolio with that name.'),
    ).toBeInTheDocument();
  });
});

describe('PortfolioSettingsPage — icon', () => {
  test('the section is called Icon, never Kind', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    expect(await screen.findByText('Icon')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Portfolio icon' })).toBeInTheDocument();
    expect(screen.queryByText('Kind')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Marks this portfolio with a coloured icon in the switcher and its lists. Stored on this device.',
      ),
    ).toBeInTheDocument();
  });

  test('every option shows its own tinted chip, group hue excluded', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    // One chip per option, each carrying that icon's hue class — the picker is
    // where the user learns which colour means what.
    expect(chipTintOf(await screen.findByRole('radio', { name: 'Private' }))).toBe('private');
    for (const [name, tint] of [
      ['Family', 'family'],
      ['Business', 'business'],
      ['Savings', 'savings'],
      ['Property', 'property'],
    ] as const) {
      expect(chipTintOf(screen.getByRole('radio', { name }))).toBe(tint);
    }
    // `group` is not a pickable icon — a synced copy overrides it (V5-P7 M5).
    expect(document.querySelectorAll('.bt-pf-chip--group')).toHaveLength(0);
  });

  test('defaults to private and marks exactly one icon checked', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    expect(await screen.findByRole('radio', { name: 'Private' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Business' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  test('picking an icon PATCHes it onto that portfolio only', async () => {
    // Board #69: the kind lives on the row now, so the pick is a server write —
    // it follows the account to every device instead of one browser.
    mockLists([MAIN, TRADING]);
    vi.mocked(updatePortfolio).mockImplementation((_id, patch) => {
      const next = { ...TRADING, ...patch };
      mockLists([MAIN, next]);
      return Promise.resolve(next);
    });
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('radio', { name: 'Property' }));

    await waitFor(() => expect(updatePortfolio).toHaveBeenCalledWith('p2', { kind: 'property' }));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Property' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    // Exactly one portfolio was written — the other keeps whatever it had.
    expect(updatePortfolio).toHaveBeenCalledTimes(1);
  });

  test('shows the kind the server carries on mount', async () => {
    mockLists([MAIN, summary({ id: 'p2', name: 'Trading', sortOrder: 1, kind: 'savings' })]);
    renderSettings('p2');

    expect(await screen.findByRole('radio', { name: 'Savings' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('falls back to the pre-#69 localStorage kind until the server carries one', async () => {
    // The stopgap documented no data migration, so a browser that classified
    // its portfolios before this shipped must look unchanged: the local value
    // is READ for a row the server has no kind for (`kind: null`)…
    localStorage.setItem('bt.portfolio.kinds', JSON.stringify({ p2: 'business' }));
    resetPortfolioKindCache();
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    expect(await screen.findByRole('radio', { name: 'Business' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('the server value wins over a stale local one', async () => {
    localStorage.setItem('bt.portfolio.kinds', JSON.stringify({ p2: 'business' }));
    resetPortfolioKindCache();
    mockLists([MAIN, summary({ id: 'p2', name: 'Trading', sortOrder: 1, kind: 'family' })]);
    renderSettings('p2');

    expect(await screen.findByRole('radio', { name: 'Family' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Business' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});

describe('PortfolioSettingsPage — tax', () => {
  test('names the mode in effect and that it comes from the account default', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    expect(await screen.findByRole('heading', { name: 'Tax' })).toBeInTheDocument();
    // The mode in force, and — the distinction users get wrong — where it is from.
    expect(screen.getByText('Tax mode')).toBeInTheDocument();
    expect(await screen.findByText('Account default')).toBeInTheDocument();
    expect(screen.queryByText('Set here')).not.toBeInTheDocument();
    // Inheriting: the way out is to the ACCOUNT default, not a local reset.
    expect(screen.getByRole('link', { name: /Edit the account default/i })).toHaveAttribute(
      'href',
      '/settings/taxes',
    );
    expect(screen.queryByRole('button', { name: 'Use account default' })).not.toBeInTheDocument();
    expect(getPortfolioTaxSettings).toHaveBeenCalledWith('p2', expect.anything());
  });

  test('picking a mode writes this portfolio’s override', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(setPortfolioTaxOverride).mockResolvedValue(OVERRIDDEN_DE);
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('radio', { name: /Germany/i }));

    await waitFor(() =>
      expect(setPortfolioTaxOverride).toHaveBeenCalledWith('p2', {
        mode: 'country_specific',
        country: 'DE',
      }),
    );
    // The mutation result seeds the cache, so the badge flips without a refetch.
    expect(await screen.findByText('Set here')).toBeInTheDocument();
  });

  test('an overridden portfolio can fall back to the account default', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(getPortfolioTaxSettings).mockResolvedValue(OVERRIDDEN_DE);
    vi.mocked(clearPortfolioTaxOverride).mockResolvedValue(INHERITED_AT);
    renderSettings('p2');

    expect(await screen.findByText('Set here')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Use account default' }));

    await waitFor(() => expect(clearPortfolioTaxOverride).toHaveBeenCalledWith('p2'));
    expect(await screen.findByText('Account default')).toBeInTheDocument();
  });

  test('a failed write says so and leaves the picker usable', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(setPortfolioTaxOverride).mockRejectedValue(new Error('boom'));
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('radio', { name: /Germany/i }));

    expect(await screen.findByText(/Couldn’t save your tax mode/i)).toBeInTheDocument();
    // Still inheriting: a refused write must not fake the new state.
    expect(screen.getByText('Account default')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Germany/i })).toBeEnabled();
  });

  test('a failing tax query degrades to its own error, not a broken page', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(getPortfolioTaxSettings)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(INHERITED_AT);
    const user = userEvent.setup();
    renderSettings('p2');

    expect(await screen.findByText(/Couldn’t load this portfolio’s tax mode/i)).toBeInTheDocument();
    // The rest of the page still works.
    expect(screen.getByLabelText('Name')).toHaveValue('Trading');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Account default')).toBeInTheDocument();
    expect(getPortfolioTaxSettings).toHaveBeenCalledTimes(2);
  });
});

describe('PortfolioSettingsPage — group portfolio', () => {
  test('a non-group portfolio offers the convert entry point', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    await userEvent.click(
      await screen.findByRole('button', { name: 'Make this a group portfolio' }),
    );

    // The existing ConvertChainDialog, wired exactly as the overview header did.
    expect(
      await screen.findByRole('dialog', { name: 'Make this a group portfolio' }),
    ).toBeInTheDocument();
  });

  test('a group portfolio manages its chain instead of converting again', async () => {
    mockLists([MAIN, HOUSEHOLD]);
    renderSettings('p4');

    expect(await screen.findByRole('button', { name: 'Manage group' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Make this a group portfolio' }),
    ).not.toBeInTheDocument();
  });
});

describe('PortfolioSettingsPage — archived', () => {
  test('renders an archived-list read failure without hiding active settings', async () => {
    vi.mocked(listPortfolios).mockImplementation((_signal, includeArchived) =>
      includeArchived
        ? Promise.reject(new Error('archive unavailable'))
        : Promise.resolve({ portfolios: [MAIN, TRADING] }),
    );
    renderSettings('p2');

    expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Trading');
  });

  test('lists archived portfolios and restores one', async () => {
    mockLists([MAIN, TRADING], [OLD]);
    vi.mocked(restorePortfolio).mockResolvedValue({ ...OLD, archivedAt: null });
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restorePortfolio).toHaveBeenCalledWith('p3'));
  });

  test('says so when nothing is archived', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    expect(await screen.findByText('No archived portfolios.')).toBeInTheDocument();
  });
});

describe('PortfolioSettingsPage — danger zone', () => {
  test('archive and delete are disabled on the only active portfolio', async () => {
    mockLists([MAIN]);
    renderSettings('p1');

    expect(await screen.findByRole('button', { name: 'Archive this portfolio' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete this portfolio' })).toBeDisabled();
  });

  test('archiving goes through the confirm dialog and forgets the active portfolio', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(archivePortfolio).mockResolvedValue({
      ...TRADING,
      archivedAt: '2026-02-01T00:00:00.000Z',
    });
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('button', { name: 'Archive this portfolio' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(archivePortfolio).toHaveBeenCalledWith('p2'));
    // The archived portfolio was active → the param AND the session memory go.
    await waitFor(() => expect(screen.getByTestId('active-param')).toHaveTextContent(''));
    expect(sessionStorage.getItem('bt.portfolio.last')).toBeNull();
  });

  test('the delete button stays disabled until the exact portfolio name is typed', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete this portfolio' }));

    const del = await screen.findByRole('button', { name: 'Delete permanently' });
    expect(del).toBeDisabled();

    const field = screen.getByLabelText('Portfolio name confirmation');
    await userEvent.type(field, 'Tradin'); // not yet the full name
    expect(del).toBeDisabled();
    await userEvent.type(field, 'g'); // now exactly "Trading"
    expect(del).toBeEnabled();
  });

  test('deletes the active portfolio and navigates away on success', async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(deletePortfolio).mockResolvedValue(undefined);
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete this portfolio' }));
    await userEvent.type(screen.getByLabelText('Portfolio name confirmation'), 'Trading');
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(deletePortfolio).toHaveBeenCalledWith('p2'));
    await waitFor(() => expect(screen.getByTestId('active-param')).toHaveTextContent(''));
  });

  test('names the auto-promoted default when deleting the current default', async () => {
    mockLists([MAIN, TRADING]);
    renderSettings('p1');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete this portfolio' }));

    expect(
      await screen.findByText('"Trading" will become your new default portfolio.'),
    ).toBeInTheDocument();
  });

  test("the API's last-active refusal is surfaced verbatim", async () => {
    mockLists([MAIN, TRADING]);
    vi.mocked(deletePortfolio).mockRejectedValue(
      new ApiError(400, 'LAST_ACTIVE_PORTFOLIO', 'You need at least one active portfolio.'),
    );
    renderSettings('p2');

    await userEvent.click(await screen.findByRole('button', { name: 'Delete this portfolio' }));
    await userEvent.type(screen.getByLabelText('Portfolio name confirmation'), 'Trading');
    await userEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    expect(await screen.findByText('You need at least one active portfolio.')).toBeInTheDocument();
  });
});
