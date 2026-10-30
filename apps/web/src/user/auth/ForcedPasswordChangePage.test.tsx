import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    user: { email: 'jane@bettertrack.test' },
    changePassword: authMocks.changePassword,
    logout: authMocks.logout,
  }),
}));

import { ApiError } from '../../lib/apiClient';
import { ForcedPasswordChangePage } from './ForcedPasswordChangePage';

beforeEach(() => {
  vi.clearAllMocks();
});

async function submit(newPassword: string, confirmPassword: string) {
  const user = userEvent.setup();
  render(<ForcedPasswordChangePage />);

  await user.type(screen.getByLabelText('New password'), newPassword);
  await user.type(screen.getByLabelText('Confirm new password'), confirmPassword);
  await user.click(screen.getByRole('button', { name: 'Update password' }));
}

test('a mismatched confirmation is attributed to the confirmation field', async () => {
  await submit('fresh-strong-password-1', 'fresh-strong-password-2');

  const field = screen.getByLabelText('Confirm new password');
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(field).toHaveAccessibleDescription(/do not match/i);
  expect(field).toHaveFocus();
  expect(screen.getByLabelText('New password')).not.toHaveAttribute('aria-invalid');
  expect(authMocks.changePassword).not.toHaveBeenCalled();
});

test('a rejected password is attributed to the new-password field, which takes focus', async () => {
  authMocks.changePassword.mockRejectedValue(
    new ApiError(400, 'WEAK_PASSWORD', 'That password is too common.'),
  );

  await submit('fresh-strong-password-1', 'fresh-strong-password-1');

  const field = await screen.findByLabelText('New password');
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(field).toHaveAccessibleDescription(/That password is too common\./);
  expect(field).toHaveFocus();
});

test('an outage stays a form-level alert and blames no field', async () => {
  authMocks.changePassword.mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'down'));

  await submit('fresh-strong-password-1', 'fresh-strong-password-1');

  // Not `getByRole('alert')`: the page's standing "you must change it" notice
  // is an Alert too, so the failure is picked out by its copy.
  const alert = await screen.findByText(/Something went wrong/);
  expect(screen.getByLabelText('New password')).not.toHaveAttribute('aria-invalid');
  expect(screen.getByLabelText('Confirm new password')).not.toHaveAttribute('aria-invalid');
  expect(document.activeElement).toContainElement(alert);
});
