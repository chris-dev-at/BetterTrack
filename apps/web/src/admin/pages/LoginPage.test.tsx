import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { AuthProvider } from '../AuthContext';
import { LoginPage } from './LoginPage';

function renderLogin(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  // Anonymous session: /auth/me rejects 401 so the login form renders (rather
  // than the authenticated redirect).
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Not signed in.'));
});

test('renders a main landmark with one descriptive page heading', async () => {
  vi.mocked(api.getVersion).mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'offline'));

  renderLogin();

  await screen.findByRole('button', { name: 'Sign in' });
  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(screen.getAllByRole('heading', { level: 1, name: 'Admin sign in' })).toHaveLength(1);
});

test('renders the web build sha in the footer, with no api segment on fetch failure', async () => {
  vi.mocked(api.getVersion).mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'offline'));

  renderLogin();

  // VITE_BUILD_SHA is unset under test, so the web marker falls back to "unknown".
  expect(await screen.findByText(/web unknown/)).toBeInTheDocument();
  // The version fetch failed → the footer must not gain an "· api …" segment.
  expect(screen.queryByText(/· api/)).not.toBeInTheDocument();
});

test('appends the api sha once the version fetch resolves', async () => {
  vi.mocked(api.getVersion).mockResolvedValue({
    commit: 'def5678000000000000000000000000000000000',
    shortCommit: 'def5678',
    builtAt: '2026-07-10T00:00:00Z',
  });

  renderLogin();

  expect(await screen.findByText(/web unknown · api def5678/)).toBeInTheDocument();
});

test('renders the P13b admin sign-in surface in German', async () => {
  vi.mocked(api.getVersion).mockRejectedValue(new ApiError(0, 'NETWORK_ERROR', 'offline'));

  renderLogin('de');

  expect(await screen.findByRole('button', { name: 'Anmelden' })).toBeInTheDocument();
  expect(screen.getByLabelText('E-Mail oder Benutzername')).toBeInTheDocument();
  expect(screen.getByLabelText('Passwort')).toBeInTheDocument();
});
