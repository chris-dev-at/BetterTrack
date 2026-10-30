import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { ForcedPasswordChangePage } from './ForcedPasswordChangePage';

const auth = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'jane@example.test', username: 'jane' },
  changePassword: vi.fn(async (_body: { newPassword: string }) => undefined),
  logout: vi.fn(async () => undefined),
}));

vi.mock('../AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../AuthContext')>()),
  useAuth: () => auth,
}));

beforeEach(() => {
  auth.changePassword.mockReset();
  auth.logout.mockReset();
});

async function submitNewPassword(): Promise<void> {
  const user = userEvent.setup();
  render(
    <I18nProvider>
      <ForcedPasswordChangePage />
    </I18nProvider>,
  );
  await user.type(screen.getByLabelText('New password'), 'fresh-strong-secret-1');
  await user.type(screen.getByLabelText('Confirm new password'), 'fresh-strong-secret-1');
  await user.click(screen.getByRole('button', { name: 'Update password' }));
}

test('sends only the new password', async () => {
  await submitNewPassword();
  await waitFor(() =>
    expect(auth.changePassword).toHaveBeenCalledWith({ newPassword: 'fresh-strong-secret-1' }),
  );
});

test('a sign-in that may not skip the current password is told to sign in with the temporary password', async () => {
  auth.changePassword.mockRejectedValueOnce(
    new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.'),
  );
  await submitNewPassword();

  expect(
    await screen.findByText(/sign in with your temporary password/i, { exact: false }),
  ).toBeInTheDocument();
  // Signing out is now the one action; the form can no longer be resubmitted.
  expect(screen.queryByRole('button', { name: 'Update password' })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
  expect(auth.logout).toHaveBeenCalledTimes(1);
});

test('any other failure keeps the form and shows the generic message', async () => {
  auth.changePassword.mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'Conflict.'));
  await submitNewPassword();

  expect(
    await screen.findByText('Could not change your password. Please try again.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Update password' })).toBeInTheDocument();
});
