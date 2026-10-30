import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CASH_TAGS_PER_ITEM_MAX } from './cash';
import { IMPORT_ROW_CANDIDATE_LIMIT } from './imports';
import { MIRROR_ROW_KINDS } from './mirrorchain';
import {
  VAULT_ENTITY_SCHEMAS,
  VAULT_IMPORT_UNDERSTANDING_COLUMNS_MAX,
  VAULT_MERGE_RECORD_MIN_JSON_BYTES,
  VAULT_MERGE_RECORD_PARENTS_MAX,
  VAULT_STRICT_DOCUMENT_COLLECTION_BOUNDS,
  VAULT_STRICT_ENTITY_MIN_JSON_BYTES,
  firstInvalidVaultStrictDocumentElement,
  precheckVaultStrictDocumentShape,
  vaultEntityMetaSchema,
  vaultJsonSchema,
  vaultMergeRecordSchema,
  vaultMirrorProvenanceSchema,
  vaultStrictDocumentEntitiesCeiling,
  vaultStrictDocumentMergeLogCeiling,
  vaultStrictDocumentV1Schema,
  vaultStrictEntitySchema,
} from './vault';

// Deterministic TEST VECTOR identifiers only.
const uuid = (value: number) => `018f0000-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;
const SHORTEST_DATETIME = '2026-01-01T00:00Z';
const AT = '2026-07-24T10:00:00.000Z';

const portfolioEntity = (id: string) => ({
  id,
  kind: 'portfolio',
  rev: 1,
  editedAt: AT,
  editedBy: uuid(9),
  deletedAt: null,
  data: {
    userId: uuid(1),
    name: 'TEST VECTOR portfolio',
    visibility: 'private',
    sortOrder: 0,
    defaultPayFromCash: true,
    archivedAt: null,
    kind: null,
    vaultId: null,
    alias: null,
    vaultAlias: null,
  },
});

describe('strict restore document floors (GHSA-mrhx-c7xc-m3w5)', () => {
  it('pins the entity floor below the tightest envelope the live schema can accept', () => {
    // The datetime floor the arithmetic assumes: 17 characters is accepted,
    // anything shorter is not — so no valid entity can save bytes there.
    const datetime = z.string().datetime();
    expect(datetime.safeParse(SHORTEST_DATETIME).success).toBe(true);
    expect(datetime.safeParse('2026-01-01T00Z').success).toBe(false);
    // Every meta key is REQUIRED; dropping any one is a different, invalid shape.
    const meta = {
      id: uuid(1),
      rev: 0,
      editedAt: SHORTEST_DATETIME,
      editedBy: uuid(2),
      deletedAt: null,
    };
    expect(vaultEntityMetaSchema.safeParse(meta).success).toBe(true);
    for (const key of Object.keys(meta)) {
      const { [key as keyof typeof meta]: _dropped, ...rest } = meta;
      expect(vaultEntityMetaSchema.safeParse(rest).success, key).toBe(false);
    }
    // Every kind's entity schema carries the meta keys AND a required data object.
    for (const schema of Object.values(VAULT_ENTITY_SCHEMAS)) {
      expect(Object.keys(schema.shape).sort()).toEqual(
        ['data', 'deletedAt', 'editedAt', 'editedBy', 'id', 'kind', 'rev'].sort(),
      );
      expect(schema.shape.data.isOptional()).toBe(false);
    }
    const shortestKind = Object.keys(VAULT_ENTITY_SCHEMAS).sort((a, b) => a.length - b.length)[0]!;
    const tightest = JSON.stringify({ ...meta, kind: shortestKind, data: {} });
    expect(Buffer.byteLength(tightest)).toBeGreaterThanOrEqual(VAULT_STRICT_ENTITY_MIN_JSON_BYTES);
  });

  it('pins the provenance and merge-record floors against a real valid record', () => {
    const shortestMirrorKind = [...MIRROR_ROW_KINDS].sort((a, b) => a.length - b.length)[0]!;
    const provenance = {
      chainId: uuid(1),
      membershipId: uuid(2),
      kind: shortestMirrorKind,
      mirrorId: uuid(3),
      portfolioId: uuid(4),
      localId: uuid(5),
    };
    expect(vaultMirrorProvenanceSchema.safeParse(provenance).success).toBe(true);
    expect(Object.keys(vaultMirrorProvenanceSchema.shape).sort()).toEqual(
      Object.keys(provenance).sort(),
    );
    expect(Buffer.byteLength(JSON.stringify(provenance))).toBeGreaterThanOrEqual(
      VAULT_STRICT_ENTITY_MIN_JSON_BYTES,
    );

    const merge = { mergedAt: SHORTEST_DATETIME, parents: [1], into: 1, deviceId: uuid(6) };
    expect(vaultMergeRecordSchema.safeParse(merge).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(merge))).toBeGreaterThanOrEqual(
      VAULT_MERGE_RECORD_MIN_JSON_BYTES,
    );
  });

  it('lists every collection reachable in the strict document that zod does not bound first', () => {
    const found = new Set<string>();
    const visited = new Set<z.ZodTypeAny>();
    const walk = (schema: z.ZodTypeAny, path: string): void => {
      if (schema === (vaultJsonSchema as z.ZodTypeAny)) return; // accepts every JSON value
      const def = schema._def as { typeName: z.ZodFirstPartyTypeKind } & Record<string, unknown>;
      if (def.typeName === z.ZodFirstPartyTypeKind.ZodLazy) {
        if (visited.has(schema)) return;
        visited.add(schema);
      }
      switch (def.typeName) {
        case z.ZodFirstPartyTypeKind.ZodObject:
          for (const [key, value] of Object.entries((schema as z.AnyZodObject).shape)) {
            walk(value as z.ZodTypeAny, path === '' ? key : `${path}.${key}`);
          }
          return;
        case z.ZodFirstPartyTypeKind.ZodArray:
          found.add(path);
          walk(def.type as z.ZodTypeAny, `${path}[]`);
          return;
        case z.ZodFirstPartyTypeKind.ZodRecord:
        case z.ZodFirstPartyTypeKind.ZodMap:
        case z.ZodFirstPartyTypeKind.ZodSet:
        case z.ZodFirstPartyTypeKind.ZodTuple:
          found.add(`${path}<${def.typeName}>`);
          return;
        case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
          for (const option of def.options as z.AnyZodObject[]) {
            const kind = (option.shape.kind as z.ZodLiteral<string>).value;
            walk(option, `${path.replace(/\[\]$/, '')}[${kind}]`);
          }
          return;
        case z.ZodFirstPartyTypeKind.ZodUnion:
          for (const option of def.options as z.ZodTypeAny[]) walk(option, path);
          return;
        case z.ZodFirstPartyTypeKind.ZodLazy:
          walk((def.getter as () => z.ZodTypeAny)(), path);
          return;
        case z.ZodFirstPartyTypeKind.ZodEffects:
          walk(def.schema as z.ZodTypeAny, path);
          return;
        case z.ZodFirstPartyTypeKind.ZodOptional:
        case z.ZodFirstPartyTypeKind.ZodNullable:
        case z.ZodFirstPartyTypeKind.ZodDefault:
        case z.ZodFirstPartyTypeKind.ZodCatch:
        case z.ZodFirstPartyTypeKind.ZodReadonly:
          walk(def.innerType as z.ZodTypeAny, path);
          return;
        default:
          return;
      }
    };
    walk(vaultStrictDocumentV1Schema, '');
    expect([...found].sort()).toEqual(Object.keys(VAULT_STRICT_DOCUMENT_COLLECTION_BOUNDS).sort());
  });
});

describe('precheckVaultStrictDocumentShape', () => {
  const documentOf = (entities: unknown[], extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    entities,
    mergeLog: [],
    mirrorProvenance: [],
    ...extra,
  });

  it('never refuses a valid document at its own byte length', () => {
    const document = documentOf(
      Array.from({ length: 2_000 }, (_, i) => portfolioEntity(uuid(100 + i))),
    );
    expect(vaultStrictDocumentV1Schema.safeParse(document).success).toBe(true);
    const bodyBytes = Buffer.byteLength(JSON.stringify(document));
    expect(precheckVaultStrictDocumentShape(document, { bodyBytes })).toBeNull();
    expect(document.entities.length).toBeLessThanOrEqual(
      vaultStrictDocumentEntitiesCeiling(bodyBytes),
    );
  });

  it('refuses a flood of tiny elements from its length alone, before any element is read', () => {
    const entities = new Array(100_000).fill({});
    const document = documentOf(entities);
    const bodyBytes = Buffer.byteLength(JSON.stringify(document));
    const parse = vi.spyOn(vaultStrictEntitySchema, '_parse');
    try {
      const issue = precheckVaultStrictDocumentShape(document, { bodyBytes });
      expect(issue).toMatchObject({
        code: 'too_big',
        type: 'array',
        path: ['entities'],
        maximum: vaultStrictDocumentEntitiesCeiling(bodyBytes),
      });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('bounds the merge log, its parents, provenance and the nested catch-wrapped arrays', () => {
    const bytes = 1_000_000;
    const cases: Array<[Record<string, unknown>, (string | number)[], number]> = [
      [
        documentOf([], {
          mergeLog: new Array(vaultStrictDocumentMergeLogCeiling(bytes) + 1).fill({}),
        }),
        ['mergeLog'],
        vaultStrictDocumentMergeLogCeiling(bytes),
      ],
      [
        documentOf([], {
          mergeLog: [{ parents: new Array(VAULT_MERGE_RECORD_PARENTS_MAX + 1).fill(0) }],
        }),
        ['mergeLog', 0, 'parents'],
        VAULT_MERGE_RECORD_PARENTS_MAX,
      ],
      [
        documentOf([], {
          mirrorProvenance: new Array(vaultStrictDocumentEntitiesCeiling(bytes) + 1).fill({}),
        }),
        ['mirrorProvenance'],
        vaultStrictDocumentEntitiesCeiling(bytes),
      ],
      [
        documentOf([
          {},
          {
            kind: 'importRow',
            data: { candidates: new Array(IMPORT_ROW_CANDIDATE_LIMIT + 1).fill({}) },
          },
        ]),
        ['entities', 1, 'data', 'candidates'],
        IMPORT_ROW_CANDIDATE_LIMIT,
      ],
      [
        documentOf([
          {
            kind: 'importRow',
            data: { ruleTagIds: new Array(CASH_TAGS_PER_ITEM_MAX + 1).fill(0) },
          },
        ]),
        ['entities', 0, 'data', 'ruleTagIds'],
        CASH_TAGS_PER_ITEM_MAX,
      ],
      [
        documentOf([
          {
            kind: 'importBatch',
            data: {
              understanding: {
                mappings: new Array(VAULT_IMPORT_UNDERSTANDING_COLUMNS_MAX + 1).fill({}),
              },
            },
          },
        ]),
        ['entities', 0, 'data', 'understanding', 'mappings'],
        VAULT_IMPORT_UNDERSTANDING_COLUMNS_MAX,
      ],
      [
        documentOf([
          {
            kind: 'importBatch',
            data: {
              understanding: {
                unmappedHeaders: new Array(VAULT_IMPORT_UNDERSTANDING_COLUMNS_MAX + 1).fill(0),
              },
            },
          },
        ]),
        ['entities', 0, 'data', 'understanding', 'unmappedHeaders'],
        VAULT_IMPORT_UNDERSTANDING_COLUMNS_MAX,
      ],
    ];
    for (const [document, path, maximum] of cases) {
      expect(
        precheckVaultStrictDocumentShape(document, { bodyBytes: bytes }),
        path.join('.'),
      ).toMatchObject({
        code: 'too_big',
        path,
        maximum,
      });
    }
    // At the bound itself, nothing is refused — the bound is inclusive.
    expect(
      precheckVaultStrictDocumentShape(
        documentOf([
          {
            kind: 'importRow',
            data: { candidates: new Array(IMPORT_ROW_CANDIDATE_LIMIT).fill({}) },
          },
        ]),
        { bodyBytes: bytes },
      ),
    ).toBeNull();
  });

  it('leaves non-container shapes to the schema, which reports them with one issue', () => {
    for (const document of [undefined, null, 'x', [], { entities: 'nope' }, { entities: {} }]) {
      expect(precheckVaultStrictDocumentShape(document, { bodyBytes: 10 })).toBeNull();
    }
  });
});

describe('firstInvalidVaultStrictDocumentElement', () => {
  it('stops at the first invalid element, so issues stay one element’s worth', () => {
    const padded = { kind: 'importRow', data: {}, pad: 'x'.repeat(200) };
    const document = {
      schemaVersion: 1,
      entities: [portfolioEntity(uuid(50)), ...new Array(5_000).fill(padded)],
    };
    // The full schema accumulates one issue per missing field of EVERY element.
    const full = vaultStrictDocumentV1Schema.safeParse(document);
    expect(full.success).toBe(false);
    const perElement = vaultStrictEntitySchema.safeParse(padded);
    expect(perElement.success).toBe(false);
    const elementIssues = perElement.success ? 0 : perElement.error.issues.length;
    expect(full.success ? 0 : full.error.issues.length).toBe(5_000 * elementIssues);

    const parse = vi.spyOn(vaultStrictEntitySchema, '_parse');
    try {
      const issues = firstInvalidVaultStrictDocumentElement(document);
      expect(issues).toHaveLength(elementIssues);
      expect(issues?.every((issue) => issue.path[0] === 'entities' && issue.path[1] === 1)).toBe(
        true,
      );
      expect(parse).toHaveBeenCalledTimes(2);
    } finally {
      parse.mockRestore();
    }
  });

  it('checks the merge log and provenance the same way and passes a valid document', () => {
    expect(
      firstInvalidVaultStrictDocumentElement({
        entities: [],
        mergeLog: [{ mergedAt: AT, parents: [1], into: 2, deviceId: uuid(1) }, { parents: [] }],
      })?.[0]?.path.slice(0, 2),
    ).toEqual(['mergeLog', 1]);
    expect(
      firstInvalidVaultStrictDocumentElement({
        entities: [],
        mirrorProvenance: [{}],
      })?.[0]?.path.slice(0, 2),
    ).toEqual(['mirrorProvenance', 0]);
    expect(
      firstInvalidVaultStrictDocumentElement({
        schemaVersion: 1,
        entities: [portfolioEntity(uuid(60))],
      }),
    ).toBeNull();
  });
});
