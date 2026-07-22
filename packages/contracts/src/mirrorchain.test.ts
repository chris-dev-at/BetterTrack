import { describe, expect, it } from 'vitest';

import {
  MIRROR_CHAIN_OP_KINDS,
  MIRROR_LEDGER_OP_KINDS,
  MIRROR_OP_KINDS,
  MIRROR_OP_VERSION,
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  mirrorAttributionSchema,
  mirrorOpPayloadSchema,
  mirrorRowInfoSchema,
} from './mirrorchain';

const MIRROR_A = '018f0000-0000-7000-8000-00000000000a';
const MIRROR_B = '018f0000-0000-7000-8000-00000000000b';
const USER_A = '018f0000-0000-7000-8000-0000000000c1';

describe('mirrorchain — reserved source tag', () => {
  it('is the reserved sync:<slug> value replica rows carry', () => {
    expect(SOURCE_TAG_SYNC_MIRRORCHAIN).toBe('sync:mirrorchain');
    // Must satisfy the shared sourceTagSchema regex (kept in sync with portfolio.ts).
    expect(
      /^(?:manual|standing-order|(?:import|sync):[a-z0-9][a-z0-9_-]*)$/.test(
        SOURCE_TAG_SYNC_MIRRORCHAIN,
      ),
    ).toBe(true);
  });
});

describe('mirrorchain — op kind coverage', () => {
  it('unions the 13 ledger + 9 chain/membership kinds with no overlap', () => {
    expect(MIRROR_LEDGER_OP_KINDS).toHaveLength(13);
    expect(MIRROR_CHAIN_OP_KINDS).toHaveLength(9);
    expect(MIRROR_OP_KINDS).toHaveLength(22);
    expect(new Set(MIRROR_OP_KINDS).size).toBe(22);
  });
});

describe('mirrorOpPayloadSchema — opVersion + discrimination', () => {
  const txCreate = {
    opVersion: MIRROR_OP_VERSION,
    kind: 'tx.create',
    mirrorId: MIRROR_A,
    assetId: MIRROR_B,
    side: 'buy',
    quantity: 3,
    price: 100,
    fee: 1,
    executedAt: '2026-07-22T10:00:00.000Z',
    note: null,
    allowUncovered: false,
    uncoveredEntryPrice: null,
    originSource: 'manual',
  };

  it('accepts a well-formed full-state create payload', () => {
    expect(mirrorOpPayloadSchema.safeParse(txCreate).success).toBe(true);
  });

  it('every op payload carries opVersion === 1 (rejects any other version)', () => {
    expect(mirrorOpPayloadSchema.safeParse({ ...txCreate, opVersion: 2 }).success).toBe(false);
    expect(mirrorOpPayloadSchema.safeParse({ ...txCreate, opVersion: 0 }).success).toBe(false);
  });

  it('is strict — an unknown extra field is rejected', () => {
    expect(mirrorOpPayloadSchema.safeParse({ ...txCreate, taxAmountEur: 5 }).success).toBe(false);
  });

  it('rejects an unknown op kind', () => {
    expect(
      mirrorOpPayloadSchema.safeParse({ opVersion: 1, kind: 'tx.frobnicate', mirrorId: MIRROR_A })
        .success,
    ).toBe(false);
  });

  it('requires baseSeq on the optimistic-concurrency mutation ops (§3)', () => {
    // tx.update without baseSeq fails; with it, passes.
    const base = {
      opVersion: 1,
      kind: 'tx.update',
      mirrorId: MIRROR_A,
      side: 'sell',
      quantity: 2,
      price: 110,
      fee: 0,
      executedAt: '2026-07-22T10:00:00.000Z',
      note: null,
      allowUncovered: false,
      uncoveredEntryPrice: null,
    };
    expect(mirrorOpPayloadSchema.safeParse(base).success).toBe(false);
    expect(mirrorOpPayloadSchema.safeParse({ ...base, baseSeq: 40 }).success).toBe(true);
  });

  it('cash.transfer carries both minted leg mirror ids (§2)', () => {
    const transfer = {
      opVersion: 1,
      kind: 'cash.transfer',
      outMirrorId: MIRROR_A,
      inMirrorId: MIRROR_B,
      fromSourceMirrorId: MIRROR_A,
      toSourceMirrorId: MIRROR_B,
      amountEur: 50,
      executedAt: '2026-07-22T10:00:00.000Z',
      note: null,
      originSource: 'manual',
    };
    expect(mirrorOpPayloadSchema.safeParse(transfer).success).toBe(true);
    const { inMirrorId: _drop, ...missingLeg } = transfer;
    expect(mirrorOpPayloadSchema.safeParse(missingLeg).success).toBe(false);
  });

  it('cash.setBalance replicates a signed nonzero delta (§8)', () => {
    const base = {
      opVersion: 1,
      kind: 'cash.setBalance',
      mirrorId: MIRROR_A,
      sourceMirrorId: null,
      executedAt: '2026-07-22T10:00:00.000Z',
      note: null,
      originSource: 'manual',
    };
    expect(mirrorOpPayloadSchema.safeParse({ ...base, deltaEur: -25 }).success).toBe(true);
    expect(mirrorOpPayloadSchema.safeParse({ ...base, deltaEur: 0 }).success).toBe(false);
  });

  it('accepts a chain/membership op with denormalized username', () => {
    expect(
      mirrorOpPayloadSchema.safeParse({
        opVersion: 1,
        kind: 'owner.transferred',
        fromUserId: USER_A,
        fromUsername: 'alice',
        toUserId: MIRROR_B,
        toUsername: 'bob',
        via: 'account_deletion',
      }).success,
    ).toBe(true);
  });
});

describe('additive DTO field schemas', () => {
  it('mirror.version + attribution chip parse (design §3/§11)', () => {
    const attribution = { userId: USER_A, username: 'alice', profileIcon: null };
    expect(mirrorAttributionSchema.safeParse(attribution).success).toBe(true);
    // Account-deleted actor: userId null, denormalized username kept.
    expect(mirrorAttributionSchema.safeParse({ ...attribution, userId: null }).success).toBe(true);
    expect(
      mirrorRowInfoSchema.safeParse({ mirrorId: MIRROR_A, version: 41, addedBy: attribution })
        .success,
    ).toBe(true);
  });
});
