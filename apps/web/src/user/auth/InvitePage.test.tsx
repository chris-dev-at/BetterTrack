import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../lib/userApi');

const authMocks = vi.hoisted(() => ({
  acceptInvite: vi.fn(),
}));

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ acceptInvite: authMocks.acceptInvite }),
}));

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/userApi';
import { InvitePage } from './InvitePage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/invite/invite-token']}>
      <Routes>
        <Route path="/invite/:token" element={<InvitePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

test.each([0, 500])(
  'a status %i validation outage shows a retryable unavailable state',
  async (status) => {
    vi.mocked(api.validateInvite)
      .mockRejectedValueOnce(
        new ApiError(status, status === 0 ? 'NETWORK_ERROR' : 'UNKNOWN', 'unavailable'),
      )
      .mockResolvedValueOnce({ valid: true, email: 'invitee@bettertrack.test' });
    const user = userEvent.setup();

    renderPage();

    expect(await screen.findByText(/can’t check this invite right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/invalid, expired/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByDisplayValue('invitee@bettertrack.test')).toBeInTheDocument();
    expect(api.validateInvite).toHaveBeenCalledTimes(2);
  },
);

test('a confirmed invalid response keeps the terminal invalid-invite state', async () => {
  vi.mocked(api.validateInvite).mockResolvedValue({ valid: false, email: null });

  renderPage();

  expect(await screen.findByText(/invalid, expired/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});
