import {
  vaultDocMaxBytes,
  type VaultBackends,
  type VaultPortfolioRestoreDocument,
} from '@bettertrack/contracts';
import { and, asc, count, eq, isNotNull, sql } from 'drizzle-orm';

import { createParanoidRehydrationSourceRepository } from './paranoidRehydrationRepository';
import { hasVaultPortfolioCleartextRows, purgeVaultPortfolioRows } from './vaultPortfolioPurge';
import type { Database } from '../db';
import {
  mirrorChainMembers,
  portfolios,
  vaultDocs,
  vaultLeaveReceipts,
  vaults,
  type VaultDocRow,
  type VaultRow,
} from '../schema';

/**
 * Vaults v2 persistence (`docs/VAULTS_V2_DESIGN.md` §3).
 *
 * OWNERSHIP SCOPING LIVES HERE, not in controllers (§10): every method takes the
 * acting `userId` and every statement joins or filters on `vaults.user_id` /
 * `portfolios.user_id`. A caller can therefore never address another account's
 * vault by guessing an id — the row simply does not resolve, and the service
 * turns that into the same `VAULT_NOT_FOUND` a genuinely missing id produces.
 *
 * The server is BLIND: `ciphertext` is stored, size-capped and CAS-versioned,
 * never decoded. Unlike the account-level vault there is no header inspection at
 * all here, because a v2 header is a client-format document the server has no
 * stake in.
 */

export type VaultDocSelector =
  | { kind: 'header' }
  | { kind: 'common' }
  | { kind: 'portfolio'; portfolioId: string };

export interface VaultWithCount extends VaultRow {
  portfolioCount: number;
  /** Membership, exposed to the owning account's clients only (r2 §15). */
  portfolioIds: string[];
}

export type VaultDocMetaRow = Omit<VaultDocRow, 'ciphertext'>;

export type VaultCasResult =
  | { status: 'ok'; doc: VaultDocMetaRow }
  | { status: 'precondition_failed'; currentVersion: number | null }
  | { status: 'vault_not_found' }
  | { status: 'doc_not_found' }
  | { status: 'server_backend_inactive' }
  | { status: 'too_large'; sizeBytes: number; maxBytes: number };

export type VaultDeleteResult =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'not_empty'; portfolioCount: number };

export type VaultUpdateResult =
  | { status: 'ok'; vault: VaultWithCount }
  | { status: 'not_found' }
  | { status: 'name_taken' };

export type VaultCreateResult =
  | { status: 'ok'; vault: VaultWithCount; header: VaultDocMetaRow | null }
  | { status: 'name_taken' }
  /** A client-minted id already exists (possibly on ANOTHER account — see below). */
  | { status: 'id_taken' }
  | { status: 'too_large'; sizeBytes: number; maxBytes: number };

export type VaultJoinResult =
  | { status: 'ok'; vault: VaultRow; blob: VaultDocMetaRow }
  | { status: 'vault_not_found' }
  | { status: 'portfolio_not_found' }
  | { status: 'already_vaulted' }
  | { status: 'blocked'; reason: string }
  | { status: 'too_large'; sizeBytes: number; maxBytes: number };

export type PortfolioAliasResult =
  | { status: 'ok' }
  | { status: 'portfolio_not_found' }
  /** The portfolio is not in a vault — its rename stays on the normal route. */
  | { status: 'not_vaulted' };

export type VaultLeaveResult =
  | { status: 'ok'; idempotent: boolean }
  | { status: 'portfolio_not_found' }
  | { status: 'not_vaulted' }
  | { status: 'restore_invalid'; reason: string };

/** Postgres unique-violation, used to turn a create race into a clean 409. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '23505';
}

/**
 * Which uniqueness lost. The primary key means a client-minted id collided; any
 * other unique index on `vaults` is the per-owner name. Read from the driver's
 * `constraint`/`constraint_name` field, with a message fallback for drivers that
 * do not populate it (the PGlite test harness among them).
 */
function violatedVaultPrimaryKey(error: unknown): boolean {
  const err = error as { constraint?: unknown; constraint_name?: unknown; message?: unknown };
  const constraint =
    (typeof err?.constraint === 'string' && err.constraint) ||
    (typeof err?.constraint_name === 'string' && err.constraint_name) ||
    '';
  if (constraint) return constraint === 'vaults_pkey';
  return typeof err?.message === 'string' && err.message.includes('vaults_pkey');
}

function metaOf(row: VaultDocRow | VaultDocMetaRow): VaultDocMetaRow {
  const { ciphertext: _ciphertext, ...meta } = row as VaultDocRow;
  return meta;
}

function docWhere(vaultId: string, selector: VaultDocSelector) {
  return selector.kind === 'portfolio'
    ? and(
        eq(vaultDocs.vaultId, vaultId),
        eq(vaultDocs.docKind, 'portfolio'),
        eq(vaultDocs.portfolioId, selector.portfolioId),
      )
    : and(eq(vaultDocs.vaultId, vaultId), eq(vaultDocs.docKind, selector.kind));
}

function usesServerBackend(backends: VaultBackends): boolean {
  return backends === 'server' || backends === 'both';
}

export interface VaultRepository {
  listVaults(userId: string): Promise<VaultWithCount[]>;
  findVault(userId: string, vaultId: string): Promise<VaultWithCount | null>;
  createVault(input: {
    userId: string;
    /** Client-minted id (r2 §11 derives it); omitted lets the database mint one. */
    id?: string;
    name: string;
    backends: VaultBackends;
    header: Buffer | null;
  }): Promise<VaultCreateResult>;
  updateVault(input: {
    userId: string;
    vaultId: string;
    name?: string;
    backends?: VaultBackends;
  }): Promise<VaultUpdateResult>;
  deleteVault(userId: string, vaultId: string): Promise<VaultDeleteResult>;
  readDoc(
    userId: string,
    vaultId: string,
    selector: VaultDocSelector,
  ): Promise<
    { status: 'ok'; row: VaultDocRow } | { status: 'vault_not_found' } | { status: 'doc_not_found' }
  >;
  writeDoc(input: {
    userId: string;
    vaultId: string;
    selector: VaultDocSelector;
    expectedVersion: number | null;
    ciphertext: Buffer;
  }): Promise<VaultCasResult>;
  joinPortfolio(input: {
    userId: string;
    portfolioId: string;
    vaultId: string;
    ciphertext: Buffer;
    /** Injected failure point — the both-or-neither regression test's seam. */
    afterPurge?: () => Promise<void>;
  }): Promise<VaultJoinResult>;
  leavePortfolio(input: {
    userId: string;
    portfolioId: string;
    /** Client-supplied idempotency key; persisted so a replay stays tellable. */
    restoreId: string;
    document: VaultPortfolioRestoreDocument;
    afterRestore?: () => Promise<void>;
  }): Promise<VaultLeaveResult>;
  portfolioVaultState(
    userId: string,
    portfolioId: string,
  ): Promise<{ portfolioId: string; alias: string | null; vault: VaultRow | null } | null>;
  /**
   * Owner-scoped membership probe for the HTTP kill rail. A portfolio the
   * caller does not own answers `false`, never `true` — the guard must not
   * become a membership oracle for foreign ids.
   */
  isPortfolioVaulted(userId: string, portfolioId: string): Promise<boolean>;
  /**
   * Set the cleartext display alias of a VAULTED portfolio (§4). The
   * `vault_id IS NOT NULL` predicate is part of the UPDATE, not a prior read, so
   * a portfolio that leaves its vault concurrently cannot have an alias written
   * onto it — the statement simply matches nothing and the caller gets the same
   * refusal a normal portfolio gets.
   */
  setPortfolioAlias(
    userId: string,
    portfolioId: string,
    alias: string | null,
  ): Promise<PortfolioAliasResult>;
}

export function createVaultRepository(db: Database): VaultRepository {
  /**
   * `vaults` rows of one owner, with the live membership count beside each.
   * The owner predicate is baked in here rather than passed by callers — that
   * is what keeps ownership scoping a property of the repository (§10) instead
   * of something each call site has to remember.
   */
  const selectWithCount = (userId: string, vaultId?: string) =>
    db
      .select({
        id: vaults.id,
        userId: vaults.userId,
        name: vaults.name,
        backends: vaults.backends,
        createdAt: vaults.createdAt,
        updatedAt: vaults.updatedAt,
        portfolioCount: sql<number>`(
          select count(*) from ${portfolios} where ${portfolios.vaultId} = ${vaults.id}
        )`.mapWith(Number),
      })
      .from(vaults)
      .where(
        vaultId === undefined
          ? eq(vaults.userId, userId)
          : and(eq(vaults.userId, userId), eq(vaults.id, vaultId)),
      );

  /**
   * r2 §15 exposes vault MEMBERSHIP to the owning account's clients. Resolved in
   * a second owner-scoped query rather than a correlated `array_agg`, because
   * the aggregate's array decoding differs between the production driver and the
   * PGlite test harness — and a membership list that is silently empty in one of
   * them is exactly the kind of drift a sync client would follow off a cliff.
   */
  const membership = async (userId: string): Promise<Map<string, string[]>> => {
    const rows = await db
      .select({ vaultId: portfolios.vaultId, id: portfolios.id })
      .from(portfolios)
      .innerJoin(vaults, eq(vaults.id, portfolios.vaultId))
      .where(eq(vaults.userId, userId))
      .orderBy(asc(portfolios.id));
    const byVault = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.vaultId) continue;
      byVault.set(row.vaultId, [...(byVault.get(row.vaultId) ?? []), row.id]);
    }
    return byVault;
  };

  const withMembership = async (userId: string, rows: Omit<VaultWithCount, 'portfolioIds'>[]) => {
    const byVault = await membership(userId);
    return rows.map((row) => ({ ...row, portfolioIds: byVault.get(row.id) ?? [] }));
  };

  return {
    async listVaults(userId) {
      const rows = await selectWithCount(userId).orderBy(asc(vaults.createdAt), asc(vaults.id));
      return withMembership(userId, rows);
    },

    async findVault(userId, vaultId) {
      const [row] = await selectWithCount(userId, vaultId);
      if (!row) return null;
      const [enriched] = await withMembership(userId, [row]);
      return enriched ?? null;
    },

    async createVault({ userId, id, name, backends, header }) {
      if (header) {
        const maxBytes = vaultDocMaxBytes('header');
        if (header.length > maxBytes) {
          return { status: 'too_large', sizeBytes: header.length, maxBytes };
        }
      }
      try {
        return await db.transaction(async (tx) => {
          const [vault] = await tx
            .insert(vaults)
            // A client-minted id is global, so a collision can name ANOTHER
            // account's vault. That is answered with the same `VAULT_ID_TAKEN` as
            // an own-account collision and nothing else: revealing which of the
            // two it was would turn create into an existence oracle for ids a
            // caller can derive.
            .values({ ...(id !== undefined ? { id } : {}), userId, name, backends })
            .returning();
          if (!vault) throw new Error('vault insert returned no row');
          let headerRow: VaultDocMetaRow | null = null;
          if (header) {
            const [doc] = await tx
              .insert(vaultDocs)
              .values({
                vaultId: vault.id,
                docKind: 'header',
                portfolioId: null,
                ciphertext: header,
                sizeBytes: header.length,
                version: 1,
              })
              .returning();
            if (!doc) throw new Error('vault header insert returned no row');
            headerRow = metaOf(doc);
          }
          return {
            status: 'ok' as const,
            vault: { ...vault, portfolioCount: 0, portfolioIds: [] },
            header: headerRow,
          };
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return violatedVaultPrimaryKey(error) ? { status: 'id_taken' } : { status: 'name_taken' };
        }
        throw error;
      }
    },

    async updateVault({ userId, vaultId, name, backends }) {
      try {
        const [row] = await db
          .update(vaults)
          .set({
            ...(name !== undefined ? { name } : {}),
            ...(backends !== undefined ? { backends } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)))
          .returning();
        if (!row) return { status: 'not_found' };
        const members = await db
          .select({ id: portfolios.id })
          .from(portfolios)
          .where(eq(portfolios.vaultId, vaultId))
          .orderBy(asc(portfolios.id));
        return {
          status: 'ok',
          vault: {
            ...row,
            portfolioCount: members.length,
            portfolioIds: members.map((member) => member.id),
          },
        };
      } catch (error) {
        if (isUniqueViolation(error)) return { status: 'name_taken' };
        throw error;
      }
    },

    async deleteVault(userId, vaultId) {
      return db.transaction(async (tx) => {
        // FOR UPDATE, so a concurrent join cannot slip a portfolio into a vault
        // between the emptiness check and the delete. The FK is SET NULL, so
        // this lock IS the invariant — losing it would silently orphan a
        // portfolio whose cleartext rows are already gone.
        const [vault] = await tx
          .select({ id: vaults.id })
          .from(vaults)
          .where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)))
          .for('update');
        if (!vault) return { status: 'not_found' as const };
        const [members] = await tx
          .select({ value: count() })
          .from(portfolios)
          .where(eq(portfolios.vaultId, vaultId));
        const portfolioCount = Number(members?.value ?? 0);
        if (portfolioCount > 0) return { status: 'not_empty' as const, portfolioCount };
        // A portfolio document without a member portfolio is unreachable state,
        // but deleting on top of it would destroy ciphertext the user might
        // still hold a key for. Treat it as non-empty rather than guessing.
        const [orphans] = await tx
          .select({ value: count() })
          .from(vaultDocs)
          .where(and(eq(vaultDocs.vaultId, vaultId), eq(vaultDocs.docKind, 'portfolio')));
        if (Number(orphans?.value ?? 0) > 0) {
          return { status: 'not_empty' as const, portfolioCount: Number(orphans?.value ?? 0) };
        }
        await tx.delete(vaults).where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)));
        return { status: 'ok' as const };
      });
    },

    async readDoc(userId, vaultId, selector) {
      const [vault] = await db
        .select({ id: vaults.id, backends: vaults.backends })
        .from(vaults)
        .where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)));
      if (!vault) return { status: 'vault_not_found' };
      const [row] = await db.select().from(vaultDocs).where(docWhere(vaultId, selector));
      if (!row) return { status: 'doc_not_found' };
      return { status: 'ok', row };
    },

    async writeDoc({ userId, vaultId, selector, expectedVersion, ciphertext }) {
      const maxBytes = vaultDocMaxBytes(selector.kind);
      if (ciphertext.length > maxBytes) {
        return { status: 'too_large', sizeBytes: ciphertext.length, maxBytes };
      }
      return db.transaction(async (tx) => {
        // Lock the vault row first: this serializes every document write of one
        // vault against a concurrent delete/backend change, and it is also the
        // ownership check — a foreign vaultId resolves to nothing at all.
        const [vault] = await tx
          .select({ id: vaults.id, backends: vaults.backends })
          .from(vaults)
          .where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)))
          .for('update');
        if (!vault) return { status: 'vault_not_found' as const };
        if (!usesServerBackend(vault.backends)) {
          return { status: 'server_backend_inactive' as const };
        }
        if (selector.kind === 'portfolio') {
          // A portfolio blob may only exist for a portfolio that is IN this
          // vault. Without this a `vault:sync` bearer could mint blobs for
          // arbitrary portfolio ids and use the vault as free storage.
          const [member] = await tx
            .select({ id: portfolios.id })
            .from(portfolios)
            .where(
              and(
                eq(portfolios.id, selector.portfolioId),
                eq(portfolios.userId, userId),
                eq(portfolios.vaultId, vaultId),
              ),
            );
          if (!member) return { status: 'doc_not_found' as const };
        }
        const [current] = await tx
          .select()
          .from(vaultDocs)
          .where(docWhere(vaultId, selector))
          .for('update');
        if (expectedVersion === null) {
          if (current) {
            return { status: 'precondition_failed' as const, currentVersion: current.version };
          }
          const [created] = await tx
            .insert(vaultDocs)
            .values({
              vaultId,
              docKind: selector.kind,
              portfolioId: selector.kind === 'portfolio' ? selector.portfolioId : null,
              ciphertext,
              sizeBytes: ciphertext.length,
              version: 1,
            })
            .returning();
          if (!created) throw new Error('vault doc insert returned no row');
          return { status: 'ok' as const, doc: metaOf(created) };
        }
        if (!current) return { status: 'precondition_failed' as const, currentVersion: null };
        if (current.version !== expectedVersion) {
          return { status: 'precondition_failed' as const, currentVersion: current.version };
        }
        const [updated] = await tx
          .update(vaultDocs)
          .set({
            ciphertext,
            sizeBytes: ciphertext.length,
            version: current.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(vaultDocs.id, current.id))
          .returning();
        if (!updated) throw new Error('vault doc update returned no row');
        return { status: 'ok' as const, doc: metaOf(updated) };
      });
    },

    async joinPortfolio({ userId, portfolioId, vaultId, ciphertext, afterPurge }) {
      const maxBytes = vaultDocMaxBytes('portfolio');
      if (ciphertext.length > maxBytes) {
        return { status: 'too_large', sizeBytes: ciphertext.length, maxBytes };
      }
      return db.transaction(async (tx) => {
        const [vault] = await tx
          .select()
          .from(vaults)
          .where(and(eq(vaults.id, vaultId), eq(vaults.userId, userId)))
          .for('update');
        if (!vault) return { status: 'vault_not_found' as const };
        const [portfolio] = await tx
          .select({ id: portfolios.id, vaultId: portfolios.vaultId })
          .from(portfolios)
          .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
          .for('update');
        if (!portfolio) return { status: 'portfolio_not_found' as const };
        if (portfolio.vaultId !== null) return { status: 'already_vaulted' as const };
        // The account-level enable refuses while a MIRRORCHAIN membership is
        // active (paranoid-design §7); the same boundary holds per portfolio —
        // replication would keep writing rows into a portfolio whose cleartext
        // is meant to be gone.
        const [membership] = await tx
          .select({ id: mirrorChainMembers.id })
          .from(mirrorChainMembers)
          .where(
            and(
              eq(mirrorChainMembers.portfolioId, portfolioId),
              eq(mirrorChainMembers.status, 'active'),
            ),
          );
        if (membership) {
          return {
            status: 'blocked' as const,
            reason: 'Leave the portfolio’s mirrorchain before moving it into a vault.',
          };
        }

        // ONE transaction, in this order: store the ciphertext, purge the
        // cleartext, flip the bit. The purge's zero-cleartext probe throws on a
        // survivor, which aborts the whole join — both-or-neither by
        // construction, never a portfolio marked paranoid with readable rows.
        const [doc] = await tx
          .insert(vaultDocs)
          .values({
            vaultId,
            docKind: 'portfolio',
            portfolioId,
            ciphertext,
            sizeBytes: ciphertext.length,
            version: 1,
          })
          .returning();
        if (!doc) throw new Error('vault portfolio blob insert returned no row');
        await purgeVaultPortfolioRows(tx, portfolioId);
        if (afterPurge) await afterPurge();
        await tx
          .update(portfolios)
          .set({ vaultId })
          .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)));
        return { status: 'ok' as const, vault, blob: metaOf(doc) };
      });
    },

    async leavePortfolio({ userId, portfolioId, restoreId, document, afterRestore }) {
      return db.transaction(async (tx) => {
        const [portfolio] = await tx
          .select({ id: portfolios.id, vaultId: portfolios.vaultId })
          .from(portfolios)
          .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
          .for('update');
        if (!portfolio) return { status: 'portfolio_not_found' as const };
        if (portfolio.vaultId === null) {
          // IDEMPOTENCY KEY: `vault_leave_receipts.restore_id`. Leave is one
          // atomic transaction, so a crash either rolled everything back
          // (vault_id still set — the retry below does the real work) or
          // committed everything, in which case the receipt is present and this
          // acknowledges the replay instead of inserting the rows twice.
          //
          // The receipt is what makes the OTHER case tellable: a leave against a
          // portfolio that was never vaulted looks identical from `vault_id`
          // alone, and answering it with an idempotent success would silently
          // confirm a transition that never happened.
          const [receipt] = await tx
            .select({ restoreId: vaultLeaveReceipts.restoreId })
            .from(vaultLeaveReceipts)
            .where(
              and(
                eq(vaultLeaveReceipts.restoreId, restoreId),
                eq(vaultLeaveReceipts.userId, userId),
                eq(vaultLeaveReceipts.portfolioId, portfolioId),
              ),
            );
          if (receipt) return { status: 'ok' as const, idempotent: true };
          return { status: 'not_vaulted' as const };
        }
        if (await hasVaultPortfolioCleartextRows(tx, portfolioId)) {
          return {
            status: 'restore_invalid' as const,
            reason: 'The portfolio still holds cleartext rows; refusing to restore on top of them.',
          };
        }

        const restore = createParanoidRehydrationSourceRepository(tx);
        const byKind = <K extends VaultPortfolioRestoreDocument['entities'][number]['kind']>(
          kind: K,
        ): Array<Extract<VaultPortfolioRestoreDocument['entities'][number], { kind: K }>> =>
          document.entities.filter(
            (
              entity,
            ): entity is Extract<VaultPortfolioRestoreDocument['entities'][number], { kind: K }> =>
              entity.kind === kind,
          );

        // Dependency order, mirroring the account-level rehydration: sources →
        // ledger → derived classification. Any FK/CHECK violation throws and
        // takes the whole leave with it.
        await restore.restoreCashSources(byKind('cashSource'));
        await restore.restorePortfolioSettings(byKind('portfolioSetting'));
        await restore.restoreTransactions(byKind('transaction'));
        await restore.restoreDividends(byKind('dividend'));
        await restore.restoreCashMovements(byKind('cashMovement'));
        await restore.restoreStandingOrders(byKind('standingOrder'));
        await restore.restoreStandingOrderRuns(byKind('standingOrderRun'));
        await restore.restoreCashBudgets(byKind('cashBudget'));
        await restore.restoreCashMovementTags(byKind('cashMovementTag'));
        if (afterRestore) await afterRestore();

        await tx.insert(vaultLeaveReceipts).values({ restoreId, userId, portfolioId });
        await tx
          .update(portfolios)
          .set({ vaultId: null })
          .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)));
        // Retire the blob: the ciphertext has served its purpose and keeping it
        // would leave a copy of the ledger the user just brought back.
        await tx
          .delete(vaultDocs)
          .where(
            and(
              eq(vaultDocs.vaultId, portfolio.vaultId),
              eq(vaultDocs.docKind, 'portfolio'),
              eq(vaultDocs.portfolioId, portfolioId),
            ),
          );
        return { status: 'ok' as const, idempotent: false };
      });
    },

    async isPortfolioVaulted(userId, portfolioId) {
      const [row] = await db
        .select({ vaultId: portfolios.vaultId })
        .from(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
        .limit(1);
      return row?.vaultId != null;
    },

    async setPortfolioAlias(userId, portfolioId, alias) {
      const updated = await db
        .update(portfolios)
        .set({ alias })
        .where(
          and(
            eq(portfolios.id, portfolioId),
            eq(portfolios.userId, userId),
            isNotNull(portfolios.vaultId),
          ),
        )
        .returning({ id: portfolios.id });
      if (updated.length > 0) return { status: 'ok' };
      // Nothing matched: distinguish "not yours / gone" from "not vaulted" with
      // one more owner-scoped read, so a normal portfolio gets the precise 409
      // and a foreign id still gets an indistinguishable 404.
      const [row] = await db
        .select({ vaultId: portfolios.vaultId })
        .from(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)));
      if (!row) return { status: 'portfolio_not_found' };
      return { status: 'not_vaulted' };
    },

    async portfolioVaultState(userId, portfolioId) {
      const [row] = await db
        .select({ portfolioId: portfolios.id, alias: portfolios.alias, vault: vaults })
        .from(portfolios)
        .leftJoin(vaults, eq(vaults.id, portfolios.vaultId))
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)));
      if (!row) return null;
      return { portfolioId: row.portfolioId, alias: row.alias, vault: row.vault ?? null };
    },
  };
}
