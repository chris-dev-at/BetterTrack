import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/settingsApi', () => ({
  getNotificationSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
}));

import { getNotificationSettings, updateNotificationSettings } from '../../lib/settingsApi';
import { NotificationSettingsPage } from './SettingsSection';

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
}

function renderPage() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <NotificationSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getNotificationSettings).mockResolvedValue({
    inapp: { enabled: true },
    email: { enabled: true },
  });
});

describe('NotificationSettingsPage', () => {
  test('reads the settings and renders in-app locked on', async () => {
    renderPage();

    const inApp = await screen.findByRole('switch', { name: 'In-app' });
    expect(inApp).toBeChecked();
    expect(inApp).toBeDisabled();

    expect(screen.getByRole('switch', { name: 'Email' })).toBeChecked();
  });

  test('toggling email off writes the setting and reflects the new state', async () => {
    vi.mocked(updateNotificationSettings).mockResolvedValue({
      inapp: { enabled: true },
      email: { enabled: false },
    });
    const user = userEvent.setup();
    renderPage();

    const email = await screen.findByRole('switch', { name: 'Email' });
    expect(email).toBeChecked();

    await user.click(email);

    expect(updateNotificationSettings).toHaveBeenCalledWith({ email: { enabled: false } });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Email' })).not.toBeChecked());
  });

  test('shows an error affordance when settings fail to load', async () => {
    vi.mocked(getNotificationSettings).mockRejectedValue(new Error('nope'));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load your notification settings/i)).toBeInTheDocument(),
    );
  });
});
