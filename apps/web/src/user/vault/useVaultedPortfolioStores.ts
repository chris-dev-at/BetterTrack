import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { PortfolioSummary } from '@bettertrack/contracts';

import { useOptionalAuth } from '../AuthContext';
import { isVaultedPortfolio } from '../portfolio/lockedPortfolio';
import type { UnlockedVaultPortfolioAccess } from './resolvedPortfolioStore';
import type { VaultedPortfolioStoresBatch } from './vaultedPortfolioStores';

/**
 * The one seam production surfaces use to ask "can this device read that
 * vaulted portfolio right now?" (PARANOID-E6 residual, #1416).
 *
 * DELIBERATELY LIGHT. Everything imported statically here is already in the
 * app's main graph; the resolver, the keystore and the client money engine
 * arrive through a dynamic import that only fires once the account actually
 * holds a vaulted portfolio. A normal account keeps loading exactly the API
 * portfolio adapter it loads today, and issues not one extra request.
 *
 * ONE RESOLUTION PER ROSTER, NOT PER CALLER. The registry below is module-level
 * and reference-counted because the alternative is genuinely bad: `useRollup`
 * runs inside every Home widget, so a per-hook resolution would open the vault,
 * fetch its documents and decrypt them once per widget on the board — the same
 * plaintext, materialized N times, each with its own lifetime to revoke.
 *
 * FAIL-CLOSED. No account, no vault configs, a rejected chunk load, a resolver
 * error, a locked vault — every one lands on the same empty map, which is
 * precisely today's behaviour: the stub, the locked qualifier, no server money
 * read. This hook can only ever ADD readability, never remove a guard.
 */

export interface VaultedPortfolioStores {
  /** Vaulted portfolios unlocked on this device, by portfolio id. */
  unlocked: ReadonlyMap<string, UnlockedVaultPortfolioAccess>;
}

const NO_UNLOCKED_PORTFOLIOS: VaultedPortfolioStores = { unlocked: new Map() };

interface RegistryEntry {
  refs: number;
  /** Stable snapshot identity — `useSyncExternalStore` compares by reference. */
  stores: VaultedPortfolioStores;
  batch: VaultedPortfolioStoresBatch | null;
  listeners: Set<() => void>;
  abort: AbortController;
  releaseKeystoreListeners: (() => void) | null;
  released: boolean;
  /**
   * True while a resolution is running. The vault-opened edge fires from inside
   * `openStoredVault`, i.e. from inside OUR OWN resolution — reacting to that
   * would re-resolve forever. Only an unlock that happens while we are idle is
   * news.
   */
  resolving: boolean;
}

const registry = new Map<string, RegistryEntry>();

export function useVaultedPortfolioStores(
  portfolios: readonly PortfolioSummary[],
): VaultedPortfolioStores {
  // OPTIONAL auth: this hook sits under `useRollup`, which every Home widget
  // reaches. Throwing outside an `AuthProvider` would turn "no account context
  // here" into a crashed widget board; the honest answer is that without an
  // authenticated account there is no vault to open.
  const auth = useOptionalAuth();
  const accountId = auth?.status === 'authenticated' ? (auth.user?.id ?? null) : null;

  /**
   * Identity of the ROSTER, not of the array.
   *
   * Every portfolio is in it, plain ones included: the loader's in-flight
   * roster tolerance (#1528 F1) is derived from which ids are currently PLAIN,
   * so two callers holding different plain sets must not share one resolution.
   * And it is a string because `useQueries`-style callers hand back a fresh
   * array on every render — keying on identity would re-open the vault
   * continuously.
   */
  const rosterKey = useMemo(
    () =>
      portfolios
        .map((portfolio) => `${portfolio.id}:${portfolio.vaultId ?? ''}`)
        .sort()
        .join('|'),
    [portfolios],
  );
  const hasVaulted = portfolios.some(isVaultedPortfolio);
  const token = accountId === null || !hasVaulted ? null : `${accountId}#${rosterKey}`;

  // The roster this token stands for, held in a ref rather than a dependency.
  // `token` already encodes every field of it the resolution depends on, while
  // the ARRAY's identity changes on every render of a `useQueries`-style
  // caller — depending on that would re-open the vault continuously.
  const latestRoster = useRef(portfolios);
  latestRoster.current = portfolios;

  useEffect(() => {
    if (token === null || accountId === null) return;
    acquire(token, accountId, latestRoster.current);
    return () => release(token);
  }, [accountId, token]);

  return useSyncExternalStore(
    useCallback(
      (onChange: () => void) => (token === null ? () => {} : subscribe(token, onChange)),
      [token],
    ),
    useCallback(() => (token === null ? NO_UNLOCKED_PORTFOLIOS : snapshot(token)), [token]),
  );
}

function snapshot(token: string): VaultedPortfolioStores {
  return registry.get(token)?.stores ?? NO_UNLOCKED_PORTFOLIOS;
}

function subscribe(token: string, onChange: () => void): () => void {
  const entry = registry.get(token);
  if (entry === undefined) {
    // Subscribed before the acquiring effect ran (React subscribes during
    // commit, effects run after). A placeholder keeps the listener attached to
    // the same entry the loader will fill in.
    registry.set(token, placeholderEntry());
  }
  const target = registry.get(token)!;
  target.listeners.add(onChange);
  return () => {
    target.listeners.delete(onChange);
  };
}

function placeholderEntry(): RegistryEntry {
  return {
    refs: 0,
    stores: NO_UNLOCKED_PORTFOLIOS,
    batch: null,
    listeners: new Set(),
    abort: new AbortController(),
    releaseKeystoreListeners: null,
    released: false,
    resolving: false,
  };
}

function publish(entry: RegistryEntry, stores: VaultedPortfolioStores): void {
  entry.stores = stores;
  for (const listener of [...entry.listeners]) listener();
}

function acquire(token: string, accountId: string, portfolios: readonly PortfolioSummary[]): void {
  const existing = registry.get(token);
  if (existing !== undefined && existing.refs > 0) {
    existing.refs += 1;
    return;
  }
  const entry = existing ?? placeholderEntry();
  entry.refs += 1;
  entry.released = false;
  registry.set(token, entry);

  void load(entry, accountId, portfolios);
}

async function load(
  entry: RegistryEntry,
  accountId: string,
  portfolios: readonly PortfolioSummary[],
): Promise<void> {
  entry.resolving = true;
  try {
    const { listVaults } = await import('../../lib/vaultApi');
    const { resolveVaultedPortfolioStores, sessionEndSubscription, vaultOpenedSubscription } =
      await import('./vaultedPortfolioStores');
    if (entry.released) return;
    if (entry.releaseKeystoreListeners === null) {
      // Armed BEFORE the resolution, so a lock landing while documents are in
      // flight still drops the batch this loader is about to publish.
      const releaseSessionEnd = sessionEndSubscription(() => {
        entry.batch?.dispose();
        entry.batch = null;
        publish(entry, NO_UNLOCKED_PORTFOLIOS);
      });
      const releaseVaultOpened = vaultOpenedSubscription(() => {
        // Our own `openStoredVault` fires this too; only an unlock that lands
        // while this entry is idle means something new can be read.
        if (entry.released || entry.resolving) return;
        entry.batch?.dispose();
        entry.batch = null;
        void load(entry, accountId, portfolios);
      });
      entry.releaseKeystoreListeners = () => {
        releaseSessionEnd();
        releaseVaultOpened();
      };
    }
    const vaults = await listVaults(entry.abort.signal);
    if (entry.released) return;
    const batch = await resolveVaultedPortfolioStores({
      accountId,
      portfolios,
      vaults,
      signal: entry.abort.signal,
    });
    if (entry.released) {
      batch.dispose();
      return;
    }
    entry.batch?.dispose();
    entry.batch = batch;
    publish(entry, { unlocked: batch.unlocked });
  } catch {
    // Fail closed to the stub. Nothing here is worth a console line: a locked
    // vault, a cancelled navigation and a failed chunk load all produce the
    // same, already-correct, screen.
    if (!entry.released) publish(entry, NO_UNLOCKED_PORTFOLIOS);
  } finally {
    entry.resolving = false;
  }
}

function release(token: string): void {
  const entry = registry.get(token);
  if (entry === undefined) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.released = true;
  entry.abort.abort();
  entry.releaseKeystoreListeners?.();
  entry.releaseKeystoreListeners = null;
  entry.batch?.dispose();
  entry.batch = null;
  entry.stores = NO_UNLOCKED_PORTFOLIOS;
  // Only drop the entry when nothing is still listening, so a subscriber that
  // outlives the last acquirer keeps reading the same (now empty) snapshot.
  if (entry.listeners.size === 0) registry.delete(token);
}

/** Test-only reset; production has exactly one registry for the tab's lifetime. */
export function resetVaultedPortfolioStoreRegistry(): void {
  for (const token of [...registry.keys()]) {
    const entry = registry.get(token)!;
    entry.released = true;
    entry.abort.abort();
    entry.releaseKeystoreListeners?.();
    entry.batch?.dispose();
    registry.delete(token);
  }
}
