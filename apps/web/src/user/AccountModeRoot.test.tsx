import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { ParanoidVaultMediaState, PrivacyMode } from '@bettertrack/contracts';

const runtime = vi.hoisted(() => ({
  phase: 'locked' as 'locked' | 'unlocking' | 'unlocked',
  lock: vi.fn(async () => undefined),
  unlockFromDevice: vi.fn(async () => false),
  unlockWithPassphrase: vi.fn(async () => ({})),
  unlockWithRecoveryKit: vi.fn(async () => ({})),
  cleanupAfterDisable: vi.fn(async () => undefined),
}));

const privacy = vi.hoisted(() => ({
  privacyMode: 'normal' as PrivacyMode | null,
  mediaState: null as ParanoidVaultMediaState | null,
  isPending: false,
  isError: false,
  refetch: vi.fn(async () => undefined),
  acceptEnabled: vi.fn(),
  acceptNormal: vi.fn(),
}));

vi.mock('./vault/VaultRuntimeContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vault/VaultRuntimeContext')>()),
  useVaultRuntime: () => runtime,
}));

vi.mock('./vault/usePrivacyMode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vault/usePrivacyMode')>()),
  usePrivacyMode: () => privacy,
}));

vi.mock('./vault/engine/VaultMoneyEngineContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vault/engine/VaultMoneyEngineContext')>()),
  useVaultMoneySession: () => null,
}));

vi.mock('./AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./AuthContext')>()),
  useAuth: () => ({
    status: 'authenticated',
    user: { id: 'user-1', username: 'jane' },
    logout: vi.fn(async () => undefined),
  }),
}));

vi.mock('../lib/twoFactorApi', () => ({ getTwoFactorStatus: vi.fn(async () => null) }));

import { VaultModeRoot } from './vault/VaultAccountRoot';

const SERVER_MEDIA: ParanoidVaultMediaState = {
  mediaSet: ['server'],
  driveAttestedVersion: null,
  server: { disposition: 'active', candidate: null, retired: null },
};

function renderRoot(path = '/portfolio') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <VaultModeRoot privacy={privacy}>
          <div>money surface</div>
        </VaultModeRoot>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.phase = 'locked';
  privacy.privacyMode = 'normal';
  privacy.mediaState = null;
  privacy.isPending = false;
  privacy.isError = false;
});

test('a paranoid account whose vault is locked never renders the subtree behind the gate', async () => {
  privacy.privacyMode = 'paranoid';
  privacy.mediaState = SERVER_MEDIA;

  renderRoot();

  expect(await screen.findByText('Unlock your vault')).toBeInTheDocument();
  expect(screen.queryByText('money surface')).not.toBeInTheDocument();
});

test('a normal account renders the subtree against the server store', () => {
  renderRoot();

  expect(screen.getByText('money surface')).toBeInTheDocument();
  expect(runtime.lock).not.toHaveBeenCalled();
});

test('a disable performed elsewhere revokes the still-decrypted runtime', async () => {
  runtime.phase = 'unlocked';

  renderRoot();

  // Mode says normal while a decrypted session is still open: that session
  // belongs to an account that is no longer paranoid, so it has to go before
  // any API-backed money screen mounts.
  await waitFor(() => expect(runtime.lock).toHaveBeenCalledWith({ broadcast: false }));
});

test('an unlock already in flight is left alone while the mode still reads normal', async () => {
  // The enable wizard's window: it flips the account mode from the receipt and
  // starts the first unlock in the same turn, but the mode flip lands one
  // macrotask later than the phase change, so for one render this component
  // sees 'normal' + 'unlocking'. Locking here would cancel the unlock the user
  // just authenticated (`lock` bumps the runtime's operation generation) and
  // drop them onto a passphrase prompt for the passphrase they had just set.
  runtime.phase = 'unlocking';

  renderRoot();

  // It still refuses to mount the API-backed subtree — an in-flight unlock is
  // not a normal account — it just waits instead of revoking the operation.
  await waitFor(() => expect(runtime.lock).not.toHaveBeenCalled());
  expect(screen.queryByText('money surface')).not.toBeInTheDocument();
});

test('a locked vault still serves the kept account-deletion route (§8 kept list, §12)', async () => {
  privacy.privacyMode = 'paranoid';
  privacy.mediaState = SERVER_MEDIA;

  renderRoot('/account/delete');

  // The stable public deletion URL must not become unreachable behind the gate,
  // and it reads no money data — so it is served, the gate is not.
  expect(await screen.findByText('Delete your account')).toBeInTheDocument();
  expect(screen.queryByText('Unlock your vault')).not.toBeInTheDocument();
  expect(screen.queryByText('money surface')).not.toBeInTheDocument();
});

test('the gate fails closed while the mode read is unresolved', async () => {
  privacy.isError = true;
  privacy.privacyMode = null;

  renderRoot();

  expect(await screen.findByText('Your vault is staying locked')).toBeInTheDocument();
  expect(screen.queryByText('money surface')).not.toBeInTheDocument();
});
