import { strToU8, zipSync } from 'fflate';

import type { VaultDocKind, VaultMediaList, VaultMediaSet } from '@bettertrack/contracts';

import {
  EXPORT_MAX_ARCHIVE_BYTES,
  EXPORT_MAX_CONTENT_BYTES,
  ExportTooLargeError,
  stringifyBounded,
} from './limits';
import { EXPORT_TABLE_CLASSIFICATION } from './manifest';
import type { CollectedExport } from './collector';

export interface ParanoidCiphertextExport {
  mediaSet: VaultMediaSet;
  vault: {
    version: number;
    formatVersion: number;
    sizeBytes: number;
    updatedAt: Date;
    blob: Uint8Array;
  } | null;
}

/** One owner-scoped per-vault config and its current server-resident docs. */
export interface VaultCiphertextExport {
  vaultId: string;
  media: VaultMediaList;
  docs: {
    docId: string;
    docKind: VaultDocKind;
    version: number;
    formatVersion: number;
    sizeBytes: number;
    updatedAt: Date;
    blob: Uint8Array;
  }[];
}

/**
 * Package a {@link CollectedExport} into a zip archive (§13.4 V4-P6a, #494).
 * Layout:
 *   - `manifest.json`  — export metadata: user, timestamp, per-entity row counts,
 *                        and the skipped-tables list with reasons (the audit of
 *                        what is and isn't in the archive).
 *   - `data/<entity>.json` — one pretty-printed JSON array per exported entity.
 *   - `csv/transactions.csv`, `csv/cash-movements.csv`, `csv/holdings.csv`.
 *   - `paranoid/vaults/<vaultId>/docs/<docId>.btvault` — current opaque docs
 *     for every per-vault config whose active media include the server.
 *   - `README.txt`     — a short human note.
 *
 * fflate's `zipSync` produces a standard (STORE/DEFLATE) archive any unzip tool
 * — and the completeness test's `unzipSync` — reads back verbatim.
 */
export function buildExportZip(input: {
  userId: string;
  collected: CollectedExport;
  generatedAt: Date;
  paranoid?: ParanoidCiphertextExport;
  vaults?: VaultCiphertextExport[];
  /** Override the packaged-bytes ceiling (tests); defaults to the real limit. */
  maxContentBytes?: number;
}): Buffer {
  const { userId, collected, generatedAt, paranoid } = input;
  const maxContentBytes = input.maxContentBytes ?? EXPORT_MAX_CONTENT_BYTES;
  const vaults = (input.vaults ?? [])
    .map((vault) => ({
      ...vault,
      docs: [...vault.docs].sort((a, b) => a.docId.localeCompare(b.docId)),
    }))
    .sort((a, b) => a.vaultId.localeCompare(b.vaultId));

  const counts: Record<string, number> = {};
  for (const [entity, rows] of Object.entries(collected.entities)) counts[entity] = rows.length;

  const skipped = Object.entries(EXPORT_TABLE_CLASSIFICATION)
    .filter(([, c]) => c.kind === 'skip')
    .map(([table, c]) => ({ table, reason: (c as { reason: string }).reason }))
    .sort((a, b) => a.table.localeCompare(b.table));

  const manifest = {
    format: 'bettertrack-account-export',
    version: 1,
    userId,
    generatedAt: generatedAt.toISOString(),
    entities: counts,
    csv: paranoid ? [] : ['transactions', 'cash-movements', 'holdings'],
    ...(paranoid
      ? {
          paranoidVault: {
            mediaSet: paranoid.mediaSet,
            included: paranoid.vault !== null,
            ...(paranoid.vault
              ? {
                  file: 'paranoid/current-vault.btvault',
                  version: paranoid.vault.version,
                  formatVersion: paranoid.vault.formatVersion,
                  sizeBytes: paranoid.vault.sizeBytes,
                  updatedAt: paranoid.vault.updatedAt.toISOString(),
                }
              : {}),
          },
        }
      : {}),
    vaults: vaults.map((vault) => ({
      vaultId: vault.vaultId,
      media: vault.media,
      docs: vault.docs.map((doc) => ({
        docId: doc.docId,
        docKind: doc.docKind,
        version: doc.version,
        formatVersion: doc.formatVersion,
        sizeBytes: doc.sizeBytes,
        updatedAt: doc.updatedAt.toISOString(),
        file: `paranoid/vaults/${vault.vaultId}/docs/${doc.docId}.btvault`,
      })),
    })),
    skippedTables: skipped,
  };

  const files: Record<string, Uint8Array> = {};
  // Packaging is fully buffered, so the bytes are accounted as they are added
  // and the build is refused the moment it crosses the ceiling — before the
  // remaining entities are serialized, and long before the worker runs out of
  // memory (#1714).
  let contentBytes = 0;
  const addFile = (name: string, bytes: Uint8Array): void => {
    contentBytes += bytes.byteLength;
    if (contentBytes > maxContentBytes) {
      throw new ExportTooLargeError('content_bytes', contentBytes, maxContentBytes);
    }
    files[name] = bytes;
  };

  addFile('manifest.json', strToU8(stringifyBounded(manifest, 'content_bytes')));
  addFile('README.txt', strToU8(paranoid ? PARANOID_README : README));
  if (paranoid?.vault) {
    addFile('paranoid/current-vault.btvault', paranoid.vault.blob);
  }
  for (const vault of vaults) {
    for (const doc of vault.docs) {
      addFile(`paranoid/vaults/${vault.vaultId}/docs/${doc.docId}.btvault`, doc.blob);
    }
  }
  if (!paranoid) {
    addFile('csv/transactions.csv', strToU8(collected.csv.transactions));
    addFile('csv/cash-movements.csv', strToU8(collected.csv.cashMovements));
    addFile('csv/holdings.csv', strToU8(collected.csv.holdings));
  }
  for (const [entity, rows] of Object.entries(collected.entities)) {
    addFile(`data/${entity}.json`, strToU8(stringifyBounded(rows, 'content_bytes')));
  }

  const archive = Buffer.from(zipSync(files));
  if (archive.byteLength > EXPORT_MAX_ARCHIVE_BYTES) {
    throw new ExportTooLargeError('archive_bytes', archive.byteLength, EXPORT_MAX_ARCHIVE_BYTES);
  }
  return archive;
}

const README = `BetterTrack — account data export

This archive contains a copy of the data associated with your BetterTrack
account.

  manifest.json       Metadata: what this export contains and which internal
                      tables were deliberately excluded (with reasons).
  data/<entity>.json  One JSON file per kind of data you own.
  csv/                Spreadsheet-friendly copies of your transactions, cash
                      movements and current holdings.

Security notes and transient credentials (session tokens, password/2FA secrets,
push registrations) are never included.

Current opaque documents for vaults that use BetterTrack server storage appear
under paranoid/vaults/<vaultId>/docs/. BetterTrack cannot decrypt these files.
`;

const PARANOID_README = `BetterTrack — paranoid account data export

This archive contains the server-classified account data BetterTrack retains.
It never contains cleartext portfolio, tax, cash-flow, or expense data.

When the selected media include the BetterTrack server, the current opaque
client-encrypted vault is included at paranoid/current-vault.btvault. BetterTrack
does not hold the passphrase or key needed to decrypt it. For a cleartext data
export, use the client-side export on an unlocked device.

Current opaque documents for per-vault server storage appear under
paranoid/vaults/<vaultId>/docs/. Empty server-backed vault configs remain listed
in manifest.json even when no current document has been written yet.

Security notes and transient credentials (session tokens, password/2FA secrets,
push registrations) are never included.
`;
