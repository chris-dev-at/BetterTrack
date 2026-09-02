import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
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
const VAULT_ID_B = '018f0000-0000-7000-8000-000000000703';
const FOREIGN_VAULT_ID = '018f0000-0000-7000-8000-000000000704';

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
const VAULTED_B: PortfolioSummary = { ...PLAIN, id: 'p-vaulted-b', vaultId: VAULT_ID_B };

function Probe({ portfolios }: { portfolios: PortfolioSummary[] }) {
  const { unlocked } = useVaultedPortfolioStores(portfolios);
  return <span data-testid="unlocked">{[...unlocked.keys()].join(',') || 'none'}</span>;
}

function renderProbe(portfolios: PortfolioSummary[]) {
  return renderProbeWithClient(portfolios).view;
}

/** Same tree, with the cache handed back so a test can look inside it. */
function renderProbeWithClient(portfolios: PortfolioSummary[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Probe portfolios={portfolios} />
    </QueryClientProvider>,
  );
  return { view, client };
}

function batchFor(portfolioId: string) {
  return {
    unlocked: new Map([[portfolioId, { portfolioId, vaultId: VAULT_ID } as never]]),
    dispose: vi.fn(),
  };
}

function batchOf(...portfolioIds: readonly string[]) {
  return {
    unlocked: new Map(portfolioIds.map((id) => [id, { portfolioId: id } as never])),
    dispose: vi.fn(),
  };
}

function emptyBatch() {
  return { unlocked: new Map<string, never>(), dispose: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetVaultedPortfolioStoreRegistry();
  mocks.useOptionalAuth.mockReturnValue({ status: 'authenticated', user: { id: ACCOUNT_ID } });
  // SIGNAL-AWARE ON PURPOSE. `listVaults` is the first call in the loader that
  // carries the registry entry's abort signal, and the real one is `fetch`:
  // handed an already-aborted signal it REJECTS, it does not resolve. A plain
  // `mockResolvedValue` here models a `listVaults` that cannot fail that way,
  // and that is exactly how the shipped suite stayed green while every remount
  // re-used a permanently-aborted controller and failed closed forever.
  mocks.listVaults.mockImplementation(async (signal?: AbortSignal) => {
    if (signal?.aborted === true) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The vault list request was aborted.', 'AbortError');
    }
    return [{ id: VAULT_ID, keyFingerprint: 'TESTVECTOR000000' }];
  });
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

  it('sweeps the DERIVED plaintext out of the query cache when the session ends', async () => {
    // Disposing the batch releases the decrypted DOCUMENTS. Every figure
    // already derived from them has been copied into React Query — the
    // portfolio response, its history, Home's `readTotals` — and those entries
    // outlive the lock by `gcTime`, servable to the next mount while the vault
    // itself is correctly closed. The account-level v1 stack always swept on
    // its lock; the per-portfolio model had no equivalent.
    const batch = batchFor(VAULTED.id);
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batch);
    let endSession = () => {};
    mocks.sessionEndSubscription.mockImplementation((listener: () => void) => {
      endSession = listener;
      return () => {};
    });

    const { client } = renderProbeWithClient([PLAIN, VAULTED]);
    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));

    // Exactly the shapes this lane's two keyspaces produce, plus one entry that
    // must SURVIVE: the sweep has to be precise, not merely thorough.
    const holdings = { holdings: [{ symbol: 'MSFT', quantity: 5 }] };
    client.setQueryData(['portfolio', VAULTED.id, { vaultAccess: 'vault-access-1' }], holdings);
    client.setQueryData(['portfolio', VAULTED.id, 'vaulted-unlocked', 'vault-access-1'], {
      totals: { totalValueEur: 4147.19 },
      snapshotId: 's1',
    });
    client.setQueryData(['vaults', 'configs'], [{ id: VAULT_ID, name: 'Private Holdings' }]);

    act(() => endSession());

    expect(
      client.getQueryData(['portfolio', VAULTED.id, { vaultAccess: 'vault-access-1' }]),
    ).toBeUndefined();
    expect(
      client.getQueryData(['portfolio', VAULTED.id, 'vaulted-unlocked', 'vault-access-1']),
    ).toBeUndefined();
    // Nothing anywhere in the cache still holds a decrypted figure.
    const surviving = client
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.state.data ?? null));
    expect(surviving.filter((data) => data.includes('MSFT') || data.includes('4147.19'))).toEqual(
      [],
    );
    // The vault DIRECTORY is cleartext by design (§21 Q4) and is what the
    // locked stub routes by — sweeping it would blank the manager on every lock.
    expect(client.getQueryData(['vaults', 'configs'])).toBeDefined();
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
    let vaultOpened = (_vaultId: string) => {};
    mocks.vaultOpenedSubscription.mockImplementation((listener: (vaultId: string) => void) => {
      vaultOpened = listener;
      return () => {};
    });

    renderProbe([PLAIN, VAULTED]);
    await waitFor(() => expect(mocks.resolveVaultedPortfolioStores).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('unlocked')).toHaveTextContent('none');

    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));
    await act(async () => {
      vaultOpened(VAULT_ID);
    });

    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));
  });

  it('ignores the vault-opened edge raised by its own in-flight resolution', async () => {
    let vaultOpened = (_vaultId: string) => {};
    mocks.vaultOpenedSubscription.mockImplementation((listener: (vaultId: string) => void) => {
      vaultOpened = listener;
      return () => {};
    });
    // The resolver opens the vault, which fires the edge from INSIDE the
    // resolution. Reacting to it would restart the resolution forever.
    mocks.resolveVaultedPortfolioStores.mockImplementation(async () => {
      vaultOpened(VAULT_ID);
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

  /**
   * THE REGISTRY MUST SURVIVE A SECOND MOUNT (#1531 F1).
   *
   * `release()` aborts the entry's controller but deliberately KEEPS the entry
   * while a listener is still attached — and the acquiring effect is registered
   * before `useSyncExternalStore`'s subscription, so its cleanup always runs
   * first and that "still attached" case is the NORMAL one, not an exotic race.
   * A second `acquire()` on that entry must not reuse the dead signal: it makes
   * the very first awaited call reject, and the feature fails closed for the
   * rest of the tab's life. Under StrictMode that is every dev session; in
   * production it is any Home → Portfolio → Home round trip.
   *
   * The three probes below are the three shapes that reach it.
   */
  it('resolves under StrictMode, whose simulated remount re-acquires the same entry', async () => {
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <Probe portfolios={[PLAIN, VAULTED]} />
        </QueryClientProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));
  });

  /**
   * The leak behind the same lifecycle (#1531 F4). `release` runs first and
   * deliberately keeps the entry while a listener is still attached, so without
   * the re-check on the unsubscribe side every roster token the account ever
   * mounted stays in the module-level registry for the tab's lifetime. Nothing
   * secret survives in one — `release` disposed the batch and dropped the
   * keystore listeners — but "bounded" is a claim that has to be tested, and an
   * empty dead entry has no other symptom than still being there.
   */
  it('leaves no registry entry behind once the last consumer unmounts', async () => {
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));

    const view = renderProbe([PLAIN, VAULTED]);
    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));
    view.unmount();

    expect(resetVaultedPortfolioStoreRegistry()).toBe(0);
  });

  it('resolves again after an unmount and remount of the same roster', async () => {
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));

    const first = renderProbe([PLAIN, VAULTED]);
    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));
    first.unmount();

    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));
    renderProbe([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));
  });

  it('resolves a roster it already released, after switching away and back', async () => {
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <Probe portfolios={[PLAIN, VAULTED]} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));

    // T1 → T2: the T1 entry is released and its controller aborted.
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor('p-other'));
    view.rerender(
      <QueryClientProvider client={client}>
        <Probe portfolios={[PLAIN, { ...VAULTED, id: 'p-other' }]} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-other'));

    // T2 → T1: back to the roster whose controller is already aborted.
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));
    view.rerender(
      <QueryClientProvider client={client}>
        <Probe portfolios={[PLAIN, VAULTED]} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));
  });

  /**
   * The other half of the vault-opened edge (#1531 F2). The own-resolution case
   * above is ignored because our `openStoredVault` raises the same signal — but
   * an unlock that lands while a resolution that opened NOTHING is in flight is
   * genuinely new, and dropping it left the portfolio a stub until a reload.
   */
  it('re-resolves an unlock that lands while the first resolution is still running', async () => {
    let vaultOpened = (_vaultId: string) => {};
    mocks.vaultOpenedSubscription.mockImplementation((listener: (vaultId: string) => void) => {
      vaultOpened = listener;
      return () => {};
    });
    const locked = emptyBatch();
    // Resolution #1 finds the vault LOCKED (empty batch). The user unlocks
    // while it is still running, i.e. strictly inside `entry.resolving`.
    mocks.resolveVaultedPortfolioStores.mockImplementationOnce(async () => {
      vaultOpened(VAULT_ID);
      return locked;
    });
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));

    renderProbe([PLAIN, VAULTED]);

    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));
    expect(mocks.resolveVaultedPortfolioStores).toHaveBeenCalledTimes(2);
    expect(locked.dispose).toHaveBeenCalled();
  });

  /**
   * THE SECOND VAULT'S EDGE (#1533).
   *
   * Judging a mid-resolution edge by the RUN's outcome — "opened nothing and
   * still saw one" — could only ever describe one vault. The re-run that opens
   * the first vault publishes a non-empty batch, so a second vault unlocked
   * inside that window looked exactly like the re-run's own open and was
   * dropped: its portfolios stayed stubs until the next remount. The vault id
   * on the edge is what tells the two apart.
   */
  it('renders both vaults when a second one is unlocked during the re-run window', async () => {
    let vaultOpened = (_vaultId: string) => {};
    mocks.vaultOpenedSubscription.mockImplementation((listener: (vaultId: string) => void) => {
      vaultOpened = listener;
      return () => {};
    });
    mocks.listVaults.mockImplementation(async () => [
      { id: VAULT_ID, keyFingerprint: 'TESTVECTOR000000' },
      { id: VAULT_ID_B, keyFingerprint: 'TESTVECTOR000001' },
    ]);
    const locked = emptyBatch();
    // #1: both vaults locked; the user unlocks A while documents are in flight.
    mocks.resolveVaultedPortfolioStores.mockImplementationOnce(async () => {
      vaultOpened(VAULT_ID);
      return locked;
    });
    // #2: the re-run opens A — and the user unlocks B while IT is in flight.
    mocks.resolveVaultedPortfolioStores.mockImplementationOnce(async () => {
      vaultOpened(VAULT_ID_B);
      return batchOf(VAULTED.id);
    });
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchOf(VAULTED.id, VAULTED_B.id));

    renderProbe([PLAIN, VAULTED, VAULTED_B]);

    await waitFor(() =>
      expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted,p-vaulted-b'),
    );
    expect(mocks.resolveVaultedPortfolioStores).toHaveBeenCalledTimes(3);
  });

  /**
   * The other half of the id: an open this roster has no portfolio in cannot
   * change this snapshot, so it must not cost a resolution — decrypting the
   * same document set again for a vault nobody here reads.
   */
  it('ignores a vault-opened edge for a vault outside its roster', async () => {
    let vaultOpened = (_vaultId: string) => {};
    mocks.vaultOpenedSubscription.mockImplementation((listener: (vaultId: string) => void) => {
      vaultOpened = listener;
      return () => {};
    });
    mocks.resolveVaultedPortfolioStores.mockResolvedValue(batchFor(VAULTED.id));

    renderProbe([PLAIN, VAULTED]);
    await waitFor(() => expect(screen.getByTestId('unlocked')).toHaveTextContent('p-vaulted'));

    await act(async () => {
      vaultOpened(FOREIGN_VAULT_ID);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mocks.resolveVaultedPortfolioStores).toHaveBeenCalledTimes(1);
  });
});
