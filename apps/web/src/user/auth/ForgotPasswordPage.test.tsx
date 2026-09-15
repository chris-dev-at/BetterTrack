import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../lib/userApi');
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  listWorkboard: vi.fn(),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/userApi';
import { listWorkboard } from '../../lib/workboardApi';
import { waitForColdStart } from '../../test/waitForColdStart';
import { UserApp } from '../UserApp';

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'nope'));
  vi.mocked(api.getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
});

async function submitAddress() {
  const u = userEvent.setup();
  renderApp();
  await waitForColdStart(() => screen.getByText('Reset your password'));
  await u.type(screen.getByLabelText('Email'), 'jane@bettertrack.test');
  await u.click(screen.getByRole('button', { name: 'Send reset link' }));
  return u;
}

test('a successful request shows the generic confirmation, not whether the account exists', async () => {
  vi.mocked(api.requestPasswordReset).mockResolvedValue(undefined);

  await submitAddress();

  expect(await screen.findByText(/If an account exists for that email/)).toBeInTheDocument();
  expect(api.requestPasswordReset).toHaveBeenCalledWith({ email: 'jane@bettertrack.test' });
});

// §6.1 / §14: this page's whole contract is that the response reveals nothing
// about the address. Marking the email box `aria-invalid` on a failure would be
// a user-enumeration regression — "we rejected what you typed" is exactly the
// signal the generic confirmation exists to withhold. The `useFieldErrors` call
// here can only ever pass `field: null`, and these tests pin that so a later
// "helpfully attribute it to the email box" edit fails loudly.
test('a rate limit stays a form-level alert and blames no field', async () => {
  vi.mocked(api.requestPasswordReset).mockRejectedValue(
    Object.assign(new ApiError(429, 'RATE_LIMITED', 'slow down'), { retryAfterSeconds: 30 }),
  );

  await submitAddress();

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Too many requests. Please wait 30 seconds and try again.');
  expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
  // Focus lands on the alert's focusable wrapper, so the failure is announced
  // where the keyboard actually is rather than in a region nothing reaches.
  expect(document.activeElement).toContainElement(alert);
});

test('an outage stays a form-level alert and blames no field', async () => {
  vi.mocked(api.requestPasswordReset).mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom'));

  await submitAddress();

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/Something went wrong/i);
  expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
  expect(document.activeElement).toContainElement(alert);
});
