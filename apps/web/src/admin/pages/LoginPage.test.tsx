import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { ApiError } from '../../lib/apiClient';
import { AuthProvider } from '../AuthContext';
import { LoginPage } from './LoginPage';

function renderLogin() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // Anonymous session: /auth/me rejects 401 so the login form renders (rather
  // than the authenticated redirect).
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Not signed in.'));
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
