import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/userApi', () => ({
  deleteAccount: vi.fn(),
}));
vi.mock('../../lib/twoFactorApi', () => ({
  getTwoFactorStatus: vi.fn(),
}));
const logout = vi.fn();
vi.mock('../AuthContext', () => ({
  useAuth: () => ({ user: ME, logout }),
}));

import { I18nProvider } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { getTwoFactorStatus } from '../../lib/twoFactorApi';
import { deleteAccount } from '../../lib/userApi';
import { DeleteAccountPage } from './DeleteAccountPage';

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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/account/delete']}>
      <I18nProvider>
        <QueryClientProvider client={client}>
          <DeleteAccountPage />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(getTwoFactorStatus).mockResolvedValue({
    totpEnabled: false,
    totpPending: false,
    emailEnabled: false,
    recoveryCodesRemaining: 0,
  });
  vi.mocked(deleteAccount).mockResolvedValue(undefined);
});

describe('DeleteAccountPage (V4-P2c, #362)', () => {
  test('shows the strong warning and blocks a mismatched typed confirmation locally', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Delete your account')).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/type your username/i), 'not-ada');
    await user.type(screen.getByLabelText('Current password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: /delete my account permanently/i }));

    expect(
      await screen.findByText('The username you typed does not match your account.'),
    ).toBeInTheDocument();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  test('submits confirmation + password, then resets local auth state', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/type your username/i), 'ada');
    await user.type(screen.getByLabelText('Current password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: /delete my account permanently/i }));

    await waitFor(() =>
      expect(deleteAccount).toHaveBeenCalledWith({
        confirmUsername: 'ada',
        password: 'hunter2hunter2',
      }),
    );
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  test('a wrong password from the server renders as an in-form error', async () => {
    vi.mocked(deleteAccount).mockRejectedValue(
      new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.'),
    );
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/type your username/i), 'ada');
    await user.type(screen.getByLabelText('Current password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /delete my account permanently/i }));

    expect(await screen.findByText('That password is incorrect.')).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });

  test('a 2FA-enrolled account can re-auth with an authenticator code instead', async () => {
    vi.mocked(getTwoFactorStatus).mockResolvedValue({
      totpEnabled: true,
      totpPending: false,
      emailEnabled: false,
      recoveryCodesRemaining: 8,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /use an authenticator code/i }));
    await user.type(screen.getByLabelText(/type your username/i), 'ada');
    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: /delete my account permanently/i }));

    await waitFor(() =>
      expect(deleteAccount).toHaveBeenCalledWith({ confirmUsername: 'ada', code: '123456' }),
    );
  });
});
