import { describe, expect, it } from 'vitest';

import {
  MIRROR_ATTRIBUTION_STATES,
  MIRROR_CHAIN_OP_KINDS,
  MIRROR_LEDGER_OP_KINDS,
  MIRROR_OP_KINDS,
  MIRROR_OP_VERSION,
  MIRROR_STRIPPED_ATTRIBUTION_USERNAME,
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  mirrorAttributionSchema,
  mirrorInviteListResponseSchema,
  mirrorInviteSchema,
  mirrorOpPayloadSchema,
  mirrorRowInfoSchema,
  strippedMirrorAttribution,
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
  it('unions the 16 ledger + 9 chain/membership kinds with no overlap', () => {
    expect(MIRROR_LEDGER_OP_KINDS).toHaveLength(16);
    expect(MIRROR_CHAIN_OP_KINDS).toHaveLength(9);
    expect(MIRROR_OP_KINDS).toHaveLength(25);
    expect(new Set(MIRROR_OP_KINDS).size).toBe(25);
  });

  it('replicates a hand-entered `fee` as its own ledger op (§16 2026-07-30)', () => {
    // A fee is TWR-internal but origin-entered, so it MUST replicate — and it
    // must replicate as a fee, not a withdrawal, or every non-origin copy would
    // divide it back out of its own performance curve.
    expect(MIRROR_LEDGER_OP_KINDS).toContain('cash.fee');
  });

  it('replicates a CORRECTION to a hand-entered movement (§16 2026-07-31)', () => {
    // The cash ledger stopped being append-only for the three kinds a person
    // typed. A correction is origin data like the create it amends, so a copy
    // that kept the uncorrected row would disagree with the origin's balance
    // forever — and a delete has to reach every copy for the same reason.
    expect(MIRROR_LEDGER_OP_KINDS).toContain('cash.update');
    expect(MIRROR_LEDGER_OP_KINDS).toContain('cash.delete');
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
    // M2 (#644): the replicated cash-link intent — flows identical per copy (§8).
    payFromCash: false,
    addProceedsToCash: false,
    cashSourceMirrorId: null,
    settleCashAsOfToday: false,
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
      payFromCash: false,
      addProceedsToCash: false,
      cashSourceMirrorId: null,
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
    const attribution = { state: 'shown', userId: USER_A, username: 'alice', profileIcon: null };
    expect(mirrorAttributionSchema.safeParse(attribution).success).toBe(true);
    // Account-deleted actor: userId null, denormalized username kept (§6/§7).
    expect(
      mirrorAttributionSchema.safeParse({ ...attribution, state: 'deleted', userId: null }).success,
    ).toBe(true);
    expect(
      mirrorRowInfoSchema.safeParse({ mirrorId: MIRROR_A, version: 41, addedBy: attribution })
        .success,
    ).toBe(true);
  });

  it('separates the two null-actor states instead of collapsing them (#2009)', () => {
    // The whole point of `state`: `userId: null` is reachable two ways, and the
    // chip must render them differently. Neither is a substring of the other.
    const deleted = mirrorAttributionSchema.parse({
      state: 'deleted',
      userId: null,
      username: 'alice',
      profileIcon: null,
    });
    expect(deleted.username).toBe('alice');
    expect(deleted.state).not.toBe(strippedMirrorAttribution.state);
    expect(strippedMirrorAttribution.username).toBe(MIRROR_STRIPPED_ATTRIBUTION_USERNAME);
    expect(MIRROR_ATTRIBUTION_STATES).toEqual(['shown', 'stripped', 'deleted']);
    // The constant the service hands a non-member is itself a legal DTO.
    expect(mirrorAttributionSchema.safeParse(strippedMirrorAttribution).success).toBe(true);
  });

  it('refuses a stripped attribution that still carries the actor (design §10)', () => {
    // The §10 boundary made structural: a service regression that forgot to
    // replace the actor cannot serialize as `stripped`. NEGATIVE SPACE — each
    // clause is probed alone so one over-broad check cannot pass for the wrong
    // reason.
    const stripped = {
      state: 'stripped' as const,
      userId: null,
      username: MIRROR_STRIPPED_ATTRIBUTION_USERNAME,
      profileIcon: null,
    };
    expect(mirrorAttributionSchema.safeParse(stripped).success).toBe(true);
    // …the frozen name of an account-deleted author is exactly what may not ride along.
    expect(mirrorAttributionSchema.safeParse({ ...stripped, username: 'alice' }).success).toBe(
      false,
    );
    expect(mirrorAttributionSchema.safeParse({ ...stripped, profileIcon: 'fox' }).success).toBe(
      false,
    );
    expect(mirrorAttributionSchema.safeParse({ ...stripped, userId: USER_A }).success).toBe(false);
  });

  it('refuses an account id on a deleted actor and a missing one on a shown actor', () => {
    const base = { userId: null, username: 'alice', profileIcon: null };
    expect(mirrorAttributionSchema.safeParse({ ...base, state: 'deleted' }).success).toBe(true);
    // No account ids are added by this DTO — a deleted actor has none to give.
    expect(
      mirrorAttributionSchema.safeParse({ ...base, state: 'deleted', userId: USER_A }).success,
    ).toBe(false);
    // …and the live case is the mirror image: `shown` without an id is a bug.
    expect(mirrorAttributionSchema.safeParse({ ...base, state: 'shown' }).success).toBe(false);
    // An unknown state is not silently tolerated either.
    expect(mirrorAttributionSchema.safeParse({ ...base, state: 'anonymized' }).success).toBe(false);
    // …nor is the pre-#2009 shape that had no state at all.
    expect(mirrorAttributionSchema.safeParse(base).success).toBe(false);
  });
});

describe('mirror invite rows carry a face (board #70)', () => {
  const invite = {
    id: '018f0000-0000-7000-8000-0000000000e1',
    chainId: '018f0000-0000-7000-8000-0000000000e2',
    chainName: 'Household',
    fromUsername: 'alice',
    toUsername: 'bob',
    profileIcon: 'fox',
    direction: 'incoming' as const,
    createdAt: '2026-08-07T09:00:00.000Z',
  };

  it('requires the icon field, nullable — the same shape the member roster uses', () => {
    // Required-and-nullable, not optional: the server always emits it, and a
    // client that always finds the key never has to distinguish "no icon" from
    // "old server". `null` covers both "never picked one" and the deleted
    // inviter (whose `fromUsername` is null too).
    expect(mirrorInviteSchema.safeParse(invite).success).toBe(true);
    expect(mirrorInviteSchema.safeParse({ ...invite, profileIcon: null }).success).toBe(true);
    expect(
      mirrorInviteSchema.safeParse({ ...invite, fromUsername: null, profileIcon: null }).success,
    ).toBe(true);
    const { profileIcon: _omitted, ...withoutIcon } = invite;
    expect(mirrorInviteSchema.safeParse(withoutIcon).success).toBe(false);
  });

  it('stays strict — the icon is the only field the row grew', () => {
    expect(Object.keys(mirrorInviteSchema.parse(invite)).sort()).toEqual([
      'chainId',
      'chainName',
      'createdAt',
      'direction',
      'fromUsername',
      'id',
      'profileIcon',
      'toUsername',
    ]);
    expect(mirrorInviteSchema.safeParse({ ...invite, email: 'a@b.test' }).success).toBe(false);
  });

  it('carries on both directions of the list response', () => {
    const parsed = mirrorInviteListResponseSchema.parse({
      incoming: [invite],
      outgoing: [{ ...invite, direction: 'outgoing', profileIcon: 'panda' }],
    });
    expect(parsed.incoming[0]!.profileIcon).toBe('fox');
    expect(parsed.outgoing[0]!.profileIcon).toBe('panda');
  });
});
