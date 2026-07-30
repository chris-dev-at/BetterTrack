import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const toggleDiscreetMode = vi.fn(async () => undefined);
const auth = { user: { username: 'jane', discreetMode: false }, toggleDiscreetMode };

vi.mock('../../AuthContext', () => ({ useAuth: () => auth }));

import { PrivacyPanel } from './PrivacyPanel';

function renderPanel() {
  return render(
    <MemoryRouter>
      <PrivacyPanel />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { username: 'jane', discreetMode: false };
  toggleDiscreetMode.mockImplementation(async () => undefined);
});

describe('PrivacyPanel (§13.5 V5-P13)', () => {
  test('names itself once and reflects the stored discreet-mode state', () => {
    auth.user = { username: 'jane', discreetMode: true };
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Privacy modes' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Discreet mode' })).toBeChecked();
  });

  test('flipping the switch goes through the auth mutation', async () => {
    const user = userEvent.setup();
    renderPanel();

    const control = screen.getByRole('switch', { name: 'Discreet mode' });
    expect(control).not.toBeChecked();
    await user.click(control);

    await waitFor(() => expect(toggleDiscreetMode).toHaveBeenCalledTimes(1));
  });

  test('a failed write is swallowed — the optimistic flip is rolled back upstream', async () => {
    toggleDiscreetMode.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('switch', { name: 'Discreet mode' }));

    await waitFor(() => expect(toggleDiscreetMode).toHaveBeenCalledTimes(1));
    // The rejection never escapes as an unhandled rejection, and the switch
    // keeps rendering whatever auth state says (still off).
    expect(screen.getByRole('switch', { name: 'Discreet mode' })).not.toBeChecked();
  });

  test('the parked paranoid surface keeps the real client-side vault semantics', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: /Paranoid mode/i })).toBeInTheDocument();
    // The three load-bearing promises: server-blind ciphertext, a key that never
    // leaves the device, and a lost key meaning lost data.
    expect(screen.getByText(/the server can never read it/i)).toBeInTheDocument();
    expect(screen.getByText(/key that never leaves your devices/i)).toBeInTheDocument();
    expect(screen.getByText(/Lost key means lost data/i)).toBeInTheDocument();
  });
});
