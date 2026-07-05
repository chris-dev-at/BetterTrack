import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { MeResponse, PortfolioSummary } from '@bettertrack/contracts';

vi.mock('../../lib/userApi', () => ({
  getMe: vi.fn(),
  changePassword: vi.fn(),
}));
vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
  updatePortfolio: vi.fn(),
}));

import { listPortfolios, updatePortfolio } from '../../lib/portfolioApi';
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
  lastLoginAt: '2026-07-01T10:00:00.000Z',
  createdAt: '2026-01-15T09:00:00.000Z',
};

const DEFAULT_PORTFOLIO: PortfolioSummary = {
  id: '00000000-0000-0000-0000-0000000000aa',
  name: 'Main',
  visibility: 'private',
  sortOrder: 0,
  isDefault: true,
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <AccountSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMe).mockResolvedValue(ME);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [DEFAULT_PORTFOLIO] });
  vi.mocked(changePassword).mockResolvedValue(ME);
  vi.mocked(updatePortfolio).mockResolvedValue({ ...DEFAULT_PORTFOLIO, visibility: 'friends' });
});

describe('AccountSettingsPage', () => {
  test('renders identity and the fixed EUR base-currency marker', async () => {
    renderPage();

    expect(await screen.findByText('ada')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Member since')).toBeInTheDocument();
    expect(screen.getByText('EUR (fixed)')).toBeInTheDocument();
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
