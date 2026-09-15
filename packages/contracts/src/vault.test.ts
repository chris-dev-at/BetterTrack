import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CASH_RULE_PATTERN_MAX, CASH_TAGS_PER_ITEM_MAX, CASH_TAGS_PER_USER_MAX } from './cash';
import { EXPENSE_RULE_PATTERN_MAX } from './expenses';
import {
  decodeVaultEnvelope,
  encodeVaultEnvelope,
  parseVaultEtag,
  privacyModeSchema,
  readVaultServerHeader,
  VAULT_CONTENT_CIPHER,
  VAULT_DOCUMENT_VERSION,
  VAULT_FORMAT_VERSION,
  VAULT_HISTORY_PAGE_MAX,
  VAULT_MAGIC,
  VAULT_VERSION_MAX,
  vaultDocumentV1Schema,
  vaultClientSecuritySchema,
  vaultEnvelopeHeaderSchema,
  vaultEtag,
  VaultEnvelopeError,
  vaultHistoryListQuerySchema,
  vaultHistoryListResponseSchema,
  vaultHistoryMetadataSchema,
  vaultHistoryVersionParamSchema,
  paranoidDisableRequestSchema,
  paranoidMediaStateResponseSchema,
  paranoidMediaTransitionRequestSchema,
  paranoidVaultMediaStateSchema,
  retiredServerPurgeRequestSchema,
  vaultMediaSetSchema,
  vaultRetirementProofPublicKeySchema,
  vaultRetirementProofPrivateKeySchema,
  vaultServerHeaderSchema,
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_ENTITY_ROW_SCHEMAS,
  vaultStrictDocumentV1Schema,
  vaultVersionSchema,
} from './vault';

const UUID_A = '018f0000-0000-7000-8000-00000000000a';
const UUID_B = '018f0000-0000-7000-8000-00000000000b';
const UUID_C = '018f0000-0000-7000-8000-00000000000c';

function validHeader(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: VAULT_FORMAT_VERSION,
    cipher: VAULT_CONTENT_CIPHER,
    iv: 'aXYtOTZiaXQ=',
    keyId: UUID_A,
    wrappedKeys: [
      {
        keyId: UUID_A,
        kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: 'c2FsdA==' },
        wrappedVk: 'd3JhcHBlZA==',
      },
    ],
    vaultVersion: 1,
    schemaVersion: VAULT_DOCUMENT_VERSION,
    deviceId: UUID_B,
    writeId: UUID_C,
    writtenAt: '2026-07-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('privacy mode', () => {
  it('accepts the two modes and rejects anything else', () => {
    expect(privacyModeSchema.parse('normal')).toBe('normal');
    expect(privacyModeSchema.parse('paranoid')).toBe('paranoid');
    expect(privacyModeSchema.safeParse('drive-only').success).toBe(false);
  });
});

describe('media set', () => {
  it('accepts every non-empty subset', () => {
    expect(vaultMediaSetSchema.parse(['server'])).toEqual(['server']);
    expect(vaultMediaSetSchema.parse(['drive'])).toEqual(['drive']);
    expect(vaultMediaSetSchema.parse(['server', 'drive'])).toEqual(['server', 'drive']);
  });

  it('rejects an empty set, an unknown medium, and a repeated medium', () => {
    expect(vaultMediaSetSchema.safeParse([]).success).toBe(false);
    expect(vaultMediaSetSchema.safeParse(['icloud']).success).toBe(false);
    expect(vaultMediaSetSchema.safeParse(['server', 'server']).success).toBe(false);
  });
});

describe('durable media transition contracts', () => {
  const serverOnly = { mediaSet: ['server'], driveAttestedVersion: null } as const;
  const both = { mediaSet: ['server', 'drive'], driveAttestedVersion: 4 } as const;

  it('rejects no-op and multi-medium transitions while pinning the required read-back kind', () => {
    expect(
      paranoidMediaTransitionRequestSchema.safeParse({
        expected: serverOnly,
        nextMediaSet: ['server'],
        verification: { kind: 'server', version: 1 },
      }).success,
    ).toBe(false);
    expect(
      paranoidMediaTransitionRequestSchema.safeParse({
        expected: serverOnly,
        nextMediaSet: ['drive'],
        verification: { kind: 'drive', version: 1 },
      }).success,
    ).toBe(false);
    expect(
      paranoidMediaTransitionRequestSchema.safeParse({
        expected: serverOnly,
        nextMediaSet: ['server', 'drive'],
        verification: { kind: 'server', version: 1 },
      }).success,
    ).toBe(false);
    expect(
      paranoidMediaTransitionRequestSchema.safeParse({
        expected: both,
        nextMediaSet: ['drive'],
        verification: { kind: 'drive', version: 4 },
      }).success,
    ).toBe(true);
  });

  it('exposes only physical server disposition metadata, never ciphertext', () => {
    const state = {
      mediaSet: ['drive'],
      driveAttestedVersion: 4,
      server: {
        disposition: 'inactive-candidate',
        candidate: {
          candidateId: UUID_A,
          version: 4,
          formatVersion: 1,
          sizeBytes: 42,
          expiresAt: '2026-07-24T10:10:00.000Z',
        },
        retired: {
          version: 3,
          retiredAt: '2026-07-24T10:00:00.000Z',
          purgeAfter: '2026-07-31T10:00:00.000Z',
        },
      },
    };
    expect(paranoidVaultMediaStateSchema.parse(state)).toEqual(state);
    expect(
      paranoidVaultMediaStateSchema.safeParse({
        ...state,
        server: { ...state.server, ciphertext: 'never exposed' },
      }).success,
    ).toBe(false);
    expect(
      paranoidMediaStateResponseSchema.safeParse({ privacyMode: 'normal', mediaState: state })
        .success,
    ).toBe(false);
  });

  it('keeps retired purge proof inputs strict and bounded', () => {
    expect(
      retiredServerPurgeRequestSchema.safeParse({
        retiredVersion: 4,
        observedVersion: 5,
        challenge: 'x'.repeat(40),
        signature: 'a'.repeat(86),
      }).success,
    ).toBe(true);
    expect(
      retiredServerPurgeRequestSchema.safeParse({
        retiredVersion: 4,
        observedVersion: 5,
        challenge: 'x'.repeat(40),
        signature: 'not base64url!',
      }).success,
    ).toBe(false);
  });

  it('accepts only canonical Ed25519 SPKI retirement verifiers', () => {
    const pair = generateKeyPairSync('ed25519');
    const ed25519 = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const privateKey = pair.privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64url');
    const x25519 = generateKeyPairSync('x25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64url');

    expect(vaultRetirementProofPublicKeySchema.safeParse(ed25519).success).toBe(true);
    expect(vaultRetirementProofPrivateKeySchema.safeParse(privateKey).success).toBe(true);
    expect(
      vaultClientSecuritySchema.safeParse({
        retirementProof: { publicKey: ed25519, privateKey },
      }).success,
    ).toBe(true);
    expect(vaultRetirementProofPublicKeySchema.safeParse(x25519).success).toBe(false);
    expect(vaultRetirementProofPrivateKeySchema.safeParse('a'.repeat(64)).success).toBe(false);
    expect(vaultRetirementProofPublicKeySchema.safeParse('a'.repeat(59)).success).toBe(false);
  });
});

describe('blind vault history', () => {
  const metadata = {
    version: 7,
    createdAt: '2026-07-24T10:00:00.000Z',
    sizeBytes: 4096,
    medium: 'server' as const,
  };

  it('accepts only non-sensitive metadata and rejects cleartext-derived fields', () => {
    expect(vaultHistoryMetadataSchema.parse(metadata)).toEqual(metadata);
    for (const leaked of [
      { decryptedRowCount: 12 },
      { entityNames: ['portfolio'] },
      { documentHash: 'cleartext-derived' },
      { plaintext: { balance: 42 } },
    ]) {
      expect(vaultHistoryMetadataSchema.safeParse({ ...metadata, ...leaked }).success).toBe(false);
    }

    expect(
      vaultHistoryListResponseSchema.safeParse({
        items: [metadata],
        nextCursor: null,
        portfolioNames: ['Main'],
      }).success,
    ).toBe(false);
  });

  it('leaves oversized page requests valid so the server can clamp them', () => {
    expect(vaultHistoryListQuerySchema.parse({ limit: VAULT_HISTORY_PAGE_MAX * 100 })).toEqual({
      limit: VAULT_HISTORY_PAGE_MAX * 100,
    });
  });

  it('bounds durable versions, list cursors, and read params to PostgreSQL int4', () => {
    expect(vaultVersionSchema.parse(VAULT_VERSION_MAX)).toBe(VAULT_VERSION_MAX);
    expect(vaultVersionSchema.safeParse(VAULT_VERSION_MAX + 1).success).toBe(false);
    expect(vaultHistoryListQuerySchema.parse({ cursor: String(VAULT_VERSION_MAX) })).toEqual({
      cursor: VAULT_VERSION_MAX,
    });
    expect(
      vaultHistoryListQuerySchema.safeParse({ cursor: String(VAULT_VERSION_MAX + 1) }).success,
    ).toBe(false);
    expect(vaultHistoryVersionParamSchema.parse({ version: String(VAULT_VERSION_MAX) })).toEqual({
      version: VAULT_VERSION_MAX,
    });
    expect(
      vaultHistoryVersionParamSchema.safeParse({ version: String(VAULT_VERSION_MAX + 1) }).success,
    ).toBe(false);
  });
});

describe('envelope header', () => {
  it('validates a well-formed header and pins the format version', () => {
    expect(vaultEnvelopeHeaderSchema.parse(validHeader())).toMatchObject({ vaultVersion: 1 });
    expect(vaultEnvelopeHeaderSchema.safeParse(validHeader({ formatVersion: 2 })).success).toBe(
      false,
    );
    expect(vaultEnvelopeHeaderSchema.safeParse(validHeader({ vaultVersion: 0 })).success).toBe(
      false,
    );
  });

  it('server header view reads only formatVersion + vaultVersion and strips the rest', () => {
    const parsed = vaultServerHeaderSchema.parse(validHeader());
    expect(parsed).toEqual({ formatVersion: 1, vaultVersion: 1 });
    // The crypto material never survives the server-side parse.
    expect(parsed).not.toHaveProperty('wrappedKeys');
    expect(parsed).not.toHaveProperty('iv');
  });
});

describe('envelope codec', () => {
  it('round-trips a header + ciphertext', () => {
    const ciphertext = new Uint8Array([1, 2, 3, 250, 0, 128]);
    const bytes = encodeVaultEnvelope(validHeader(), ciphertext);
    // Magic prefix is intact.
    expect(new TextDecoder().decode(bytes.subarray(0, VAULT_MAGIC.length))).toBe(VAULT_MAGIC);

    const decoded = decodeVaultEnvelope(bytes);
    expect(vaultServerHeaderSchema.parse(decoded.header)).toEqual({
      formatVersion: 1,
      vaultVersion: 1,
    });
    expect(Array.from(decoded.ciphertext)).toEqual(Array.from(ciphertext));
  });

  it('readVaultServerHeader extracts the CAS fields', () => {
    const bytes = encodeVaultEnvelope(validHeader({ vaultVersion: 7 }), new Uint8Array([9]));
    expect(readVaultServerHeader(bytes)).toEqual({ formatVersion: 1, vaultVersion: 7 });
  });

  it('rejects malformed envelopes', () => {
    expect(() => decodeVaultEnvelope(new Uint8Array([1, 2, 3]))).toThrow(VaultEnvelopeError);
    // Right length, wrong magic.
    const wrongMagic = encodeVaultEnvelope(validHeader(), new Uint8Array());
    wrongMagic[0] = 0;
    expect(() => decodeVaultEnvelope(wrongMagic)).toThrow(VaultEnvelopeError);
    // Header length prefix claims more bytes than exist.
    const truncated = encodeVaultEnvelope(validHeader(), new Uint8Array());
    const broken = truncated.subarray(0, truncated.length - 10);
    expect(() => decodeVaultEnvelope(broken)).toThrow(VaultEnvelopeError);
    // A header without the required CAS fields is rejected by the server read.
    const noVersion = encodeVaultEnvelope({ formatVersion: 1 }, new Uint8Array());
    expect(() => readVaultServerHeader(noVersion)).toThrow(VaultEnvelopeError);
  });
});

describe('etag helpers', () => {
  it('formats and parses a version tag', () => {
    expect(vaultEtag(12)).toBe('"12"');
    expect(parseVaultEtag('"12"')).toBe(12);
    expect(parseVaultEtag('W/"12"')).toBe(12);
    expect(parseVaultEtag('  12 ')).toBe(12);
  });

  it('rejects wildcards, lists and non-integers', () => {
    expect(parseVaultEtag('*')).toBeNull();
    expect(parseVaultEtag('"1", "2"')).toBeNull();
    expect(parseVaultEtag('abc')).toBeNull();
    expect(parseVaultEtag(undefined)).toBeNull();
    expect(parseVaultEtag(null)).toBeNull();
  });
});

describe('vault document v1', () => {
  it('parses a minimal document and defaults the merge log', () => {
    const doc = vaultDocumentV1Schema.parse({
      schemaVersion: 1,
      entities: {
        portfolio: [
          {
            id: UUID_A,
            rev: 0,
            editedAt: '2026-07-24T10:00:00.000Z',
            editedBy: UUID_B,
            deletedAt: null,
            data: { name: 'Main' },
          },
        ],
      },
    });
    expect(doc.mergeLog).toEqual([]);
    expect(doc.entities.portfolio?.[0]?.data.name).toBe('Main');
  });

  it('rejects an unknown entity kind and a wrong schema version', () => {
    expect(vaultDocumentV1Schema.safeParse({ schemaVersion: 2, entities: {} }).success).toBe(false);
    expect(
      vaultDocumentV1Schema.safeParse({ schemaVersion: 1, entities: { bogus: [] } }).success,
    ).toBe(false);
  });
});

describe('paranoid disable request', () => {
  const emptyDocument = { schemaVersion: 1 as const, entities: [], mergeLog: [] };
  const base = { confirm: true as const, rehydrationId: UUID_A, document: emptyDocument };

  it('asks a restoring disable for nothing but the confirmation', () => {
    expect(paranoidDisableRequestSchema.safeParse(base).success).toBe(true);
  });

  it('requires the account-deletion rung on the irreversible discard', () => {
    // Neither half may be optional: the flag destroys a vault whose owner
    // cannot decrypt it, so it carries the same gates as `DELETE /account`.
    expect(paranoidDisableRequestSchema.safeParse({ ...base, discard: true }).success).toBe(false);
    expect(
      paranoidDisableRequestSchema.safeParse({ ...base, discard: true, confirmUsername: 'ada' })
        .success,
    ).toBe(false);
    expect(
      paranoidDisableRequestSchema.safeParse({ ...base, discard: true, password: 'hunter2hunter2' })
        .success,
    ).toBe(false);

    for (const credential of [
      { password: 'hunter2hunter2' },
      { code: '123456' },
      { recoveryCode: 'abcd-efgh' },
    ]) {
      expect(
        paranoidDisableRequestSchema.safeParse({
          ...base,
          discard: true,
          confirmUsername: 'ada',
          ...credential,
        }).success,
      ).toBe(true);
    }
  });
});

describe('restored rule rows', () => {
  /**
   * A rule pattern in a vault document used to be a bare `z.string()`, so the
   * restore lane could install a pattern no HTTP request could ever create —
   * the document itself is bounded only by `VAULT_MAX_BYTES_DEFAULT` (16 MB),
   * and the rule engine then matched it against every note (#1743).
   */
  const cashRule = (pattern: string) => ({
    userId: UUID_A,
    matchType: 'contains' as const,
    pattern,
    priority: 0,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const expenseRule = (pattern: string) => ({
    userId: UUID_A,
    categoryId: UUID_B,
    matchType: 'contains' as const,
    pattern,
    priority: 0,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('holds a restored cash-rule pattern to the ceiling the write path enforces', () => {
    expect(
      VAULT_ENTITY_ROW_SCHEMAS.cashRule.safeParse(cashRule('a'.repeat(CASH_RULE_PATTERN_MAX)))
        .success,
    ).toBe(true);
    expect(
      VAULT_ENTITY_ROW_SCHEMAS.cashRule.safeParse(cashRule('a'.repeat(CASH_RULE_PATTERN_MAX + 1)))
        .success,
    ).toBe(false);
    // The 16 MB case the bound exists for.
    expect(VAULT_ENTITY_ROW_SCHEMAS.cashRule.safeParse(cashRule('a'.repeat(100_000))).success).toBe(
      false,
    );
    expect(VAULT_ENTITY_ROW_SCHEMAS.cashRule.safeParse(cashRule('')).success).toBe(false);
  });

  it('holds a restored expense-rule pattern to the same ceiling', () => {
    expect(
      VAULT_ENTITY_ROW_SCHEMAS.expenseRule.safeParse(
        expenseRule('a'.repeat(EXPENSE_RULE_PATTERN_MAX)),
      ).success,
    ).toBe(true);
    expect(
      VAULT_ENTITY_ROW_SCHEMAS.expenseRule.safeParse(
        expenseRule('a'.repeat(EXPENSE_RULE_PATTERN_MAX + 1)),
      ).success,
    ).toBe(false);
    expect(VAULT_ENTITY_ROW_SCHEMAS.expenseRule.safeParse(expenseRule('')).success).toBe(false);
  });

  it('REFUSES rather than truncates, so a restored rule cannot quietly become another rule', () => {
    const parsed = VAULT_ENTITY_ROW_SCHEMAS.cashRule.safeParse(
      cashRule('a'.repeat(CASH_RULE_PATTERN_MAX + 1)),
    );
    expect(parsed.success).toBe(false);
    // And a legal pattern survives the trip byte-for-byte — no trimming, no
    // normalizing: a restore gives back what the document holds, or refuses it.
    const kept = ' spaced pattern ';
    const ok = VAULT_ENTITY_ROW_SCHEMAS.cashRule.safeParse(cashRule(kept));
    expect(ok.success && ok.data.pattern).toBe(kept);
  });
});

describe('a restored rule’s tag fan-out (#1954)', () => {
  /**
   * `CASH_TAGS_PER_ITEM_MAX` is the cap the HTTP path gets for free, because a
   * written rule carries its tags as ONE array (`tagIdsSchema`). A restore
   * carries the same set as N independent `cashRuleTag` link rows, so no row
   * schema can see the cardinality and the document has to state it.
   *
   * Left ungated, the fan-out multiplies every later pass: `loadRules`
   * aggregates a rule's tags with an unbounded `array_agg` and
   * `applyCashRuleTags` pushes one (movement, tag) pair per tag per matched
   * movement — the other half of the product #1743 capped the rule COUNT of.
   */
  const RULE_A = '018f0000-0000-7000-8000-0000000000e1';
  const RULE_B = '018f0000-0000-7000-8000-0000000000e2';

  /**
   * A DISTINCT tag per link. `(ruleId, tagId)` is unique in `cash_rule_tags` and
   * the document now says so too (#1963), so a fan-out fixture that repeated one
   * tag id would be refused for being a duplicate and would stop proving
   * anything about the fan-out cap.
   */
  const tagId = (index: number) =>
    `018f0000-0000-7000-8000-1${index.toString(16).padStart(11, '0')}`;

  const link = (ruleId: string, index: number, deletedAt: string | null = null) => ({
    id: `018f0000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
    rev: 1,
    editedAt: '2026-01-01T00:00:00.000Z',
    editedBy: UUID_A,
    deletedAt,
    kind: 'cashRuleTag' as const,
    data: { ruleId, tagId: tagId(index), createdAt: '2026-01-01T00:00:00.000Z' },
  });

  const documentWith = (...links: ReturnType<typeof link>[]) => ({
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities: links,
    mergeLog: [],
    mirrorProvenance: [],
  });

  const linksFor = (ruleId: string, count: number, offset = 0) =>
    Array.from({ length: count }, (_unused, i) => link(ruleId, offset + i));

  /** Soft-deleted links: `deletedAt` set, which is what a tombstone IS (§2/§4). */
  const tombstonesFor = (ruleId: string, count: number, offset = 0) =>
    Array.from({ length: count }, (_unused, i) =>
      link(ruleId, offset + i, '2026-02-01T00:00:00.000Z'),
    );

  it('accepts a rule landing EXACTLY on the cap', () => {
    const parsed = vaultStrictDocumentV1Schema.safeParse(
      documentWith(...linksFor(RULE_A, CASH_TAGS_PER_ITEM_MAX)),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.entities).toHaveLength(CASH_TAGS_PER_ITEM_MAX);
  });

  it('refuses the WHOLE document one link past the cap — never a bounded prefix', () => {
    const parsed = vaultStrictDocumentV1Schema.safeParse(
      documentWith(...linksFor(RULE_A, CASH_TAGS_PER_ITEM_MAX + 1)),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.code).toBe('too_big');
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(['entities']);
  });

  it('counts PER RULE, so two capped rules in one document are legal', () => {
    // The bound is a rule's fan-out, not the document's link count: an account
    // with many fully-tagged rules is ordinary, and refusing it would make a
    // legitimate vault unrestorable.
    const parsed = vaultStrictDocumentV1Schema.safeParse(
      documentWith(
        ...linksFor(RULE_A, CASH_TAGS_PER_ITEM_MAX),
        ...linksFor(RULE_B, CASH_TAGS_PER_ITEM_MAX, 1_000),
      ),
    );
    expect(parsed.success).toBe(true);

    // …and one rule past the cap still condemns the document even when its
    // sibling is fine — the offender is found wherever it sits.
    expect(
      vaultStrictDocumentV1Schema.safeParse(
        documentWith(
          ...linksFor(RULE_A, CASH_TAGS_PER_ITEM_MAX),
          ...linksFor(RULE_B, CASH_TAGS_PER_ITEM_MAX + 1, 1_000),
        ),
      ).success,
    ).toBe(false);
  });

  it('refuses the 16 MB case the bound exists for', () => {
    // A document is bounded only by VAULT_MAX_BYTES_DEFAULT, so "one rule, five
    // thousand tags" is a shape a client can actually write.
    expect(
      vaultStrictDocumentV1Schema.safeParse(documentWith(...linksFor(RULE_A, 5_000))).success,
    ).toBe(false);
  });

  it('counts LIVE links only — a tombstone is not a tag the rule carries', () => {
    /**
     * THE TWO SEAMS HAVE TO AGREE, AND THE SERVICE SEAM COUNTS LIVE ROWS.
     * `paranoidRehydrationService` hands `restoreRuleTags` the output of
     * `liveEntities()` (`entity.deletedAt === null`), so a tombstoned link never
     * reaches the table and never joins a rule's `array_agg`. A refinement
     * counting tombstones would therefore refuse documents the service accepts —
     * the two gates disagreeing about the same document.
     *
     * And the disagreement would not be academic. `paranoidDisable.ts`'s
     * `toStrictRestoreDocument` pushes EVERY row of the unlocked document into
     * this schema, tombstones included, and throws `document-invalid` when the
     * parse fails — with no bypass. The day the paranoid client can soft-delete
     * a `cashRuleTag` (§16 2026-08-19 item 6), a user who had unlinked one tag
     * from a fully-tagged rule could not disable paranoid mode or move a
     * portfolio out AT ALL. A cap on live fan-out must not become a lock on the
     * exit.
     */
    const parsed = vaultStrictDocumentV1Schema.safeParse(
      documentWith(
        ...linksFor(RULE_A, CASH_TAGS_PER_ITEM_MAX),
        ...tombstonesFor(RULE_A, 40, 2_000),
      ),
    );
    expect(parsed.success).toBe(true);
    // The tombstones are CARRIED, not dropped: §4's merge rules key off them, so
    // the refinement must ignore them without removing them.
    expect(parsed.success && parsed.data.entities).toHaveLength(CASH_TAGS_PER_ITEM_MAX + 40);

    // …and the live count is still what decides: one live link past the cap is
    // refused however many tombstones sit beside it.
    expect(
      vaultStrictDocumentV1Schema.safeParse(
        documentWith(
          ...linksFor(RULE_A, CASH_TAGS_PER_ITEM_MAX + 1),
          ...tombstonesFor(RULE_A, 40, 2_000),
        ),
      ).success,
    ).toBe(false);
  });

  it('leaves a document with no rule links alone', () => {
    expect(vaultStrictDocumentV1Schema.safeParse(documentWith()).success).toBe(true);
  });
});

describe('a restored account’s TAG SET (#1963)', () => {
  /**
   * The tag table was the last uncapped restore surface in the cash lane. #1743
   * capped the rule COUNT and #1954 capped a rule's tag FAN-OUT, but a document
   * could still carry tens of thousands of `cashTag` rows — and those rows are
   * what made 20 000 links to one rule reachable to begin with. They are also
   * read back unbounded (`GET /cash/tags` returns the whole set) and cascade
   * into every link table on delete.
   *
   * LIVE TAGS ONLY, for the reason the fan-out refinement states at length: the
   * service gate counts `liveEntities()`, and `paranoidDisable.ts` pushes every
   * row — tombstones included — through this schema on the way OUT. A cap that
   * counted tombstones would refuse documents the service accepts and could turn
   * a deleted tag into a locked exit.
   */
  const tag = (index: number, deletedAt: string | null = null) => ({
    id: `018f0000-0000-7000-8000-2${index.toString(16).padStart(11, '0')}`,
    rev: 1,
    editedAt: '2026-01-01T00:00:00.000Z',
    editedBy: UUID_A,
    deletedAt,
    kind: 'cashTag' as const,
    data: {
      userId: UUID_A,
      name: `tag-${index}`,
      color: '#64748b',
      system: false,
      systemKey: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });

  const tags = (count: number, offset = 0, deletedAt: string | null = null) =>
    Array.from({ length: count }, (_unused, i) => tag(offset + i, deletedAt));

  const documentWith = (...entities: ReturnType<typeof tag>[]) => ({
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities,
    mergeLog: [],
    mirrorProvenance: [],
  });

  it('accepts a document landing EXACTLY on the cap', () => {
    const parsed = vaultStrictDocumentV1Schema.safeParse(
      documentWith(...tags(CASH_TAGS_PER_USER_MAX)),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.entities).toHaveLength(CASH_TAGS_PER_USER_MAX);
  });

  it('refuses the WHOLE document one tag past the cap — never a bounded prefix', () => {
    const parsed = vaultStrictDocumentV1Schema.safeParse(
      documentWith(...tags(CASH_TAGS_PER_USER_MAX + 1)),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.code).toBe('too_big');
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(['entities']);
    // First offender wins: one issue, not one per offending row. A document
    // already refused does not become more refused, and a malformed one must not
    // make the server build an issue list proportional to its own size.
    expect(parsed.success === false && parsed.error.issues).toHaveLength(1);
  });

  it('refuses the 16 MB case the bound exists for', () => {
    expect(vaultStrictDocumentV1Schema.safeParse(documentWith(...tags(20_000))).success).toBe(
      false,
    );
  });

  it('counts LIVE tags only — a tombstone is not a tag the account holds', () => {
    const parsed = vaultStrictDocumentV1Schema.safeParse(
      documentWith(
        ...tags(CASH_TAGS_PER_USER_MAX),
        ...tags(500, 100_000, '2026-02-01T00:00:00.000Z'),
      ),
    );
    expect(parsed.success).toBe(true);
    // Carried, not dropped: §4's merge rules key off tombstones.
    expect(parsed.success && parsed.data.entities).toHaveLength(CASH_TAGS_PER_USER_MAX + 500);

    // …and the live count is still what decides.
    expect(
      vaultStrictDocumentV1Schema.safeParse(
        documentWith(
          ...tags(CASH_TAGS_PER_USER_MAX + 1),
          ...tags(500, 100_000, '2026-02-01T00:00:00.000Z'),
        ),
      ).success,
    ).toBe(false);
  });

  it('leaves a document with no tags alone', () => {
    expect(vaultStrictDocumentV1Schema.safeParse(documentWith()).success).toBe(true);
  });
});

describe('a restored rule→tag link is UNIQUE per pair (#1963)', () => {
  /**
   * `cash_rule_tags` carries `uniqueIndex('cash_rule_tags_rule_tag_unique')`, and
   * the restore repository inserts with no conflict handling ON PURPOSE — "a
   * duplicate here means a malformed vault, which must fail loudly rather than
   * be absorbed". Loudly meant a Postgres unique violation inside the open
   * rehydration transaction: a 500, after the document had already been proved
   * and the write had begun.
   *
   * REFUSED, NOT DE-DUPLICATED, because the exporter cannot produce this shape:
   * every document producer in the app reads the link set from the table the
   * unique index guards (`rule.tagIds` per rule, one capture, fresh entity ids),
   * so a repeated pair is a document no legitimate capture wrote. Absorbing it
   * with `onConflictDoNothing` would silently accept a payload we cannot explain
   * — and would quietly make the fan-out cap count something other than what
   * lands in the table.
   */
  const RULE = '018f0000-0000-7000-8000-0000000000e1';
  const OTHER_RULE = '018f0000-0000-7000-8000-0000000000e2';
  const TAG = '018f0000-0000-7000-8000-0000000000f1';
  const OTHER_TAG = '018f0000-0000-7000-8000-0000000000f2';

  const link = (index: number, ruleId: string, tagId: string, deletedAt: string | null = null) => ({
    id: `018f0000-0000-7000-8000-3${index.toString(16).padStart(11, '0')}`,
    rev: 1,
    editedAt: '2026-01-01T00:00:00.000Z',
    editedBy: UUID_A,
    deletedAt,
    kind: 'cashRuleTag' as const,
    data: { ruleId, tagId, createdAt: '2026-01-01T00:00:00.000Z' },
  });

  const documentWith = (...entities: ReturnType<typeof link>[]) => ({
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities,
    mergeLog: [],
    mirrorProvenance: [],
  });

  it('refuses the same (rule, tag) pair twice, instead of leaving it to the unique index', () => {
    const parsed = vaultStrictDocumentV1Schema.safeParse(
      documentWith(link(1, RULE, TAG), link(2, RULE, TAG)),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.code).toBe('custom');
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(['entities']);
    expect(parsed.success === false && parsed.error.issues).toHaveLength(1);
  });

  it('is a PAIR, not an id: the same tag on two rules and two tags on one rule are legal', () => {
    expect(
      vaultStrictDocumentV1Schema.safeParse(
        documentWith(link(1, RULE, TAG), link(2, OTHER_RULE, TAG), link(3, RULE, OTHER_TAG)),
      ).success,
    ).toBe(true);
  });

  it('lets a TOMBSTONED link sit beside the live one — unlink then relink is not a duplicate', () => {
    /**
     * The exit-path rule again (§16 2026-08-19 item 6): the day the client can
     * soft-delete a `cashRuleTag`, removing a tag from a rule and adding it back
     * leaves a tombstone and a live row for the same pair. Only the live row is
     * ever written, so only live rows may be compared — otherwise an ordinary
     * edit would make the vault unrestorable AND undisableable.
     */
    expect(
      vaultStrictDocumentV1Schema.safeParse(
        documentWith(link(1, RULE, TAG, '2026-02-01T00:00:00.000Z'), link(2, RULE, TAG)),
      ).success,
    ).toBe(true);

    // Two tombstones of the same pair are equally harmless — neither is written.
    expect(
      vaultStrictDocumentV1Schema.safeParse(
        documentWith(
          link(1, RULE, TAG, '2026-02-01T00:00:00.000Z'),
          link(2, RULE, TAG, '2026-03-01T00:00:00.000Z'),
        ),
      ).success,
    ).toBe(true);
  });

  it('names the DUPLICATE, not the cap, when a rule is over-tagged BY duplicates', () => {
    // 20 distinct tags plus one repeat is 21 rows for one rule, which the #1954
    // fan-out cap would also refuse. The pair check runs first so the answer
    // describes what is actually wrong with the document.
    const distinct = Array.from({ length: CASH_TAGS_PER_ITEM_MAX }, (_unused, i) =>
      link(i, RULE, `018f0000-0000-7000-8000-4${i.toString(16).padStart(11, '0')}`),
    );
    const parsed = vaultStrictDocumentV1Schema.safeParse(
      documentWith(...distinct, link(900, RULE, distinct[0]!.data.tagId)),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.code).toBe('custom');
  });
});
