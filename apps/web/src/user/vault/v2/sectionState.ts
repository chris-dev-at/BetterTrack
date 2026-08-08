import type { VaultBackends, VaultHeaderDoc, Vault } from '@bettertrack/contracts';

/**
 * The state machine behind the always-visible "Vault / Paranoid mode" section on
 * EVERY portfolio's settings page (`docs/VAULTS_V2_DESIGN.md` §4 — the owner's
 * discoverability order).
 *
 * It is a pure projection of four inputs so the section's behaviour is testable
 * without rendering, and so every surface that needs the same answer (the
 * section, the locked-row merge, the Control-Center pointer) derives it the
 * same way.
 */

export interface VaultKnowledge {
  /** The vault as the server lists it. */
  summary: Vault;
  /**
   * Its header doc, once fetched. `null` while unfetched or unreadable — the
   * section still renders, it just cannot show the alias or the key state.
   */
  header: VaultHeaderDoc | null;
  /** True when this browser currently holds the vault's content key. */
  unlocked: boolean;
  /** True when this device has the passphrase stored (wrapped or raw). */
  rememberedOnDevice: boolean;
}

export interface VaultSectionInput {
  portfolioId: string;
  /** `loading` until the vault list has resolved at least once. */
  status: 'loading' | 'ready' | 'error';
  vaults: VaultKnowledge[];
  /**
   * The account still runs the v1 account-level paranoid mode and has not been
   * migrated. Every portfolio is inside the legacy vault, so the per-portfolio
   * choice is not offered until migration runs.
   */
  legacyParanoid: boolean;
}

export type VaultSectionState =
  | { kind: 'loading' }
  | { kind: 'error' }
  /** Legacy account-level paranoid: point at the one-time migration. */
  | { kind: 'legacy' }
  /** No vault exists yet: explainer teaser + "Create a vault". */
  | { kind: 'no-vaults' }
  /** Vaults exist and this portfolio is a normal server portfolio. */
  | { kind: 'joinable'; choices: VaultChoice[] }
  /** This portfolio lives in a vault whose key this browser does not hold. */
  | {
      kind: 'vaulted-locked';
      vaultId: string;
      vaultName: string;
      alias: string | null;
      backends: VaultBackends;
      rememberedOnDevice: boolean;
    }
  /** This portfolio lives in a vault this browser has unlocked. */
  | {
      kind: 'vaulted-unlocked';
      vaultId: string;
      vaultName: string;
      alias: string | null;
      backends: VaultBackends;
      rememberedOnDevice: boolean;
    };

export interface VaultChoice {
  vaultId: string;
  name: string;
  backends: VaultBackends;
  /** Vault membership is only provable with the key, so joining needs it. */
  unlocked: boolean;
}

/**
 * Decide which portfolio a vault owns from BOTH sources and prefer the header.
 *
 * The server's `portfolioIds` is authoritative for "is this portfolio vaulted"
 * (it holds the `portfolios.vaultId` FK), while the header's index is
 * authoritative for the alias — and, once the header seal verifies, is the copy
 * an attacker cannot edit. Taking the union means a portfolio is never rendered
 * as a normal, joinable portfolio just because one of the two sources lags.
 */
export function vaultOwnsPortfolio(knowledge: VaultKnowledge, portfolioId: string): boolean {
  if (knowledge.summary.portfolioIds.includes(portfolioId)) return true;
  return knowledge.header?.portfolios.some((entry) => entry.portfolioId === portfolioId) ?? false;
}

export function aliasForPortfolio(knowledge: VaultKnowledge, portfolioId: string): string | null {
  return (
    knowledge.header?.portfolios.find((entry) => entry.portfolioId === portfolioId)?.alias ?? null
  );
}

export function resolveVaultSectionState(input: VaultSectionInput): VaultSectionState {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error' };
  if (input.legacyParanoid) return { kind: 'legacy' };

  const owner = input.vaults.find((vault) => vaultOwnsPortfolio(vault, input.portfolioId));
  if (owner != null) {
    const shared = {
      vaultId: owner.summary.id,
      vaultName: owner.summary.name,
      alias: aliasForPortfolio(owner, input.portfolioId),
      backends: owner.summary.backends,
      rememberedOnDevice: owner.rememberedOnDevice,
    };
    return owner.unlocked
      ? { kind: 'vaulted-unlocked', ...shared }
      : { kind: 'vaulted-locked', ...shared };
  }

  if (input.vaults.length === 0) return { kind: 'no-vaults' };

  return {
    kind: 'joinable',
    choices: input.vaults.map((vault) => ({
      vaultId: vault.summary.id,
      name: vault.summary.name,
      backends: vault.summary.backends,
      unlocked: vault.unlocked,
    })),
  };
}

// ── Locked rows on money surfaces (§4) ───────────────────────────────────────

export interface LockedPortfolioRow {
  portfolioId: string;
  vaultId: string;
  vaultName: string;
  /** What the row shows instead of the portfolio name. */
  alias: string;
  locked: boolean;
  /**
   * r2 §8: the header index names this portfolio but its blob could not be
   * fetched or decrypted. It renders as a distinct error state — **never as
   * empty and never as €0** — while the rest of the vault stays usable.
   */
  unavailable: boolean;
}

/**
 * Project the vault knowledge into the locked rows every money surface renders
 * (dashboard, portfolio list, analytics pickers).
 *
 * This deliberately derives from the vault headers rather than from a new
 * `portfolios.vaultId` field on `portfolioSummarySchema`: the header index
 * already carries `portfolioId + alias`, it is the copy the seal authenticates,
 * and it means the web PR adds nothing to the shared portfolio contract that
 * the parallel server PR would have to reconcile.
 *
 * A vaulted portfolio the server omits from `GET /portfolios` entirely still
 * produces a row here, so purging cleartext rows can never make a portfolio
 * silently vanish from the user's own dashboard.
 */
export function lockedPortfolioRows(
  vaults: VaultKnowledge[],
  unavailablePortfolioIds: readonly string[] = [],
): LockedPortfolioRow[] {
  const unavailable = new Set(unavailablePortfolioIds);
  const rows = new Map<string, LockedPortfolioRow>();
  for (const vault of vaults) {
    const fromHeader = vault.header?.portfolios ?? [];
    for (const entry of fromHeader) {
      rows.set(entry.portfolioId, {
        portfolioId: entry.portfolioId,
        vaultId: vault.summary.id,
        vaultName: vault.summary.name,
        alias: entry.alias,
        locked: !vault.unlocked,
        unavailable: unavailable.has(entry.portfolioId),
      });
    }
    // Server-known members with no header entry yet (header not fetched, or a
    // join whose header revision has not landed) still render, aliased by the
    // vault so the row is never nameless.
    for (const portfolioId of vault.summary.portfolioIds) {
      if (rows.has(portfolioId)) continue;
      rows.set(portfolioId, {
        portfolioId,
        vaultId: vault.summary.id,
        vaultName: vault.summary.name,
        alias: vault.summary.name,
        locked: !vault.unlocked,
        unavailable: unavailable.has(portfolioId),
      });
    }
  }
  return [...rows.values()];
}

/** Index the rows for O(1) lookup from a list renderer. */
export function lockedPortfolioIndex(
  vaults: VaultKnowledge[],
  unavailablePortfolioIds: readonly string[] = [],
): ReadonlyMap<string, LockedPortfolioRow> {
  return new Map(
    lockedPortfolioRows(vaults, unavailablePortfolioIds).map((row) => [row.portfolioId, row]),
  );
}
