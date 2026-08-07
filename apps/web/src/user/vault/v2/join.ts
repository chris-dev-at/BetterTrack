import type { VaultDocument, VaultHeaderDoc, VaultPortfolioDoc } from '@bettertrack/contracts';
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
  const nextHeader = reviseVaultHeader(
    input.header,
    {
      portfolios: [
        ...input.header.portfolios.filter((entry) => entry.portfolioId !== input.portfolioId),
        { portfolioId: input.portfolioId, alias: input.alias },
      ],
    },
    { deviceId: id(), writeId: id(), writtenAt: now() },
  );

  let headerVersion: number | null = null;
  const written = await writeVaultHeaderDoc(input.vaultId, nextHeader, input.headerVersion);
  if (written.status === 'ok') headerVersion = written.version;

  input.onStage?.('done');
  return { blobVersion: joined.blobVersion, header: nextHeader, headerVersion };
}

/**
 * Move a portfolio back out (`§3` leave). The caller must already hold the
 * decrypted document; this helper only shapes the restore payload and drops the
 * portfolio from the header index.
 */
export async function movePortfolioOutOfVault(input: {
  portfolioId: string;
  vaultId: string;
  header: VaultHeaderDoc;
  headerVersion: number | null;
  contentKey: Uint8Array;
  document: VaultPortfolioDoc;
  leave: (payload: { portfolioId: string; document: unknown }) => Promise<unknown>;
  now?: () => string;
  id?: () => string;
}): Promise<VaultHeaderDoc> {
  const now = input.now ?? (() => new Date().toISOString());
  const id = input.id ?? uuidv7;

  await input.leave({ portfolioId: input.portfolioId, document: input.document });

  const nextHeader = reviseVaultHeader(
    input.header,
    {
      portfolios: input.header.portfolios.filter(
        (entry) => entry.portfolioId !== input.portfolioId,
      ),
    },
    { deviceId: id(), writeId: id(), writtenAt: now() },
  );
  await writeVaultHeaderDoc(input.vaultId, nextHeader, input.headerVersion);
  return nextHeader;
}

/** Zero a content key copy a caller had to materialize. */
export function disposeContentKey(key: Uint8Array): void {
  zeroBytes(key);
}
