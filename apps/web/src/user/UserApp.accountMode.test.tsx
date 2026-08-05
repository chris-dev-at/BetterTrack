import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse, ParanoidMediaStateResponse } from '@bettertrack/contracts';

const vaultRuntimeMocks = vi.hoisted(() => ({
  createServerBlobDataHome: vi.fn(() => ({
    read: vi.fn(async () => {
      throw new Error('no envelope in tests');
    }),
    write: vi.fn(async () => {
      throw new Error('no envelope in tests');
    }),
    remove: vi.fn(async () => undefined),
  })),
}));

vi.mock('../lib/userApi');
vi.mock('../lib/portfolioApi');
vi.mock('../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  WATCHLISTS_QUERY_KEY: ['workboard', 'watchlists'],
  listWorkboard: vi.fn(async () => ({ items: [] })),
  listWatchlists: vi.fn(async () => ({ watchlists: [] })),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));
// The locked gate tries the trusted-device custody path once on mount. It reads
// the encrypted envelope through this seam; failing it keeps the runtime at
// phase 'locked' without a real request (`unlockFromDevice` swallows the error
// by contract), which is exactly the state under test.
vi.mock('./vault/serverBlobDataHome', () => ({
  createServerBlobDataHome: vaultRuntimeMocks.createServerBlobDataHome,
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

/**
 * Drives in-app navigation from a case, so a surface can be reached the way a
 * user reaches it — mid-session — instead of only as a cold deep link.
 */
let navigateTo: ((to: string) => void) | null = null;

function Navigator() {
  navigateTo = useNavigate();
  return null;
}

/** Mount the user app under a `/*` parent, exactly as App.tsx does. */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Navigator />
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateTo = null;
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

  expect(await screen.findByText('Unlock your vault', {}, { timeout: 5_000 })).toBeInTheDocument();
  // The mode gate requested and initialized the real lazy vault runtime before
  // showing an unlock UI; a paranoid boot cannot defer this until first use.
  expect(vaultRuntimeMocks.createServerBlobDataHome).toHaveBeenCalled();
  // No app chrome either — the gate replaces the shell, not just the page.
  expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
  expect(listPortfolios).not.toHaveBeenCalled();
});

test('a money deep link on a locked vault still lands on the gate, with no server portfolio read', async () => {
  vi.mocked(api.getParanoidMediaState).mockResolvedValue(paranoidOnServer);

  renderAt('/portfolio/tax');

  expect(await screen.findByText('Unlock your vault', {}, { timeout: 5_000 })).toBeInTheDocument();
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
  await waitFor(() => expect(listPortfolios).toHaveBeenCalled(), { timeout: 5_000 });
  expect(screen.queryByText('Unlock your vault')).not.toBeInTheDocument();
  expect(vaultRuntimeMocks.createServerBlobDataHome).not.toHaveBeenCalled();
});

/**
 * Control Center → Privacy is the one settings surface that reaches into the
 * vault stack, and it is reachable from every normal session. Opening it must
 * not swap the account-mode branch: that replaces the whole authenticated
 * subtree — shell, socket, mounted page and the page the popup opens over — so
 * the popup would end up floating over a freshly booted Home instead of the
 * page it was opened from.
 */
test('opening Privacy mid-session keeps the whole authenticated subtree mounted', async () => {
  vi.mocked(api.getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });

  renderAt('/portfolio');

  await screen.findByRole('button', { name: 'Account menu' }, { timeout: 5_000 });
  const shellBefore = document.querySelector('#main-content');
  expect(shellBefore).not.toBeNull();

  await act(async () => {
    navigateTo?.('/control/privacy');
  });

  // The panel renders — nothing above it threw for want of a vault provider…
  expect(
    await screen.findByRole('switch', { name: 'Discreet mode' }, { timeout: 5_000 }),
  ).toBeInTheDocument();
  // …the very same shell node is still on screen (a remount would replace it,
  // taking the popup's background page with it)…
  expect(document.querySelector('#main-content')).toBe(shellBefore);
  // …and no vault runtime was mounted for a normal account just reading it.
  expect(vaultRuntimeMocks.createServerBlobDataHome).not.toHaveBeenCalled();
});

test('the explicit setup request is what mounts the vault runtime for a normal account', async () => {
  vi.mocked(api.getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });

  renderAt('/control/privacy?enable=1');

  // The wizard only renders with the providers above it (`useVaultRuntime`
  // throws otherwise), so its heading IS the assertion that the gate swapped.
  // The request rides in the URL precisely because that swap unmounts whoever
  // asked for it.
  expect(
    await screen.findByRole('heading', { name: 'What changes' }, { timeout: 5_000 }),
  ).toBeInTheDocument();
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
