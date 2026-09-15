import { uuidv7 } from 'uuidv7';

import {
  CUSTOM_ASSET_VAULT_SNAPSHOT_ERROR_CODES,
  PER_VAULT_ERROR_CODES,
  PORTFOLIO_VAULT_IMPORT_CAPTURE_PAGE_MAX,
  PORTFOLIO_VAULT_TRANSITION_ERROR_CODES,
  VAULT_DOC_SCHEMA_VERSION,
  VAULT_ENTITY_ROW_SCHEMAS,
  serializePortfolioVaultMoveOutProofTranscript,
  serializePortfolioVaultRestoreDocument,
  serializeVaultRetirementVersionSet,
  vaultCommonDocSchema,
  vaultHeaderDocSchema,
  vaultPortfolioDocSchema,
  type CustomAssetVaultSnapshot,
  type PerVaultMediaDocAttestation,
  type PortfolioAsset,
  type PortfolioSummary,
  type PortfolioVaultImportCaptureResponse,
  type VaultCommonDoc,
  type VaultConfig,
  type VaultDocEnvelopeHeader,
  type VaultEntity,
  type VaultEntityKind,
  type VaultHeaderDoc,
  type VaultMirrorProvenance,
  type VaultPortfolioDoc,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { getAssetDetail } from '../../lib/assetApi';
import { listAllCashBudgets } from '../../lib/cashApi';
import {
  getCustomAssetVaultSnapshots,
  getTaxYearReport,
  getTaxYearReports,
  listDividends,
} from '../../lib/portfolioApi';
import { apiPortfolioStore, type PortfolioStore } from '../../lib/portfolioStore';
import { listStandingOrderRuns } from '../../lib/standingOrdersApi';
import { getMe, getParanoidForkProvenance } from '../../lib/userApi';
import {
  getPortfolioVaultLifecycle,
  getPortfolioVaultRevision,
  getVaultMediaState,
  listPortfolioVaultImportBatches,
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
import {
  buildPortfolioVaultRestoreDocument,
  type ManualAssetSnapshotResolver,
} from './portfolioRestoreDocument';
import {
  decimal,
  frozenFactsForDividend,
  frozenFactsForTransaction,
  frozenTaxFacts,
  listAllCashMovements,
  listAllTransactions,
  runKey,
  type FrozenTaxFacts,
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
 * Deliberate fail-closed limits, each surfaced before anything destructive:
 *  - Drive-carrying vaults are refused (no per-vault Drive provisioning —
 *    `PER_VAULT_DRIVE_PROVISIONING_AVAILABLE === false` — so none can exist).
 *  - Historical import batches and owner-manual (custom) assets were refused
 *    by the #1528 ruling (§16 2026-08-28) because no lossless read path
 *    existed. #1529 supplies both seams — the paged import-capture read and
 *    the exact manual-asset snapshot read — and the refusals now lift BY
 *    CAPABILITY: when a seam is absent from `PortfolioMoveCaptureApi` the
 *    pre-#1529 refusal is byte-identical, and when it is present the capture
 *    still refuses anything it cannot prove lossless (a served row the
 *    document contract would degrade, a batch set that disagrees with the
 *    settled revision, a referenced asset the server does not hold as the
 *    owner's manual asset). The refusal machinery stays for future gaps.
 *  - A portfolio carrying a legacy `country_specific` row with NO frozen
 *    country is refused with its own typed code — see
 *    `refuseLegacyNullCountryTaxRows` for the shape and its migration path.
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
  /**
   * Legacy V3-P4 rows freeze `country_specific` with NO country; the client
   * vault contract has no representation for them (see
   * `refuseLegacyNullCountryTaxRows`). Needs the backfill migration, not a
   * retry.
   */
  'VAULT_MOVE_LEGACY_TAX_FACTS_UNSUPPORTED',
  /** Concurrent writer / stale roster / lifecycle mismatch; nothing committed. */
  'VAULT_MOVE_STATE_CONFLICT',
  /** A written document did not read back byte-identical. */
  'VAULT_MOVE_VERIFY_FAILED',
  /**
   * TERMINAL for this caller (#1530). The server's exact-set attestation
   * refused because another portfolio's interrupted move-in left a prospective
   * blob staged in this vault. No readback of THIS portfolio's documents can
   * ever satisfy it, so the honest answer is the named blocker and its remedy —
   * finish or cancel that move — not an invitation to retry.
   */
  'VAULT_MOVE_CAPTURE_IN_FLIGHT',
] as const;

export type PortfolioMoveCaptureErrorCode = (typeof PORTFOLIO_MOVE_CAPTURE_ERROR_CODES)[number];

export class PortfolioMoveCaptureError extends Error {
  constructor(
    readonly code: PortfolioMoveCaptureErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions & {
      /**
       * Display names of the portfolios whose in-flight move blocks this one
       * (`VAULT_MOVE_CAPTURE_IN_FLIGHT`). Names, not ids: this reaches a user.
       * An id the roster cannot name is carried through verbatim rather than
       * dropped — a blocker the surface cannot name is still a blocker.
       */
      blockingPortfolios?: readonly string[];
    },
  ) {
    super(message, options);
    this.name = 'PortfolioMoveCaptureError';
    this.blockingPortfolios = options?.blockingPortfolios ?? [];
  }

  readonly blockingPortfolios: readonly string[];
}

/**
 * Translate the server's `VAULT_MEDIA_CAPTURE_IN_FLIGHT` 412 (#1530) into this
 * module's own terminal refusal, or `null` when the cause is something else.
 *
 * The distinction is the whole point of the split 412 vocabulary: a
 * `VAULT_MEDIA_VERIFICATION_FAILED` is worth another attempt with a fresh
 * readback, while this one never is — the gap is a prospective blob belonging
 * to a DIFFERENT portfolio, which no readback of this portfolio's documents can
 * account for. Before this translation the user saw an undifferentiated
 * failure and could only retry forever.
 */
function captureInFlightRefusal(
  cause: unknown,
  nameFor: (portfolioId: string) => string,
): PortfolioMoveCaptureError | null {
  if (!(cause instanceof ApiError) || cause.code !== PER_VAULT_ERROR_CODES.mediaCaptureInFlight) {
    return null;
  }
  const details = cause.details;
  const ids =
    typeof details === 'object' && details !== null && 'portfolioIds' in details
      ? (details as { portfolioIds?: unknown }).portfolioIds
      : undefined;
  const blockingPortfolios = Array.isArray(ids)
    ? ids.filter((value): value is string => typeof value === 'string').map(nameFor)
    : [];
  return new PortfolioMoveCaptureError(
    'VAULT_MOVE_CAPTURE_IN_FLIGHT',
    'Another portfolio has an unfinished move into this vault; finish or cancel it first.',
    false,
    { cause, blockingPortfolios },
  );
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
  /**
   * #1529 capability seams. Optional ON PURPOSE: their absence keeps the
   * #1528 fail-closed refusals in force exactly as shipped; production always
   * supplies both. A harness toggles them to prove the refusal machinery is
   * lifted, not deleted.
   */
  listPortfolioVaultImportBatches?: typeof listPortfolioVaultImportBatches;
  getCustomAssetVaultSnapshots?: typeof getCustomAssetVaultSnapshots;
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
  listPortfolioVaultImportBatches,
  getCustomAssetVaultSnapshots,
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

/** Enough named rows for the owner to find them; the rest are counted. */
const LEGACY_TAX_ROW_SAMPLE = 5;

/**
 * The legacy V3-P4 frozen shape: `taxMode = 'country_specific'` with
 * `taxCountry = null`. `drizzle/0021_tax_engine.sql` added the column without a
 * backfill, so rows settled before it carry the mode and no country.
 *
 * Server-side that shape is NOT ambiguous: `frozenTaxCountryEngine(null)`
 * resolves it to AT (the `rowEngineCountry` legacy rule), and the #1512 shared
 * row-engine classifier and its committed vectors pin that reading. The CLIENT
 * vault contract has no such fallback — `assertProvenTaxFacts`
 * (`ui/migration.ts`), the strict restore contract, the server's rehydration
 * validator and the snapshot gate (`engine/session.ts validateFrozenTaxShape`)
 * all require a country whenever the mode is `country_specific`, because a
 * vault document is the only remaining copy and a mode without its country
 * cannot be settled twice the same way by construction.
 *
 * MIGRATION PATH (the recommended fix, deliberately NOT done here): a one-off
 * backfill migration
 * `UPDATE transactions/dividends SET tax_country = 'AT' WHERE tax_mode = 'country_specific' AND tax_country IS NULL`
 * — it writes down exactly what the engine already reads, so there is one
 * source of truth and no capture-time rewriting of frozen facts. Rewriting the
 * fact on the way into the vault was rejected: capture must carry what the
 * server holds, byte for byte, or move-out cannot restore it. Until that
 * migration ships, the honest answer is this typed refusal — named rows, zero
 * writes — rather than the untyped `Error` the row-schema parse used to raise.
 * Recorded in `docs/paranoid-design.md` §9.
 */
function isLegacyNullCountryTaxRow(facts: {
  taxMode: string | null;
  taxCountry: string | null;
}): boolean {
  return facts.taxMode === 'country_specific' && facts.taxCountry === null;
}

/**
 * Scan the whole capture set BEFORE a single row is appended (and therefore
 * long before any ciphertext write), so the refusal can name every offending
 * row instead of dying on whichever one the loop reached first.
 */
function refuseLegacyNullCountryTaxRows(
  transactions: readonly { id: string; side: string }[],
  dividends: readonly { id: string; taxMode: string | null; taxCountry: string | null }[],
  recorded: Map<string, FrozenTaxFacts>,
): void {
  const offenders: string[] = [];
  for (const transaction of transactions) {
    if (transaction.side !== 'sell') continue;
    const facts = recorded.get(transaction.id);
    if (facts !== undefined && isLegacyNullCountryTaxRow(facts)) {
      offenders.push(`sell ${transaction.id}`);
    }
  }
  for (const dividend of dividends) {
    const facts = recorded.get(dividend.id);
    if (
      isLegacyNullCountryTaxRow(dividend) ||
      (facts !== undefined && isLegacyNullCountryTaxRow(facts))
    ) {
      offenders.push(`dividend ${dividend.id}`);
    }
  }
  if (offenders.length === 0) return;
  const named = offenders.slice(0, LEGACY_TAX_ROW_SAMPLE).join(', ');
  const rest = offenders.length - LEGACY_TAX_ROW_SAMPLE;
  throw new PortfolioMoveCaptureError(
    'VAULT_MOVE_LEGACY_TAX_FACTS_UNSUPPORTED',
    `This portfolio has ${offenders.length} legacy row(s) that record a country-specific tax mode with no country and cannot be captured: ${named}${rest > 0 ? ` and ${rest} more` : ''}.`,
  );
}

interface PortfolioCaptureRows {
  entities: VaultPortfolioDoc['entities'];
  /** Every referenced MARKET-catalog asset, for the client-only common-doc snapshot. */
  referencedAssets: Map<string, PortfolioAsset>;
  /**
   * Every referenced owner-manual asset as the EXACT server row + value set
   * (#1529) — the common-doc fold writes these verbatim, never the DTO.
   */
  manualAssets: Map<string, CustomAssetVaultSnapshot>;
  /** Batches captured through the lossless read, or null when the seam is absent. */
  capturedImportBatchCount: number | null;
}

/** Structural JSON equality: key order is irrelevant, array order and values are not. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  const leftKeys = Object.keys(left as object).filter(
    (key) => (left as Record<string, unknown>)[key] !== undefined,
  );
  const rightKeys = Object.keys(right as object).filter(
    (key) => (right as Record<string, unknown>)[key] !== undefined,
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        rightKeys.includes(key) &&
        sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

/**
 * Read the exact manual-asset seam, translating its typed refusals (a stored
 * row that cannot be served exactly, or a value set too large for one read)
 * into the manual-asset move refusal — never a raw transport error.
 */
async function readManualAssetSnapshots(
  read: NonNullable<PortfolioMoveCaptureApi['getCustomAssetVaultSnapshots']>,
  assetIds: readonly string[],
  signal?: AbortSignal,
) {
  try {
    return await read(assetIds, signal);
  } catch (cause) {
    if (
      cause instanceof ApiError &&
      (Object.values(CUSTOM_ASSET_VAULT_SNAPSHOT_ERROR_CODES) as string[]).includes(cause.code)
    ) {
      throw new PortfolioMoveCaptureError(
        'VAULT_MOVE_MANUAL_ASSETS_UNSUPPORTED',
        'This version cannot capture a manual asset exactly: the server could not serve its current state losslessly.',
        false,
        { cause },
      );
    }
    throw cause;
  }
}

/**
 * Read EVERY page of the lossless import-capture seam. The batch list rides on
 * every page; a page whose batch list differs from the first proves the set
 * moved mid-read, which the revision CAS would refuse anyway — refuse here
 * first, before the document is even assembled.
 */
async function readAllImportBatches(
  read: NonNullable<PortfolioMoveCaptureApi['listPortfolioVaultImportBatches']>,
  portfolioId: string,
  signal?: AbortSignal,
): Promise<PortfolioVaultImportCaptureResponse> {
  let cursor: string | undefined;
  let batches: PortfolioVaultImportCaptureResponse['batches'] | null = null;
  const rows: PortfolioVaultImportCaptureResponse['rows'] = [];
  const seenRowIds = new Set<string>();
  do {
    signal?.throwIfAborted();
    let page: PortfolioVaultImportCaptureResponse;
    try {
      page = await read(
        portfolioId,
        {
          ...(cursor === undefined ? {} : { cursor }),
          limit: PORTFOLIO_VAULT_IMPORT_CAPTURE_PAGE_MAX,
        },
        signal,
      );
    } catch (cause) {
      // The server's typed answer for a stored row it cannot serve exactly
      // (review F2): the portfolio's import history is not losslessly
      // capturable — the same refusal class as a row the document contract
      // would degrade, never a "your request was invalid".
      if (
        cause instanceof ApiError &&
        cause.code === PORTFOLIO_VAULT_TRANSITION_ERROR_CODES.captureUnservable
      ) {
        throw new PortfolioMoveCaptureError(
          'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
          'This version cannot capture the portfolio’s import history losslessly: a stored staging row cannot be served exactly.',
          false,
          { cause },
        );
      }
      throw cause;
    }
    if (batches === null) batches = page.batches;
    else if (!sameJson(batches, page.batches)) {
      throw conflict('The portfolio’s import batches changed while they were being captured.');
    }
    for (const row of page.rows) {
      if (seenRowIds.has(row.id)) {
        throw conflict('The import-capture read served a staging row twice.');
      }
      seenRowIds.add(row.id);
      rows.push(row);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { batches: batches ?? [], rows, nextCursor: null };
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
  const manualAssetIds = new Set<string>();
  const importCapture = api.listPortfolioVaultImportBatches;
  const manualCapture = api.getCustomAssetVaultSnapshots;
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
  /**
   * The lossless-or-refuse discipline for served import rows: the document
   * contract tolerates malformed staging fields by degrading them to null
   * (`.catch(null)` in `vault.ts`) so a cosmetic suggestion can never lock a
   * portfolio out of restore — but a CAPTURE must never rely on that: a row
   * the contract would degrade is a row this capture cannot carry, and the
   * §9 purge would then delete what the document never held.
   */
  const appendLossless = (
    kind: 'importBatch' | 'importRow',
    entityId: string,
    data: Record<string, unknown>,
    editedAt: string,
  ) => {
    const parsed = VAULT_ENTITY_ROW_SCHEMAS[kind].safeParse(data);
    if (!parsed.success || !sameJson(parsed.data, data)) {
      throw new PortfolioMoveCaptureError(
        'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
        `This version cannot capture ${kind === 'importBatch' ? 'import batch' : 'import row'} ${entityId} losslessly.`,
      );
    }
    append(kind, entityId, data, editedAt);
  };
  // Capability-gated refusals (#1529): byte-identical to the #1528 ruling
  // while the corresponding read seam is absent.
  const refuseImportSource = (source: string, label: string) => {
    if (importCapture === undefined && source.startsWith('import:')) {
      throw new PortfolioMoveCaptureError(
        'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
        `This version cannot capture imported rows losslessly (${label}).`,
      );
    }
  };
  const refuseCustomAsset = (asset: { id: string; isCustom: boolean }) => {
    if (!asset.isCustom) return;
    if (manualCapture === undefined) {
      throw new PortfolioMoveCaptureError(
        'VAULT_MOVE_MANUAL_ASSETS_UNSUPPORTED',
        `This version cannot capture custom asset ${asset.id} with exact values.`,
      );
    }
    manualAssetIds.add(asset.id);
  };
  /** Market assets snapshot from the DTO; owner-manual ones only through the exact seam. */
  const reference = (asset: PortfolioAsset) => {
    refuseCustomAsset(asset);
    if (!asset.isCustom) referencedAssets.set(asset.id, asset);
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
  refuseLegacyNullCountryTaxRows(transactions, dividendList.dividends, recordedTax);

  for (const transaction of transactions) {
    refuseImportSource(transaction.source, `transaction ${transaction.id}`);
    reference(transaction.asset);
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
    reference(dividend.asset);
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
    if (assetId != null && !referencedAssets.has(assetId) && !manualAssetIds.has(assetId)) {
      signal?.throwIfAborted();
      const detail = await api.getAssetDetail(assetId, signal);
      reference(detail.asset);
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

  // ── #1529: historical import batches ride the doc (the §9 table row).
  let capturedImportBatchCount: number | null = null;
  if (importCapture !== undefined) {
    const captured = await readAllImportBatches(importCapture, portfolio.id, signal);
    const batchCreatedAt = new Map<string, string>();
    for (const batch of captured.batches) {
      if (batch.data.portfolioId !== portfolio.id || batch.data.ownerId !== accountId) {
        throw conflict(`The import-capture read served batch ${batch.id} of another portfolio.`);
      }
      if (batch.data.status !== 'applied') {
        // E4 refuses the commit on a pending import anyway (PENDING_IMPORT);
        // say so here, before any ciphertext write, as the same fixable state.
        throw conflict(
          `Import batch ${batch.id} is still pending; apply or delete it before moving the portfolio.`,
        );
      }
      if (batchCreatedAt.has(batch.id)) {
        throw conflict(`The import-capture read served batch ${batch.id} twice.`);
      }
      batchCreatedAt.set(batch.id, batch.data.createdAt);
      appendLossless(
        'importBatch',
        batch.id,
        batch.data,
        batch.data.appliedAt ?? batch.data.createdAt,
      );
    }
    for (const row of captured.rows) {
      const createdAt = batchCreatedAt.get(row.data.batchId);
      if (createdAt === undefined) {
        throw conflict(`The import-capture read served row ${row.id} of a batch it did not list.`);
      }
      appendLossless('importRow', row.id, row.data, createdAt);
      const assetId = row.data.assetId;
      if (assetId !== null && !referencedAssets.has(assetId) && !manualAssetIds.has(assetId)) {
        // A staged row may reference an instrument nothing else in the
        // portfolio touched; E4's restore re-resolves catalog ones and needs
        // the owner-manual ones restated, so classify it like a standing order.
        signal?.throwIfAborted();
        const detail = await api.getAssetDetail(assetId, signal);
        reference(detail.asset);
      }
    }
    capturedImportBatchCount = captured.batches.length;
  }

  // ── #1529: owner-manual assets fold as the EXACT server row + value set.
  const manualAssets = new Map<string, CustomAssetVaultSnapshot>();
  if (manualAssetIds.size > 0) {
    if (manualCapture === undefined)
      throw new Error('unreachable: manual assets were refused above');
    const ids = [...manualAssetIds].sort();
    const snapshots = await readManualAssetSnapshots(manualCapture, ids, signal);
    const present = new Map(snapshots.present.map((snapshot) => [snapshot.id, snapshot]));
    for (const assetId of ids) {
      const snapshot = present.get(assetId);
      if (
        snapshot === undefined ||
        snapshot.asset.ownerId !== accountId ||
        snapshot.asset.providerId !== 'manual' ||
        snapshot.asset.providerRef !== assetId ||
        snapshot.values.some((value) => value.assetId !== assetId)
      ) {
        // Not held server-side as THIS owner's manual asset: E4's restore
        // would refuse the restatement, so the capture refuses first.
        throw new PortfolioMoveCaptureError(
          'VAULT_MOVE_MANUAL_ASSETS_UNSUPPORTED',
          `Custom asset ${assetId} is not held by the server as one of your own manual assets.`,
        );
      }
      manualAssets.set(assetId, snapshot);
    }
  }

  return {
    entities: Object.fromEntries(buckets),
    referencedAssets,
    manualAssets,
    capturedImportBatchCount,
  };
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
  manualAssets: ReadonlyMap<string, CustomAssetVaultSnapshot>;
  capturedProvenance: readonly VaultMirrorProvenance[];
  allEntities: Record<string, VaultEntity[]>;
  deviceId: string;
  now: () => string;
  id: () => string;
}): CommonDocFold {
  let changed = false;
  const entities: VaultCommonDoc['entities'] = { ...input.common.entities };

  const existingAssets = [...(entities.customAsset ?? [])];
  const byId = new Map(existingAssets.map((entity, index) => [entity.id, index]));
  const upsertAsset = (assetId: string, data: VaultEntity['data']) => {
    const index = byId.get(assetId);
    const existing = index === undefined ? undefined : existingAssets[index];
    if (existing && existing.deletedAt === null && sameJson(existing.data, data)) return;
    const next: VaultEntity = {
      id: assetId,
      rev: (existing?.rev ?? 0) + 1,
      editedAt: input.now(),
      editedBy: input.deviceId,
      deletedAt: null,
      data,
    };
    if (index === undefined) {
      byId.set(assetId, existingAssets.length);
      existingAssets.push(next);
    } else {
      existingAssets[index] = next;
    }
    changed = true;
  };
  const sortedIds = (ids: Iterable<string>) =>
    [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const assetId of sortedIds(input.referencedAssets.keys())) {
    upsertAsset(
      assetId,
      VAULT_ENTITY_ROW_SCHEMAS.customAsset.parse(
        assetSnapshotRow(input.referencedAssets.get(assetId)!, input.accountId),
      ) as VaultEntity['data'],
    );
  }
  // #1529: the owner's manual assets fold as the EXACT server rows, and their
  // live value set in this doc is made equal to the server's — a stale close
  // is replaced under the same entity id, a missing date is added, and a
  // date the server no longer holds is tombstoned. For a server-present
  // asset the server IS the fact E4 compares at restore (`COMMON_FACT_CONFLICT`).
  const existingValues = [...(entities.customAssetValue ?? [])];
  for (const assetId of sortedIds(input.manualAssets.keys())) {
    const snapshot = input.manualAssets.get(assetId)!;
    upsertAsset(
      assetId,
      VAULT_ENTITY_ROW_SCHEMAS.customAsset.parse(snapshot.asset) as VaultEntity['data'],
    );
    const liveByDate = new Map<string, number>();
    existingValues.forEach((entity, index) => {
      if (entity.deletedAt === null && entity.data.assetId === assetId) {
        liveByDate.set(String(entity.data.date), index);
      }
    });
    const servedDates = new Set<string>();
    for (const value of snapshot.values) {
      servedDates.add(value.date);
      const data = VAULT_ENTITY_ROW_SCHEMAS.customAssetValue.parse(value) as VaultEntity['data'];
      const index = liveByDate.get(value.date);
      const existing = index === undefined ? undefined : existingValues[index];
      if (existing && sameJson(existing.data, data)) continue;
      const next: VaultEntity = {
        id: existing?.id ?? input.id(),
        rev: (existing?.rev ?? 0) + 1,
        editedAt: input.now(),
        editedBy: input.deviceId,
        deletedAt: null,
        data,
      };
      if (index === undefined) existingValues.push(next);
      else existingValues[index] = next;
      changed = true;
    }
    for (const [date, index] of liveByDate) {
      if (servedDates.has(date)) continue;
      const stale = existingValues[index]!;
      existingValues[index] = {
        ...stale,
        rev: stale.rev + 1,
        editedAt: input.now(),
        editedBy: input.deviceId,
        deletedAt: input.now(),
      };
      changed = true;
    }
  }
  if (existingAssets.length > 0) entities.customAsset = existingAssets;
  if (existingValues.length > 0) entities.customAssetValue = existingValues;

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
    plainOwnedPortfolioIds: readonly string[],
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
      // §9's capture-then-refused-commit leaves the header roster one entry
      // ahead of the server membership. The loader tolerates exactly that
      // provable in-flight shape (#1528 F1) so a refused commit never wedges
      // the vault; this capture then converges by rewriting the prospective
      // document idempotently.
      plainOwnedPortfolioIds,
      keys: deps.keys,
      reader: deps.reader,
    });
  }

  /**
   * One E1 CAS write through the raw `vaultApi` seam, with the 412 translated
   * into the capture's own typed channel (#1528 F4): a concurrent writer is a
   * retryable state conflict of THIS operation, never a raw transport error
   * leaking into the wizard.
   */
  async function writeDocument(
    vaultId: string,
    docId: string,
    envelope: Uint8Array,
    options: { ifVersion: number | null },
  ): Promise<void> {
    try {
      await deps.api.writeVaultDocument(vaultId, docId, envelope, options);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'VAULT_DOCUMENT_CAS_CONFLICT') {
        throw conflict('Another writer changed the vault documents during the capture.', {
          cause,
        });
      }
      throw cause;
    }
  }

  async function refreshServerAttestation(
    vault: VaultConfig,
    docs: readonly PerVaultMediaDocAttestation[],
    expectedMediaAttestedAt: string | null,
    nameFor: (portfolioId: string) => string,
  ): Promise<void> {
    try {
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
    } catch (cause) {
      throw captureInFlightRefusal(cause, nameFor) ?? cause;
    }
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
      const plainOwnedIds = roster
        .filter((candidate) => candidate.vaultId == null)
        .map((candidate) => candidate.id);
      // The roster this capture already read is the only place a blocking
      // portfolio id can be turned into something worth showing a user. An id
      // it does not cover (another device moved it since) still names a real
      // blocker, so it travels as itself rather than being dropped.
      const nameFor = (portfolioId: string): string =>
        roster.find((candidate) => candidate.id === portfolioId)?.name ?? portfolioId;

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
        if (built.capturedImportBatchCount === null) {
          // #1528 ruling, unchanged while the lossless read seam is absent.
          if (settled.importBatchCount > 0) {
            throw new PortfolioMoveCaptureError(
              'VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED',
              'This version cannot capture the portfolio’s historical import batches losslessly.',
            );
          }
        } else if (built.capturedImportBatchCount !== settled.importBatchCount) {
          // The count rides the same snapshot as the digest, so a disagreement
          // with what the read served is a server that changed under the
          // build (the digest refuses too) or one that lies — never a purge.
          throw conflict(
            'The captured import batches do not match the portfolio’s settled batch count.',
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
      const set = await openVaultSet(vault, me.id, memberIds, plainOwnedIds);
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
        manualAssets: rows.manualAssets,
        capturedProvenance,
        allEntities: entityUnion([
          set.common.document,
          ...set.portfolios.map(({ document }) => document),
          portfolioDocument,
        ]),
        deviceId,
        now,
        id,
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
          await refreshServerAttestation(vault, currentAttestations(set), null, nameFor);
        }

        // ── Writes, strictly ordered: the portfolio doc FIRST (its admission
        // binds the capture and invalidates the full-set proof), then the
        // header roster, then the common fold — each under the E1 HTTP CAS.
        await writeDocument(vault.id, portfolioId, encrypted.portfolio.envelope, {
          ifVersion: null,
        });
        if (encrypted.header) {
          await writeDocument(vault.id, set.header.envelope.docId, encrypted.header.envelope, {
            ifVersion: set.header.envelope.docVersion,
          });
        }
        if (encrypted.common) {
          await writeDocument(vault.id, set.common.envelope.docId, encrypted.common.envelope, {
            ifVersion: set.common.envelope.docVersion,
          });
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
        await refreshServerAttestation(vault, finalDocs, null, nameFor);

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

      // The same in-flight tolerance as move-in: another portfolio wedged
      // between ITS capture and refused commit must not block opening this
      // vault. The `documentSetHash` below still hashes members only, and E4
      // compares it against the locked server roster — a vault carrying a
      // stale prospective blob keeps refusing the destructive commit
      // server-side until that move-in converges or the next capture begin
      // clears the blob (`beginPortfolioVaultCapture`).
      const plainOwnedIds = roster
        .filter((candidate) => candidate.vaultId == null)
        .map((candidate) => candidate.id);
      const set = await openVaultSet(vault, me.id, memberIds, plainOwnedIds);

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

      // #1529: the lossless manual-asset seam for move-out. Server-present
      // assets cross as the EXACT current rows (E4 compares them field for
      // field at restore); ids the server does not hold are the ones move-in
      // detached, restorable from the encrypted snapshot. Entity envelopes
      // reuse the encrypted doc's revs/ids where the identity matches so two
      // authorings of the same set are byte-deterministic. Absent seam →
      // `undefined` → the restore builder's own fail-closed refusal, unchanged.
      const manualCapture = deps.api.getCustomAssetVaultSnapshots;
      const encryptedAssets = new Map(
        (set.common.document.entities.customAsset ?? []).map((entity) => [entity.id, entity]),
      );
      const encryptedValues = (set.common.document.entities.customAssetValue ?? []).filter(
        (entity) => entity.deletedAt === null,
      );
      const resolveManualAssetSnapshots: ManualAssetSnapshotResolver | undefined =
        manualCapture === undefined
          ? undefined
          : async ({ assetIds, signal }) => {
              const response = await readManualAssetSnapshots(manualCapture, assetIds, signal);
              const authoredAt = now();
              return {
                serverPresent: response.present.map(({ id: assetId, asset, values }) => ({
                  asset: {
                    id: assetId,
                    rev: encryptedAssets.get(assetId)?.rev ?? 1,
                    editedAt: authoredAt,
                    editedBy: deviceId,
                    deletedAt: null,
                    data: asset as VaultEntity['data'],
                  },
                  values: values.map((value) => {
                    const prior = encryptedValues.find(
                      (entity) =>
                        entity.data.assetId === assetId && entity.data.date === value.date,
                    );
                    return {
                      id: prior?.id ?? id(),
                      rev: prior?.rev ?? 1,
                      editedAt: authoredAt,
                      editedBy: deviceId,
                      deletedAt: null,
                      data: value as VaultEntity['data'],
                    };
                  }),
                })),
                detachedAssetIds: response.absentIds,
              };
            };

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
          resolveManualAssetSnapshots,
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
