import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortfolioSummary } from '@bettertrack/contracts';

const mocks = vi.hoisted(() => ({
  useOptionalAuth: vi.fn(),
  listVaults: vi.fn(),
  resolveVaultedPortfolioStores: vi.fn(),
  sessionEndSubscription: vi.fn(),
  vaultOpenedSubscription: vi.fn(),
}));

vi.mock('../AuthContext', () => ({ useOptionalAuth: mocks.useOptionalAuth }));
vi.mock('../../lib/vaultApi', () => ({
  VAULTS_QUERY_KEY: ['vaults', 'configs'],
  listVaults: mocks.listVaults,
}));
vi.mock('./vaultedPortfolioStores', () => ({
  resolveVaultedPortfolioStores: mocks.resolveVaultedPortfolioStores,
  sessionEndSubscription: mocks.sessionEndSubscription,
  vaultOpenedSubscription: mocks.vaultOpenedSubscription,
}));

import {
  resetVaultedPortfolioStoreRegistry,
  useVaultedPortfolioStores,
} from './useVaultedPortfolioStores';

/**
 * The lifecycle seam (#1416). Everything here is about WHEN a client store may
 * exist, not what it serves: no account, no vault list, a failed resolution and
 * a locked session must all land on the same empty map — which is exactly
 * today's stub-and-qualifier behaviour — and a lock must take an existing one
 * away without waiting for a refetch.
 */

const VAULT_ID = '018f0000-0000-7000-8000-000000000701';
const ACCOUNT_ID = '018f0000-0000-7000-8000-000000000702';

const PLAIN: PortfolioSummary = {
  id: 'p-plain',
  name: 'Plain',
  visibility: 'private',
  sortOrder: 0,
  isDefault: true,
  defaultPayFromCash: false,
  archivedAt: null,
};
const VAULTED: PortfolioSummary = { ...PLAIN, id: 'p-vaulted', vaultId: VAULT_ID };

function Probe({ portfolios }: { portfolios: PortfolioSummary[] }) {
  const { unlocked } = useVaultedPortfolioStores(portfolios);
  return <span data-testid="unlocked">{[...unlocked.keys()].join(',') || 'none'}</span>;
}

function renderProbe(portfolios: PortfolioSummary[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Probe portfolios={portfolios} />
    </QueryClientProvider>,
  );
}

function batchFor(portfolioId: string) {
  return {
    unlocked: new Map([[portfolioId, { portfolioId, vaultId: VAULT_ID } as never]]),
    dispose: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetVaultedPortfolioStoreRegistry();
  mocks.useOptionalAuth.mockReturnValue({ status: 'authenticated', user: { id: ACCOUNT_ID } });
  mocks.listVaults.mockResolvedValue([{ id: VAULT_ID, keyFingerprint: 'TESTVECTOR000000' }]);
  mocks.sessionEndSubscription.mockImplementation(() => () => {});
  mocks.vaultOpenedSubscription.mockImplementation(() => () => {});
});

describe('useVaultedPortfolioStores', () => {
  it('never loads the vault graph for an all-plain roster', async () => {
    renderProbe([PLAIN]);

    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('none'));
    expect(mocks.resolveVaultedPortfolioStores).not.toHaveBeenCalled();
    // Not even the cleartext vault list: a plain account's Home asks nothing new.
    expect(mocks.listVaults).not.toHaveBeenCalled();
  });

  it('resolves once a vaulted member appears and exposes what opened', async () => {
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));

    renderProbe([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));
    expect(mocks.resolveVaultedPortfolioStores).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID }),
    );
  });

  it('drops the batch the moment the endpoint session ends', async () => {
    const batch = batchFor(VAULTED.id);
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batch);
    let endSession = () => {};
    mocks.sessionEndSubscription.mockImplementation((listener: () => void) => {
      endSession = listener;
      return () => {};
    });

    renderProbe([PLAIN, VAULTED]);
    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));

    act(() => endSession());

    expect(screen.getByTestId('unlocked')).toHaveTextContent('none');
    expect(batch.dispose).toHaveBeenCalled();
  });

  /**
   * The edge the keystore had to grow (`subscribeToVaultOpened`). The roster
   * does not change when a user unlocks a vault, so without this the batch
   * resolved WHILE LOCKED would stand forever and the portfolio would keep
   * rendering as a stub until the next full navigation.
   */
  it('re-resolves when a vault is unlocked, without any roster change', async () => {
    mocks.resolveVaultedPortfolioStores.mockResolvedValue({
      unlocked: new Map(),
      dispose: vi.fn(),
    });
    let vaultOpened = () => {};
    mocks.vaultOpenedSubscription.mockImplementation((listener: () => void) => {
      vaultOpened = listener;
      return () => {};
    });

    renderProbe([PLAIN, VAULTED]);
    await waitFor(() => expect(mocks.resolveVaultedPortfolioStores).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('unlocked')).toHaveTextContent('none');

    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));
    await act(async () => {
      vaultOpened();
    });

    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));
  });

  it('ignores the vault-opened edge raised by its own in-flight resolution', async () => {
    let vaultOpened = () => {};
    mocks.vaultOpenedSubscription.mockImplementation((listener: () => void) => {
      vaultOpened = listener;
      return () => {};
    });
    // The resolver opens the vault, which fires the edge from INSIDE the
    // resolution. Reacting to it would restart the resolution forever.
    mocks.resolveVaultedPortfolioStores.mockImplementation(async () => {
      vaultOpened();
      return batchFor(VAULTED.id);
    });

    renderProbe([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.resolveVaultedPortfolioStores).toHaveBeenCalledTimes(1);
  });

  it('fails closed to the stub when the resolution rejects', async () => {
    mocks.resolveVaultedPortfolioStores.mockRejectedValue(new Error('vault unreachable'));

    renderProbe([PLAIN, VAULTED]);

    await waitFor(() => expect(mocks.resolveVaultedPortfolioStores).toHaveBeenCalled());
    expect(screen.getByTestId('unlocked')).toHaveTextContent('none');
  });

  it('resolves nothing for an unauthenticated session', async () => {
    mocks.useOptionalAuth.mockReturnValue({ status: 'anonymous', user: null });

    renderProbe([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('none'));
    expect(mocks.resolveVaultedPortfolioStores).not.toHaveBeenCalled();
  });

  it('disposes the previous batch when the roster changes', async () => {
    const first = batchFor(VAULTED.id);
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(first);
    const view = renderProbe([PLAIN, VAULTED]);
    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));

    const second = batchFor('p-other');
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(second);
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Probe portfolios={[PLAIN, { ...VAULTED, id: 'p-other' }]} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(first.dispose).toHaveBeenCalled());
  });

  /**
   * The reason the registry exists. `useRollup` runs inside every Home widget,
   * so N widgets on one board must still mean ONE vault open and one decrypted
   * document set — not N of them, each with its own lifetime to revoke.
   */
  it('opens the vault once for many simultaneous consumers and disposes it once', async () => {
    const batch = batchFor(VAULTED.id);
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const view = render(
      <QueryClientProvider client={client}>
        <Probe portfolios={[PLAIN, VAULTED]} />
        <Probe portfolios={[PLAIN, VAULTED]} />
        <Probe portfolios={[PLAIN, VAULTED]} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getAllByTestId('unlocked')[0]).toHaveTextContent('p-vaulted'),
    );
    expect(screen.getAllByTestId('unlocked')).toHaveLength(3);
    for (const probe of screen.getAllByTestId('unlocked')) {
      expect(probe).toHaveTextContent('p-vaulted');
    }
    expect(mocks.resolveVaultedPortfolioStores).toHaveBeenCalledTimes(1);
    expect(mocks.listVaults).toHaveBeenCalledTimes(1);

    view.unmount();

    expect(batch.dispose).toHaveBeenCalledTimes(1);
  });
});
