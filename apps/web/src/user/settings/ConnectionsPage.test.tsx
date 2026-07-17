import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/userApi', () => ({
  getGoogleLinkStatus: vi.fn(),
  unlinkGoogle: vi.fn(),
  googleStartUrl: vi.fn(() => 'http://api.test/api/v1/auth/google/start'),
}));

import { ApiError } from '../../lib/apiClient';
import { getGoogleLinkStatus, unlinkGoogle } from '../../lib/userApi';
import { ConnectionsPage } from './ConnectionsPage';

const GOOGLE_OFF = {
  enabled: false,
  linked: false,
  email: null,
  linkedAt: null,
  canUnlink: false,
} as const;

const LINKED = {
  enabled: true,
  linked: true,
  email: 'me@example.com',
  linkedAt: '2026-07-01T08:00:00.000Z',
  canUnlink: true,
} as const;

function renderPage(initialEntry = '/settings/connections') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}>
        <ConnectionsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Google off by default so the section stays hidden unless a test opts in.
  vi.mocked(getGoogleLinkStatus).mockResolvedValue(GOOGLE_OFF);
  vi.mocked(unlinkGoogle).mockResolvedValue(undefined);
});

describe('ConnectionsPage — connector slots (V5-P0c)', () => {
  test('renders the compact, non-functional connector slots with sync semantics', async () => {
    renderPage();

    // The page shell renders even while Google is off.
    expect(await screen.findByRole('heading', { name: 'Connections' })).toBeInTheDocument();

    // Each designed slot is present with a "coming soon" chip and no dead button.
    expect(screen.getByText('Google Drive backup')).toBeInTheDocument();
    expect(screen.getByText('Bank & broker cash sync')).toBeInTheDocument();
    expect(screen.getByText('Parqet')).toBeInTheDocument();
    expect(screen.getAllByText('Coming soon').length).toBe(3);
    // Both sync-semantics variants are surfaced.
    expect(screen.getAllByText(/Stays connected/).length).toBeGreaterThan(0);
    expect(screen.getByText(/One-time import/)).toBeInTheDocument();
    // No dead action buttons in the connectors area.
    expect(screen.queryByRole('button', { name: /connect|sync/i })).not.toBeInTheDocument();
  });
});

describe('ConnectionsPage — Google account (§13.4 V4-P4b, moved from Security)', () => {
  test('the section is hidden when Google is not configured (routes 404 / disabled)', async () => {
    renderPage();
    // The connectors still render; the Google section resolves to nothing once
    // the disabled status arrives (a transient skeleton clears on settle).
    expect(await screen.findByText('Google Drive backup')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Google account')).not.toBeInTheDocument());
  });

  test('shows the linked identity and unlinks after a password re-auth', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Linked as me@example.com')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    await user.type(await screen.findByLabelText('Password'), 'my-password-1');
    await user.click(screen.getByRole('button', { name: 'Unlink Google' }));

    await waitFor(() => expect(unlinkGoogle).toHaveBeenCalledWith('my-password-1'));
    expect(await screen.findByText('Google account unlinked.')).toBeInTheDocument();
  });

  test('a wrong password surfaces an in-form error and does not unlink further', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    vi.mocked(unlinkGoogle).mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'nope'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await user.type(await screen.findByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Unlink Google' }));

    expect(await screen.findByText('Your password is incorrect.')).toBeInTheDocument();
  });

  test('Google as the only sign-in method: unlink is withheld with a hint', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue({ ...LINKED, canUnlink: false });
    renderPage();

    expect(await screen.findByText('Linked as me@example.com')).toBeInTheDocument();
    expect(screen.getByText(/only way to sign in/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument();
  });

  test('when not linked, offers a Connect Google affordance', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue({
      enabled: true,
      linked: false,
      email: null,
      linkedAt: null,
      canUnlink: false,
    });
    renderPage();

    expect(await screen.findByText('No Google account is linked.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect Google' })).toBeInTheDocument();
  });

  test('announces a just-completed link from the ?google=linked callback marker', async () => {
    vi.mocked(getGoogleLinkStatus).mockResolvedValue(LINKED);
    renderPage('/settings/connections?google=linked');

    expect(await screen.findByText('Google account linked.')).toBeInTheDocument();
  });

  test('surfaces an email-mismatch connect failure from the ?error=google_email_mismatch marker', async () => {
    // Connect is email-match-only (owner order 2026-07-16): the callback bounces
    // a mismatched Google email back as ?error=google_email_mismatch.
    vi.mocked(getGoogleLinkStatus).mockResolvedValue({
      enabled: true,
      linked: false,
      email: null,
      linkedAt: null,
      canUnlink: false,
    });
    renderPage('/settings/connections?error=google_email_mismatch');

    expect(await screen.findByText(/doesn't match your account email/i)).toBeInTheDocument();
    // The connect affordance is still offered — nothing was linked.
    expect(screen.getByRole('link', { name: 'Connect Google' })).toBeInTheDocument();
  });
});
