import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { MeResponse, PortfolioSummary } from '@bettertrack/contracts';

vi.mock('../../lib/userApi', () => ({
  getMe: vi.fn(),
  changePassword: vi.fn(),
}));
vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  updatePortfolio: vi.fn(),
}));
vi.mock('../../lib/settingsApi', () => ({
  getAccountSettings: vi.fn(),
  updateAccountSettings: vi.fn(),
}));

import { I18nProvider } from '../../i18n';
import { getMoneyCurrency, setMoneyCurrency } from '../../lib/format';
import { listPortfolios, updatePortfolio } from '../../lib/portfolioApi';
import { getAccountSettings, updateAccountSettings } from '../../lib/settingsApi';
import { changePassword, getMe } from '../../lib/userApi';
import { AccountSettingsPage } from './AccountSettingsPage';

const ME: MeResponse = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'ada@example.com',
  username: 'ada',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: '2026-07-01T10:00:00.000Z',
  createdAt: '2026-01-15T09:00:00.000Z',
};

const DEFAULT_PORTFOLIO: PortfolioSummary = {
  id: '00000000-0000-0000-0000-0000000000aa',
  name: 'Main',
  visibility: 'private',
  sortOrder: 0,
  isDefault: true,
  defaultPayFromCash: false,
  archivedAt: null,
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <I18nProvider>
      <QueryClientProvider client={client}>
        <AccountSettingsPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(getMe).mockResolvedValue(ME);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [DEFAULT_PORTFOLIO] });
  vi.mocked(changePassword).mockResolvedValue(ME);
  vi.mocked(updatePortfolio).mockResolvedValue({ ...DEFAULT_PORTFOLIO, visibility: 'friends' });
  vi.mocked(getAccountSettings).mockResolvedValue({
    defaultPortfolioVisibility: 'private',
    locale: 'en',
    baseCurrency: 'EUR',
  });
  vi.mocked(updateAccountSettings).mockResolvedValue({
    defaultPortfolioVisibility: 'friends',
    locale: 'en',
    baseCurrency: 'EUR',
  });
});

// The default money currency is module-level state — restore EUR so tests
// stay order-independent.
afterEach(() => setMoneyCurrency('EUR'));

describe('AccountSettingsPage', () => {
  test('renders identity fields; the base currency moved to its own picker (V3-P10d)', async () => {
    renderPage();

    expect(await screen.findByText('ada')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Member since')).toBeInTheDocument();
    // The V2 "EUR (fixed)" identity marker is gone — the base is configurable now.
    expect(screen.queryByText(/\(fixed\)/)).not.toBeInTheDocument();
  });

  test('change-password submit calls the client with current + new', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Current password'), 'oldpassword1');
    await user.type(screen.getByLabelText('New password'), 'newpassword123');
    await user.type(screen.getByLabelText('Confirm new password'), 'newpassword123');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith({
        currentPassword: 'oldpassword1',
        newPassword: 'newpassword123',
      }),
    );
    expect(await screen.findByText(/password has been changed/i)).toBeInTheDocument();
  });

  test('mismatched new passwords do not call the client', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Current password'), 'oldpassword1');
    await user.type(screen.getByLabelText('New password'), 'newpassword123');
    await user.type(screen.getByLabelText('Confirm new password'), 'different12345');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  test('setting the default portfolio sharing to Friends PATCHes account settings', async () => {
    const user = userEvent.setup();
    renderPage();

    const friends = await screen.findByRole('radio', { name: 'Friends' });
    expect(screen.getByRole('radio', { name: 'Private' })).toHaveAttribute('aria-checked', 'true');

    await user.click(friends);

    await waitFor(() =>
      expect(updateAccountSettings).toHaveBeenCalledWith({ defaultPortfolioVisibility: 'friends' }),
    );
  });

  test('the language picker persists the choice and switches the app to German', async () => {
    const user = userEvent.setup();
    vi.mocked(updateAccountSettings).mockResolvedValue({
      defaultPortfolioVisibility: 'private',
      locale: 'de',
      baseCurrency: 'EUR',
    });
    renderPage();

    // Renders in English by default (source of truth).
    expect(await screen.findByText('Account')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Display language'), 'de');

    // Persists the choice server-side …
    await waitFor(() => expect(updateAccountSettings).toHaveBeenCalledWith({ locale: 'de' }));
    // … and switches the app at runtime without a reload (German heading appears).
    expect(await screen.findByText('Konto')).toBeInTheDocument();
  });

  test('the base-currency picker persists the choice and flips the money formatter (V3-P10d)', async () => {
    const user = userEvent.setup();
    vi.mocked(updateAccountSettings).mockResolvedValue({
      defaultPortfolioVisibility: 'private',
      locale: 'en',
      baseCurrency: 'USD',
    });
    renderPage();

    // Defaults to EUR (the migration/backfill default) with all four options.
    const picker = await screen.findByLabelText('Base currency');
    await waitFor(() => expect(picker).toHaveValue('EUR'));
    for (const code of ['EUR', 'USD', 'CHF', 'GBP']) {
      expect(screen.getByRole('option', { name: new RegExp(`^${code} — `) })).toBeInTheDocument();
    }

    await user.selectOptions(picker, 'USD');

    // Persists the choice server-side …
    await waitFor(() =>
      expect(updateAccountSettings).toHaveBeenCalledWith({ baseCurrency: 'USD' }),
    );
    // … and immediately drives the display layer's default money currency, so
    // every omitted-currency MoneyText re-renders in the new base.
    await waitFor(() => expect(getMoneyCurrency()).toBe('USD'));
  });

  test('turning sharing on PATCHes the default portfolio to friends', async () => {
    const user = userEvent.setup();
    renderPage();

    const yes = await screen.findByRole('radio', { name: 'Yes' });
    expect(screen.getByRole('radio', { name: 'No' })).toHaveAttribute('aria-checked', 'true');

    await user.click(yes);

    await waitFor(() =>
      expect(updatePortfolio).toHaveBeenCalledWith(DEFAULT_PORTFOLIO.id, { visibility: 'friends' }),
    );
  });
});
