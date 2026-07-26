import { strToU8, zipSync } from 'fflate';

import { EXPORT_TABLE_CLASSIFICATION } from './manifest';
import type { CollectedExport } from './collector';

/**
 * Package a {@link CollectedExport} into a zip archive (§13.4 V4-P6a, #494).
 * Layout:
 *   - `manifest.json`  — export metadata: user, timestamp, per-entity row counts,
 *                        and the skipped-tables list with reasons (the audit of
 *                        what is and isn't in the archive).
 *   - `data/<entity>.json` — one pretty-printed JSON array per exported entity.
 *   - `csv/transactions.csv`, `csv/cash-movements.csv`, `csv/holdings.csv`.
 *   - `README.txt`     — a short human note.
 *
 * fflate's `zipSync` produces a standard (STORE/DEFLATE) archive any unzip tool
 * — and the completeness test's `unzipSync` — reads back verbatim.
 */
export function buildExportZip(input: {
  userId: string;
  collected: CollectedExport;
  generatedAt: Date;
  currentVault?: {
    version: number;
    formatVersion: number;
    sizeBytes: number;
    updatedAt: Date;
    blob: Uint8Array;
  };
}): Buffer {
  const { userId, collected, generatedAt, currentVault } = input;

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
    csv: collected.includeCleartextCsv ? ['transactions', 'cash-movements', 'holdings'] : [],
    ...(currentVault
      ? {
          paranoidVault: {
            path: 'vault/current.btvault',
            version: currentVault.version,
            formatVersion: currentVault.formatVersion,
            sizeBytes: currentVault.sizeBytes,
            updatedAt: currentVault.updatedAt.toISOString(),
          },
        }
      : {}),
    skippedTables: skipped,
  };

  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'README.txt': strToU8(collected.includeCleartextCsv ? README : PARANOID_README),
  };
  if (collected.includeCleartextCsv) {
    files['csv/transactions.csv'] = strToU8(collected.csv.transactions);
    files['csv/cash-movements.csv'] = strToU8(collected.csv.cashMovements);
    files['csv/holdings.csv'] = strToU8(collected.csv.holdings);
  }
  if (currentVault) files['vault/current.btvault'] = currentVault.blob;
  for (const [entity, rows] of Object.entries(collected.entities)) {
    files[`data/${entity}.json`] = strToU8(JSON.stringify(rows, null, 2));
  }

  return Buffer.from(zipSync(files));
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
`;

const PARANOID_README = `BetterTrack — paranoid account data export

This archive contains only the server-classified data associated with your
account. It never contains cleartext portfolio data or key material. When your
selected media include the BetterTrack server, vault/current.btvault is the
current opaque encrypted vault envelope; vault history is never exported.

Use BetterTrack's unlocked client-side export to produce cleartext portfolio
JSON and CSV files from your own decrypted vault.
`;
