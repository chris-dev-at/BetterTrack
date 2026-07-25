import { describe, expect, it } from 'vitest';

import type { VaultDocumentV1, VaultEntity, VaultMergeRecord } from '@bettertrack/contracts';

import { VaultCryptoError } from './errors';
import {
  chooseVaultEntity,
  mergeVaultDocuments,
  VAULT_MERGE_LOG_LIMIT,
  type MergeVaultDocumentsInput,
} from './merge';

const ENTITY_A = '018f0000-0000-7000-8000-000000000001';
const ENTITY_B = '018f0000-0000-7000-8000-000000000002';
const DEVICE_A = '018f0000-0000-7000-8000-00000000000a';
const DEVICE_B = '018f0000-0000-7000-8000-00000000000b';
const MERGE_DEVICE = '018f0000-0000-7000-8000-00000000000c';
const MERGED_AT = '2026-07-25T12:00:00.000Z';

function entity(overrides: Partial<VaultEntity> = {}): VaultEntity {
  return {
    id: ENTITY_A,
    rev: 1,
    editedAt: '2026-07-25T10:00:00Z',
    editedBy: DEVICE_A,
    deletedAt: null,
    data: { amount: 1 },
    ...overrides,
  };
}

function document(entities: VaultEntity[], mergeLog: VaultMergeRecord[] = []): VaultDocumentV1 {
  return {
    schemaVersion: 1,
    entities: { transaction: entities },
    mergeLog,
  };
}

function merge(
  left: VaultDocumentV1,
  right: VaultDocumentV1,
  overrides: Partial<MergeVaultDocumentsInput> = {},
) {
  return mergeVaultDocuments({
    left,
    leftVersion: 4,
    right,
    rightVersion: 4,
    deviceId: MERGE_DEVICE,
    mergedAt: MERGED_AT,
    ...overrides,
  });
}

const mergeMatrix: { name: string; left: VaultEntity; right: VaultEntity; winner: VaultEntity }[] =
  [
    {
      name: 'higher revision',
      left: entity({ rev: 2, data: { amount: 2 } }),
      right: entity({
        rev: 1,
        editedAt: '2026-07-25T11:00:00Z',
        editedBy: DEVICE_B,
        data: { amount: 3 },
      }),
      winner: entity({ rev: 2, data: { amount: 2 } }),
    },
    {
      name: 'later tombstone among tombstones',
      left: entity({
        rev: 2,
        editedAt: '2026-07-25T10:00:00Z',
        deletedAt: '2026-07-25T10:00:00Z',
        data: {},
      }),
      right: entity({
        rev: 2,
        editedAt: '2026-07-25T10:01:00Z',
        deletedAt: '2026-07-25T10:01:00Z',
        data: {},
      }),
      winner: entity({
        rev: 2,
        editedAt: '2026-07-25T10:01:00Z',
        deletedAt: '2026-07-25T10:01:00Z',
        data: {},
      }),
    },
    {
      name: 'live edit against a concurrent tombstone',
      left: entity({
        rev: 2,
        editedAt: '2026-07-25T11:00:00Z',
        editedBy: DEVICE_B,
        deletedAt: '2026-07-25T11:00:00Z',
        data: {},
      }),
      right: entity({
        rev: 2,
        editedAt: '2026-07-25T10:00:00Z',
        editedBy: DEVICE_A,
        data: { amount: 2 },
      }),
      winner: entity({
        rev: 2,
        editedAt: '2026-07-25T10:00:00Z',
        editedBy: DEVICE_A,
        data: { amount: 2 },
      }),
    },
    {
      name: 're-deletion after resurrection',
      left: entity({
        rev: 2,
        editedAt: '2026-07-25T10:00:00Z',
        editedBy: DEVICE_B,
        data: { amount: 2 },
      }),
      right: entity({
        rev: 3,
        editedAt: '2026-07-25T11:00:00Z',
        editedBy: DEVICE_A,
        deletedAt: '2026-07-25T11:00:00Z',
        data: {},
      }),
      winner: entity({
        rev: 3,
        editedAt: '2026-07-25T11:00:00Z',
        editedBy: DEVICE_A,
        deletedAt: '2026-07-25T11:00:00Z',
        data: {},
      }),
    },
    {
      name: 'later normalized sub-second instant',
      left: entity({
        rev: 2,
        editedAt: '2026-07-25T10:00:00Z',
        data: { amount: 1 },
      }),
      right: entity({
        rev: 2,
        editedAt: '2026-07-25T10:00:00.001Z',
        data: { amount: 2 },
      }),
      winner: entity({
        rev: 2,
        editedAt: '2026-07-25T10:00:00.001Z',
        data: { amount: 2 },
      }),
    },
    {
      name: 'later instant against a seconds-omitted instant',
      left: entity({
        rev: 2,
        editedAt: '2026-07-25T10:00Z',
        data: { amount: 1 },
      }),
      right: entity({
        rev: 2,
        editedAt: '2026-07-25T10:00:00.001Z',
        data: { amount: 2 },
      }),
      winner: entity({
        rev: 2,
        editedAt: '2026-07-25T10:00:00.001Z',
        data: { amount: 2 },
      }),
    },
    {
      name: 'lexicographically higher device at the same instant',
      left: entity({ rev: 2, editedBy: DEVICE_A, data: { amount: 1 } }),
      right: entity({ rev: 2, editedBy: DEVICE_B, data: { amount: 2 } }),
      winner: entity({ rev: 2, editedBy: DEVICE_B, data: { amount: 2 } }),
    },
    {
      name: 'canonical whole-entity tie-break for differing payloads',
      left: entity({ rev: 2, data: { amount: 1 } }),
      right: entity({ rev: 2, data: { amount: 2 } }),
      winner: entity({ rev: 2, data: { amount: 2 } }),
    },
    {
      name: 'canonical whole-entity tie-break for signed zero',
      left: entity({ rev: 2, data: { amount: -0 } }),
      right: entity({ rev: 2, data: { amount: 0 } }),
      winner: entity({ rev: 2, data: { amount: 0 } }),
    },
  ];

describe.each(mergeMatrix)('deterministic merge: $name', ({ left, right, winner }) => {
  it('selects the expected whole entity in both parent orders', () => {
    const forward = merge(document([left]), document([right]));
    const backward = merge(document([right]), document([left]));

    expect(forward.document.entities.transaction).toEqual([winner]);
    expect(backward.document.entities.transaction).toEqual([winner]);
    expect(backward).toEqual(forward);
    expect(forward).toMatchObject({ vaultVersion: 5, divergent: true });
    expect(forward.document.mergeLog).toEqual([
      {
        mergedAt: MERGED_AT,
        parents: [4],
        into: 5,
        deviceId: MERGE_DEVICE,
      },
    ]);
  });

  it('is idempotent against either original parent in both parent orders', () => {
    const leftParent = document([left]);
    const rightParent = document([right]);
    const merged = merge(leftParent, rightParent);

    for (const parent of [leftParent, rightParent]) {
      const resultFirst = mergeVaultDocuments({
        left: merged.document,
        leftVersion: merged.vaultVersion,
        right: parent,
        rightVersion: 4,
        deviceId: MERGE_DEVICE,
        mergedAt: '2026-07-25T13:00:00.000Z',
      });
      const parentFirst = mergeVaultDocuments({
        left: parent,
        leftVersion: 4,
        right: merged.document,
        rightVersion: merged.vaultVersion,
        deviceId: MERGE_DEVICE,
        mergedAt: '2026-07-25T13:00:00.000Z',
      });

      expect(resultFirst).toEqual({
        document: merged.document,
        vaultVersion: merged.vaultVersion,
        divergent: false,
      });
      expect(parentFirst).toEqual(resultFirst);
    }
  });
});

describe('vault merge metadata and validation', () => {
  it('recognizes the sub-second instant as later instead of comparing Z against dot', () => {
    const wholeSecond = entity({ rev: 2, editedAt: '2026-07-25T10:00:00Z' });
    const millisecondLater = entity({
      rev: 2,
      editedAt: '2026-07-25T10:00:00.001Z',
      data: { amount: 2 },
    });

    expect(chooseVaultEntity(wholeSecond, millisecondLater)).toEqual(millisecondLater);
    expect(chooseVaultEntity(millisecondLater, wholeSecond)).toEqual(millisecondLater);
  });

  it('keeps the log bounded while appending exactly one diagnostic record', () => {
    const history = (offset: number): VaultMergeRecord[] =>
      Array.from({ length: VAULT_MERGE_LOG_LIMIT }, (_, index) => {
        const version = offset + index + 1;
        return {
          mergedAt: new Date(Date.UTC(2026, 6, 24, 0, 0, version)).toISOString(),
          parents: [version],
          into: version + 1,
          deviceId: index % 2 === 0 ? DEVICE_A : DEVICE_B,
        };
      });
    const left = document([entity({ id: ENTITY_A })], history(0));
    const right = document([entity({ id: ENTITY_B })], history(10));

    const result = merge(left, right, { leftVersion: 40, rightVersion: 60 });
    const reversed = merge(right, left, { leftVersion: 60, rightVersion: 40 });
    const appended = {
      mergedAt: MERGED_AT,
      parents: [40, 60],
      into: 61,
      deviceId: MERGE_DEVICE,
    };

    expect(result).toMatchObject({ vaultVersion: 61, divergent: true });
    expect(reversed).toEqual(result);
    expect(result.document.mergeLog).toHaveLength(VAULT_MERGE_LOG_LIMIT);
    expect(result.document.mergeLog.at(-1)).toEqual(appended);
    expect(result.document.mergeLog.filter((record) => record.into === 61)).toEqual([appended]);
  });

  it('sorts seconds-omitted history and a seconds-omitted supplied merge instant', () => {
    const existingRecord: VaultMergeRecord = {
      mergedAt: '2026-07-25T11:00Z',
      parents: [2],
      into: 3,
      deviceId: DEVICE_A,
    };
    const first = merge(
      document([entity({ id: ENTITY_A })], [existingRecord]),
      document([entity({ id: ENTITY_B })]),
      { mergedAt: '2026-07-25T12:00Z' },
    );

    expect(first.document.mergeLog.map((record) => record.mergedAt)).toEqual([
      '2026-07-25T11:00Z',
      '2026-07-25T12:00Z',
    ]);

    const second = merge(first.document, document([entity({ rev: 2 })]), {
      leftVersion: first.vaultVersion,
      rightVersion: first.vaultVersion,
      mergedAt: '2026-07-25T13:00Z',
    });

    expect(second.document.mergeLog.map((record) => record.mergedAt)).toEqual([
      '2026-07-25T11:00Z',
      '2026-07-25T12:00Z',
      '2026-07-25T13:00Z',
    ]);
  });

  it('fails closed with a typed error for an unparseable editedAt', () => {
    const malformed = entity({ editedAt: '2026-07-25T10:00:00.not-a-fractionZ' });

    let caught: unknown;
    try {
      chooseVaultEntity(malformed, entity());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VaultCryptoError);
    expect(caught).toMatchObject({ code: 'document-invalid' });
    expect(() => merge(document([malformed]), document([entity({ rev: 2 })]))).toThrowError(
      VaultCryptoError,
    );
  });

  it('fails closed for sparse arrays in both candidate and document orders', () => {
    const sparseValues = new Array<unknown>(1);
    const sparse = entity({ rev: 2, data: { values: sparseValues } });
    const dense = entity({ rev: 2, data: { values: [] } });
    const attempts = [
      () => chooseVaultEntity(sparse, dense),
      () => chooseVaultEntity(dense, sparse),
      () => merge(document([sparse]), document([dense])),
      () => merge(document([dense]), document([sparse])),
    ];

    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(VaultCryptoError);
      expect(caught).toMatchObject({ code: 'document-invalid' });
    }
  });

  it('fails closed for array index accessors in both candidate and document orders', () => {
    const accessorValues = new Array<unknown>(1);
    Object.defineProperty(accessorValues, 0, {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error('Vault canonicalization must not invoke array accessors.');
      },
    });

    const accessor = entity({ rev: 2, data: { values: accessorValues } });
    const plain = entity({ rev: 2, data: { values: [1] } });
    const attempts = [
      () => chooseVaultEntity(accessor, plain),
      () => chooseVaultEntity(plain, accessor),
      () => merge(document([accessor]), document([plain])),
      () => merge(document([plain]), document([accessor])),
    ];

    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(VaultCryptoError);
      expect(caught).toMatchObject({ code: 'document-invalid' });
    }
  });

  it('fails closed for non-JSON object properties in both candidate and document orders', () => {
    const nonEnumerable: Record<string, unknown> = {};
    Object.defineProperty(nonEnumerable, 'amount', {
      configurable: true,
      enumerable: false,
      value: 1,
    });

    const symbolKeyed: Record<PropertyKey, unknown> = {};
    symbolKeyed[Symbol('amount')] = 1;

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'amount', {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error('Vault canonicalization must not invoke accessors.');
      },
    });

    for (const invalidObject of [nonEnumerable, symbolKeyed, accessor]) {
      const invalid = entity({ rev: 2, data: { nested: invalidObject } });
      const plain = entity({ rev: 2, data: { nested: {} } });
      const attempts = [
        () => chooseVaultEntity(invalid, plain),
        () => chooseVaultEntity(plain, invalid),
        () => merge(document([invalid]), document([plain])),
        () => merge(document([plain]), document([invalid])),
      ];

      for (const attempt of attempts) {
        let caught: unknown;
        try {
          attempt();
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(VaultCryptoError);
        expect(caught).toMatchObject({ code: 'document-invalid' });
      }
    }
  });

  it('fails closed for unsafe versions and safe-integer successor overflow', () => {
    const left = document([entity({ id: ENTITY_A })]);
    const right = document([entity({ id: ENTITY_B })]);
    const attempts = [
      () =>
        merge(left, right, {
          leftVersion: Number.MAX_SAFE_INTEGER + 1,
          rightVersion: 4,
        }),
      () =>
        merge(left, right, {
          leftVersion: Number.MAX_SAFE_INTEGER,
          rightVersion: 4,
        }),
    ];

    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(VaultCryptoError);
      expect(caught).toMatchObject({ code: 'envelope-invalid' });
    }
  });
});
