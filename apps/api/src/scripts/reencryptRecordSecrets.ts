import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { loadConfig } from '../config/env';
import {
  createDiscordWebhookRepository,
  type DiscordWebhookRepository,
} from '../data/repositories/discordWebhookRepository';
import { createDatabase } from '../data/db';
import {
  createTwoFactorRepository,
  type TwoFactorRepository,
} from '../data/repositories/twoFactorRepository';
import {
  decryptSecret,
  encryptSecret,
  secretEnvelopeKeyId,
  type SecretBoxKeyring,
} from '../services/crypto/secretBox';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;

interface SecretEnvelopeRow {
  userId: string;
  envelope: string;
}

interface SecretEnvelopeRepository {
  listSecretEnvelopes(afterUserId: string | null, limit: number): Promise<SecretEnvelopeRow[]>;
  replaceSecretEnvelope(
    userId: string,
    expectedEnvelope: string,
    replacementEnvelope: string,
  ): Promise<boolean>;
}

export interface RecordSecretRepositories {
  twoFactor: Pick<TwoFactorRepository, 'listSecretEnvelopes' | 'replaceSecretEnvelope'>;
  discord: Pick<DiscordWebhookRepository, 'listSecretEnvelopes' | 'replaceSecretEnvelope'>;
}

export interface ReencryptionTargetReport {
  scanned: number;
  alreadyActive: number;
  wouldReencrypt: number;
  reencrypted: number;
  conflicts: number;
  failed: number;
}

export interface ReencryptionReport {
  mode: 'dry-run' | 'apply';
  twoFactor: ReencryptionTargetReport;
  discord: ReencryptionTargetReport;
}

export interface ReencryptRecordSecretsOptions {
  dryRun: boolean;
  keyring: SecretBoxKeyring;
  repositories: RecordSecretRepositories;
  batchSize?: number;
}

function emptyTargetReport(): ReencryptionTargetReport {
  return {
    scanned: 0,
    alreadyActive: 0,
    wouldReencrypt: 0,
    reencrypted: 0,
    conflicts: 0,
    failed: 0,
  };
}

function plaintextMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function reencryptTarget(
  repository: SecretEnvelopeRepository,
  keyring: SecretBoxKeyring,
  dryRun: boolean,
  batchSize: number,
): Promise<ReencryptionTargetReport> {
  const report = emptyTargetReport();
  let cursor: string | null = null;

  for (;;) {
    const rows = await repository.listSecretEnvelopes(cursor, batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.userId;
      report.scanned += 1;

      try {
        // Authentication happens before header state is trusted. Unknown keys,
        // malformed envelopes, wrong keys, and tampering all stop at this point.
        const plaintext = decryptSecret(row.envelope, keyring);
        if (secretEnvelopeKeyId(row.envelope) === keyring.active.id) {
          report.alreadyActive += 1;
          continue;
        }

        const replacement = encryptSecret(plaintext, keyring);
        const verified = decryptSecret(replacement, keyring);
        if (!plaintextMatches(plaintext, verified)) {
          report.failed += 1;
          continue;
        }

        report.wouldReencrypt += 1;
        if (dryRun) continue;

        // CAS protects a concurrent enrollment/webhook update. A mismatch is
        // reported and safely retried by rerunning this resumable command.
        const replaced = await repository.replaceSecretEnvelope(
          row.userId,
          row.envelope,
          replacement,
        );
        if (replaced) {
          report.reencrypted += 1;
        } else {
          report.conflicts += 1;
        }
      } catch {
        // Per-row errors are deliberately reduced to a count. Never print the
        // row id, ciphertext, key id, key material, or decrypted secret.
        report.failed += 1;
      }
    }

    if (rows.length < batchSize) break;
  }

  return report;
}

/**
 * Re-encrypt all scoped server-side records. Safe to resume: active envelopes
 * are verified then skipped, and every replacement uses compare-and-swap.
 */
export async function reencryptRecordSecrets(
  options: ReencryptRecordSecretsOptions,
): Promise<ReencryptionReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}`);
  }

  return {
    mode: options.dryRun ? 'dry-run' : 'apply',
    twoFactor: await reencryptTarget(
      options.repositories.twoFactor,
      options.keyring,
      options.dryRun,
      batchSize,
    ),
    discord: await reencryptTarget(
      options.repositories.discord,
      options.keyring,
      options.dryRun,
      batchSize,
    ),
  };
}

export interface ReencryptCliOptions {
  dryRun: boolean;
  batchSize: number;
}

export function parseReencryptArgs(argv: readonly string[]): ReencryptCliOptions {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  if (dryRun === apply) {
    throw new Error('Choose exactly one of --dry-run or --apply.');
  }

  let batchSize = DEFAULT_BATCH_SIZE;
  const batchIndex = args.indexOf('--batch-size');
  if (batchIndex >= 0) {
    batchSize = Number(args[batchIndex + 1]);
  }
  const known = new Set(['--dry-run', '--apply', '--batch-size']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--batch-size') {
      index += 1;
      continue;
    }
    if (!known.has(arg)) {
      throw new Error('Unknown argument.');
    }
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be an integer from 1 to ${MAX_BATCH_SIZE}.`);
  }
  return { dryRun, batchSize };
}

async function main(): Promise<void> {
  const cli = parseReencryptArgs(process.argv);
  const config = loadConfig();
  const { db, client } = createDatabase(config.databaseUrl);

  try {
    const report = await reencryptRecordSecrets({
      dryRun: cli.dryRun,
      batchSize: cli.batchSize,
      keyring: config.recordEncryption,
      repositories: {
        twoFactor: createTwoFactorRepository(db),
        discord: createDiscordWebhookRepository(db),
      },
    });
    console.log(JSON.stringify(report));

    const targets = [report.twoFactor, report.discord];
    if (targets.some((target) => target.failed > 0 || target.conflicts > 0)) {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    console.error(
      'Record re-encryption failed. No record identifiers, ciphertext, keys, or plaintext were logged.',
    );
    process.exitCode = 1;
  }
}
