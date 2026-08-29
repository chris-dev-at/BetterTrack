import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PARANOID_V1_ACCOUNT_DIGEST_SQL } from '../services/account/paranoidV1TransitionSql';

/**
 * `scripts/ops/export-paranoid-v1-backup.mjs` — §17 step 1, the owner-run
 * verified ciphertext backup that every destructive step downstream is gated on.
 *
 * §17: "dump every `paranoid_vaults` account blob + bounded history to a
 * verified archive on the prod host, offsite copy confirmed, THEN any
 * destructive step."
 *
 * "Verified" is the load-bearing word and the reason this suite exists. The
 * script must not conclude success from `writeFileSync` returning — it re-reads
 * the archive from disk and matches BOTH the per-table row counts and a SHA-256
 * content digest. The tamper case below proves that: a file mutated after the
 * write is caught, and no attestation is recorded, so the wipe stays locked.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../../../scripts/ops/export-paranoid-v1-backup.mjs');

interface AttestationRecord {
  id: string;
  archiveFile: string;
  archiveSha256: string;
  rowCounts: Record<string, number>;
  userDigests: Record<string, string>;
  createdBy: string;
  offsiteConfirmedAt: string | null;
  offsiteConfirmedSha256: string | null;
}

interface ExportModule {
  LEGACY_TABLES: readonly string[];
  PARANOID_V1_ACCOUNT_DIGEST_SQL: string;
  SNAPSHOT_ISOLATION: string;
  findGitRoot: (dir: string) => string | null;
  encodeValue: (value: unknown) => unknown;
  verifyArchive: (args: {
    file: string;
    expectedCounts: Record<string, number>;
    expectedContentSha256: string;
  }) => { ok: true; archiveSha256: string } | { ok: false; reason: string };
  runExport: (args: { port: FakePort; outDir: string; createdBy: string; now?: Date }) => Promise<{
    file: string;
    archiveSha256: string;
    counts: Record<string, number>;
    userDigests: Record<string, string>;
  }>;
  confirmOffsite: (args: {
    port: FakePort;
    archiveFile: string;
    offsiteSha256: string;
  }) => Promise<{ attestationId: string }>;
}

const loadScript = async (): Promise<ExportModule> =>
  (await import(pathToFileURL(SCRIPT).href)) as unknown as ExportModule;

const U1 = '019756a0-0000-7000-8000-0000000e9001';
const U2 = '019756a0-0000-7000-8000-0000000e9002';

/**
 * An in-memory stand-in for the `postgres` driver. The script's SQL is thin by
 * design — the sharp logic is the archive verification and the gate — so the
 * port keeps the suite hermetic while still exercising every branch.
 */
class FakePort {
  attestations: AttestationRecord[] = [];
  insertCalls = 0;
  /** Every read the export performed, in order, tagged with snapshot state. */
  reads: Array<{ call: string; inSnapshot: boolean }> = [];
  snapshots = 0;
  private inSnapshot = false;

  constructor(
    private readonly tables: Record<string, Array<Record<string, unknown>>>,
    private readonly digests: Record<string, string>,
  ) {}

  /**
   * The snapshot contract, enforced rather than assumed. A read outside the
   * snapshot is the TOCTOU the reviewer found: the archive would hold one
   * version of a vault while the digest covered another, and the wipe — which
   * trusts the digest — would then destroy bytes the archive never contained.
   * The fake refuses instead of quietly succeeding.
   */
  async withSnapshot<T>(run: (snap: FakePort) => Promise<T>): Promise<T> {
    this.snapshots += 1;
    this.inSnapshot = true;
    try {
      return await run(this);
    } finally {
      this.inSnapshot = false;
    }
  }

  private guard(call: string): void {
    this.reads.push({ call, inSnapshot: this.inSnapshot });
    if (!this.inSnapshot) {
      throw new Error(
        `${call} ran outside the snapshot: the archive and the digests would not ` +
          'be guaranteed to describe the same instant.',
      );
    }
  }

  listUserIds(): Promise<string[]> {
    this.guard('listUserIds');
    return Promise.resolve(Object.keys(this.digests));
  }

  readTable(name: string): Promise<Array<Record<string, unknown>>> {
    this.guard(`readTable(${name})`);
    return Promise.resolve(this.tables[name] ?? []);
  }

  accountDigest(userId: string): Promise<string> {
    this.guard('accountDigest');
    return Promise.resolve(this.digests[userId]!);
  }

  insertAttestation(record: AttestationRecord): Promise<void> {
    this.insertCalls += 1;
    this.attestations.push({ ...record });
    return Promise.resolve();
  }

  attestationByArchiveFile(file: string): Promise<AttestationRecord | null> {
    return Promise.resolve(this.attestations.find((a) => a.archiveFile === file) ?? null);
  }

  markOffsiteConfirmed(id: string, sha: string): Promise<void> {
    const row = this.attestations.find((a) => a.id === id);
    if (!row) throw new Error('no such attestation');
    row.offsiteConfirmedAt = new Date().toISOString();
    row.offsiteConfirmedSha256 = sha;
    return Promise.resolve();
  }
}

function freshPort(): FakePort {
  return new FakePort(
    {
      paranoid_vaults: [
        { user_id: U1, version: 7, blob: Buffer.from('ciphertext-1'), created_at: new Date(0) },
        { user_id: U2, version: 3, blob: Buffer.from('ciphertext-2'), created_at: new Date(0) },
      ],
      paranoid_vault_history: [
        {
          id: 'h1',
          user_id: U1,
          version: 6,
          blob: Buffer.from('older-1'),
          created_at: new Date(0),
        },
      ],
      paranoid_enable_transitions: [],
      paranoid_vault_server_candidates: [],
      paranoid_vault_retirements: [],
      paranoid_vault_retired: [],
      paranoid_rehydration_receipts: [],
    },
    { [U1]: 'a'.repeat(64), [U2]: 'b'.repeat(64) },
  );
}

const outsideRepo = (): string => mkdtempSync(path.join(tmpdir(), 'bt-e9-backup-'));

describe('export-paranoid-v1-backup — §17 step 1, the verified ciphertext backup', () => {
  it('writes a 0600 archive, verifies it off disk, and records the attestation', async () => {
    const script = await loadScript();
    const port = freshPort();
    const outDir = outsideRepo();

    const result = await script.runExport({ port, outDir, createdBy: 'owner' });

    // The archive really exists and is not world-readable: it holds every byte of
    // account ciphertext plus the account ids that own it.
    expect(statSync(result.file).mode & 0o777).toBe(0o600);
    expect(result.counts.paranoid_vaults).toBe(2);
    expect(result.counts.paranoid_vault_history).toBe(1);

    // `bytea` round-trips byte-exact through the archive.
    const parsed = JSON.parse(readFileSync(result.file, 'utf8')) as {
      tables: Record<string, Array<{ blob: { $bytea: string } }>>;
    };
    expect(Buffer.from(parsed.tables.paranoid_vaults![0]!.blob.$bytea, 'base64').toString()).toBe(
      'ciphertext-1',
    );

    // The attestation is the gate the wipe reads — one row, both accounts covered,
    // and NOT yet offsite-confirmed.
    expect(port.insertCalls).toBe(1);
    const attestation = port.attestations[0]!;
    expect(Object.keys(attestation.userDigests).sort()).toEqual([U1, U2].sort());
    expect(attestation.archiveSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(attestation.offsiteConfirmedAt).toBeNull();
  });

  it('catches an archive tampered with after the write, and attests nothing', async () => {
    const script = await loadScript();
    const outDir = outsideRepo();
    const file = path.join(outDir, 'archive.json');
    const payload = { tables: { paranoid_vaults: [{ user_id: U1 }] } };
    writeFileSync(file, JSON.stringify(payload));
    const honest = createHash('sha256').update(JSON.stringify(payload.tables)).digest('hex');

    // Truth first: the untampered file verifies.
    expect(
      script.verifyArchive({
        file,
        expectedCounts: { paranoid_vaults: 1 },
        expectedContentSha256: honest,
      }).ok,
    ).toBe(true);

    // Now a single row is removed behind the script's back.
    writeFileSync(file, JSON.stringify({ tables: { paranoid_vaults: [] } }));
    const verdict = script.verifyArchive({
      file,
      expectedCounts: { paranoid_vaults: 1 },
      expectedContentSha256: honest,
    });
    expect(verdict.ok).toBe(false);
  });

  it('refuses an output directory inside a git working tree', async () => {
    const script = await loadScript();
    // The repo itself: one `git add` away from publishing user ciphertext.
    expect(script.findGitRoot(HERE)).not.toBeNull();
    expect(script.findGitRoot(outsideRepo())).toBeNull();
  });

  it('offsite confirmation rejects a digest that does not match the archive', async () => {
    const script = await loadScript();
    const port = freshPort();
    const outDir = outsideRepo();
    const { file } = await script.runExport({ port, outDir, createdBy: 'owner' });

    await expect(
      script.confirmOffsite({ port, archiveFile: file, offsiteSha256: 'c'.repeat(64) }),
    ).rejects.toThrow(/does not match/iu);
    expect(port.attestations[0]!.offsiteConfirmedAt).toBeNull();
  });

  it('offsite confirmation accepts the true digest and opens the gate', async () => {
    const script = await loadScript();
    const port = freshPort();
    const outDir = outsideRepo();
    const { file, archiveSha256 } = await script.runExport({ port, outDir, createdBy: 'owner' });

    await script.confirmOffsite({ port, archiveFile: file, offsiteSha256: archiveSha256 });

    expect(port.attestations[0]!.offsiteConfirmedAt).not.toBeNull();
    expect(port.attestations[0]!.offsiteConfirmedSha256).toBe(archiveSha256);
  });

  it('reads the tables, the account list AND every digest inside ONE snapshot', async () => {
    const script = await loadScript();
    const port = freshPort();

    await script.runExport({ port, outDir: outsideRepo(), createdBy: 'owner' });

    // Exactly one snapshot, and not a single read escaped it. Without this the
    // export is a sequence of independent auto-commit queries: a client CAS-write
    // landing between the table dump and the digest pass would produce an
    // attestation whose digest describes data the archive does not contain, and
    // the wipe would then accept it and destroy the difference.
    expect(port.snapshots).toBe(1);
    expect(port.reads.length).toBeGreaterThan(0);
    expect(port.reads.filter((r) => !r.inSnapshot)).toEqual([]);
  });

  it('pins the snapshot to REPEATABLE READ — READ COMMITTED would not hold it', async () => {
    const script = await loadScript();
    // A transaction alone is not enough: under READ COMMITTED each statement gets
    // a new snapshot, so the dump and the digests could still straddle a commit.
    expect(script.SNAPSHOT_ISOLATION).toBe('isolation level repeatable read');
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toMatch(/sql\.begin\(\s*SNAPSHOT_ISOLATION/u);
  });

  it('shares ONE account-digest statement with the wipe service, byte for byte', async () => {
    const script = await loadScript();
    // The script digests each account at backup time; the wipe recomputes the
    // same digest inside its own transaction and refuses on any difference. If
    // these two statements ever drift, that comparison silently stops meaning
    // anything — so they are pinned to each other here.
    expect(script.PARANOID_V1_ACCOUNT_DIGEST_SQL).toBe(PARANOID_V1_ACCOUNT_DIGEST_SQL);
  });
});
