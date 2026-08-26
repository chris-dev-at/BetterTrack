import {
  VAULT_DOCUMENT_VERSION,
  VAULT_ENTITY_ROW_SCHEMAS,
  vaultCommonDocSchema,
  vaultDocumentSchema,
  vaultHeaderDocSchema,
  vaultPortfolioDocSchema,
  type VaultCommonDoc,
  type VaultConfig,
  type VaultDocEnvelopeHeader,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
  type VaultHeaderDoc,
  type VaultPortfolioDoc,
} from '@bettertrack/contracts';

import type { MarketDataSource } from '../../../lib/marketDataSource';
import { zeroBytes } from '../bytes';
import { decryptVaultDoc } from '../keys/documents';
import { deriveAccountBinding } from '../keys/keyCore';
import { moneyFailure } from './errors';
import { createPortfolioDerivationEngine, type PortfolioDerivationEngine } from './portfolioEngine';
import { openVaultSession, type VaultMoneySnapshotSource } from './session';
import { createClientTaxEngine, type ClientTaxEngine } from './taxEngine';

export const PORTFOLIO_DOCUMENT_SET_ERROR_CODES = [
  'VAULT_LOCKED',
  'VAULT_DOCUMENT_UNAVAILABLE',
  'VAULT_DOCUMENT_INVALID',
  'VAULT_DOCUMENT_SET_CHANGED',
] as const;

export type PortfolioDocumentSetErrorCode = (typeof PORTFOLIO_DOCUMENT_SET_ERROR_CODES)[number];

export class PortfolioDocumentSetError extends Error {
  constructor(
    readonly code: PortfolioDocumentSetErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PortfolioDocumentSetError';
  }
}

export interface VaultDocEnvelopeRead {
  envelope: Uint8Array;
  header: VaultDocEnvelopeHeader;
}

export interface VaultDocEnvelopeReader {
  read(vaultId: string, docId: string, signal?: AbortSignal): Promise<VaultDocEnvelopeRead>;
}

/** The exact E3 borrow surface; the borrowed key never leaves its callback. */
export interface VaultContentKeyBorrower {
  withContentKey<T>(
    vaultId: string,
    operation: (
      contentKey: Uint8Array,
      keyId: string,
      assertSessionCurrent: () => void,
    ) => Promise<T> | T,
  ): Promise<T>;
}

export interface DecryptedPortfolioDocumentSet {
  vaultId: string;
  portfolioId: string;
  header: { envelope: VaultDocEnvelopeHeader; document: VaultHeaderDoc };
  common: { envelope: VaultDocEnvelopeHeader; document: VaultCommonDoc };
  portfolio: { envelope: VaultDocEnvelopeHeader; document: VaultPortfolioDoc };
}

export interface DecryptedVaultDocumentSet {
  vaultId: string;
  header: DecryptedPortfolioDocumentSet['header'];
  common: DecryptedPortfolioDocumentSet['common'];
  portfolios: readonly DecryptedPortfolioDocumentSet['portfolio'][];
}

/**
 * Read and authenticate one portfolio's complete E0 doc set. All remote reads
 * remain opaque; every plaintext parse happens inside E3's borrowed-content-key
 * callback, and `assertSessionCurrent` runs after crypto and before the
 * decrypted snapshot is handed to any caller.
 */
export async function loadDecryptedPortfolioDocumentSet(input: {
  vault: Pick<VaultConfig, 'id' | 'headerDocId' | 'commonDocId'>;
  /** Authenticated account id; its digest is required in every AEAD address. */
  accountId: string;
  portfolioId: string;
  /** Complete server-stub roster used to reject stale/omitting headers. */
  expectedPortfolioIds: readonly string[];
  keys: VaultContentKeyBorrower;
  reader: VaultDocEnvelopeReader;
  signal?: AbortSignal;
}): Promise<DecryptedPortfolioDocumentSet> {
  input.signal?.throwIfAborted();
  const accountBinding = await deriveAccountBinding(input.accountId);
  input.signal?.throwIfAborted();
  const [headerRead, commonRead, portfolioRead] = await Promise.all([
    input.reader.read(input.vault.id, input.vault.headerDocId, input.signal),
    input.reader.read(input.vault.id, input.vault.commonDocId, input.signal),
    input.reader.read(input.vault.id, input.portfolioId, input.signal),
  ]);
  input.signal?.throwIfAborted();

  return input.keys.withContentKey(
    input.vault.id,
    async (contentKey, keyId, assertSessionCurrent) => {
      const header = await decryptAndParse(
        headerRead,
        contentKey,
        {
          vaultId: input.vault.id,
          docId: input.vault.headerDocId,
          docKind: 'header',
          keyId,
          accountBinding,
        },
        vaultHeaderDocSchema,
        'header',
      );
      input.signal?.throwIfAborted();
      assertSessionCurrent();
      assertExactRoster(
        header.document.portfolios.map(({ id }) => id),
        input.expectedPortfolioIds,
      );
      input.signal?.throwIfAborted();
      assertSessionCurrent();
      const common = await decryptAndParse(
        commonRead,
        contentKey,
        {
          vaultId: input.vault.id,
          docId: input.vault.commonDocId,
          docKind: 'common',
          keyId,
          accountBinding,
        },
        vaultCommonDocSchema,
        'common',
      );
      input.signal?.throwIfAborted();
      assertSessionCurrent();
      const portfolio = await decryptAndParse(
        portfolioRead,
        contentKey,
        {
          vaultId: input.vault.id,
          docId: input.portfolioId,
          docKind: 'portfolio',
          keyId,
          accountBinding,
        },
        vaultPortfolioDocSchema,
        'portfolio',
      );
      input.signal?.throwIfAborted();
      assertSessionCurrent();

      assertDocumentSetConsistency(input.portfolioId, input.accountId, header, common, portfolio);
      input.signal?.throwIfAborted();
      assertSessionCurrent();
      return {
        vaultId: input.vault.id,
        portfolioId: input.portfolioId,
        header,
        common,
        portfolio,
      };
    },
  );
}

/** Read one complete per-vault roster for cleartext export and vault-wide scans. */
export async function loadDecryptedVaultDocumentSet(input: {
  vault: Pick<VaultConfig, 'id' | 'headerDocId' | 'commonDocId'>;
  accountId: string;
  /** Complete server-stub roster; a stale/partial encrypted header must fail. */
  expectedPortfolioIds: readonly string[];
  keys: VaultContentKeyBorrower;
  reader: VaultDocEnvelopeReader;
  signal?: AbortSignal;
}): Promise<DecryptedVaultDocumentSet> {
  input.signal?.throwIfAborted();
  const accountBinding = await deriveAccountBinding(input.accountId);
  input.signal?.throwIfAborted();
  const headerRead = await input.reader.read(input.vault.id, input.vault.headerDocId, input.signal);
  return input.keys.withContentKey(
    input.vault.id,
    async (contentKey, keyId, assertSessionCurrent) => {
      const header = await decryptAndParse(
        headerRead,
        contentKey,
        {
          vaultId: input.vault.id,
          docId: input.vault.headerDocId,
          docKind: 'header',
          keyId,
          accountBinding,
        },
        vaultHeaderDocSchema,
        'header',
      );
      input.signal?.throwIfAborted();
      assertSessionCurrent();
      const portfolioIds = header.document.portfolios.map(({ id }) => id);
      if (new Set(portfolioIds).size !== portfolioIds.length) {
        throw new PortfolioDocumentSetError(
          'VAULT_DOCUMENT_INVALID',
          'The encrypted header roster repeats a portfolio id.',
        );
      }
      assertExactRoster(portfolioIds, input.expectedPortfolioIds);
      input.signal?.throwIfAborted();
      // E3: the roster came from plaintext. Assert immediately before its
      // network reads, keep them inside the same pinned borrow, then assert
      // again before any returned bytes are decrypted or exposed.
      assertSessionCurrent();
      const [commonRead, ...portfolioReads] = await Promise.all([
        input.reader.read(input.vault.id, input.vault.commonDocId, input.signal),
        ...portfolioIds.map((portfolioId) =>
          input.reader.read(input.vault.id, portfolioId, input.signal),
        ),
      ]);
      input.signal?.throwIfAborted();
      assertSessionCurrent();
      const common = await decryptAndParse(
        commonRead!,
        contentKey,
        {
          vaultId: input.vault.id,
          docId: input.vault.commonDocId,
          docKind: 'common',
          keyId,
          accountBinding,
        },
        vaultCommonDocSchema,
        'common',
      );
      input.signal?.throwIfAborted();
      assertSessionCurrent();
      assertHeaderCommonConsistency(input.accountId, header, common);
      const portfolios: DecryptedVaultDocumentSet['portfolios'][number][] = [];
      for (const [index, portfolioId] of portfolioIds.entries()) {
        const portfolio = await decryptAndParse(
          portfolioReads[index]!,
          contentKey,
          {
            vaultId: input.vault.id,
            docId: portfolioId,
            docKind: 'portfolio',
            keyId,
            accountBinding,
          },
          vaultPortfolioDocSchema,
          'portfolio',
        );
        input.signal?.throwIfAborted();
        assertSessionCurrent();
        assertDocumentSetConsistency(portfolioId, input.accountId, header, common, portfolio);
        portfolios.push(portfolio);
      }
      assertUniqueEntityIds(common, portfolios);
      input.signal?.throwIfAborted();
      assertSessionCurrent();
      return { vaultId: input.vault.id, header, common, portfolios };
    },
  );
}

/**
 * Present one split doc set to the shipped engine validator. This is a payload
 * adapter only: entity rows remain unchanged, and all valuation/tax arithmetic
 * continues through the existing `@bettertrack/domain` call sites.
 */
export function portfolioEngineDocument(set: DecryptedPortfolioDocumentSet): VaultDocument {
  return vaultDocumentSchema.parse({
    schemaVersion: VAULT_DOCUMENT_VERSION,
    entities: {
      ...set.common.document.entities,
      ...set.portfolio.document.entities,
    },
    mergeLog: set.portfolio.document.mergeLog,
    mirrorProvenance: set.common.document.mirrorProvenance,
    clientSecurity: set.common.document.clientSecurity,
  });
}

/** Assemble every member portfolio with its shared common payload for export. */
export function vaultEngineDocument(set: DecryptedVaultDocumentSet): VaultDocument {
  const entities: VaultDocument['entities'] = { ...set.common.document.entities };
  for (const { document } of set.portfolios) {
    for (const [kind, rows] of Object.entries(document.entities) as Array<
      [
        keyof VaultDocument['entities'],
        NonNullable<VaultDocument['entities'][keyof VaultDocument['entities']]>,
      ]
    >) {
      entities[kind] = [...(entities[kind] ?? []), ...rows];
    }
  }
  return vaultDocumentSchema.parse({
    schemaVersion: VAULT_DOCUMENT_VERSION,
    entities,
    mergeLog: [
      ...set.common.document.mergeLog,
      ...set.portfolios.flatMap(({ document }) => document.mergeLog),
    ],
    mirrorProvenance: set.common.document.mirrorProvenance,
    clientSecurity: set.common.document.clientSecurity,
  });
}

export interface PortfolioDocumentSetEngine
  extends PortfolioDerivationEngine, Pick<ClientTaxEngine, 'deriveTaxReport' | 'clearTaxCache'> {
  /** Synchronously revoke all later reads when the owning vault locks. */
  revoke(): void;
}

/**
 * Revocable authenticated snapshot for non-engine consumers such as the
 * client-side cleartext exporter. Revocation drops the last strong reference
 * to decrypted rows held by this adapter.
 */
export interface PortfolioDocumentSetSession extends VaultMoneySnapshotSource {
  revoke(): void;
}

export function createPortfolioDocumentSetSession(
  set: DecryptedPortfolioDocumentSet,
  options: { isSessionCurrent?: () => boolean } = {},
): PortfolioDocumentSetSession {
  let snapshot: ReturnType<VaultMoneySnapshotSource['validatedSnapshot']> | null = (() => {
    const opened = openVaultSession(portfolioEngineDocument(set));
    const envelopes = [set.header.envelope, set.common.envelope, set.portfolio.envelope];
    return {
      document: opened.document,
      ownerUserId: opened.ownerUserId,
      vaultVersion: Math.max(...envelopes.map(({ docVersion }) => docVersion)),
      vaultKeyId: set.portfolio.envelope.keyId,
      writeId: set.portfolio.envelope.writeId,
      snapshotId: documentSetSnapshotId(envelopes),
    };
  })();

  function requireCurrent(): NonNullable<typeof snapshot> {
    if (snapshot === null || options.isSessionCurrent?.() === false) {
      throw moneyFailure('VAULT_LOCKED', 'The vault locked during the client operation.', {
        retryable: true,
      });
    }
    return snapshot;
  }

  return {
    validatedSnapshot() {
      return requireCurrent();
    },
    assertSnapshotCurrent(candidate) {
      const current = requireCurrent();
      if (
        candidate.document !== current.document ||
        candidate.snapshotId !== current.snapshotId ||
        candidate.vaultVersion !== current.vaultVersion ||
        candidate.vaultKeyId !== current.vaultKeyId ||
        candidate.writeId !== current.writeId
      ) {
        throw moneyFailure(
          'OPERATION_ABORTED',
          'The vault document set changed during operation.',
          {
            retryable: true,
          },
        );
      }
    },
    revoke() {
      snapshot = null;
    },
  };
}

export function createVaultDocumentSetSession(
  set: DecryptedVaultDocumentSet,
  options: { isSessionCurrent?: () => boolean } = {},
): PortfolioDocumentSetSession {
  const envelopes = [
    set.header.envelope,
    set.common.envelope,
    ...set.portfolios.map(({ envelope }) => envelope),
  ];
  let snapshot: ReturnType<VaultMoneySnapshotSource['validatedSnapshot']> | null = (() => {
    const opened = openVaultSession(vaultEngineDocument(set));
    return {
      document: opened.document,
      ownerUserId: opened.ownerUserId,
      vaultVersion: Math.max(...envelopes.map(({ docVersion }) => docVersion)),
      vaultKeyId: set.header.envelope.keyId,
      writeId: set.header.envelope.writeId,
      snapshotId: documentSetSnapshotId(envelopes),
    };
  })();

  function requireCurrent(): NonNullable<typeof snapshot> {
    if (snapshot === null || options.isSessionCurrent?.() === false) {
      throw moneyFailure('VAULT_LOCKED', 'The vault locked during the client operation.', {
        retryable: true,
      });
    }
    return snapshot;
  }

  return {
    validatedSnapshot: requireCurrent,
    assertSnapshotCurrent(candidate) {
      if (candidate !== requireCurrent()) {
        throw moneyFailure('OPERATION_ABORTED', 'The vault document set changed during export.', {
          retryable: true,
        });
      }
    },
    revoke() {
      snapshot = null;
    },
  };
}

/** Invoke the existing client engine over one authenticated split doc set. */
export function createPortfolioDocumentSetEngine(
  set: DecryptedPortfolioDocumentSet,
  market: MarketDataSource,
  options: { now?: () => number; isSessionCurrent?: () => boolean } = {},
): PortfolioDocumentSetEngine {
  const session = createPortfolioDocumentSetSession(set, options);
  const portfolio = createPortfolioDerivationEngine(session, market, options);
  const tax = createClientTaxEngine(session, market, options);

  return {
    ...portfolio,
    deriveTaxReport: tax.deriveTaxReport,
    clearTaxCache: tax.clearTaxCache,
    revoke() {
      session.revoke();
      portfolio.clearCache();
      tax.clearTaxCache();
    },
  };
}

async function decryptAndParse<T>(
  read: VaultDocEnvelopeRead,
  contentKey: Uint8Array,
  expected: {
    vaultId: string;
    docId: string;
    docKind: 'header' | 'common' | 'portfolio';
    keyId: string;
    accountBinding: VaultDocEnvelopeHeader['accountBinding'];
  },
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  label: string,
): Promise<{ envelope: VaultDocEnvelopeHeader; document: T }> {
  let plaintext: Uint8Array | null = null;
  try {
    if (
      read.header.vaultId !== expected.vaultId ||
      read.header.docId !== expected.docId ||
      read.header.docKind !== expected.docKind ||
      read.header.keyId !== expected.keyId ||
      read.header.accountBinding !== expected.accountBinding
    ) {
      throw new PortfolioDocumentSetError(
        'VAULT_DOCUMENT_INVALID',
        `The ${label} document read metadata does not match its requested address.`,
      );
    }
    const decrypted = await decryptVaultDoc({ envelope: read.envelope, contentKey, expected });
    plaintext = decrypted.plaintext;
    if (!sameEnvelopeHeader(read.header, decrypted.header)) {
      throw new PortfolioDocumentSetError(
        'VAULT_DOCUMENT_SET_CHANGED',
        `The ${label} document changed between its transport and authenticated header.`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } catch (cause) {
      throw new PortfolioDocumentSetError(
        'VAULT_DOCUMENT_INVALID',
        `The ${label} document is not valid UTF-8 JSON.`,
        { cause },
      );
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new PortfolioDocumentSetError(
        'VAULT_DOCUMENT_INVALID',
        `The ${label} document does not match its payload contract.`,
      );
    }
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('schemaVersion' in raw) ||
      raw.schemaVersion !== decrypted.header.schemaVersion
    ) {
      throw new PortfolioDocumentSetError(
        'VAULT_DOCUMENT_INVALID',
        `The ${label} payload version does not match its authenticated envelope.`,
      );
    }
    return { envelope: decrypted.header, document: parsed.data };
  } finally {
    if (plaintext !== null) zeroBytes(plaintext);
  }
}

function assertDocumentSetConsistency(
  portfolioId: string,
  accountId: string,
  header: DecryptedPortfolioDocumentSet['header'],
  common: DecryptedPortfolioDocumentSet['common'],
  portfolio: DecryptedPortfolioDocumentSet['portfolio'],
): void {
  assertHeaderCommonConsistency(accountId, header, common);
  assertEnvelopeSetConsistency([header.envelope, portfolio.envelope]);
  if (portfolio.document.portfolioId !== portfolioId) {
    throw new PortfolioDocumentSetError(
      'VAULT_DOCUMENT_INVALID',
      'The portfolio payload does not match the requested locked stub.',
    );
  }
  const roster = header.document.portfolios.filter((entry) => entry.id === portfolioId);
  if (roster.length !== 1) {
    throw new PortfolioDocumentSetError(
      'VAULT_DOCUMENT_INVALID',
      'The encrypted header roster does not contain the requested portfolio exactly once.',
    );
  }
  assertPortfolioDocumentScope(portfolioId, accountId, roster[0]!.name, portfolio.document);
  assertUniqueEntityIds(common, [portfolio]);
}

function assertHeaderCommonConsistency(
  accountId: string,
  header: DecryptedPortfolioDocumentSet['header'],
  common: DecryptedPortfolioDocumentSet['common'],
): void {
  assertEnvelopeSetConsistency([header.envelope, common.envelope]);
  if (!sameKeySlots(header.document.keySlots, header.envelope.keySlots)) {
    throw new PortfolioDocumentSetError(
      'VAULT_DOCUMENT_INVALID',
      'The encrypted header key-slot echo does not match the document set.',
    );
  }
  assertCommonDocumentOwnership(accountId, common.document);
}

function assertEnvelopeSetConsistency(envelopes: readonly VaultDocEnvelopeHeader[]): void {
  const first = envelopes[0];
  if (first === undefined) return;
  for (const envelope of envelopes.slice(1)) {
    if (
      envelope.vaultId !== first.vaultId ||
      envelope.accountBinding !== first.accountBinding ||
      envelope.keyId !== first.keyId ||
      !sameKeySlots(envelope.keySlots, first.keySlots)
    ) {
      throw new PortfolioDocumentSetError(
        'VAULT_DOCUMENT_INVALID',
        'The authenticated documents do not belong to one vault/key/account set.',
      );
    }
  }
}

function assertExactRoster(
  encryptedPortfolioIds: readonly string[],
  expectedPortfolioIds: readonly string[],
): void {
  const expected = new Set(expectedPortfolioIds);
  const encrypted = new Set(encryptedPortfolioIds);
  if (
    expected.size !== expectedPortfolioIds.length ||
    encrypted.size !== encryptedPortfolioIds.length ||
    encryptedPortfolioIds.length !== expectedPortfolioIds.length ||
    encryptedPortfolioIds.some((portfolioId) => !expected.has(portfolioId))
  ) {
    throw new PortfolioDocumentSetError(
      'VAULT_DOCUMENT_SET_CHANGED',
      'The encrypted header roster does not match the current locked-stub roster.',
    );
  }
}

const DIRECT_PORTFOLIO_KINDS = new Set<VaultEntityKind>([
  'transaction',
  'dividend',
  'cashSource',
  'cashMovement',
  'portfolioSetting',
  'standingOrder',
  'importBatch',
  'portfolioDailySnapshot',
  'portfolioSnapshotState',
  'cashBudget',
]);

function assertPortfolioDocumentScope(
  portfolioId: string,
  accountId: string,
  rosterName: string,
  document: VaultPortfolioDoc,
): void {
  const anchors = document.entities.portfolio ?? [];
  if (anchors.length !== 1 || anchors[0]!.id !== portfolioId || anchors[0]!.deletedAt !== null) {
    throw new PortfolioDocumentSetError(
      'VAULT_DOCUMENT_INVALID',
      'A portfolio document must contain exactly one matching live portfolio anchor.',
    );
  }
  const anchor = parseEntityRow('portfolio', anchors[0]!);
  if (anchor.userId !== accountId || anchor.name !== rosterName) {
    throw new PortfolioDocumentSetError(
      'VAULT_DOCUMENT_INVALID',
      'The portfolio anchor disagrees with its authenticated owner or header roster.',
    );
  }

  const parsedByKind = new Map<VaultEntityKind, Map<string, Record<string, unknown>>>();
  for (const [kind, rows] of Object.entries(document.entities) as Array<
    [VaultEntityKind, VaultEntity[]]
  >) {
    const parsedRows = new Map<string, Record<string, unknown>>();
    for (const entity of rows) {
      const row = parseEntityRow(kind, entity);
      parsedRows.set(entity.id, row);
      if (DIRECT_PORTFOLIO_KINDS.has(kind) && row.portfolioId !== portfolioId) {
        throw new PortfolioDocumentSetError(
          'VAULT_DOCUMENT_INVALID',
          `A ${kind} row belongs to another portfolio document.`,
        );
      }
      if (
        (kind === 'standingOrder' && row.userId !== accountId) ||
        (kind === 'importBatch' && row.ownerId !== accountId)
      ) {
        throw new PortfolioDocumentSetError(
          'VAULT_DOCUMENT_INVALID',
          `A ${kind} row belongs to another account.`,
        );
      }
    }
    parsedByKind.set(kind, parsedRows);
  }

  assertLiveParentScope(
    document,
    'standingOrderRun',
    'standingOrderId',
    'standingOrder',
    parsedByKind,
  );
  assertLiveParentScope(document, 'importRow', 'batchId', 'importBatch', parsedByKind);
  assertLiveParentScope(document, 'cashMovementTag', 'movementId', 'cashMovement', parsedByKind);
  assertLiveParentScope(document, 'cashBudgetFire', 'budgetId', 'cashBudget', parsedByKind);
}

function assertLiveParentScope(
  document: VaultPortfolioDoc,
  childKind: VaultEntityKind,
  parentIdField: string,
  parentKind: VaultEntityKind,
  parsedByKind: ReadonlyMap<VaultEntityKind, ReadonlyMap<string, Record<string, unknown>>>,
): void {
  for (const child of document.entities[childKind] ?? []) {
    if (child.deletedAt !== null) continue;
    const row = parsedByKind.get(childKind)?.get(child.id);
    const parentId = row?.[parentIdField];
    if (typeof parentId !== 'string' || !parsedByKind.get(parentKind)?.has(parentId)) {
      throw new PortfolioDocumentSetError(
        'VAULT_DOCUMENT_INVALID',
        `A live ${childKind} row has no parent in its portfolio document.`,
      );
    }
  }
}

const ACCOUNT_OWNED_COMMON_KINDS = new Set<VaultEntityKind>([
  'taxSetting',
  'expenseCategory',
  'expenseTransaction',
  'expenseRule',
  'expenseBudget',
  'cashTag',
  'cashRule',
]);

function assertCommonDocumentOwnership(accountId: string, document: VaultCommonDoc): void {
  for (const [kind, rows] of Object.entries(document.entities) as Array<
    [VaultEntityKind, VaultEntity[]]
  >) {
    for (const entity of rows) {
      const row = parseEntityRow(kind, entity);
      if (ACCOUNT_OWNED_COMMON_KINDS.has(kind) && row.userId !== accountId) {
        throw new PortfolioDocumentSetError(
          'VAULT_DOCUMENT_INVALID',
          `A ${kind} row belongs to another account.`,
        );
      }
      if (kind === 'customAsset' && row.ownerId !== null && row.ownerId !== accountId) {
        throw new PortfolioDocumentSetError(
          'VAULT_DOCUMENT_INVALID',
          'A customAsset row belongs to another account.',
        );
      }
    }
  }
}

function parseEntityRow(kind: VaultEntityKind, entity: VaultEntity): Record<string, unknown> {
  const parsed = VAULT_ENTITY_ROW_SCHEMAS[kind].safeParse(entity.data);
  if (!parsed.success) {
    throw new PortfolioDocumentSetError(
      'VAULT_DOCUMENT_INVALID',
      `The ${kind}/${entity.id} row does not match its strict entity contract.`,
    );
  }
  return parsed.data as Record<string, unknown>;
}

function assertUniqueEntityIds(
  common: DecryptedPortfolioDocumentSet['common'],
  portfolios: readonly DecryptedPortfolioDocumentSet['portfolio'][],
): void {
  const seenByKind = new Map<VaultEntityKind, Set<string>>();
  for (const document of [common.document, ...portfolios.map(({ document }) => document)]) {
    for (const [kind, rows] of Object.entries(document.entities) as Array<
      [VaultEntityKind, VaultEntity[]]
    >) {
      const seen = seenByKind.get(kind) ?? new Set<string>();
      for (const entity of rows) {
        if (seen.has(entity.id)) {
          throw new PortfolioDocumentSetError(
            'VAULT_DOCUMENT_INVALID',
            `The document set repeats entity ${kind}/${entity.id}.`,
          );
        }
        seen.add(entity.id);
      }
      seenByKind.set(kind, seen);
    }
  }
}

function documentSetSnapshotId(envelopes: readonly VaultDocEnvelopeHeader[]): string {
  const versions = envelopes
    .map(({ vaultId, docId, docKind, docVersion, writeId }) => [
      vaultId,
      docId,
      docKind,
      docVersion,
      writeId,
    ])
    .sort((left, right) => String(left[1]).localeCompare(String(right[1])));
  return JSON.stringify(['vault-document-set-v1', versions]);
}

function sameKeySlots(
  left: readonly { keyId: string; slot: string; wrappedKc: string }[],
  right: readonly { keyId: string; slot: string; wrappedKc: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (slot, index) =>
        slot.keyId === right[index]?.keyId &&
        slot.slot === right[index]?.slot &&
        slot.wrappedKc === right[index]?.wrappedKc,
    )
  );
}

function sameEnvelopeHeader(left: VaultDocEnvelopeHeader, right: VaultDocEnvelopeHeader): boolean {
  return (
    left.formatVersion === right.formatVersion &&
    left.cipher === right.cipher &&
    left.iv === right.iv &&
    left.keyId === right.keyId &&
    left.vaultId === right.vaultId &&
    left.docId === right.docId &&
    left.docKind === right.docKind &&
    left.accountBinding === right.accountBinding &&
    left.docVersion === right.docVersion &&
    left.schemaVersion === right.schemaVersion &&
    left.deviceId === right.deviceId &&
    left.writeId === right.writeId &&
    left.writtenAt === right.writtenAt &&
    sameKeySlots(left.keySlots, right.keySlots)
  );
}
