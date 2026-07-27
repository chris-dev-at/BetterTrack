import { describe, expect, it } from 'vitest';

import {
  createSecretBoxKeyring,
  decryptSecret,
  encryptSecret,
} from '../../services/crypto/secretBox';
import {
  parseReencryptArgs,
  reencryptRecordSecrets,
  type RecordSecretRepositories,
} from '../reencryptRecordSecrets';

const ACTIVE_KEY = Buffer.alloc(32, 0x41);
const PREVIOUS_KEY = Buffer.alloc(32, 0x42);
const LEGACY_KEY = Buffer.alloc(32, 0x43);

const ACTIVE = createSecretBoxKeyring({
  active: { id: 'active_2026', key: ACTIVE_KEY },
  previous: [{ id: 'previous_2025', key: PREVIOUS_KEY }],
  legacyKeys: [LEGACY_KEY],
});
const PREVIOUS = createSecretBoxKeyring({
  active: { id: 'previous_2025', key: PREVIOUS_KEY },
});

interface FakeRepository {
  rows: Map<string, string>;
  replacements: number;
  forceConflict: boolean;
  listSecretEnvelopes(
    afterUserId: string | null,
    limit: number,
  ): Promise<Array<{ userId: string; envelope: string }>>;
  replaceSecretEnvelope(
    userId: string,
    expectedEnvelope: string,
    replacementEnvelope: string,
  ): Promise<boolean>;
}

function fakeRepository(initial: Record<string, string>): FakeRepository {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    replacements: 0,
    forceConflict: false,
    async listSecretEnvelopes(afterUserId, limit) {
      return [...rows.entries()]
        .filter(([userId]) => afterUserId === null || userId > afterUserId)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit)
        .map(([userId, envelope]) => ({ userId, envelope }));
    },
    async replaceSecretEnvelope(userId, expectedEnvelope, replacementEnvelope) {
      if (this.forceConflict || rows.get(userId) !== expectedEnvelope) return false;
      rows.set(userId, replacementEnvelope);
      this.replacements += 1;
      return true;
    },
  };
}

function repositories(
  twoFactor: FakeRepository,
  discord: FakeRepository,
): RecordSecretRepositories {
  return { twoFactor, discord };
}

describe('record-secret re-encryption command', () => {
  it('dry-runs every envelope, reports failures, and writes nothing', async () => {
    const twoFactor = fakeRepository({
      'user-1': encryptSecret('legacy TOTP', LEGACY_KEY),
      'user-2': encryptSecret('already active', ACTIVE),
      'user-3': 'v2.unknown.bad.bad.bad',
    });
    const discord = fakeRepository({
      'user-4': encryptSecret('previous Discord URL', PREVIOUS),
    });

    const report = await reencryptRecordSecrets({
      dryRun: true,
      batchSize: 2,
      keyring: ACTIVE,
      repositories: repositories(twoFactor, discord),
    });

    expect(report).toEqual({
      mode: 'dry-run',
      twoFactor: {
        scanned: 3,
        alreadyActive: 1,
        wouldReencrypt: 1,
        reencrypted: 0,
        conflicts: 0,
        failed: 1,
      },
      discord: {
        scanned: 1,
        alreadyActive: 0,
        wouldReencrypt: 1,
        reencrypted: 0,
        conflicts: 0,
        failed: 0,
      },
    });
    expect(twoFactor.replacements).toBe(0);
    expect(discord.replacements).toBe(0);
  });

  it('is resumable and idempotent after verified compare-and-swap replacements', async () => {
    const twoFactor = fakeRepository({
      'user-1': encryptSecret('legacy TOTP', LEGACY_KEY),
    });
    const discord = fakeRepository({
      'user-2': encryptSecret('previous Discord URL', PREVIOUS),
    });

    const first = await reencryptRecordSecrets({
      dryRun: false,
      keyring: ACTIVE,
      repositories: repositories(twoFactor, discord),
    });
    expect(first.twoFactor.reencrypted).toBe(1);
    expect(first.discord.reencrypted).toBe(1);
    expect(decryptSecret(twoFactor.rows.get('user-1')!, ACTIVE)).toBe('legacy TOTP');
    expect(decryptSecret(discord.rows.get('user-2')!, ACTIVE)).toBe('previous Discord URL');
    expect(twoFactor.rows.get('user-1')).toMatch(/^v2\.active_2026\./);
    expect(discord.rows.get('user-2')).toMatch(/^v2\.active_2026\./);

    const resumed = await reencryptRecordSecrets({
      dryRun: false,
      keyring: ACTIVE,
      repositories: repositories(twoFactor, discord),
    });
    expect(resumed.twoFactor).toMatchObject({ alreadyActive: 1, reencrypted: 0 });
    expect(resumed.discord).toMatchObject({ alreadyActive: 1, reencrypted: 0 });
    expect(twoFactor.replacements).toBe(1);
    expect(discord.replacements).toBe(1);
  });

  it('reports a concurrent-write conflict without replacing the newer row', async () => {
    const original = encryptSecret('legacy TOTP', LEGACY_KEY);
    const twoFactor = fakeRepository({ 'user-1': original });
    twoFactor.forceConflict = true;
    const discord = fakeRepository({});

    const report = await reencryptRecordSecrets({
      dryRun: false,
      keyring: ACTIVE,
      repositories: repositories(twoFactor, discord),
    });
    expect(report.twoFactor).toMatchObject({
      wouldReencrypt: 1,
      reencrypted: 0,
      conflicts: 1,
    });
    expect(twoFactor.rows.get('user-1')).toBe(original);
  });

  it('requires an explicit dry-run/apply mode and validates batch size', () => {
    expect(parseReencryptArgs(['node', 'script', '--dry-run'])).toEqual({
      dryRun: true,
      batchSize: 100,
    });
    expect(parseReencryptArgs(['node', 'script', '--apply', '--batch-size', '25'])).toEqual({
      dryRun: false,
      batchSize: 25,
    });
    expect(() => parseReencryptArgs(['node', 'script'])).toThrow('exactly one');
    expect(() => parseReencryptArgs(['node', 'script', '--apply', '--dry-run'])).toThrow(
      'exactly one',
    );
    expect(() => parseReencryptArgs(['node', 'script', '--apply', '--batch-size', '0'])).toThrow(
      'batch-size',
    );
  });
});
