import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse, ParanoidMediaStateResponse } from '@bettertrack/contracts';

vi.mock('../lib/userApi');
vi.mock('../lib/portfolioApi');
vi.mock('../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  WATCHLISTS_QUERY_KEY: ['workboard', 'watchlists'],
  WATCHLIST_SHARING_QUERY_KEY: ['workboard', 'sharing'],
  listWorkboard: vi.fn(async () => ({ items: [] })),
  listWatchlists: vi.fn(async () => ({ watchlists: [] })),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
  getWatchlistSharing: vi.fn(async () => ({ visibility: 'private' })),
  updateWatchlistSharing: vi.fn(),
}));
// The locked gate tries the trusted-device custody path once on mount. It reads
// the encrypted envelope through this seam; failing it keeps the runtime at
// phase 'locked' without a real request (`unlockFromDevice` swallows the error
// by contract), which is exactly the state under test.
vi.mock('./vault/serverBlobDataHome', () => ({
  createServerBlobDataHome: () => ({
    read: vi.fn(async () => {
      throw new Error('no envelope in tests');
    }),
    write: vi.fn(async () => {
      throw new Error('no envelope in tests');
    }),
    remove: vi.fn(async () => undefined),
  }),
  serverBlobDataHome: () => {
    throw new Error('unused');
  },
}));

import { ApiError } from '../lib/apiClient';
import * as api from '../lib/userApi';
import { listPortfolios } from '../lib/portfolioApi';
import { UserApp, queryClient } from './UserApp';

const member: MeResponse = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const paranoidOnServer: ParanoidMediaStateResponse = {
  privacyMode: 'paranoid',
  mediaState: {
    mediaSet: ['server'],
    driveAttestedVersion: null,
    server: { disposition: 'active', candidate: null, retired: null },
  },
};

/** Mount the user app under a `/*` parent, exactly as App.tsx does. */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.localStorage?.clear();
  // `UserApp` owns a module-level QueryClient, so the resolved privacy mode of
  // one case would otherwise still be cached (and fresh) for the next one.
  queryClient.clear();
  vi.mocked(api.getMe).mockResolvedValue(member);
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
});

/**
 * `AccountModeRoot` is the single most security-relevant branch in PD8: it is
 * what decides "paranoid + locked ⇒ the unlock gate, never a money page, never
 * `apiPortfolioStore`". Its constituents are unit-tested individually; these
 * cases assert the WIRING, through the real `UserApp` tree.
 *
 * `listPortfolios` is the probe for `apiPortfolioStore`: it is the first call
 * every server-backed money surface makes, so "not called" means no plaintext
 * portfolio read reached the network on a locked encrypted account.
 */
test('paranoid + locked replaces the whole authenticated subtree with the unlock gate', async () => {
  vi.mocked(api.getParanoidMediaState).mockResolvedValue(paranoidOnServer);

  renderAt('/portfolio');

  expect(await screen.findByText('Unlock your vault')).toBeInTheDocument();
  // No app chrome either — the gate replaces the shell, not just the page.
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
  expect(listPortfolios).not.toHaveBeenCalled();
});

test('a money deep link on a locked vault still lands on the gate, with no server portfolio read', async () => {
  vi.mocked(api.getParanoidMediaState).mockResolvedValue(paranoidOnServer);

  renderAt('/portfolio/tax');

  expect(await screen.findByText('Unlock your vault')).toBeInTheDocument();
  // Give the route a turn to settle before claiming nothing was fetched.
  await waitFor(() => expect(listPortfolios).not.toHaveBeenCalled());
});

test('the gate never appears for a normal account, which keeps reading the server store', async () => {
  vi.mocked(api.getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });

  renderAt('/portfolio');

  // The control for the two cases above: the same route on a normal account
  // does mount a money surface and does call `apiPortfolioStore`.
  await waitFor(() => expect(listPortfolios).toHaveBeenCalled());
  expect(screen.queryByText('Unlock your vault')).not.toBeInTheDocument();
});

test('the mode read failing closed shows the retry card, never a money page', async () => {
  vi.mocked(api.getParanoidMediaState).mockRejectedValue(
    new ApiError(503, 'UNAVAILABLE', 'Service unavailable.'),
  );

  renderAt('/portfolio');

  // The gate read retries twice with backoff before it gives up (a single
  // transient failure must not replace the app with a retry card), so this wait
  // has to outlast ~3 s of retry delay.
  expect(
    await screen.findByText('Your vault is staying locked', {}, { timeout: 10_000 }),
  ).toBeInTheDocument();
  expect(listPortfolios).not.toHaveBeenCalled();
});
