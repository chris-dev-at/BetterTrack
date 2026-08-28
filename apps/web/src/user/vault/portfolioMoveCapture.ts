import { uuidv7 } from 'uuidv7';

import {
  VAULT_DOC_SCHEMA_VERSION,
  VAULT_ENTITY_ROW_SCHEMAS,
  serializePortfolioVaultMoveOutProofTranscript,
  serializePortfolioVaultRestoreDocument,
  serializeVaultRetirementVersionSet,
  vaultCommonDocSchema,
  vaultHeaderDocSchema,
  vaultPortfolioDocSchema,
  type PerVaultMediaDocAttestation,
  type PortfolioAsset,
  type PortfolioSummary,
  type VaultCommonDoc,
  type VaultConfig,
  type VaultDocEnvelopeHeader,
  type VaultEntity,
  type VaultEntityKind,
  type VaultHeaderDoc,
  type VaultMirrorProvenance,
  type VaultPortfolioDoc,
} from '@bettertrack/contracts';

import { getAssetDetail } from '../../lib/assetApi';
import { listAllCashBudgets } from '../../lib/cashApi';
import { getTaxYearReport, getTaxYearReports, listDividends } from '../../lib/portfolioApi';
import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';
import { listStandingOrderRuns } from '../../lib/standingOrdersApi';
import { getMe, getParanoidForkProvenance } from '../../lib/userApi';
import {
  getPortfolioVaultLifecycle,
  getPortfolioVaultRevision,
  getVaultMediaState,
  transitionVaultMedia,
  writeVaultDocument,
} from '../../lib/vaultApi';
import { apiVaultDocEnvelopeReader, type VaultDocEnvelopeReader } from '../../lib/vaultsApi';
import { assetSnapshotRow } from './assetSnapshot';
import { equalBytes, utf8, zeroBytes } from './bytes';
import {
  loadDecryptedVaultDocumentSet,
  type DecryptedPortfolioDocumentSet,
  type DecryptedVaultDocumentSet,
} from './engine/portfolioDocumentSet';
import { decodeBase64Url, encodeBase64Url } from './keys/base64url';
import { deriveAccountBinding } from './keys';
import { encryptVaultDoc, type EncryptedVaultDoc } from './keys/documents';
import { endpointVaultKeystore } from './keystore/runtime';
import { mergeForkProvenance, pruneForkProvenance } from './mirrorProvenance';
import type { PortfolioVaultKeystore } from './portfolioStoreResolver';
import type { PortfolioVaultMoveCapture } from './portfolioVaultMove';
import { buildPortfolioVaultRestoreDocument } from './portfolioRestoreDocument';
import {
  decimal,
  frozenFactsForDividend,
  frozenFactsForTransaction,
  frozenTaxFacts,
  listAllCashMovements,
  listAllTransactions,
  runKey,
} from './ui/migration';

/**
 * The E6 client half of the §9/§10 move pipeline (#1416 residual, #1525).
 *
 * MOVE-IN: capture the portfolio's exact restorable cleartext through the
 * existing read APIs, encrypt it as the vault's new portfolio document (R1:
 * `docId === portfolioId`), fold referenced-asset snapshots and severed-fork
 * provenance into the common doc, add the roster entry to the header doc,
 * round-trip-verify every write, and refresh the full-set media attestation —
 * everything E4's destructive commit verifies before the purge. No cleartext
 * ever reaches the server on this path: every PUT body is an AES-256-GCM
 * envelope whose full serialized header is bound as AAD (§5).
 *
 * MOVE-OUT: open the vault, author the strict restore graph through the
 * shipped `buildPortfolioVaultRestoreDocument` boundary, hash the exact opened
 * encrypted roster (the server's `documentSetHash` CAS), and sign E4's
 * challenge transcript with the retirement-proof Ed25519 key that exists only
 * inside the encrypted common doc — possession of the vault, not of a session.
 *
 * Deliberate fail-closed limits of THIS build, each surfaced before anything
 * destructive and recorded in #1525:
 *  - Drive-carrying vaults are refused (no per-vault Drive provisioning —
 *    `PER_VAULT_DRIVE_PROVISIONING_AVAILABLE === false` — so none can exist).
 *  - A portfolio with historical import batches is refused: there is no client
 *    read path for their staging rows, and purging rows the encrypted document
 *    never carried is exactly the loss class §9 forbids. The refusal fact is
 *    the `importBatchCount` returned in the same snapshot as the revision.
 *  - A portfolio referencing owner-manual (custom) assets is refused on BOTH
 *    paths: move-in has only the rounded public DTO (not the exact decimal
 *    snapshot E4's restore CAS needs) and move-out already fails closed in
 *    `portfolioRestoreDocument` without a lossless resolver.
 */

export const PORTFOLIO_MOVE_CAPTURE_ERROR_CODES = [
  /** The vault stores on media this build cannot write (Drive, reserved local). */
  'VAULT_MOVE_MEDIA_UNSUPPORTED',
  /** The portfolio's rows moved during the capture; retry once it settles. */
  'VAULT_MOVE_CAPTURE_UNSTABLE',
  /** Historical import batches exist and cannot be captured losslessly yet. */
  'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
  /** Owner-manual assets need the exact-snapshot seam this build lacks. */
  'VAULT_MOVE_MANUAL_ASSETS_UNSUPPORTED',
  /** Concurrent writer / stale roster / lifecycle mismatch; nothing committed. */
  'VAULT_MOVE_STATE_CONFLICT',
  /** A written document did not read back byte-identical. */
  'VAULT_MOVE_VERIFY_FAILED',
] as const;

export type PortfolioMoveCaptureErrorCode = (typeof PORTFOLIO_MOVE_CAPTURE_ERROR_CODES)[number];

export class PortfolioMoveCaptureError extends Error {
  constructor(
    readonly code: PortfolioMoveCaptureErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PortfolioMoveCaptureError';
  }
}

export interface PortfolioMoveCaptureApi {
  getMe: typeof getMe;
  getPortfolioVaultRevision: typeof getPortfolioVaultRevision;
  getPortfolioVaultLifecycle: typeof getPortfolioVaultLifecycle;
  getVaultMediaState: typeof getVaultMediaState;
  transitionVaultMedia: typeof transitionVaultMedia;
  writeVaultDocument: typeof writeVaultDocument;
  listDividends: typeof listDividends;
  getTaxYearReports: typeof getTaxYearReports;
  getTaxYearReport: typeof getTaxYearReport;
  listStandingOrderRuns: typeof listStandingOrderRuns;
  listAllCashBudgets: typeof listAllCashBudgets;
  getAssetDetail: typeof getAssetDetail;
  getParanoidForkProvenance: typeof getParanoidForkProvenance;
}

export interface PortfolioMoveCaptureDependencies {
  keys: PortfolioVaultKeystore;
  reader: VaultDocEnvelopeReader;
  store: PortfolioStore;
  api: PortfolioMoveCaptureApi;
  now?: () => string;
  id?: () => string;
}

const PRODUCTION_API: PortfolioMoveCaptureApi = {
  getMe,
  getPortfolioVaultRevision,
  getPortfolioVaultLifecycle,
  getVaultMediaState,
  transitionVaultMedia,
  writeVaultDocument,
  listDividends,
  getTaxYearReports,
  getTaxYearReport,
  listStandingOrderRuns,
  listAllCashBudgets,
  getAssetDetail,
  getParanoidForkProvenance,
};

function conflict(message: string, options?: ErrorOptions): PortfolioMoveCaptureError {
  return new PortfolioMoveCaptureError('VAULT_MOVE_STATE_CONFLICT', message, true, options);
}

/**
 * This build writes the server medium only. A Drive-carrying vault cannot be
 * provisioned yet (`PER_VAULT_DRIVE_PROVISIONING_AVAILABLE === false`), so the
 * refusal is a guard against a future flag flip silently producing a move that
 * verifies one medium of two — §7's verified-round-trip rule is per medium.
 */
function requireServerOnlyMedia(vault: VaultConfig): void {
  if (vault.media.length !== 1 || vault.media[0] !== 'server') {
    throw new PortfolioMoveCaptureError(
      'VAULT_MOVE_MEDIA_UNSUPPORTED',
      'This version can move portfolios only for server-stored vaults.',
    );
  }
}

interface PortfolioCaptureRows {
  entities: VaultPortfolioDoc['entities'];
  /** Every referenced asset, market-catalog included, for the common-doc fold. */
  referencedAssets: Map<string, PortfolioAsset>;
}

/**
 * Read the target portfolio's complete restorable graph through the existing
 * read APIs — the per-portfolio re-scope of `buildNormalVaultDocument`
 * (`ui/migration.ts`), row for row, so the two capture boundaries agree by
 * construction: same frozen-tax-fact proofs, same raw run-ledger discipline,
 * same decimal handling. Kinds absent here (`portfolioDailySnapshot`,
 * `portfolioSnapshotState`, `cashBudgetFire`) are derived-and-purged and are
 * re-derived after restore; carrying them is refused by E4's validator.
 */
async function buildPortfolioCaptureRows(input: {
  accountId: string;
  portfolio: PortfolioSummary;
  deviceId: string;
  store: PortfolioStore;
  api: PortfolioMoveCaptureApi;
  now: () => string;
  id: () => string;
  signal?: AbortSignal;
}): Promise<PortfolioCaptureRows> {
  const { accountId, portfolio, store, api, signal } = input;
  const buckets = new Map<VaultEntityKind, VaultEntity[]>();
  const referencedAssets = new Map<string, PortfolioAsset>();
  const append = (
    kind: VaultEntityKind,
    entityId: string,
    data: Record<string, unknown>,
    editedAt = input.now(),
  ) => {
    const parsed = VAULT_ENTITY_ROW_SCHEMAS[kind].parse(data);
    const bucket = buckets.get(kind) ?? [];
    bucket.push({
      id: entityId,
      rev: 1,
      editedAt,
      editedBy: input.deviceId,
      deletedAt: null,
      data: parsed as VaultEntity['data'],
    });
    buckets.set(kind, bucket);
  };
  const refuseImportSource = (source: string, label: string) => {
    if (source.startsWith('import:')) {
      throw new PortfolioMoveCaptureError(
        'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
        `This version cannot capture imported rows losslessly (${label}).`,
      );
    }
  };
  const refuseCustomAsset = (asset: { id: string; isCustom: boolean }) => {
    if (asset.isCustom) {
      throw new PortfolioMoveCaptureError(
        'VAULT_MOVE_MANUAL_ASSETS_UNSUPPORTED',
        `This version cannot capture custom asset ${asset.id} with exact values.`,
      );
    }
  };

  append(
    'portfolio',
    portfolio.id,
    {
      userId: accountId,
      name: portfolio.name,
      visibility: portfolio.visibility,
      sortOrder: portfolio.sortOrder,
      defaultPayFromCash: portfolio.defaultPayFromCash,
      archivedAt: portfolio.archivedAt,
      kind: portfolio.kind ?? null,
      vaultId: null,
      alias: null,
      vaultAlias: null,
    },
    portfolio.archivedAt ?? input.now(),
  );

  const [transactions, cash, dividendList, tax, taxYears] = await Promise.all([
    listAllTransactions(store, portfolio.id, signal),
    listAllCashMovements(store, portfolio.id, signal),
    api.listDividends(portfolio.id, undefined, signal),
    store.getPortfolioTaxSettings(portfolio.id, signal),
    api.getTaxYearReports(portfolio.id, signal),
  ]);
  const reports = await Promise.all(
    taxYears.years.map((year) => api.getTaxYearReport(portfolio.id, year.year, signal)),
  );
  const recordedTax = frozenTaxFacts(reports);

  for (const transaction of transactions) {
    refuseImportSource(transaction.source, `transaction ${transaction.id}`);
    refuseCustomAsset(transaction.asset);
    referencedAssets.set(transaction.asset.id, transaction.asset);
    const taxFact = frozenFactsForTransaction(transaction, recordedTax);
    append(
      'transaction',
      transaction.id,
      {
        portfolioId: portfolio.id,
        assetId: transaction.assetId,
        side: transaction.side,
        quantity: decimal(transaction.quantity),
        price: decimal(transaction.price),
        fee: decimal(transaction.fee),
        executedAt: transaction.executedAt,
        note: transaction.note,
        taxMode: taxFact.taxMode,
        taxCountry: taxFact.taxCountry,
        taxAmountEur: taxFact.taxAmountEur == null ? null : decimal(taxFact.taxAmountEur),
        taxParams: taxFact.taxParams,
        allowUncovered: transaction.allowUncovered,
        uncoveredEntryPrice:
          transaction.uncoveredEntryPrice == null ? null : decimal(transaction.uncoveredEntryPrice),
        source: transaction.source,
      },
      transaction.executedAt,
    );
  }

  for (const source of cash.sources) {
    append(
      'cashSource',
      source.id,
      {
        portfolioId: portfolio.id,
        name: source.name,
        type: source.type,
        isMain: source.isMain,
        archivedAt: source.archivedAt,
        createdAt: source.createdAt,
      },
      source.createdAt,
    );
  }
  for (const movement of cash.movements) {
    refuseImportSource(movement.source, `cash movement ${movement.id}`);
    append(
      'cashMovement',
      movement.id,
      {
        portfolioId: portfolio.id,
        sourceId: movement.sourceId,
        kind: movement.kind,
        amountEur: decimal(movement.amountEur),
        transactionId: movement.transactionId,
        transferId: movement.transferId,
        counterpartSourceId: movement.counterpartSourceId,
        dividendId: movement.dividendId,
        taxYear: movement.taxYear,
        executedAt: movement.executedAt,
        note: movement.note,
        source: movement.source,
        dedupHash: null,
        originalCurrency: movement.originalCurrency ?? null,
        createdAt: movement.createdAt,
      },
      movement.createdAt,
    );
    for (const tagId of movement.tags ?? []) {
      append('cashMovementTag', input.id(), {
        movementId: movement.id,
        tagId,
        createdAt: movement.createdAt,
      });
    }
  }

  for (const dividend of dividendList.dividends) {
    refuseImportSource(dividend.source, `dividend ${dividend.id}`);
    refuseCustomAsset(dividend.asset);
    referencedAssets.set(dividend.asset.id, dividend.asset);
    const taxFact = frozenFactsForDividend(dividend, recordedTax);
    append(
      'dividend',
      dividend.id,
      {
        portfolioId: portfolio.id,
        assetId: dividend.assetId,
        cashSourceId: dividend.cashSourceId,
        grossAmountEur: decimal(dividend.grossAmountEur),
        executedAt: dividend.executedAt,
        note: dividend.note,
        taxMode: dividend.taxMode,
        taxCountry: dividend.taxCountry,
        taxAmountEur: dividend.taxAmountEur == null ? null : decimal(dividend.taxAmountEur),
        taxParams: taxFact.taxParams,
        source: dividend.source,
        createdAt: dividend.createdAt,
      },
      dividend.createdAt,
    );
  }

  if (tax.override != null) {
    append('portfolioSetting', input.id(), {
      portfolioId: portfolio.id,
      key: 'tax',
      value: tax.override,
      updatedAt: input.now(),
    });
  }

  // Standing orders are account-listed; only this portfolio's ride its doc.
  const standingOrders = (await store.listStandingOrders(undefined, signal)).orders.filter(
    (order) => order.portfolioId === portfolio.id,
  );
  for (const order of standingOrders) {
    const assetId = order.assetId;
    if (assetId != null && !referencedAssets.has(assetId)) {
      signal?.throwIfAborted();
      const detail = await api.getAssetDetail(assetId, signal);
      refuseCustomAsset(detail.asset);
      referencedAssets.set(assetId, detail.asset);
    }
  }

  // The authoritative exactly-once run ledger, read RAW for exactly the same
  // duplicate-booking reason recorded in `ui/migration.ts`: a claimed period
  // can legally exist that no order watermark mentions, and move-in purges
  // `standing_order_runs` while move-out restores it from this doc alone.
  const orderIds = new Set(standingOrders.map((order) => order.id));
  const capturedRuns = new Set<string>();
  const runLedger = await api.listStandingOrderRuns(signal);
  for (const run of runLedger.runs) {
    if (!orderIds.has(run.standingOrderId)) continue; // another portfolio's order
    append('standingOrderRun', run.id, {
      standingOrderId: run.standingOrderId,
      periodKey: run.periodKey,
      bookedAt: run.bookedAt,
    });
    capturedRuns.add(runKey(run.standingOrderId, run.periodKey));
  }
  for (const order of standingOrders) {
    if (order.lastPeriodKey != null && !capturedRuns.has(runKey(order.id, order.lastPeriodKey))) {
      throw conflict(
        `The capture read no run row for the booked period ${order.lastPeriodKey} of standing order ${order.id}.`,
      );
    }
    append(
      'standingOrder',
      order.id,
      {
        userId: accountId,
        portfolioId: order.portfolioId,
        kind: order.kind,
        assetId: order.assetId,
        amount: decimal(order.amount),
        currency: order.currency,
        label: order.label,
        cadence: order.cadence,
        anchorDay: order.anchorDay,
        startDate: order.startDate,
        endDate: order.endDate,
        status: order.status,
        lastRunAt: order.lastRunAt,
        lastPeriodKey: order.lastPeriodKey,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      },
      order.updatedAt,
    );
  }

  const budgets = (await api.listAllCashBudgets(signal)).budgets.filter(
    (budget) => budget.portfolioId === portfolio.id,
  );
  for (const budget of budgets) {
    append(
      'cashBudget',
      budget.id,
      {
        portfolioId: budget.portfolioId,
        tagId: budget.tagId,
        periodKey: budget.period,
        amount: decimal(budget.amount),
        currency: budget.currency,
        createdAt: budget.createdAt,
        updatedAt: budget.updatedAt,
      },
      budget.updatedAt,
    );
  }

  return { entities: Object.fromEntries(buckets), referencedAssets };
}

interface CommonDocFold {
  document: VaultCommonDoc;
  changed: boolean;
}

/**
 * Fold the capture's referenced-asset snapshots and this portfolio's
 * severed-fork provenance into the vault's common doc (§9 step 3). Snapshots
 * upsert by asset id under the per-entity rev discipline; provenance merges by
 * the §7.1 content-addressed union and is pruned against the entity union of
 * every doc INCLUDING the new portfolio doc, so an entry naming a live row is
 * never dropped and a stale alias never accumulates.
 */
function foldCommonDocument(input: {
  accountId: string;
  common: VaultCommonDoc;
  referencedAssets: ReadonlyMap<string, PortfolioAsset>;
  capturedProvenance: readonly VaultMirrorProvenance[];
  allEntities: Record<string, VaultEntity[]>;
  deviceId: string;
  now: () => string;
}): CommonDocFold {
  let changed = false;
  const entities: VaultCommonDoc['entities'] = { ...input.common.entities };

  const existingAssets = [...(entities.customAsset ?? [])];
  const byId = new Map(existingAssets.map((entity, index) => [entity.id, index]));
  for (const asset of [...input.referencedAssets.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const data = VAULT_ENTITY_ROW_SCHEMAS.customAsset.parse(
      assetSnapshotRow(asset, input.accountId),
    ) as VaultEntity['data'];
    const index = byId.get(asset.id);
    const existing = index === undefined ? undefined : existingAssets[index];
    if (
      existing &&
      existing.deletedAt === null &&
      JSON.stringify(existing.data) === JSON.stringify(data)
    ) {
      continue;
    }
    const next: VaultEntity = {
      id: asset.id,
      rev: (existing?.rev ?? 0) + 1,
      editedAt: input.now(),
      editedBy: input.deviceId,
      deletedAt: null,
      data,
    };
    if (index === undefined) existingAssets.push(next);
    else existingAssets[index] = next;
    changed = true;
  }
  if (existingAssets.length > 0) entities.customAsset = existingAssets;

  const mergedProvenance = pruneForkProvenance(
    mergeForkProvenance(input.common.mirrorProvenance, input.capturedProvenance),
    input.allEntities,
  );
  const provenanceChanged =
    JSON.stringify(mergedProvenance) !== JSON.stringify(input.common.mirrorProvenance);

  return {
    changed: changed || provenanceChanged,
    document: {
      ...input.common,
      entities,
      mirrorProvenance: mergedProvenance,
    },
  };
}

function entityUnion(
  documents: readonly { entities: Record<string, VaultEntity[]> }[],
): Record<string, VaultEntity[]> {
  const union: Record<string, VaultEntity[]> = {};
  for (const document of documents) {
    for (const [kind, rows] of Object.entries(document.entities)) {
      union[kind] = [...(union[kind] ?? []), ...rows];
    }
  }
  return union;
}

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return encodeBase64Url(new Uint8Array(digest));
}

function currentAttestations(set: DecryptedVaultDocumentSet): PerVaultMediaDocAttestation[] {
  return [set.header.envelope, set.common.envelope, ...set.portfolios.map((p) => p.envelope)].map(
    (envelope) => ({
      docId: envelope.docId,
      docVersion: envelope.docVersion,
      writeId: envelope.writeId,
    }),
  );
}

export function createPortfolioVaultMoveCapture(
  overrides: Partial<PortfolioMoveCaptureDependencies> = {},
): PortfolioVaultMoveCapture {
  const deps: PortfolioMoveCaptureDependencies = {
    keys: overrides.keys ?? endpointVaultKeystore,
    reader: overrides.reader ?? apiVaultDocEnvelopeReader,
    store: overrides.store ?? apiPortfolioStore,
    api: overrides.api ?? PRODUCTION_API,
    now: overrides.now,
    id: overrides.id,
  };
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? uuidv7;

  async function openVaultSet(
    vault: VaultConfig,
    accountId: string,
    expectedPortfolioIds: readonly string[],
  ): Promise<DecryptedVaultDocumentSet> {
    await deps.keys.openStoredVault(
      vault.id,
      async ({ vaultId, signal }) =>
        (await deps.reader.read(vaultId, vault.headerDocId, signal)).envelope,
      vault.keyFingerprint,
    );
    return loadDecryptedVaultDocumentSet({
      vault,
      accountId,
      expectedPortfolioIds,
      keys: deps.keys,
      reader: deps.reader,
    });
  }

  async function refreshServerAttestation(
    vault: VaultConfig,
    docs: readonly PerVaultMediaDocAttestation[],
    expectedMediaAttestedAt: string | null,
  ): Promise<void> {
    await deps.api.transitionVaultMedia(vault.id, {
      transitionId: id(),
      expected: {
        media: [...vault.media],
        driveConnectionId: vault.driveConnectionId,
        mediaAttestedAt: expectedMediaAttestedAt,
      },
      next: { media: [...vault.media], driveConnectionId: vault.driveConnectionId },
      verification: { kind: 'server', docs: [...docs] },
    });
  }

  return {
    async captureMoveIn({ portfolioId, vault, portfolioDataRevision }) {
      requireServerOnlyMedia(vault);
      const me = await deps.api.getMe();
      const deviceId = id();

      const roster = (await deps.store.listPortfolios(undefined, true)).portfolios;
      const portfolio = roster.find((candidate) => candidate.id === portfolioId);
      if (!portfolio) throw conflict('The portfolio to move was not found.');
      if (portfolio.vaultId != null) {
        throw conflict('The portfolio is already stored in a vault.');
      }
      const memberIds = roster
        .filter((candidate) => candidate.vaultId === vault.id)
        .map((candidate) => candidate.id);

      // ── §9 validate-then-accept, with v1's one-rebuild allowance: capture
      // reads WRITE (the cash main-source seed, the tax-year self-heal), so
      // the first build on a fresh portfolio legitimately moves its own token.
      // Each pass opens on the previous settled read; a pass is accepted only
      // when the re-read equals its opening token, so the accepted token's
      // window provably contains the whole accepted build. Every re-read also
      // renews the bounded prospective window. E4 re-derives the same digest
      // under the account lock before deleting anything, so these refusals
      // are courtesy fences, never the safety boundary.
      let openingRevision = portfolioDataRevision;
      let rows: PortfolioCaptureRows | null = null;
      let capturedProvenance: VaultMirrorProvenance[] = [];
      for (let attempt = 1; attempt <= 2 && rows === null; attempt += 1) {
        const built = await buildPortfolioCaptureRows({
          accountId: me.id,
          portfolio,
          deviceId,
          store: deps.store,
          api: deps.api,
          now,
          id,
        });
        const builtProvenance = (await deps.api.getParanoidForkProvenance()).provenance.filter(
          (entry) => entry.portfolioId === portfolioId,
        );
        const settled = await deps.api.getPortfolioVaultRevision(portfolioId);
        if (settled.importBatchCount > 0) {
          throw new PortfolioMoveCaptureError(
            'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
            'This version cannot capture the portfolio’s historical import batches losslessly.',
          );
        }
        if (settled.portfolioDataRevision === openingRevision) {
          rows = built;
          capturedProvenance = builtProvenance;
        } else {
          // Carry the closing token into the next pass as its opening one;
          // nothing runs between the two reads.
          openingRevision = settled.portfolioDataRevision;
        }
      }
      if (rows === null) {
        throw new PortfolioMoveCaptureError(
          'VAULT_MOVE_CAPTURE_UNSTABLE',
          'The portfolio kept changing while its encrypted copy was being prepared. Try again.',
          true,
        );
      }

      // ── Open the vault and read the exact current encrypted doc set.
      const set = await openVaultSet(vault, me.id, memberIds);
      const accountBinding = await deriveAccountBinding(me.id);

      const portfolioDocument: VaultPortfolioDoc = vaultPortfolioDocSchema.parse({
        schemaVersion: VAULT_DOC_SCHEMA_VERSION,
        portfolioId,
        entities: rows.entities,
        mergeLog: [],
      });

      const fold = foldCommonDocument({
        accountId: me.id,
        common: set.common.document,
        referencedAssets: rows.referencedAssets,
        capturedProvenance,
        allEntities: entityUnion([
          set.common.document,
          ...set.portfolios.map(({ document }) => document),
          portfolioDocument,
        ]),
        deviceId,
        now,
      });
      const commonDocument = vaultCommonDocSchema.parse(fold.document);

      const rosterEntry = { id: portfolioId, name: portfolio.name };
      const priorRoster = set.header.document.portfolios;
      const headerChanged = !priorRoster.some(
        (entry) => entry.id === rosterEntry.id && entry.name === rosterEntry.name,
      );
      const headerDocument: VaultHeaderDoc = vaultHeaderDocSchema.parse({
        ...set.header.document,
        portfolios: [...priorRoster.filter((entry) => entry.id !== portfolioId), rosterEntry],
      });

      const encrypted = await deps.keys.withContentKey(
        vault.id,
        async (contentKey, keyId, assertSessionCurrent) => {
          const base = {
            keyId,
            keySlots: set.header.envelope.keySlots,
            vaultId: vault.id,
            accountBinding,
            schemaVersion: VAULT_DOC_SCHEMA_VERSION,
            deviceId,
            writtenAt: now(),
          };
          const encryptDoc = async (
            document: unknown,
            docId: string,
            docKind: 'header' | 'common' | 'portfolio',
            docVersion: number,
          ): Promise<EncryptedVaultDoc> => {
            const plaintext = utf8(JSON.stringify(document));
            try {
              return await encryptVaultDoc({
                plaintext,
                contentKey,
                header: { ...base, docId, docKind, docVersion, writeId: id() },
              });
            } finally {
              zeroBytes(plaintext);
            }
          };
          const result = {
            portfolio: await encryptDoc(portfolioDocument, portfolioId, 'portfolio', 1),
            header: headerChanged
              ? await encryptDoc(
                  headerDocument,
                  set.header.envelope.docId,
                  'header',
                  set.header.envelope.docVersion + 1,
                )
              : null,
            common: fold.changed
              ? await encryptDoc(
                  commonDocument,
                  set.common.envelope.docId,
                  'common',
                  set.common.envelope.docVersion + 1,
                )
              : null,
          };
          assertSessionCurrent();
          return result;
        },
      );

      try {
        // ── The prospective portfolio write needs a CURRENT full-set proof to
        // bind its capture admission; a prior failed attempt leaves it nulled.
        const mediaState = await deps.api.getVaultMediaState(vault.id);
        if (
          mediaState.media.length !== 1 ||
          mediaState.media[0] !== 'server' ||
          mediaState.driveConnectionId !== null
        ) {
          throw conflict('The vault media configuration changed during the capture.');
        }
        if (mediaState.mediaAttestedAt === null) {
          await refreshServerAttestation(vault, currentAttestations(set), null);
        }

        // ── Writes, strictly ordered: the portfolio doc FIRST (its admission
        // binds the capture and invalidates the full-set proof), then the
        // header roster, then the common fold — each under the E1 HTTP CAS.
        await deps.api.writeVaultDocument(vault.id, portfolioId, encrypted.portfolio.envelope, {
          ifVersion: null,
        });
        if (encrypted.header) {
          await deps.api.writeVaultDocument(
            vault.id,
            set.header.envelope.docId,
            encrypted.header.envelope,
            { ifVersion: set.header.envelope.docVersion },
          );
        }
        if (encrypted.common) {
          await deps.api.writeVaultDocument(
            vault.id,
            set.common.envelope.docId,
            encrypted.common.envelope,
            { ifVersion: set.common.envelope.docVersion },
          );
        }

        // ── §7 rule 1: verified round trip per written doc, byte for byte.
        for (const written of [encrypted.portfolio, encrypted.header, encrypted.common]) {
          if (!written) continue;
          const readBack = await deps.reader.read(vault.id, written.header.docId);
          if (
            readBack.header.writeId !== written.header.writeId ||
            readBack.header.docVersion !== written.header.docVersion ||
            !equalBytes(readBack.envelope, written.envelope)
          ) {
            throw new PortfolioMoveCaptureError(
              'VAULT_MOVE_VERIFY_FAILED',
              `The encrypted ${written.header.docKind} document did not read back verbatim.`,
              true,
            );
          }
        }

        // ── Re-attest the completed roster: exactly what E4's destructive
        // commit checks as `mediaReady`/`exactRoster` before the purge.
        const finalDocs: PerVaultMediaDocAttestation[] = [
          ...[
            encrypted.header?.header ?? set.header.envelope,
            encrypted.common?.header ?? set.common.envelope,
            ...set.portfolios.map(({ envelope }) => envelope),
            encrypted.portfolio.header,
          ].map((header: VaultDocEnvelopeHeader) => ({
            docId: header.docId,
            docVersion: header.docVersion,
            writeId: header.writeId,
          })),
        ];
        await refreshServerAttestation(vault, finalDocs, null);

        return {
          docVersion: encrypted.portfolio.header.docVersion,
          portfolioDataRevision: openingRevision,
        };
      } finally {
        zeroBytes(encrypted.portfolio.envelope);
        if (encrypted.header) zeroBytes(encrypted.header.envelope);
        if (encrypted.common) zeroBytes(encrypted.common.envelope);
      }
    },

    async captureMoveOut({ portfolioId, vault }) {
      requireServerOnlyMedia(vault);
      const me = await deps.api.getMe();
      const deviceId = id();

      // The server-minted lifecycle the challenge and commit proofs bind to —
      // readable by any owning session, because the exit is designed for any
      // unlocked device holding the phrase (§10), not only the one that moved
      // the portfolio in.
      const lifecycle = await deps.api.getPortfolioVaultLifecycle(portfolioId);
      if (lifecycle.vaultId !== vault.id) {
        throw conflict('The portfolio is stored in a different vault.');
      }

      const roster = (await deps.store.listPortfolios(undefined, true)).portfolios;
      const memberIds = roster
        .filter((candidate) => candidate.vaultId === vault.id)
        .map((candidate) => candidate.id);
      if (!memberIds.includes(portfolioId)) {
        throw conflict('The portfolio is no longer a member of this vault.');
      }

      const set = await openVaultSet(vault, me.id, memberIds);

      // The client half of E4's roster CAS: hash the exact opened encrypted
      // version set. The challenge AND the commit both compare this value with
      // the locked current roster, so an older unlocked device can never
      // archive a newer encrypted graph.
      const envelopes = [
        set.header.envelope,
        set.common.envelope,
        ...set.portfolios.map(({ envelope }) => envelope),
      ];
      const documentSetHash = await sha256Base64Url(
        serializeVaultRetirementVersionSet(
          envelopes.map(({ docId, docVersion }) => ({ docId, docVersion })),
        ),
      );

      const portfolioEntry = set.portfolios.find(
        ({ envelope, document }) =>
          envelope.docId === portfolioId && document.portfolioId === portfolioId,
      );
      if (!portfolioEntry) {
        throw conflict('The vault document set has no document for this portfolio.');
      }
      const portfolioSet: DecryptedPortfolioDocumentSet = {
        vaultId: set.vaultId,
        portfolioId,
        header: set.header,
        common: set.common,
        portfolio: portfolioEntry,
      };

      // The common doc's proof key must be the vault's registered verifier —
      // the same immutable public key E4 checks the transcript against.
      const proof = set.common.document.clientSecurity.retirementProof;
      if (proof.publicKey !== vault.retirementProofPublicKey) {
        throw conflict('The encrypted proof key does not match the vault’s registered verifier.');
      }

      const document = await buildPortfolioVaultRestoreDocument(
        {
          userId: me.id,
          portfolioId,
          deviceId,
          documentSet: portfolioSet,
        },
        {
          keys: deps.keys,
          // The authoritative freshness CAS on this path is `documentSetHash`
          // above, which E4 compares with the LOCKED current roster at both
          // the challenge and the commit. This capture holds the one loaded
          // set for its whole (single-shot) lifetime, so identity is the
          // correct client-side check; a background sync engine for per-vault
          // docs does not exist in this build.
          isDocumentSetCurrent: (candidate) => candidate === portfolioSet,
          resolveManualAssetSnapshots: undefined,
        },
      );
      const documentDigest = await sha256Base64Url(
        serializePortfolioVaultRestoreDocument(document),
      );

      return {
        lifecycleGeneration: lifecycle.lifecycleGeneration,
        documentDigest,
        documentSetHash,
        document,
        // Prove possession of the vault over E4's exact challenge bytes: an
        // Ed25519 signature with the retirement-proof PRIVATE key that exists
        // only inside the encrypted common doc, over the SAME domain-separated
        // transcript `verifyPortfolioVaultMoveOutPhraseProof` reconstructs
        // server-side (contracts `serializePortfolioVaultMoveOutProofTranscript`).
        sign: async (challenge: string) => {
          const privateKeyDer = decodeBase64Url(proof.privateKey);
          try {
            const key = await crypto.subtle.importKey(
              'pkcs8',
              privateKeyDer.slice().buffer as ArrayBuffer,
              { name: 'Ed25519' },
              false,
              ['sign'],
            );
            const transcript = serializePortfolioVaultMoveOutProofTranscript({
              portfolioId,
              vaultId: vault.id,
              lifecycleGeneration: lifecycle.lifecycleGeneration,
              documentDigest,
              documentSetHash,
              challenge,
            });
            const signature = await crypto.subtle.sign(
              'Ed25519',
              key,
              transcript.slice().buffer as ArrayBuffer,
            );
            return encodeBase64Url(new Uint8Array(signature));
          } finally {
            zeroBytes(privateKeyDer);
          }
        },
      };
    },
  };
}
