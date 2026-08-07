import {
  VAULT2_ERROR_CODES,
  vaultDocMaxBytes,
  type CreateVaultRequest,
  type PortfolioVaultState,
  type UpdateVaultRequest,
  type Vault,
  type VaultCreateResponse,
  type VaultDocMetadata,
  type VaultJoinRequest,
  type VaultJoinResponse,
  type VaultLeaveRequest,
  type VaultLeaveResponse,
  type VaultMigrationState,
  type VaultSyncSummary,
} from '@bettertrack/contracts';

import { ApiError, EnvelopeApiError, badRequest, conflict, notFound } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';

import type {
  VaultDocMetaRow,
  VaultDocSelector,
  VaultRepository,
  VaultWithCount,
} from '../../data/repositories/vaultRepository';
import type {
  VaultMigrationRepository,
  VaultMigrationStateRow,
} from '../../data/repositories/vaultMigrationRepository';
import type { VaultDocRow, VaultRow } from '../../data/schema';

/**
 * Vaults v2 business layer (`docs/VAULTS_V2_DESIGN.md` §3).
 *
 * The service owns error mapping and the audit trail. It owns NO authorization
 * logic of its own: every repository call carries the acting `userId` and the
 * repository scopes on it, so this layer never has to remember to filter. A
 * foreign or missing vault id is one indistinguishable `VAULT_NOT_FOUND`.
 *
 * The server never parses ciphertext. There is deliberately no envelope/header
 * inspection here at all — unlike the account-level vault, which reads a
 * `BTVAULT1` header for its own CAS, a v2 document's format is entirely the
 * client's business and the CAS token is a server-assigned integer.
 */

export interface VaultServiceDeps {
  vaults: VaultRepository;
  migrations: VaultMigrationRepository;
  audit: AuditService;
}

export interface VaultDocReadResult {
  version: number;
  ciphertext: Buffer;
  updatedAt: Date;
}

export interface VaultService {
  list(userId: string): Promise<Vault[]>;
  listForSync(userId: string): Promise<VaultSyncSummary[]>;
  create(
    userId: string,
    input: CreateVaultRequest,
    ip: string | null,
  ): Promise<VaultCreateResponse>;
  update(
    userId: string,
    vaultId: string,
    input: UpdateVaultRequest,
    ip: string | null,
  ): Promise<Vault>;
  remove(userId: string, vaultId: string, ip: string | null): Promise<void>;
  readDoc(userId: string, vaultId: string, selector: VaultDocSelector): Promise<VaultDocReadResult>;
  writeDoc(input: {
    userId: string;
    vaultId: string;
    selector: VaultDocSelector;
    expectedVersion: number | null;
    ciphertext: Buffer;
  }): Promise<VaultDocMetadata>;
  join(
    userId: string,
    portfolioId: string,
    input: VaultJoinRequest,
    ip: string | null,
  ): Promise<VaultJoinResponse>;
  leave(
    userId: string,
    portfolioId: string,
    input: VaultLeaveRequest,
    ip: string | null,
  ): Promise<VaultLeaveResponse>;
  portfolioState(userId: string, portfolioId: string): Promise<PortfolioVaultState>;
  /** Owner-scoped membership probe driving the portfolio-scoped kill rail. */
  isPortfolioVaulted(userId: string, portfolioId: string): Promise<boolean>;
  // ── v1 → v2 migration protocol (design r2 §11) ────────────────────────────
  migrationState(userId: string): Promise<VaultMigrationState>;
  claimMigration(userId: string, clientNonce: string): Promise<VaultMigrationState>;
  renewMigration(userId: string, clientNonce: string): Promise<VaultMigrationState>;
  flipMigration(
    userId: string,
    clientNonce: string,
    vaultId: string,
    ip: string | null,
  ): Promise<VaultMigrationState>;
}

const vaultNotFound = (): ApiError => notFound('No such vault.', VAULT2_ERROR_CODES.notFound);

// r2 §15 has no separate document-not-found code: a missing document inside a
// vault the caller owns answers with the same VAULT_NOT_FOUND a missing vault
// does, which also keeps the two indistinguishable to a prober.
const docNotFound = (): ApiError =>
  notFound('No such vault document.', VAULT2_ERROR_CODES.notFound);

/**
 * The CAS 412. Design r2 §15 requires the server's current version at the TOP
 * level of the body, so a client that lost the race can re-fetch and merge
 * without a second round trip. `null` means the document does not exist at all.
 */
const versionConflict = (currentVersion: number | null): ApiError =>
  new EnvelopeApiError(
    412,
    VAULT2_ERROR_CODES.versionConflict,
    'The vault document changed since the version you supplied.',
    { currentVersion },
  );

const tooLarge = (sizeBytes: number, maxBytes: number): ApiError =>
  new ApiError(
    413,
    VAULT2_ERROR_CODES.docTooLarge,
    `The ciphertext is ${sizeBytes} bytes; the cap for this document kind is ${maxBytes}.`,
  );

function toVault(row: VaultWithCount): Vault {
  return {
    id: row.id,
    name: row.name,
    backends: row.backends,
    portfolioIds: row.portfolioIds,
    portfolioCount: row.portfolioCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDocMetadata(row: VaultDocMetaRow | VaultDocRow): VaultDocMetadata {
  return {
    vaultId: row.vaultId,
    docKind: row.docKind,
    portfolioId: row.portfolioId,
    version: row.version,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPortfolioState(portfolioId: string, vault: VaultRow | null): PortfolioVaultState {
  return {
    portfolioId,
    vaultId: vault?.id ?? null,
    vaultName: vault?.name ?? null,
    backends: vault?.backends ?? null,
  };
}

/**
 * Decode a base64 ciphertext field and enforce the per-kind byte cap before it
 * reaches the database. The cap is re-asserted by a CHECK constraint, so this is
 * the friendly half of a two-layer bound, not the only one.
 */
function decodeCiphertext(value: string, selector: VaultDocSelector['kind']): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) {
    throw badRequest('The ciphertext must decode to a non-empty byte string.');
  }
  const maxBytes = vaultDocMaxBytes(selector);
  if (bytes.length > maxBytes) throw tooLarge(bytes.length, maxBytes);
  return bytes;
}

function toMigrationState(row: VaultMigrationStateRow): VaultMigrationState {
  return {
    legacyPresent: row.legacyPresent,
    migratingBy: row.migratingBy,
    claimExpiresAt: row.claimExpiresAt?.toISOString() ?? null,
    migratedTo: row.migratedTo,
  };
}

export function createVaultService(deps: VaultServiceDeps): VaultService {
  return {
    async list(userId) {
      return (await deps.vaults.listVaults(userId)).map(toVault);
    },

    async listForSync(userId) {
      // The bearer projection (§3): ids + names + backends only. Built from the
      // same rows rather than a second query, so the two lists can never drift.
      return (await deps.vaults.listVaults(userId)).map((row) => ({
        id: row.id,
        name: row.name,
        backends: row.backends,
        portfolioIds: row.portfolioIds,
      }));
    },

    async create(userId, input, ip) {
      const header = input.header === undefined ? null : decodeCiphertext(input.header, 'header');
      const result = await deps.vaults.createVault({
        userId,
        name: input.name,
        backends: input.backends,
        header,
      });
      if (result.status === 'name_taken') {
        throw conflict('You already have a vault with that name.', VAULT2_ERROR_CODES.nameTaken);
      }
      if (result.status === 'too_large') throw tooLarge(result.sizeBytes, result.maxBytes);
      await deps.audit.record({
        actorId: userId,
        action: AuditAction.VaultCreated,
        targetType: 'vault',
        targetId: result.vault.id,
        ip,
        meta: { name: result.vault.name, backends: result.vault.backends },
      });
      return {
        vault: toVault(result.vault),
        header: result.header ? toDocMetadata(result.header) : null,
      };
    },

    async update(userId, vaultId, input, ip) {
      const result = await deps.vaults.updateVault({ userId, vaultId, ...input });
      if (result.status === 'not_found') throw vaultNotFound();
      if (result.status === 'name_taken') {
        throw conflict('You already have a vault with that name.', VAULT2_ERROR_CODES.nameTaken);
      }
      await deps.audit.record({
        actorId: userId,
        action: AuditAction.VaultUpdated,
        targetType: 'vault',
        targetId: vaultId,
        ip,
        meta: { name: result.vault.name, backends: result.vault.backends },
      });
      return toVault(result.vault);
    },

    async remove(userId, vaultId, ip) {
      const result = await deps.vaults.deleteVault(userId, vaultId);
      if (result.status === 'not_found') throw vaultNotFound();
      if (result.status === 'not_empty') {
        throw conflict(
          'Move every portfolio out of this vault before deleting it.',
          VAULT2_ERROR_CODES.notEmpty,
        );
      }
      await deps.audit.record({
        actorId: userId,
        action: AuditAction.VaultDeleted,
        targetType: 'vault',
        targetId: vaultId,
        ip,
      });
    },

    async readDoc(userId, vaultId, selector) {
      const result = await deps.vaults.readDoc(userId, vaultId, selector);
      if (result.status === 'vault_not_found') throw vaultNotFound();
      if (result.status === 'doc_not_found') throw docNotFound();
      return {
        version: result.row.version,
        ciphertext: result.row.ciphertext,
        updatedAt: result.row.updatedAt,
      };
    },

    async writeDoc(input) {
      const result = await deps.vaults.writeDoc(input);
      switch (result.status) {
        case 'ok':
          return toDocMetadata(result.doc);
        case 'vault_not_found':
          throw vaultNotFound();
        case 'doc_not_found':
          throw docNotFound();
        case 'precondition_failed':
          throw versionConflict(result.currentVersion);
        case 'too_large':
          throw tooLarge(result.sizeBytes, result.maxBytes);
        case 'server_backend_inactive':
          throw conflict(
            'This vault keeps no ciphertext on the server.',
            VAULT2_ERROR_CODES.backendUnavailable,
          );
      }
    },

    async join(userId, portfolioId, input, ip) {
      const ciphertext = decodeCiphertext(input.blob, 'portfolio');
      const result = await deps.vaults.joinPortfolio({
        userId,
        portfolioId,
        vaultId: input.vaultId,
        ciphertext,
      });
      switch (result.status) {
        case 'vault_not_found':
          throw vaultNotFound();
        case 'portfolio_not_found':
          throw notFound('No such portfolio.', 'PORTFOLIO_NOT_FOUND');
        case 'already_vaulted':
          throw conflict(
            'This portfolio already belongs to a vault.',
            VAULT2_ERROR_CODES.alreadyVaulted,
          );
        case 'blocked':
          throw conflict(result.reason, VAULT2_ERROR_CODES.joinBlocked);
        case 'too_large':
          throw tooLarge(result.sizeBytes, result.maxBytes);
        case 'ok':
          break;
      }
      await deps.audit.record({
        actorId: userId,
        action: AuditAction.VaultPortfolioJoined,
        targetType: 'portfolio',
        targetId: portfolioId,
        ip,
        meta: { vaultId: result.vault.id, backends: result.vault.backends },
      });
      return {
        state: toPortfolioState(portfolioId, result.vault),
        blob: toDocMetadata(result.blob),
      };
    },

    async leave(userId, portfolioId, input, ip) {
      const result = await deps.vaults.leavePortfolio({
        userId,
        portfolioId,
        document: input.document,
      });
      switch (result.status) {
        case 'portfolio_not_found':
          throw notFound('No such portfolio.', 'PORTFOLIO_NOT_FOUND');
        case 'not_vaulted':
          throw conflict('This portfolio does not belong to a vault.', VAULT2_ERROR_CODES.notFound);
        case 'restore_invalid':
          throw badRequest(result.reason, VAULT2_ERROR_CODES.restoreInvalid);
        case 'ok':
          break;
      }
      if (!result.idempotent) {
        await deps.audit.record({
          actorId: userId,
          action: AuditAction.VaultPortfolioLeft,
          targetType: 'portfolio',
          targetId: portfolioId,
          ip,
        });
      }
      const state = await this.portfolioState(userId, portfolioId);
      return { state, restoreId: input.restoreId, idempotent: result.idempotent };
    },

    async isPortfolioVaulted(userId, portfolioId) {
      return deps.vaults.isPortfolioVaulted(userId, portfolioId);
    },

    async migrationState(userId) {
      return toMigrationState(await deps.migrations.getState(userId));
    },

    async claimMigration(userId, clientNonce) {
      const result = await deps.migrations.claim(userId, clientNonce);
      if (result.status === 'not_found') {
        throw notFound('This account has no legacy vault to migrate.', VAULT2_ERROR_CODES.notFound);
      }
      if (result.status === 'claimed') {
        throw new EnvelopeApiError(
          409,
          VAULT2_ERROR_CODES.migrationClaimed,
          result.state.migratedTo
            ? 'This account has already migrated to a v2 vault.'
            : 'Another client is migrating this vault; wait for its claim to lapse.',
          { state: toMigrationState(result.state) },
        );
      }
      return toMigrationState(result.state);
    },

    async renewMigration(userId, clientNonce) {
      const result = await deps.migrations.renew(userId, clientNonce);
      if (result.status === 'not_found') {
        throw notFound('This account has no legacy vault to migrate.', VAULT2_ERROR_CODES.notFound);
      }
      if (result.status === 'claimed') {
        // A lapsed or foreign claim cannot be renewed: the holder must go back
        // through `claim`, where it may legitimately lose to another client.
        throw new EnvelopeApiError(
          409,
          VAULT2_ERROR_CODES.migrationClaimed,
          'This migration claim is no longer live; claim again before continuing.',
          { state: toMigrationState(result.state) },
        );
      }
      return toMigrationState(result.state);
    },

    async flipMigration(userId, clientNonce, vaultId, ip) {
      const result = await deps.migrations.flip(userId, clientNonce, vaultId);
      switch (result.status) {
        case 'not_found':
          throw notFound(
            'This account has no legacy vault to migrate.',
            VAULT2_ERROR_CODES.notFound,
          );
        case 'vault_not_found':
          throw vaultNotFound();
        case 'incomplete':
          throw new EnvelopeApiError(
            409,
            VAULT2_ERROR_CODES.migrationIncomplete,
            'The migration claim is not live for this client; re-claim, re-verify, then flip.',
            { state: toMigrationState(result.state) },
          );
        case 'ok':
          break;
      }
      await deps.audit.record({
        actorId: userId,
        action: AuditAction.VaultMigrated,
        targetType: 'vault',
        targetId: vaultId,
        ip,
      });
      return toMigrationState(result.state);
    },

    async portfolioState(userId, portfolioId) {
      const row = await deps.vaults.portfolioVaultState(userId, portfolioId);
      if (!row) throw notFound('No such portfolio.', 'PORTFOLIO_NOT_FOUND');
      return toPortfolioState(row.portfolioId, row.vault);
    },
  };
}
