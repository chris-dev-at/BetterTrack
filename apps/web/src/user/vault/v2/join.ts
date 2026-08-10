import type {
  VaultDocument,
  VaultHeaderDoc,
  VaultLeaveResponse,
  VaultPortfolioDoc,
  VaultPortfolioRestoreDocument,
} from '@bettertrack/contracts';
import { uuidv7 } from 'uuidv7';

import { zeroBytes } from '../bytes';
import { VaultCryptoError } from '../errors';

import { joinPortfolioToVault, writeVaultHeaderDoc } from './api';
import { decryptVaultBlob, encryptVaultBlob } from './blobCrypto';
import { reviseVaultHeader } from './headerCrypto';
import { splitVaultDocument } from './upgrade';

/**
 * Move one portfolio into a vault (`docs/VAULTS_V2_DESIGN.md` §3 join / §4
 * "Move into vault").
 *
 * The order is the whole safety argument, because the server purges cleartext
 * inside the join transaction and there is no undo:
 *
 *  1. capture the account's rows (the proven v1 capture path);
 *  2. split out THIS portfolio's document;
 *  3. encrypt it under the vault content key;
 *  4. **decrypt the produced bytes again and compare** — a blob we cannot read
 *     back is a blob we must never trade cleartext for;
 *  5. only then call join;
 *  6. add the portfolio to the vault header index and publish the header.
 *
 * Step 6 failing is recoverable: the portfolio is already vaulted and the
 * server knows it, so it still renders as a locked row from
 * `summary.portfolioIds`. That is why the header write is last.
 */

export type JoinStage = 'capture' | 'encrypt' | 'verify' | 'join' | 'index' | 'done';

export interface JoinPortfolioInput {
  portfolioId: string;
  vaultId: string;
  header: VaultHeaderDoc;
  headerVersion: number | null;
  contentKey: Uint8Array;
  /** Display alias for the cleartext portfolio index. */
  alias: string;
  /** The captured account document. Supplied by the caller so capture is testable. */
  capture: VaultDocument;
  onStage?: (stage: JoinStage) => void;
  now?: () => string;
  id?: () => string;
}

export interface JoinPortfolioResult {
  blobVersion: number;
  header: VaultHeaderDoc;
  /** `null` when the header index write did not land; the join itself still did. */
  headerVersion: number | null;
}

export async function movePortfolioIntoVault(
  input: JoinPortfolioInput,
): Promise<JoinPortfolioResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const id = input.id ?? uuidv7;

  input.onStage?.('capture');
  const split = splitVaultDocument({
    document: input.capture,
    vaultId: input.vaultId,
    aliases: { [input.portfolioId]: input.alias },
  });
  const document: VaultPortfolioDoc | undefined = split.portfolioDocs.find(
    (doc) => doc.portfolioId === input.portfolioId,
  );
  if (document == null) {
    throw new VaultCryptoError(
      'document-invalid',
      'The capture contains no rows for this portfolio.',
    );
  }

  input.onStage?.('encrypt');
  const encrypted = await encryptVaultBlob({
    document,
    contentKey: input.contentKey,
    blobVersion: 1,
    deviceId: id(),
    writeId: id(),
    writtenAt: now(),
  });

  input.onStage?.('verify');
  const readBack = await decryptVaultBlob(encrypted.envelope, input.contentKey);
  if (JSON.stringify(readBack.document) !== JSON.stringify(document)) {
    throw new VaultCryptoError(
      'document-invalid',
      'The encrypted portfolio did not read back identically; nothing was moved.',
    );
  }

  input.onStage?.('join');
  const joined = await joinPortfolioToVault({
    portfolioId: input.portfolioId,
    vaultId: input.vaultId,
    blob: encrypted.envelope,
  });

  input.onStage?.('index');
  const nextHeader = await reviseVaultHeader(
    input.header,
    {
      portfolios: [
        ...input.header.portfolios.filter((entry) => entry.portfolioId !== input.portfolioId),
        { portfolioId: input.portfolioId, alias: input.alias },
      ],
    },
    { deviceId: id(), writeId: id(), writtenAt: now() },
    input.contentKey,
  );

  let headerVersion: number | null = null;
  const written = await writeVaultHeaderDoc(input.vaultId, nextHeader, input.headerVersion);
  if (written.status === 'ok') headerVersion = written.version;

  input.onStage?.('done');
  return { blobVersion: joined.blob.version, header: nextHeader, headerVersion };
}

/**
 * Move a portfolio back out (`§3` leave).
 *
 * `restoreId` is the server's idempotency key. The client mints it ONCE and
 * keeps it until the leave is acknowledged: a crashed or retried leave re-sends
 * the same id and the server answers the original receipt from
 * `vault_leave_receipts` instead of re-inserting the rows. Minting a fresh id
 * on retry would defeat that entirely, which is why it is an input here rather
 * than something this function generates.
 */
export async function movePortfolioOutOfVault(input: {
  portfolioId: string;
  vaultId: string;
  header: VaultHeaderDoc;
  headerVersion: number | null;
  /** The unlocked vault's content key — a leave decrypted the blob, so it holds one. */
  contentKey: Uint8Array;
  restoreId: string;
  document: VaultPortfolioRestoreDocument;
  leave: (payload: {
    portfolioId: string;
    restoreId: string;
    document: VaultPortfolioRestoreDocument;
  }) => Promise<VaultLeaveResponse>;
  now?: () => string;
  id?: () => string;
}): Promise<{ header: VaultHeaderDoc; receipt: VaultLeaveResponse }> {
  const now = input.now ?? (() => new Date().toISOString());
  const id = input.id ?? uuidv7;

  const receipt = await input.leave({
    portfolioId: input.portfolioId,
    restoreId: input.restoreId,
    document: input.document,
  });

  const nextHeader = await reviseVaultHeader(
    input.header,
    {
      portfolios: input.header.portfolios.filter(
        (entry) => entry.portfolioId !== input.portfolioId,
      ),
    },
    { deviceId: id(), writeId: id(), writtenAt: now() },
    input.contentKey,
  );
  await writeVaultHeaderDoc(input.vaultId, nextHeader, input.headerVersion);
  return { header: nextHeader, receipt };
}

/** Zero a content key copy a caller had to materialize. */
export function disposeContentKey(key: Uint8Array): void {
  zeroBytes(key);
}
