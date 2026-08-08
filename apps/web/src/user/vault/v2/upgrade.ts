import {
  isCommonScopedKind,
  isPortfolioScopedKind,
  trimVaultMergeLog,
  VAULT_ENTITY_KINDS,
  VAULT2_DOCUMENT_VERSION,
  VAULT2_NAME_MAX_LENGTH,
  type VaultCommonDoc,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
  type VaultPortfolioDoc,
  type VaultPortfolioIndexEntry,
} from '@bettertrack/contracts';

import { VaultCryptoError } from '../errors';

/**
 * v1 → v2 split (`docs/VAULTS_V2_DESIGN.md` r2 §8/§11).
 *
 * A v1 account holds ONE encrypted document. v2 wants one `common` doc plus one
 * doc per portfolio, all inside vault #1. This module performs the split on
 * already-decrypted material — it is pure, so the property that matters can be
 * tested directly:
 *
 *   **every entity in, exactly one entity out.**
 *
 * Portfolio-scoped rows are routed by their portfolio, directly or through a
 * parent chain. Everything account/vault-scoped goes to `common` (r2 §8), which
 * also carries `mergeLog`, `mirrorProvenance` and `clientSecurity`.
 *
 * Rows whose portfolio cannot be resolved (a dangling parent reference in an old
 * document) are NOT dropped: they land in `common` and are reported in
 * {@link VaultUpgradeReport.orphans}, so a migration is auditable instead of
 * quietly lossy.
 *
 * Every produced doc has a **deterministic identity** (r2 §11 step 2): the
 * portfolio docs are keyed by `portfolioId` and `common` is the vault's single
 * common doc, which is what makes a resumed migration idempotent.
 */

/** How each portfolio-scoped kind finds its portfolio. */
type PortfolioResolution =
  | { via: 'self' }
  | { via: 'field'; field: string }
  | { via: 'parent'; field: string; parent: VaultEntityKind };

const PORTFOLIO_RESOLUTION: Record<string, PortfolioResolution> = {
  portfolio: { via: 'self' },
  transaction: { via: 'field', field: 'portfolioId' },
  dividend: { via: 'field', field: 'portfolioId' },
  cashSource: { via: 'field', field: 'portfolioId' },
  cashMovement: { via: 'field', field: 'portfolioId' },
  portfolioSetting: { via: 'field', field: 'portfolioId' },
  standingOrder: { via: 'field', field: 'portfolioId' },
  importBatch: { via: 'field', field: 'portfolioId' },
  portfolioDailySnapshot: { via: 'field', field: 'portfolioId' },
  portfolioSnapshotState: { via: 'field', field: 'portfolioId' },
  standingOrderRun: { via: 'parent', field: 'standingOrderId', parent: 'standingOrder' },
  importRow: { via: 'parent', field: 'batchId', parent: 'importBatch' },
  cashMovementTag: { via: 'parent', field: 'movementId', parent: 'cashMovement' },
};

export interface VaultUpgradeOrphan {
  kind: VaultEntityKind;
  entityId: string;
  reason: 'missing-reference' | 'unknown-portfolio' | 'unscoped-kind';
}

export interface VaultUpgradeReport {
  /** Total entities read out of the v1 document, tombstones included. */
  entitiesIn: number;
  /** Total entities written across every produced doc. Must equal `entitiesIn`. */
  entitiesOut: number;
  orphans: VaultUpgradeOrphan[];
}

export interface VaultUpgradeSplit {
  portfolioDocs: VaultPortfolioDoc[];
  commonDoc: VaultCommonDoc;
  index: VaultPortfolioIndexEntry[];
  report: VaultUpgradeReport;
}

export interface SplitVaultDocumentInput {
  document: VaultDocument;
  vaultId: string;
  /**
   * Display aliases for the portfolio index. A portfolio without an override
   * falls back to its own `portfolio` entity name, then to a neutral label.
   * The alias is CLEARTEXT (§2 portfolio index) — the wizard says so and lets
   * the user change it.
   */
  aliases?: Record<string, string>;
}

/**
 * Split one decrypted v1 document into per-portfolio docs plus the vault's
 * `common` doc. Pure: no crypto, no I/O, no clock.
 */
export function splitVaultDocument(input: SplitVaultDocumentInput): VaultUpgradeSplit {
  const entities = input.document.entities as Partial<Record<VaultEntityKind, VaultEntity[]>>;
  const byKind = (kind: VaultEntityKind): VaultEntity[] => entities[kind] ?? [];

  // Index every entity id per kind once so parent lookups stay linear.
  const idIndex = new Map<VaultEntityKind, Map<string, VaultEntity>>();
  for (const kind of VAULT_ENTITY_KINDS) {
    const map = new Map<string, VaultEntity>();
    for (const entity of byKind(kind)) map.set(entity.id, entity);
    idIndex.set(kind, map);
  }

  const knownPortfolioIds = new Set(byKind('portfolio').map((entity) => entity.id));
  const perPortfolio = new Map<string, Map<VaultEntityKind, VaultEntity[]>>();
  const commonEntities = new Map<VaultEntityKind, VaultEntity[]>();
  const orphans: VaultUpgradeOrphan[] = [];
  let entitiesIn = 0;
  let entitiesOut = 0;

  const pushPortfolio = (portfolioId: string, kind: VaultEntityKind, entity: VaultEntity): void => {
    let bucket = perPortfolio.get(portfolioId);
    if (bucket == null) {
      bucket = new Map();
      perPortfolio.set(portfolioId, bucket);
    }
    const list = bucket.get(kind) ?? [];
    list.push(entity);
    bucket.set(kind, list);
    entitiesOut += 1;
  };

  const pushCommon = (kind: VaultEntityKind, entity: VaultEntity): void => {
    const list = commonEntities.get(kind) ?? [];
    list.push(entity);
    commonEntities.set(kind, list);
    entitiesOut += 1;
  };

  for (const kind of VAULT_ENTITY_KINDS) {
    for (const entity of byKind(kind)) {
      entitiesIn += 1;

      if (isCommonScopedKind(kind)) {
        pushCommon(kind, entity);
        continue;
      }
      if (!isPortfolioScopedKind(kind)) {
        // A kind added to the contract without a v2 scope. Keep the row and
        // make the gap loud rather than silently discarding money data.
        orphans.push({ kind, entityId: entity.id, reason: 'unscoped-kind' });
        pushCommon(kind, entity);
        continue;
      }

      const resolved = resolvePortfolioId(kind, entity, idIndex);
      if (resolved == null) {
        orphans.push({ kind, entityId: entity.id, reason: 'missing-reference' });
        pushCommon(kind, entity);
        continue;
      }
      if (!knownPortfolioIds.has(resolved)) {
        orphans.push({ kind, entityId: entity.id, reason: 'unknown-portfolio' });
        pushCommon(kind, entity);
        continue;
      }
      pushPortfolio(resolved, kind, entity);
    }
  }

  const portfolioDocs: VaultPortfolioDoc[] = [];
  const index: VaultPortfolioIndexEntry[] = [];
  // Order by the portfolio entity order so the produced docs and index are
  // deterministic across runs — a resumed migration must rewrite byte-identical
  // documents (r2 §11 step 2).
  const orderedPortfolioIds = [
    ...byKind('portfolio').map((entity) => entity.id),
    ...[...perPortfolio.keys()].filter((id) => !knownPortfolioIds.has(id)),
  ];

  for (const portfolioId of orderedPortfolioIds) {
    const bucket = perPortfolio.get(portfolioId) ?? new Map<VaultEntityKind, VaultEntity[]>();
    portfolioDocs.push({
      schemaVersion: VAULT2_DOCUMENT_VERSION,
      docKind: 'portfolio',
      vaultId: input.vaultId,
      portfolioId,
      entities: Object.fromEntries(bucket),
      mergeLog: [],
    });
    index.push({
      portfolioId,
      alias: aliasFor(portfolioId, input.aliases, idIndex.get('portfolio')?.get(portfolioId)),
    });
  }

  const commonDoc: VaultCommonDoc = {
    schemaVersion: VAULT2_DOCUMENT_VERSION,
    docKind: 'common',
    vaultId: input.vaultId,
    entities: Object.fromEntries(commonEntities),
    // r3 §20: mergeLog and mirrorProvenance are per-vault MEMBERS of `common`.
    // The log is trimmed on write (never rejected on read) so an oversized
    // diagnostic array can never make the common doc — and with it the whole
    // vault — unparseable.
    mergeLog: trimVaultMergeLog(input.document.mergeLog ?? []),
    ...(input.document.mirrorProvenance != null
      ? { mirrorProvenance: input.document.mirrorProvenance }
      : {}),
    ...(input.document.schemaVersion === 2
      ? { clientSecurity: input.document.clientSecurity }
      : {}),
  };

  const report: VaultUpgradeReport = { entitiesIn, entitiesOut, orphans };
  if (entitiesIn !== entitiesOut) {
    throw new VaultCryptoError(
      'document-invalid',
      `The v1→v2 split lost rows (${entitiesIn} in, ${entitiesOut} out).`,
    );
  }
  return { portfolioDocs, commonDoc, index, report };
}

function resolvePortfolioId(
  kind: VaultEntityKind,
  entity: VaultEntity,
  idIndex: Map<VaultEntityKind, Map<string, VaultEntity>>,
): string | null {
  const resolution = PORTFOLIO_RESOLUTION[kind];
  if (resolution == null) return null;
  if (resolution.via === 'self') return entity.id;

  const raw = entity.data[resolution.field];
  if (typeof raw !== 'string' || raw === '') return null;
  if (resolution.via === 'field') return raw;

  const parent = idIndex.get(resolution.parent)?.get(raw);
  if (parent == null) return null;
  return resolvePortfolioId(resolution.parent, parent, idIndex);
}

function aliasFor(
  portfolioId: string,
  aliases: Record<string, string> | undefined,
  portfolioEntity: VaultEntity | undefined,
): string {
  const override = aliases?.[portfolioId]?.trim();
  if (override != null && override !== '') return override.slice(0, VAULT2_NAME_MAX_LENGTH);
  const name = portfolioEntity?.data.name;
  if (typeof name === 'string' && name.trim() !== '') {
    return name.trim().slice(0, VAULT2_NAME_MAX_LENGTH);
  }
  return `Portfolio ${portfolioId.slice(0, 8)}`;
}

/**
 * Build the per-portfolio doc a JOIN writes: the same shape the split produces,
 * from rows the client just read out of the cleartext API.
 */
export function buildPortfolioDoc(input: {
  vaultId: string;
  portfolioId: string;
  entities: Partial<Record<VaultEntityKind, VaultEntity[]>>;
}): VaultPortfolioDoc {
  for (const kind of Object.keys(input.entities) as VaultEntityKind[]) {
    if (!isPortfolioScopedKind(kind)) {
      throw new VaultCryptoError(
        'document-invalid',
        `A portfolio document cannot carry the vault-scoped kind "${kind}".`,
      );
    }
  }
  return {
    schemaVersion: VAULT2_DOCUMENT_VERSION,
    docKind: 'portfolio',
    vaultId: input.vaultId,
    portfolioId: input.portfolioId,
    entities: input.entities as VaultPortfolioDoc['entities'],
    mergeLog: [],
  };
}
