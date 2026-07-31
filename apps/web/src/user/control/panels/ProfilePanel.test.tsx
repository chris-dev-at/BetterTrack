import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ProfileSettingsResponse } from '@bettertrack/contracts';

vi.mock('../../../lib/socialApi', () => ({
  getProfileSettings: vi.fn(),
  updateProfileSettings: vi.fn(),
}));

import { I18nProvider } from '../../../i18n';
import { getProfileSettings, updateProfileSettings } from '../../../lib/socialApi';
import { ProfilePanel } from './ProfilePanel';

function makeProfile(overrides: Partial<ProfileSettingsResponse> = {}): ProfileSettingsResponse {
  return {
    username: 'ada',
    isPublic: false,
    bio: null,
    publicItemCount: 2,
    profileIcon: null,
    ...overrides,
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={['/control/profile']}>
      <I18nProvider>
        <QueryClientProvider client={client}>
          <ProfilePanel />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProfileSettings).mockResolvedValue(makeProfile());
  vi.mocked(updateProfileSettings).mockImplementation(async (body) =>
    makeProfile({
      isPublic: body.isPublic ?? false,
      bio: body.bio ?? null,
      profileIcon: body.profileIcon === undefined ? null : body.profileIcon,
    }),
  );
});

describe('ProfilePanel', () => {
  // Popup-native: ONE compact head naming the panel, no page title stack.
  test('carries one panel head and no page heading', async () => {
    renderPanel();

    const heads = await screen.findAllByRole('heading', { level: 2 });
    expect(heads).toHaveLength(1);
    expect(heads[0]).toHaveTextContent('Public profile');
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  test('shows the visibility switch off and the public item count', async () => {
    renderPanel();

    const toggle = await screen.findByRole('switch', { name: 'Make my profile public' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/2 of your items are currently public/i)).toBeInTheDocument();
  });

  // ─── The §16 friction ladder is a privacy boundary, not chrome ──────────────

  test('publishing from off shows the warning and keeps Save locked until acknowledged', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('switch', { name: 'Make my profile public' }));

    // The strong warning appears …
    expect(screen.getByText(/this makes a public page/i)).toBeInTheDocument();
    expect(screen.getByText(/even people who aren't your friends/i)).toBeInTheDocument();
    // … and Save stays disabled until the acknowledgment is ticked.
    const save = screen.getByRole('button', { name: 'Save profile' });
    expect(save).toBeDisabled();

    await user.click(
      screen.getByRole('checkbox', { name: /I understand and want a public profile/i }),
    );
    expect(save).toBeEnabled();
  });

  test('an acknowledged publish sends acknowledgePublic: true', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('switch', { name: 'Make my profile public' }));
    await user.click(
      screen.getByRole('checkbox', { name: /I understand and want a public profile/i }),
    );
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() =>
      expect(updateProfileSettings).toHaveBeenCalledWith(
        expect.objectContaining({ isPublic: true, acknowledgePublic: true }),
      ),
    );
  });

  test('flipping the switch back off clears the acknowledgment (no stale consent)', async () => {
    const user = userEvent.setup();
    renderPanel();

    const toggle = await screen.findByRole('switch', { name: 'Make my profile public' });
    await user.click(toggle);
    await user.click(
      screen.getByRole('checkbox', { name: /I understand and want a public profile/i }),
    );
    // Off again, then on again — the gate must be re-acknowledged.
    await user.click(toggle);
    await user.click(toggle);

    expect(
      screen.getByRole('checkbox', { name: /I understand and want a public profile/i }),
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
  });

  test('editing the bio while already public does not re-gate', async () => {
    vi.mocked(getProfileSettings).mockResolvedValue(makeProfile({ isPublic: true }));
    const user = userEvent.setup();
    renderPanel();

    await user.type(await screen.findByLabelText('Bio'), 'Long-term investor.');

    // No warning, no acknowledgment, and Save is immediately available.
    expect(screen.queryByText(/this makes a public page/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: /I understand and want a public profile/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
  });

  test('turning a live profile off needs no acknowledgment (unpublishing is safe)', async () => {
    vi.mocked(getProfileSettings).mockResolvedValue(makeProfile({ isPublic: true }));
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('switch', { name: 'Make my profile public' }));

    expect(
      screen.queryByRole('checkbox', { name: /I understand and want a public profile/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() =>
      expect(updateProfileSettings).toHaveBeenCalledWith(
        expect.objectContaining({ isPublic: false, acknowledgePublic: undefined }),
      ),
    );
  });

  // ─── Icon picker (§13.5 V5-P0c) ─────────────────────────────────────────────

  test('the icon grid stays collapsed until opened, then picks a curated icon', async () => {
    const user = userEvent.setup();
    renderPanel();

    // The disclosure's accessible name concatenates its title and hint, so match
    // on the title (Playwright's getByRole does substring matching for `name`,
    // which is why e2e/profile-icons.spec.ts can pass the bare string).
    const toggle = await screen.findByRole('button', { name: /^Profile icon/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();

    await user.click(toggle);
    const fox = screen.getByRole('radio', { name: 'Fox' });
    await user.click(fox);
    expect(fox).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() =>
      expect(updateProfileSettings).toHaveBeenCalledWith(
        expect.objectContaining({ profileIcon: 'fox' }),
      ),
    );
  });

  test('Save stays disabled while nothing changed', async () => {
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Save profile' })).toBeDisabled();
  });

  // The live URL is only meaningful once the SERVER says the page is published.
  test('the live URL shows only while public server-side', async () => {
    vi.mocked(getProfileSettings).mockResolvedValue(makeProfile({ isPublic: true }));
    renderPanel();

    expect(await screen.findByText(/\/u\/ada$/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/u/ada');
  });

  test('a private profile shows no live URL', async () => {
    renderPanel();

    await screen.findByRole('switch', { name: 'Make my profile public' });
    expect(screen.queryByRole('link', { name: 'View' })).not.toBeInTheDocument();
  });

  test('a load failure says so instead of rendering an empty form', async () => {
    vi.mocked(getProfileSettings)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeProfile());
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText(/could not load your profile settings/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('switch', { name: 'Make my profile public' }),
    ).toBeInTheDocument();
    expect(getProfileSettings).toHaveBeenCalledTimes(2);
  });
});
