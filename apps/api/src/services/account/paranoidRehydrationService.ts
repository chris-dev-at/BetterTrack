import type {
  ParanoidDisableRehydrationRequest,
  ParanoidDisableRehydrationResult,
  ParanoidRehydrationPostCommitPlan,
} from '@bettertrack/contracts';
import {
  customTaxParamsSchema,
  paranoidDisableRehydrationRequestSchema,
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  taxSettingsResponseSchema,
  updateTaxSettingsRequestSchema,
} from '@bettertrack/contracts';
import { CASH_MOVEMENT_SIGN } from '@bettertrack/domain/cashLedger';
import { QTY_EPSILON } from '@bettertrack/domain/holdings';
import { viennaYearOf } from '@bettertrack/domain/tax';

import type { Database } from '../../data/db';
import {
  createExpenseBudgetRepository,
  createExpenseCategoryRepository,
  createExpenseRuleRepository,
  createExpenseTransactionRepository,
} from '../../data/repositories/expenseRepository';
import {
  createParanoidRehydrationSourceRepository,
  type ParanoidRehydrationSourceRepository,
} from '../../data/repositories/paranoidRehydrationRepository';
import {
  createParanoidRehydrationTransactionRepository,
  withParanoidRehydrationTransaction,
} from '../../data/repositories/paranoidVaultRepository';
import { createExpenseBudgetService } from '../expenses/budgetService';
import { createExpenseService } from '../expenses/expenseService';
import type { NotificationCenter } from '../notifications/notificationCenter';
import { replayRestoredTaxState } from '../tax/replay';

/**
 * Dedicated normal-write transaction seam for PD3a. It validates the complete
 * restore-source document, delegates tax and expense reconstruction to their
 * transaction-bound service seams, and commits every source row plus transition
 * receipt in one transaction. Effectful public write paths are never called.
 * PD3b owns public routing and execution of the returned post-commit plan.
 */

const POST_COMMIT: ParanoidRehydrationPostCommitPlan = {
  invalidate: ['account', 'portfolio', 'expenses', 'standingOrders', 'tax'],
};

/** Rehydration must never emit while its database transaction is open. */
const NO_REHYDRATION_NOTIFICATIONS: NotificationCenter = {
  async emit() {
    throw new Error('rehydration attempted to emit a notification inside its transaction');
  },
};

export class ParanoidRehydrationError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'NOT_PARANOID'
      | 'REHYDRATION_CONFLICT'
      | 'INVALID_REFERENCE'
      | 'INVALID_CASH_LEDGER'
      | 'INJECTED_FAILURE',
    message: string,
  ) {
    super(message);
    this.name = 'ParanoidRehydrationError';
  }
}

type TestOnlyRejectPersistedTransactionQuantity = (input: {
  transactionId: string;
  quantity: bigint;
}) => boolean;

type TestOnlyObserveQuantityReachabilityOrder = (input: {
  /** Number of transaction rows routed through the fixed-width ordering proof. */
  transactionRows: number;
  /** Fixed normalized-UUID key passes used to establish document write order. */
  writeOrderKeyPasses: number;
  /** Fixed normalized-timestamp-plus-UUID passes per chronological replay row. */
  replayTimelineKeyPasses: number;
  /** Prefix rows visited once while validating singleton normal PATCH witnesses. */
  prefixRevisionRows: number;
  /** Exact-prefix deficits checked as singleton normal PATCH witnesses. */
  prefixRevisionWitnesses: number;
}) => void;

export interface ParanoidRehydrationServiceDeps {
  db: Database;
  now?: () => Date;
  /** Converts native amounts during tax-state replay at the historical day. */
  toCashEur?: (amount: number, currency: string, day: string) => Promise<number>;
  /** Test-only stage hook proving each transaction-stage rolls back completely. */
  afterStage?: (stage: ParanoidRehydrationStage) => void | Promise<void>;
  /** Test-only quantity-rule override for differential conformance. */
  testOnlyRejectPersistedTransactionQuantity?: TestOnlyRejectPersistedTransactionQuantity;
  /** Test-only trace proving the quantity-ordering pass count is fixed per row. */
  testOnlyObserveQuantityReachabilityOrder?: TestOnlyObserveQuantityReachabilityOrder;
  /** Test-only seam for proving the numeric(20,8) quantity-rounding boundary. */
  testOnlyTransactionQuantityRoundingTolerance?: bigint;
}

export type ParanoidRehydrationStage =
  | 'customAssets'
  | 'portfolios'
  | 'cashSources'
  | 'taxSettings'
  | 'portfolioSettings'
  | 'transactions'
  | 'dividends'
  | 'cashMovements'
  | 'taxReplay'
  | 'standingOrders'
  | 'expenseCategories'
  | 'expenseTransactions'
  | 'expenseRules'
  | 'expenseBudgets'
  | 'normalMode'
  | 'ciphertextDeleted'
  | 'finish';

export interface ParanoidRehydrationService {
  rehydrate(
    userId: string,
    request: ParanoidDisableRehydrationRequest,
  ): Promise<ParanoidDisableRehydrationResult>;
}

type Entity = ParanoidDisableRehydrationRequest['document']['entities'][number];
type EntityOf<K extends Entity['kind']> = Extract<Entity, { kind: K }>;

interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;
const NUMBER_DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;
const pow10 = (scale: number): bigint => 10n ** BigInt(scale);
const TRANSACTION_QUANTITY_STORAGE_PRECISION = 20;
const TRANSACTION_QUANTITY_STORAGE_SCALE = 8;

/**
 * Repository writes serialize public number inputs with String(value) and
 * PostgreSQL then rounds them to the column scale. Reproduce that fixed-scale
 * coercion without multiplying a binary float at the quantity's magnitude.
 */
function persistedNumber(value: number, scale: number, label: string): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(label + ' has no finite normal-write number');
  }
  const negative = value < 0;
  const match = NUMBER_DECIMAL_PATTERN.exec(String(Math.abs(value)));
  if (!match) {
    throw new Error(label + ' has no normal-write decimal representation');
  }
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  let coefficient = BigInt((match[1] ?? '') + fraction);
  let decimalScale = fraction.length - exponent;
  if (decimalScale < 0) {
    coefficient *= pow10(-decimalScale);
    decimalScale = 0;
  }
  if (decimalScale <= scale) {
    coefficient *= pow10(scale - decimalScale);
  } else {
    const divisor = pow10(decimalScale - scale);
    const quotient = coefficient / divisor;
    const remainder = coefficient % divisor;
    // PostgreSQL's numeric coercion rounds positive halfway values up. Quantity
    // inputs are positive, so this is the only branch the reachability proof
    // needs to model.
    coefficient = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  return negative ? -coefficient : coefficient;
}

function fixedScaleDecimal(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? '' : '.' + digits.slice(-scale);
  return (negative ? '-' : '') + whole + fraction;
}

const FLOAT64_BYTES = new ArrayBuffer(8);
const FLOAT64_VIEW = new DataView(FLOAT64_BYTES);

function nextPositiveFloat(value: number, direction: 'up' | 'down'): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new Error('cannot step non-positive or non-finite quantity ' + value);
  }
  FLOAT64_VIEW.setFloat64(0, value);
  const bits = FLOAT64_VIEW.getBigUint64(0);
  FLOAT64_VIEW.setBigUint64(0, direction === 'up' ? bits + 1n : bits - 1n);
  return FLOAT64_VIEW.getFloat64(0);
}

/**
 * Return a public-number input that persists as this scale-8 quantity, using
 * the outer edge that gives a normal reducer the most favorable holding. A
 * missing preimage is meaningful: an older strict-v1 row may still be retained
 * as an exact prefix, but it cannot be claimed as a later normal write.
 */
function quantityNumberPreimage(
  persistedQuantity: bigint,
  direction: 'upper' | 'lower',
): number | null {
  const halfQuantumBoundary = persistedQuantity * 10n + (direction === 'upper' ? 5n : -5n);
  let candidate = Number(fixedScaleDecimal(halfQuantumBoundary, 9));
  const outward = direction === 'upper' ? 'up' : 'down';

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!(candidate > 0) || !Number.isFinite(candidate)) return null;
    const stored = persistedNumber(candidate, 8, 'transaction quantity');
    if (stored === persistedQuantity) {
      const adjacent = nextPositiveFloat(candidate, outward);
      return persistedNumber(adjacent, 8, 'transaction quantity') === persistedQuantity
        ? adjacent
        : candidate;
    }
    candidate = nextPositiveFloat(candidate, stored > persistedQuantity ? 'down' : 'up');
  }
  return null;
}

interface QuantityReplayRow {
  transaction: EntityOf<'transaction'>;
  quantity: bigint;
  readbackQuantity: number;
  normalInputQuantity: number | null;
  /** Lowercase fixed-width UUID key used only by the bounded radix passes. */
  uuidOrderKey: string;
  /** Contract-valid execution time normalized once to UTC millisecond width. */
  executedAtOrderKey: string;
  /** Immutable UUIDv7 write position within the whole strict document. */
  writeOrder: number;
  /**
   * A strict-vault revision is not itself normal-write provenance. It can only
   * stand in for a one-row quantity PATCH when the unchanged normal update
   * guards would allow that financial edit.
   */
  revisionCandidate: boolean;
}

function isPersistedSolvent(rows: readonly QuantityReplayRow[]): boolean {
  let held = 0n;
  for (const row of rows) {
    if (row.transaction.data.side === 'buy') {
      held += row.quantity;
      continue;
    }
    const shortfall = row.quantity - held;
    if (shortfall > 0n && !row.transaction.data.allowUncovered) return false;
    held = shortfall > 0n ? 0n : held - row.quantity;
  }
  return true;
}

interface NormalReplayStep {
  readonly held: number;
  readonly canReplay: boolean;
}

/** Quantity-only equivalent of one `reducePosition` transition. */
function replayNormalQuantity(
  row: QuantityReplayRow,
  quantity: number | null,
  held: number,
): NormalReplayStep {
  if (quantity === null) return { held, canReplay: false };
  if (row.transaction.data.side === 'buy') return { held: held + quantity, canReplay: true };
  if (quantity > held + QTY_EPSILON) {
    return row.transaction.data.allowUncovered
      ? { held: 0, canReplay: true }
      : { held, canReplay: false };
  }
  const nextHeld = held - quantity;
  return {
    held: Math.abs(nextHeld) <= QTY_EPSILON ? 0 : nextHeld,
    canReplay: true,
  };
}

const MAX_POSITIVE_FINITE_FLOAT_BITS = 0x7fefffffffffffffn;

function positiveFloatFromBits(bits: bigint): number {
  FLOAT64_VIEW.setBigUint64(0, bits);
  return FLOAT64_VIEW.getFloat64(0);
}

/**
 * The fixed readback suffix is monotonic in its entering holding: more shares
 * can never make an ordinary sell fail. Find its smallest representable input
 * with a fixed-width Float64 search, rather than replaying the whole suffix
 * once for every possible singleton PATCH witness.
 */
function minimumNormalHoldingForSuffixRow(
  row: QuantityReplayRow,
  requiredAfter: number,
): number | null {
  const canReachRequiredAfter = (held: number): boolean => {
    const replayed = replayNormalQuantity(row, row.readbackQuantity, held);
    return replayed.canReplay && replayed.held >= requiredAfter;
  };
  if (!canReachRequiredAfter(Number.MAX_VALUE)) return null;

  let lower = 0n;
  let upper = MAX_POSITIVE_FINITE_FLOAT_BITS;
  while (lower < upper) {
    const middle = (lower + upper) >> 1n;
    if (canReachRequiredAfter(positiveFloatFromBits(middle))) {
      upper = middle;
    } else {
      lower = middle + 1n;
    }
  }
  return positiveFloatFromBits(lower);
}

const NORMAL_WRITE_BATCH_MAX_TRANSACTIONS = 500;

/**
 * UUIDs and JavaScript Date values normalize to fixed shapes. Normal writes use
 * UUIDv7, while strict-v1 validation accepts every UUID/datetime spelling
 * allowed by the contract. Keeping separate normalized keys lets the snapshot
 * proof establish both orders with radix distribution passes without narrowing
 * those public fields or invoking a user-controlled comparator sort.
 */
const UUID_HEX_DIGIT_POSITIONS = [
  0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 17, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35,
] as const;
const EXECUTED_AT_DIGIT_POSITIONS = [
  0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22,
] as const;

/**
 * Snapshot-only normal-write reachability has an intentionally bounded proof.
 *
 * The strict-v1 payload does not retain CREATE batch identities or trustworthy
 * PATCH provenance, so this validator never searches for either. Instead it
 * makes one fixed legacy-cutoff choice, replays that prefix exactly, proves
 * only its deficit-causing revised row as a singleton PATCH when necessary,
 * and proves every storage-rounding CREATE from a bounded post-cutoff epoch
 * seeded with its prior repository-readback holding. Each row is visited by a
 * fixed number of streaming passes. Ordering is bounded to 81 fixed-width radix
 * keys per row (32 document UUID keys; 32 UUID tie-breaker plus 17 canonical
 * UTC timestamp keys for chronological replay), and witness epochs may contain
 * no more than the public 500-row CREATE limit. The insolvent direct proof also
 * fails closed unless every creation key is UUIDv7. A document outside that
 * direct proof is rejected before restore writes rather than guessed at or
 * explored with a span search.
 */
interface NormalCreateWitness {
  /** Inclusive UUIDv7 write positions of one direct CREATE witness. */
  readonly start: number;
  readonly end: number;
  /** The persisted scale-8 sell that needs this witness. */
  readonly sell: QuantityReplayRow;
}

function quantityReachabilityError(row: QuantityReplayRow, reason: string): Error {
  return new Error(
    reason +
      ' at transaction[' +
      row.transaction.id +
      '].quantity=' +
      JSON.stringify(row.transaction.data.quantity),
  );
}

function decimalDigitAt(value: string, position: number): number {
  return value.charCodeAt(position) - 48;
}

function uuidHexDigitAt(value: string, position: number): number {
  const code = value.charCodeAt(position);
  return code <= 57 ? code - 48 : code - 87;
}

function hasUuidV7WriteOrder(value: string): boolean {
  return value.charCodeAt(14) === 55;
}

function normalizeExecutedAtOrderKey(value: string): string {
  // The strict request schema has already accepted this datetime. Date is also
  // the restore repository's precision boundary, so normalizing once preserves
  // its chronological semantics while producing the 24-byte radix key.
  return new Date(value).toISOString();
}

/**
 * Stable fixed-radix ordering. `positions` is compile-time constant, so this
 * runs in O(rows) time: each key performs two full passes and never invokes a
 * comparator whose work can grow with the supplied history.
 */
type FixedRadixPassObserver = () => void;

function orderByFixedRadix<T>(
  values: readonly T[],
  positions: readonly number[],
  digitAt: (value: T, position: number) => number,
  onPass?: FixedRadixPassObserver,
): T[] {
  if (values.length < 2) return [...values];

  let source = [...values];
  let target: T[] = new Array(source.length);
  const counts = new Uint32Array(16);

  for (let positionIndex = positions.length - 1; positionIndex >= 0; positionIndex -= 1) {
    onPass?.();
    counts.fill(0);
    const position = positions[positionIndex]!;
    for (const value of source) counts[digitAt(value, position)]! += 1;

    let next = 0;
    for (let digit = 0; digit < counts.length; digit += 1) {
      const count = counts[digit]!;
      counts[digit] = next;
      next += count;
    }
    for (const value of source) {
      const digit = digitAt(value, position);
      target[counts[digit]!] = value;
      counts[digit]! += 1;
    }
    [source, target] = [target, source];
  }
  return source;
}

function orderByUuidWriteHistory(
  rows: readonly QuantityReplayRow[],
  onPass?: FixedRadixPassObserver,
): QuantityReplayRow[] {
  return orderByFixedRadix(
    rows,
    UUID_HEX_DIGIT_POSITIONS,
    (row, position) => uuidHexDigitAt(row.uuidOrderKey, position),
    onPass,
  );
}

function orderByReplayTimeline(
  rows: readonly QuantityReplayRow[],
  onPass?: FixedRadixPassObserver,
): QuantityReplayRow[] {
  // LSD stability makes the UUIDv7 pass the tie-breaker for the chronological
  // timestamp pass, matching the repository's `(executed_at, id)` replay order.
  const byId = orderByFixedRadix(
    rows,
    UUID_HEX_DIGIT_POSITIONS,
    (row, position) => uuidHexDigitAt(row.uuidOrderKey, position),
    onPass,
  );
  return orderByFixedRadix(
    byId,
    EXECUTED_AT_DIGIT_POSITIONS,
    (row, position) => decimalDigitAt(row.executedAtOrderKey, position),
    onPass,
  );
}

interface PrefixRevisionWitnessStats {
  readonly rows: number;
  readonly witnesses: number;
}

/**
 * Revision metadata alone is not quantity-PATCH provenance. The fixed legacy
 * prefix is therefore replayed exactly first; a solvent prefix needs no PATCH
 * witness regardless of how many rows were edited. For every exact deficit,
 * only its revised sell can be a singleton normal PATCH input while every
 * other prefix row remains a repository-number readback.
 *
 * The reverse pass summarizes each readback suffix as its least required
 * entering holding. The forward pass can then test every singleton candidate
 * against that suffix in O(1), so N deficits do not trigger N full-prefix
 * replays. Shapes requiring cooperating raw revised rows still fail closed.
 */
function validatePrefixRevisionWitnesses(
  groups: readonly (readonly QuantityReplayRow[])[],
  legacyCutoff: number,
): PrefixRevisionWitnessStats {
  let rows = 0;
  let witnesses = 0;

  for (const group of groups) {
    // `requiredFrom[index]` is the smallest repository-readback holding that
    // can replay the remaining strict-prefix rows at and after `index`. Rows
    // created after the prefix are deliberately transparent to this proof.
    const requiredFrom: Array<number | null> = new Array(group.length + 1).fill(0);
    let required: number | null = 0;
    for (let index = group.length - 1; index >= 0; index -= 1) {
      const row = group[index]!;
      if (row.writeOrder < legacyCutoff && required !== null) {
        required = minimumNormalHoldingForSuffixRow(row, required);
      }
      requiredFrom[index] = required;
    }

    let exactHeld = 0n;
    let readbackHeld = 0;
    let readbackPrefixCanReplay = true;
    for (let index = 0; index < group.length; index += 1) {
      const row = group[index]!;
      if (row.writeOrder >= legacyCutoff) continue;
      rows += 1;

      if (row.transaction.data.side === 'buy') {
        exactHeld += row.quantity;
      } else {
        const shortfall = row.quantity - exactHeld;
        if (shortfall > 0n && !row.transaction.data.allowUncovered) {
          witnesses += 1;
          if (!row.revisionCandidate) {
            throw quantityReachabilityError(
              row,
              'transaction quantity cannot replay through the direct strict-v1 prefix',
            );
          }
          const replayedPatch = replayNormalQuantity(row, row.normalInputQuantity, readbackHeld);
          const requiredAfter = requiredFrom[index + 1]!;
          if (
            !readbackPrefixCanReplay ||
            !replayedPatch.canReplay ||
            requiredAfter === null ||
            replayedPatch.held < requiredAfter
          ) {
            throw quantityReachabilityError(
              row,
              'transaction quantity cannot replay as a pre-transition normal PATCH',
            );
          }
        }
        exactHeld = shortfall > 0n ? 0n : exactHeld - row.quantity;
      }

      // A later candidate always sees previous rows through repository
      // readback. Once that readback history is invalid, it cannot be repaired
      // by a singleton PATCH at a later row.
      if (readbackPrefixCanReplay) {
        const replayedReadback = replayNormalQuantity(row, row.readbackQuantity, readbackHeld);
        if (replayedReadback.canReplay) {
          readbackHeld = replayedReadback.held;
        } else {
          readbackPrefixCanReplay = false;
        }
      }
    }
  }

  return { rows, witnesses };
}

function updateRawEpoch(
  row: QuantityReplayRow,
  held: number,
): { held: number; canReplay: boolean } {
  return replayNormalQuantity(row, row.normalInputQuantity, held);
}

function updateReadbackEpoch(
  row: QuantityReplayRow,
  held: number,
): { held: number; canReplay: boolean } {
  return replayNormalQuantity(row, row.readbackQuantity, held);
}

/**
 * Stream each chronological asset group once. A one-quantum persisted sell can
 * be admitted only when its post-cutoff CREATE epoch replays from public inputs
 * seeded by a prior repository-readback holding whose active quantity mutations
 * all precede the witness in UUID write order. Strict-prefix rows are never raw
 * CREATE inputs, even when a deliberately backdated row places them inside the
 * epoch's chronological timeline. A later normal buy starts a new local epoch:
 * the buy's upper public preimage together with the sell's lower preimage
 * accounts for the one stored quantum, while proven-earlier normal history
 * remains repository readback. A future-written backdated sell cannot be
 * omitted from that seed: the existing epoch is retained so the bounded UUID
 * span must include it. That gives a direct bounded CREATE witness without
 * treating an arbitrary non-flat history as one request or searching
 * alternative spans.
 */
function collectNormalCreateWitnesses(
  groups: readonly (readonly QuantityReplayRow[])[],
  storageRoundingSellIds: ReadonlySet<string>,
  legacyCutoff: number,
): readonly NormalCreateWitness[] {
  const witnesses: NormalCreateWitness[] = [];

  for (const group of groups) {
    let readbackHeld = 0;
    let readbackStateMaxWriteOrder = -1;
    let rawHeld = 0;
    let rawEpochCanReplay = true;
    let rawSeedStateMaxWriteOrder = -1;
    let epochStart = -1;
    let epochEnd = -1;

    const startEpoch = (row: QuantityReplayRow, restart = false): void => {
      if (epochStart !== -1 && !restart) return;
      epochStart = row.writeOrder;
      epochEnd = row.writeOrder;
      rawHeld = readbackHeld;
      rawSeedStateMaxWriteOrder = readbackStateMaxWriteOrder;
      // Chronological replay may already have visited a deliberately
      // backdated row whose UUID says it was written only after this candidate
      // batch. Neither its funding nor its reduction can be borrowed through
      // repository readback before that later write has itself been admitted.
      rawEpochCanReplay = rawSeedStateMaxWriteOrder < epochStart;
    };
    const extendEpoch = (row: QuantityReplayRow): void => {
      // A one-quantum persisted oversell needs a later raw buy as well as the
      // raw sell. Restart at each post-cutoff buy so the local candidate is
      // seeded from every preceding normal request's repository readback,
      // rather than forcing all non-flat post-cutoff history into this batch.
      // When a future-written backdated row affects that seed, retain the
      // current epoch so the candidate must include that row in its UUID span.
      const canRestartFromReadback =
        row.transaction.data.side === 'buy' && readbackStateMaxWriteOrder < row.writeOrder;
      startEpoch(row, canRestartFromReadback);
      epochStart = Math.min(epochStart, row.writeOrder);
      epochEnd = Math.max(epochEnd, row.writeOrder);
      rawEpochCanReplay &&= rawSeedStateMaxWriteOrder < epochStart;
      const raw = updateRawEpoch(row, rawHeld);
      rawHeld = raw.held;
      rawEpochCanReplay &&= raw.canReplay;
    };
    const resetEpoch = (): void => {
      rawHeld = 0;
      rawEpochCanReplay = true;
      rawSeedStateMaxWriteOrder = -1;
      epochStart = -1;
      epochEnd = -1;
    };

    for (const row of group) {
      if (row.writeOrder >= legacyCutoff) {
        extendEpoch(row);
      } else if (epochStart !== -1) {
        // A strict-prefix row was already persisted when the normal CREATE
        // request ran, so it participates only through repository readback.
        // It can still be chronologically interleaved with backdated CREATE
        // rows and must therefore update the mixed replay state.
        const raw = updateReadbackEpoch(row, rawHeld);
        rawHeld = raw.held;
        rawEpochCanReplay &&= raw.canReplay;
      }
      const quantity = row.readbackQuantity;
      if (row.transaction.data.side === 'buy') {
        readbackHeld += quantity;
        readbackStateMaxWriteOrder = Math.max(readbackStateMaxWriteOrder, row.writeOrder);
        continue;
      }

      if (quantity > readbackHeld + QTY_EPSILON) {
        if (row.transaction.data.allowUncovered) {
          readbackHeld = 0;
          readbackStateMaxWriteOrder = -1;
          resetEpoch();
          continue;
        }
        if (!storageRoundingSellIds.has(row.transaction.id)) {
          throw quantityReachabilityError(
            row,
            'transaction quantity cannot replay from repository readback',
          );
        }
        if (row.writeOrder < legacyCutoff || epochStart === -1 || !rawEpochCanReplay) {
          throw quantityReachabilityError(
            row,
            'transaction quantity reachability cannot establish a bounded normal CREATE witness',
          );
        }
        witnesses.push({ start: epochStart, end: epochEnd, sell: row });
        readbackHeld = 0;
        readbackStateMaxWriteOrder = -1;
        resetEpoch();
        continue;
      }

      readbackHeld -= quantity;
      if (Math.abs(readbackHeld) <= QTY_EPSILON) {
        readbackHeld = 0;
        readbackStateMaxWriteOrder = -1;
        // Storage can flatten a pair whose public-number replay still carries
        // a meaningful epsilon-valid residual. Keep that raw CREATE epoch
        // alive until its own replay is flat so a following one-quantum stored
        // sell can use the same bounded normal-write witness.
        if (rawHeld === 0) resetEpoch();
      } else {
        readbackStateMaxWriteOrder = Math.max(readbackStateMaxWriteOrder, row.writeOrder);
      }
    }
  }

  return witnesses;
}

/**
 * Verify the direct witnesses globally. Overlapping witnesses must be one
 * CREATE operation, so their union still has to fit the public 500-row,
 * single-portfolio request. Disjoint witnesses can be independent calls.
 */
function validateNormalCreateWitnesses(
  witnesses: readonly NormalCreateWitness[],
  writeHistory: readonly QuantityReplayRow[],
): void {
  const portfolioRunEnds = Array.from({ length: writeHistory.length }, () => 0);
  for (let start = 0; start < writeHistory.length; ) {
    const portfolioId = writeHistory[start]!.transaction.data.portfolioId;
    let end = start + 1;
    while (
      end < writeHistory.length &&
      writeHistory[end]!.transaction.data.portfolioId === portfolioId
    ) {
      end += 1;
    }
    for (let index = start; index < end; index += 1) portfolioRunEnds[index] = end - 1;
    start = end;
  }

  const witnessesByStart = new Map<number, NormalCreateWitness[]>();
  for (const witness of witnesses) {
    if (
      witness.end - witness.start + 1 > NORMAL_WRITE_BATCH_MAX_TRANSACTIONS ||
      portfolioRunEnds[witness.start]! < witness.end
    ) {
      throw quantityReachabilityError(
        witness.sell,
        'transaction quantity reachability cannot establish a bounded normal CREATE witness',
      );
    }
    const atStart = witnessesByStart.get(witness.start) ?? [];
    atStart.push(witness);
    witnessesByStart.set(witness.start, atStart);
  }

  let activeStart = -1;
  let activeEnd = -1;
  let activeSell: QuantityReplayRow | null = null;
  for (let start = 0; start < writeHistory.length; start += 1) {
    if (start > activeEnd) {
      activeStart = -1;
      activeSell = null;
    }
    for (const witness of witnessesByStart.get(start) ?? []) {
      if (activeStart === -1) {
        activeStart = witness.start;
        activeEnd = witness.end;
        activeSell = witness.sell;
        continue;
      }
      activeEnd = Math.max(activeEnd, witness.end);
      if (activeEnd - activeStart + 1 > NORMAL_WRITE_BATCH_MAX_TRANSACTIONS) {
        throw quantityReachabilityError(
          activeSell ?? witness.sell,
          'transaction quantity reachability cannot establish compatible normal CREATE witnesses',
        );
      }
    }
  }
}

/**
 * Tax replay already has a deliberately narrow one-storage-quantum exception.
 * Keep its representation untouched: wider strict-document reachability is a
 * quantity-validation concern, not a reason to reconstruct historical tax
 * inputs or change covered-sale cost basis.
 */
function oneQuantumStorageRoundingSellIds(
  groups: readonly (readonly QuantityReplayRow[])[],
): ReadonlySet<string> {
  const sellIds = new Set<string>();
  for (const rows of groups) {
    let held = 0n;
    for (const row of rows) {
      if (row.transaction.data.side === 'buy') {
        held += row.quantity;
        continue;
      }
      const shortfall = row.quantity - held;
      if (shortfall === 1n && !row.transaction.data.allowUncovered) {
        sellIds.add(row.transaction.id);
      }
      held = shortfall > 0n ? 0n : held - row.quantity;
    }
  }
  return sellIds;
}

function isEngineTaxedTransaction(transaction: EntityOf<'transaction'>): boolean {
  return transaction.data.taxMode === 'country_specific' || transaction.data.taxMode === 'custom';
}

function portfolioAssetKey(transaction: EntityOf<'transaction'>): string {
  return `${transaction.data.portfolioId}\u0000${transaction.data.assetId}`;
}

/**
 * A vault `rev` only establishes that an entity was edited, not that its
 * quantity travelled through updateTransaction. Infer that narrow provenance
 * only when the normal financial-edit guards permit a possible PATCH:
 *
 * - manual and engine-taxed rows are immutable themselves;
 * - a linked cash movement is created with the row and permanently blocks a
 *   financial edit; and
 * - an engine-taxed sibling created before this row was already present for
 *   every possible later PATCH. A later sibling can still be recorded after a
 *   legal PATCH, so UUIDv7 write order keeps that reachable lifecycle intact.
 */
function canBeNormalQuantityPatch(
  transaction: EntityOf<'transaction'>,
  normalInputQuantity: number | null,
  writeOrder: number,
  cashLinkedTransactionIds: ReadonlySet<string>,
  earliestEngineTaxedSellWriteOrders: ReadonlyMap<string, number>,
): boolean {
  if (transaction.rev === 0 || normalInputQuantity === null) return false;
  if (
    transaction.data.taxMode === 'manual_per_trade' ||
    isEngineTaxedTransaction(transaction) ||
    cashLinkedTransactionIds.has(transaction.id)
  ) {
    return false;
  }
  const earliestEngineTaxedSellWriteOrder = earliestEngineTaxedSellWriteOrders.get(
    portfolioAssetKey(transaction),
  );
  return (
    earliestEngineTaxedSellWriteOrder === undefined ||
    earliestEngineTaxedSellWriteOrder >= writeOrder
  );
}

/**
 * A strict-v1 document may start with an exact persisted history that predates
 * public-number writes. Its membership follows one immutable UUIDv7 creation
 * cutoff for the whole document, not per asset and not `executedAt`: normal
 * writes may be deliberately backdated. The cutoff is the first point after
 * every row without a public-number preimage. We do not search later cutoffs:
 * an ambiguous snapshot fails closed under the bounded proof above.
 */
function storageRoundingSellIdsFor(
  transactions: readonly EntityOf<'transaction'>[],
  cashLinkedTransactionIds: ReadonlySet<string>,
  testOnlyRejectPersistedTransactionQuantity?: TestOnlyRejectPersistedTransactionQuantity,
  testOnlyObserveQuantityReachabilityOrder?: TestOnlyObserveQuantityReachabilityOrder,
  testOnlyTransactionQuantityRoundingTolerance?: bigint,
): ReadonlySet<string> {
  const unorderedRows = transactions.map((transaction): QuantityReplayRow => {
    const quantity = quantizedTransactionQuantity(transaction.data.quantity);
    const normalInputQuantity = quantityNumberPreimage(
      quantity,
      transaction.data.side === 'buy' ? 'upper' : 'lower',
    );
    return {
      transaction,
      quantity,
      readbackQuantity: Number(fixedScaleDecimal(quantity, 8)),
      normalInputQuantity,
      uuidOrderKey: transaction.id.toLowerCase(),
      executedAtOrderKey: normalizeExecutedAtOrderKey(transaction.data.executedAt),
      writeOrder: -1,
      revisionCandidate: false,
    };
  });

  let writeOrderKeyPasses = 0;
  const rows = orderByUuidWriteHistory(
    unorderedRows,
    testOnlyObserveQuantityReachabilityOrder
      ? () => {
          writeOrderKeyPasses += 1;
        }
      : undefined,
  );
  const earliestEngineTaxedSellWriteOrders = new Map<string, number>();
  for (let writeOrder = 0; writeOrder < rows.length; writeOrder += 1) {
    const row = rows[writeOrder]!;
    row.writeOrder = writeOrder;
    if (row.transaction.data.side !== 'sell' || !isEngineTaxedTransaction(row.transaction)) {
      continue;
    }
    const key = portfolioAssetKey(row.transaction);
    if (!earliestEngineTaxedSellWriteOrders.has(key)) {
      earliestEngineTaxedSellWriteOrders.set(key, writeOrder);
    }
  }
  for (const row of rows) {
    row.revisionCandidate = canBeNormalQuantityPatch(
      row.transaction,
      row.normalInputQuantity,
      row.writeOrder,
      cashLinkedTransactionIds,
      earliestEngineTaxedSellWriteOrders,
    );
  }

  for (const row of rows) {
    if (
      testOnlyRejectPersistedTransactionQuantity?.({
        transactionId: row.transaction.id,
        quantity: row.quantity,
      })
    ) {
      throw new Error(
        'transaction quantity was rejected by the active reachability rule at transaction[' +
          row.transaction.id +
          '].quantity=' +
          JSON.stringify(row.transaction.data.quantity),
      );
    }
  }

  const transactionsByPortfolioAsset = new Map<string, QuantityReplayRow[]>();
  for (const row of rows) {
    const key = portfolioAssetKey(row.transaction);
    const group = transactionsByPortfolioAsset.get(key) ?? [];
    group.push(row);
    transactionsByPortfolioAsset.set(key, group);
  }
  let replayTimelineKeyPasses = 0;
  const replayGroups = [...transactionsByPortfolioAsset.values()].map((group) =>
    orderByReplayTimeline(
      group,
      testOnlyObserveQuantityReachabilityOrder
        ? () => {
            replayTimelineKeyPasses += 1;
          }
        : undefined,
    ),
  );
  if (testOnlyTransactionQuantityRoundingTolerance !== undefined) {
    for (const group of replayGroups) {
      let held = 0n;
      for (const row of group) {
        if (row.transaction.data.side === 'buy') {
          held += row.quantity;
          continue;
        }
        const shortfall = row.quantity - held;
        if (
          shortfall > testOnlyTransactionQuantityRoundingTolerance &&
          !row.transaction.data.allowUncovered
        ) {
          throw new Error(
            `transaction quantity ${JSON.stringify(row.transaction.data.quantity)} would oversell its position`,
          );
        }
        held = shortfall > 0n ? 0n : held - row.quantity;
      }
    }
  }
  const persistedInsolventGroups = replayGroups.filter((group) => !isPersistedSolvent(group));
  if (persistedInsolventGroups.length === 0) {
    testOnlyObserveQuantityReachabilityOrder?.({
      transactionRows: rows.length,
      writeOrderKeyPasses,
      replayTimelineKeyPasses,
      prefixRevisionRows: 0,
      prefixRevisionWitnesses: 0,
    });
    return new Set();
  }

  // Only a UUIDv7 key carries the creation-order provenance needed by the
  // insolvent direct proof. Solvent strict-v1 rows return above without that
  // provenance requirement.
  for (const row of rows) {
    if (!hasUuidV7WriteOrder(row.uuidOrderKey)) {
      throw quantityReachabilityError(
        row,
        'transaction quantity reachability requires a UUIDv7 write key for the direct proof',
      );
    }
  }

  // A row without a public-number preimage can only live in the strict-v1
  // prefix. This direct proof deliberately does not search a later cutoff.
  const legacyCutoff = rows.reduce(
    (cutoff, row) =>
      row.normalInputQuantity === null ? Math.max(cutoff, row.writeOrder + 1) : cutoff,
    0,
  );
  // A post-cutoff normal row may be deliberately backdated between legacy
  // rows, so its full persisted group can look solvent while the exact prefix
  // still needs a singleton PATCH witness. Keep this document-wide.
  const prefixRevisionWitnessStats = validatePrefixRevisionWitnesses(replayGroups, legacyCutoff);

  const storageRoundingSellIds = oneQuantumStorageRoundingSellIds(replayGroups);
  const createWitnesses = collectNormalCreateWitnesses(
    replayGroups,
    storageRoundingSellIds,
    legacyCutoff,
  );
  validateNormalCreateWitnesses(createWitnesses, rows);
  testOnlyObserveQuantityReachabilityOrder?.({
    transactionRows: rows.length,
    writeOrderKeyPasses,
    replayTimelineKeyPasses,
    prefixRevisionRows: prefixRevisionWitnessStats.rows,
    prefixRevisionWitnesses: prefixRevisionWitnessStats.witnesses,
  });
  return storageRoundingSellIds;
}

function exactDecimal(value: string, label: string): ExactDecimal {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', `${label} is not a decimal`);
  }
  const fraction = match[3] ?? '';
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return {
    coefficient: match[1] === '-' ? -magnitude : magnitude,
    scale: fraction.length,
  };
}

/**
 * Convert one persisted PostgreSQL numeric to a fixed-scale integer without
 * crossing IEEE-754. Values that PostgreSQL would round or overflow are
 * rejected before the restore transaction instead of being silently changed.
 */
function persistedNumeric(value: string, precision: number, scale: number, label: string): bigint {
  const decimal = exactDecimal(value, label);
  if (decimal.scale > scale) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', `${label} exceeds its persisted scale`);
  }
  const integerDigits = value.replace(/^-/, '').split('.')[0]!.replace(/^0+/, '');
  if (integerDigits.length > precision - scale) {
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      `${label} exceeds its persisted precision`,
    );
  }
  return decimal.coefficient * pow10(scale - decimal.scale);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function roundToScale(value: ExactDecimal, scale: number): bigint {
  if (value.scale <= scale) {
    return value.coefficient * pow10(scale - value.scale);
  }

  const divisor = pow10(value.scale - scale);
  const quotient = value.coefficient / divisor;
  const remainder = value.coefficient % divisor;
  // PostgreSQL numeric coercion rounds halfway cases away from zero.
  if (absolute(remainder) * 2n < divisor) return quotient;
  return quotient + (value.coefficient < 0n ? -1n : 1n);
}

/**
 * Mirror PostgreSQL's `numeric(20,8)` coercion before the pre-write position
 * replay. Paranoid-vault transactions can retain the user's raw decimal input;
 * the restore repository will round it on insert, so comparing raw values here
 * would validate a different position history than the one we persist.
 */
function quantizedTransactionQuantity(value: string): bigint {
  const label = 'transaction quantity';
  const quantized = roundToScale(exactDecimal(value, label), TRANSACTION_QUANTITY_STORAGE_SCALE);
  if (absolute(quantized) >= pow10(TRANSACTION_QUANTITY_STORAGE_PRECISION)) {
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      `${label} exceeds its persisted precision`,
    );
  }
  return quantized;
}

function requirePositive(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', `${label} must be positive`);
  }
}

function requireNonnegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', `${label} must not be negative`);
  }
}

function requirePostgresInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      `${label} exceeds the PostgreSQL integer range`,
    );
  }
}

const POSTGRES_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function requirePostgresDate(value: string, label: string): void {
  const match = POSTGRES_DAY_PATTERN.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (
    !match ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0)
  ) {
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      `${label} is not a valid PostgreSQL calendar date`,
    );
  }
}

function rows<K extends Entity['kind']>(
  entities: readonly Entity[],
  kind: K,
): readonly EntityOf<K>[] {
  return entities.filter((entity): entity is EntityOf<K> => entity.kind === kind);
}

function liveEntities(document: ParanoidDisableRehydrationRequest['document']): readonly Entity[] {
  return document.entities.filter((entity) => entity.deletedAt === null);
}

function validateCustomAssetFacts(userId: string, entities: readonly Entity[]): void {
  const seen = new Set<string>();
  for (const asset of rows(entities, 'customAsset')) {
    if (seen.has(asset.id)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'custom asset restore facts must be unique by id',
      );
    }
    seen.add(asset.id);
    if (
      asset.data.ownerId !== userId ||
      asset.data.providerId !== 'manual' ||
      asset.data.providerRef !== asset.id
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'custom asset ownership or manual-provider identity is invalid',
      );
    }
  }
}

function retainedCustomAssetRetireIds(
  retainedIds: readonly string[],
  entities: readonly Entity[],
): readonly string[] {
  const restoreFacts = new Map(rows(entities, 'customAsset').map((entity) => [entity.id, entity]));
  const retireIds: string[] = [];
  for (const retainedId of retainedIds) {
    const fact = restoreFacts.get(retainedId);
    if (!fact) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        `retained custom asset ${retainedId} requires a live row or tombstone`,
      );
    }
    if (fact.deletedAt !== null) retireIds.push(retainedId);
  }
  return retireIds;
}

function ids<K extends Entity['kind']>(entities: readonly Entity[], kind: K): Set<string> {
  return new Set(rows(entities, kind).map((entity) => entity.id));
}

const RESTORED_ID_KINDS = [
  'portfolio',
  'transaction',
  'dividend',
  'cashSource',
  'cashMovement',
  'customAsset',
  'standingOrder',
  'standingOrderRun',
  'expenseCategory',
  'expenseTransaction',
  'expenseRule',
  'expenseBudget',
] as const satisfies readonly Entity['kind'][];

function validateUniqueRestoredIds(entities: readonly Entity[]): void {
  for (const kind of RESTORED_ID_KINDS) {
    const seen = new Set<string>();
    for (const entity of rows(entities, kind)) {
      if (seen.has(entity.id)) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          `${kind} persisted ids must be unique`,
        );
      }
      seen.add(entity.id);
    }
  }
}

function requireSubset(
  candidate: Iterable<string>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const id of candidate) {
    if (!allowed.has(id)) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', `${label} references missing ${id}`);
    }
  }
}

/** Portfolio tax overrides are stored in response shape but obey request invariants. */
function validTaxOverride(value: unknown): boolean {
  const stored = taxSettingsResponseSchema.safeParse(value);
  if (!stored.success) return false;
  const normalized = {
    mode: stored.data.mode,
    ...(stored.data.country === null ? {} : { country: stored.data.country }),
    ...(stored.data.custom === undefined ? {} : { custom: stored.data.custom }),
    ...(stored.data.manualDefaultAmountEur === undefined
      ? {}
      : { manualDefaultAmountEur: stored.data.manualDefaultAmountEur }),
    ...(stored.data.manualDefaultRatePct === undefined
      ? {}
      : { manualDefaultRatePct: stored.data.manualDefaultRatePct }),
  };
  return updateTaxSettingsRequestSchema.safeParse(normalized).success;
}

function validateOwnedRows(userId: string, entities: readonly Entity[]): void {
  for (const portfolio of rows(entities, 'portfolio')) {
    if (portfolio.data.userId !== userId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'portfolio owner does not match the rehydrated account',
      );
    }
  }
  for (const setting of rows(entities, 'taxSetting')) {
    if (setting.data.userId !== userId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'tax-setting owner does not match the rehydrated account',
      );
    }
  }
  for (const order of rows(entities, 'standingOrder')) {
    if (order.data.userId !== userId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'standing-order owner does not match the rehydrated account',
      );
    }
  }
  for (const batch of rows(entities, 'importBatch')) {
    if (batch.data.ownerId !== userId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'import-batch owner does not match the rehydrated account',
      );
    }
  }
  for (const kind of [
    'expenseCategory',
    'expenseTransaction',
    'expenseRule',
    'expenseBudget',
  ] as const) {
    for (const entity of rows(entities, kind)) {
      if (entity.data.userId !== userId) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          `${kind} owner does not match the rehydrated account`,
        );
      }
    }
  }
}

function validFrozenTaxShape(
  mode: EntityOf<'transaction'>['data']['taxMode'] | EntityOf<'dividend'>['data']['taxMode'],
  country: EntityOf<'transaction'>['data']['taxCountry'],
  params: EntityOf<'transaction'>['data']['taxParams'],
): boolean {
  if (mode === null) return country === null && params === null;
  if (mode === 'country_specific') return country !== null && params === null;
  if (mode === 'custom') return country === null && customTaxParamsSchema.safeParse(params).success;
  return country === null && params === null;
}

function validatePersistedDates(entities: readonly Entity[]): void {
  for (const value of rows(entities, 'customAssetValue')) {
    requirePostgresDate(value.data.date, 'custom-asset value date');
  }
  for (const order of rows(entities, 'standingOrder')) {
    requirePostgresDate(order.data.startDate, 'standing-order start date');
    if (order.data.endDate !== null) {
      requirePostgresDate(order.data.endDate, 'standing-order end date');
    }
    if (order.data.lastPeriodKey !== null) {
      requirePostgresDate(order.data.lastPeriodKey, 'standing-order last period');
    }
  }
  for (const run of rows(entities, 'standingOrderRun')) {
    requirePostgresDate(run.data.periodKey, 'standing-order run period');
  }
  for (const expense of rows(entities, 'expenseTransaction')) {
    requirePostgresDate(expense.data.bookedOn, 'expense booking date');
  }
}

function validatePersistedNumerics(entities: readonly Entity[]): void {
  for (const portfolio of rows(entities, 'portfolio')) {
    requirePostgresInteger(portfolio.data.sortOrder, 'portfolio sort order');
  }

  for (const value of rows(entities, 'customAssetValue')) {
    requireNonnegative(
      exactDecimal(value.data.close, 'custom-asset close').coefficient,
      'custom-asset close',
    );
  }

  for (const transaction of rows(entities, 'transaction')) {
    const quantity = quantizedTransactionQuantity(transaction.data.quantity);
    const price = persistedNumeric(transaction.data.price, 20, 6, 'transaction price');
    const fee = persistedNumeric(transaction.data.fee, 20, 6, 'transaction fee');
    requirePositive(quantity, 'transaction quantity');
    requireNonnegative(price, 'transaction price');
    requireNonnegative(fee, 'transaction fee');
    if (transaction.data.taxAmountEur !== null) {
      persistedNumeric(transaction.data.taxAmountEur, 20, 6, 'transaction tax amount');
    }
    if (transaction.data.uncoveredEntryPrice !== null) {
      requireNonnegative(
        persistedNumeric(
          transaction.data.uncoveredEntryPrice,
          20,
          6,
          'transaction uncovered entry price',
        ),
        'transaction uncovered entry price',
      );
    }
    if (
      (transaction.data.allowUncovered || transaction.data.uncoveredEntryPrice !== null) &&
      transaction.data.side !== 'sell'
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'uncovered transaction fields apply only to sells',
      );
    }
    if (transaction.data.uncoveredEntryPrice !== null && !transaction.data.allowUncovered) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'an uncovered entry price requires the uncovered-sell acknowledgement',
      );
    }
    if (
      transaction.data.side === 'buy' &&
      (transaction.data.taxMode !== null ||
        transaction.data.taxCountry !== null ||
        transaction.data.taxAmountEur !== null ||
        transaction.data.taxParams !== null)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'buy transactions cannot carry frozen tax facts',
      );
    }
    if (
      !validFrozenTaxShape(
        transaction.data.taxMode,
        transaction.data.taxCountry,
        transaction.data.taxParams,
      )
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'transaction frozen tax facts are inconsistent',
      );
    }
    if (
      transaction.data.taxMode === 'none' &&
      transaction.data.taxAmountEur !== null &&
      persistedNumeric(transaction.data.taxAmountEur, 20, 6, 'transaction tax amount') !== 0n
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'none-mode transactions cannot carry a frozen tax amount',
      );
    }
  }

  for (const dividend of rows(entities, 'dividend')) {
    requirePositive(
      persistedNumeric(dividend.data.grossAmountEur, 20, 6, 'dividend gross amount'),
      'dividend gross amount',
    );
    if (dividend.data.taxAmountEur !== null) {
      persistedNumeric(dividend.data.taxAmountEur, 20, 6, 'dividend tax amount');
    }
    if (
      !validFrozenTaxShape(dividend.data.taxMode, dividend.data.taxCountry, dividend.data.taxParams)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'dividend frozen tax facts are inconsistent',
      );
    }
    if (
      dividend.data.taxMode === 'none' &&
      dividend.data.taxAmountEur !== null &&
      persistedNumeric(dividend.data.taxAmountEur, 20, 6, 'dividend tax amount') !== 0n
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'none-mode dividends cannot carry a frozen tax amount',
      );
    }
  }

  for (const movement of rows(entities, 'cashMovement')) {
    persistedNumeric(movement.data.amountEur, 20, 6, 'cash-movement amount');
    if (movement.data.taxYear !== null) {
      requirePostgresInteger(movement.data.taxYear, 'cash-movement tax year');
    }
  }

  for (const setting of rows(entities, 'taxSetting')) {
    const amount =
      setting.data.manualDefaultAmountEur === null
        ? null
        : persistedNumeric(setting.data.manualDefaultAmountEur, 20, 6, 'manual tax default');
    const rate =
      setting.data.manualDefaultRatePct === null
        ? null
        : persistedNumeric(setting.data.manualDefaultRatePct, 9, 6, 'manual tax rate');
    if (amount !== null) requireNonnegative(amount, 'manual tax default');
    if (rate !== null && (rate < 0n || rate > 100n * pow10(6))) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'manual tax rate must be between zero and 100',
      );
    }
    const modeFieldsValid =
      (setting.data.mode === 'country_specific') === (setting.data.country !== null) &&
      (setting.data.mode === 'custom') === (setting.data.customParams !== null) &&
      (setting.data.mode === 'manual_per_trade' ||
        (setting.data.manualDefaultAmountEur === null &&
          setting.data.manualDefaultRatePct === null)) &&
      (setting.data.manualDefaultAmountEur === null ||
        setting.data.manualDefaultRatePct === null) &&
      (setting.data.mode !== 'custom' ||
        customTaxParamsSchema.safeParse(setting.data.customParams).success);
    if (!modeFieldsValid) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', 'tax setting is inconsistent');
    }
  }

  for (const order of rows(entities, 'standingOrder')) {
    requirePositive(
      persistedNumeric(order.data.amount, 20, 8, 'standing-order amount'),
      'standing-order amount',
    );
  }
  for (const expense of rows(entities, 'expenseTransaction')) {
    requirePositive(
      persistedNumeric(expense.data.amount, 20, 2, 'expense amount'),
      'expense amount',
    );
  }
  for (const rule of rows(entities, 'expenseRule')) {
    requirePostgresInteger(rule.data.priority, 'expense-rule priority');
  }
  for (const budget of rows(entities, 'expenseBudget')) {
    requirePositive(
      persistedNumeric(budget.data.amount, 20, 2, 'expense budget amount'),
      'expense budget amount',
    );
  }
}

/**
 * Validate every foreign-key and unique-source graph before the first insert.
 * Database checks remain defense in depth; this reports malformed decrypted vaults
 * as one clean failure and makes the no-write guarantee directly testable.
 */
interface ValidatedGraph {
  /** Existing one-quantum exception for tax replay's storage-rounding seam. */
  storageRoundingSellIds: ReadonlySet<string>;
}

function validateGraph(
  userId: string,
  entities: readonly Entity[],
  testOnlyRejectPersistedTransactionQuantity?: TestOnlyRejectPersistedTransactionQuantity,
  testOnlyObserveQuantityReachabilityOrder?: TestOnlyObserveQuantityReachabilityOrder,
  testOnlyTransactionQuantityRoundingTolerance?: bigint,
): ValidatedGraph {
  validateUniqueRestoredIds(entities);
  validateOwnedRows(userId, entities);
  validatePersistedDates(entities);
  validatePersistedNumerics(entities);

  const portfolioRows = rows(entities, 'portfolio');
  if (!portfolioRows.some((portfolio) => portfolio.data.archivedAt === null)) {
    throw new ParanoidRehydrationError(
      'INVALID_REFERENCE',
      'at least one active portfolio must be restored',
    );
  }
  const portfolioIds = new Set(portfolioRows.map((entity) => entity.id));
  const customAssetIds = ids(entities, 'customAsset');
  const sourceIds = ids(entities, 'cashSource');
  const transactionIds = ids(entities, 'transaction');
  const dividendIds = ids(entities, 'dividend');
  const standingOrderIds = ids(entities, 'standingOrder');
  const categoryIds = ids(entities, 'expenseCategory');
  const taxSettings = rows(entities, 'taxSetting');
  if (taxSettings.length > 1) {
    throw new ParanoidRehydrationError('INVALID_REFERENCE', 'only one tax setting may be restored');
  }

  const customAssetValueKeys = new Set<string>();
  for (const value of rows(entities, 'customAssetValue')) {
    const key = `${value.data.assetId}\u0000${value.data.date}`;
    if (customAssetValueKeys.has(key)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'custom asset values must be unique per asset and date',
      );
    }
    customAssetValueKeys.add(key);
  }

  const portfolioSettingKeys = new Set<string>();
  for (const setting of rows(entities, 'portfolioSetting')) {
    const key = `${setting.data.portfolioId}\u0000${setting.data.key}`;
    if (portfolioSettingKeys.has(key)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'portfolio settings must be unique per portfolio and key',
      );
    }
    portfolioSettingKeys.add(key);
    if (setting.data.key === 'tax' && !validTaxOverride(setting.data.value)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'portfolio tax override is malformed',
      );
    }
  }

  const expenseCategoryNames = new Set<string>();
  for (const category of rows(entities, 'expenseCategory')) {
    const key = `${userId}\u0000${category.data.name}`;
    if (expenseCategoryNames.has(key)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'expense category names must be unique',
      );
    }
    expenseCategoryNames.add(key);
  }

  const expenseHashes = new Set<string>();
  for (const expense of rows(entities, 'expenseTransaction')) {
    const hash = expense.data.dedupHash;
    if (hash === null) continue;
    if (expenseHashes.has(hash)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'expense rows must have unique persisted deduplication hashes',
      );
    }
    expenseHashes.add(hash);
  }

  const sourcesById = new Map(rows(entities, 'cashSource').map((entity) => [entity.id, entity]));
  const transactionsById = new Map(
    rows(entities, 'transaction').map((entity) => [entity.id, entity]),
  );
  const dividendsById = new Map(rows(entities, 'dividend').map((entity) => [entity.id, entity]));

  for (const asset of rows(entities, 'customAsset')) {
    if (asset.data.providerRef !== asset.id) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a manual asset provider reference must equal its entity id',
      );
    }
  }

  requireSubset(
    rows(entities, 'transaction').map((entity) => entity.data.portfolioId),
    portfolioIds,
    'transaction',
  );
  // Market-catalog assets are server-side global rows, while custom assets are
  // serialized here. The transaction checks their union before the first insert.
  requireSubset(
    rows(entities, 'dividend').map((entity) => entity.data.portfolioId),
    portfolioIds,
    'dividend',
  );
  // A dividend's asset may likewise be a global market asset.
  requireSubset(
    rows(entities, 'dividend').map((entity) => entity.data.cashSourceId),
    sourceIds,
    'dividend',
  );
  requireSubset(
    rows(entities, 'cashSource').map((entity) => entity.data.portfolioId),
    portfolioIds,
    'cash source',
  );
  requireSubset(
    rows(entities, 'portfolioSetting').map((entity) => entity.data.portfolioId),
    portfolioIds,
    'portfolio setting',
  );
  requireSubset(
    rows(entities, 'customAssetValue').map((entity) => entity.data.assetId),
    customAssetIds,
    'custom asset value',
  );
  requireSubset(
    rows(entities, 'standingOrder').map((entity) => entity.data.portfolioId),
    portfolioIds,
    'standing order',
  );
  requireSubset(
    rows(entities, 'standingOrderRun').map((entity) => entity.data.standingOrderId),
    standingOrderIds,
    'standing-order run',
  );
  const standingOrderRunKeys = new Set<string>();
  for (const run of rows(entities, 'standingOrderRun')) {
    const key = `${run.data.standingOrderId}\u0000${run.data.periodKey}`;
    if (standingOrderRunKeys.has(key)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'standing-order runs must be unique per order and period',
      );
    }
    standingOrderRunKeys.add(key);
  }
  for (const order of rows(entities, 'standingOrder')) {
    const isBuy = order.data.kind === 'buy-asset';
    if (isBuy !== (order.data.assetId !== null)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order asset must be present exactly for an asset buy',
      );
    }
    const isMonthly = order.data.cadence === 'monthly';
    if (isMonthly !== (order.data.anchorDay !== null)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order anchor day must be present exactly for a monthly schedule',
      );
    }
    if (order.data.anchorDay !== null && (order.data.anchorDay < 1 || order.data.anchorDay > 31)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order anchor day must be between 1 and 31',
      );
    }
    if (order.data.endDate !== null && order.data.endDate < order.data.startDate) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order end date must not precede its start date',
      );
    }
    if ((order.data.lastRunAt === null) !== (order.data.lastPeriodKey === null)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order run watermark requires both its timestamp and period key',
      );
    }
    if (order.data.lastPeriodKey !== null && order.data.lastPeriodKey < order.data.startDate) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order run watermark must not precede its schedule start',
      );
    }
    if (
      order.data.lastPeriodKey !== null &&
      !standingOrderRunKeys.has(`${order.id}\u0000${order.data.lastPeriodKey}`)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a standing-order run watermark requires its authoritative run row',
      );
    }
  }
  requireSubset(
    rows(entities, 'expenseTransaction').flatMap((entity) =>
      entity.data.categoryId ? [entity.data.categoryId] : [],
    ),
    categoryIds,
    'expense transaction',
  );
  requireSubset(
    rows(entities, 'expenseRule').map((entity) => entity.data.categoryId),
    categoryIds,
    'expense rule',
  );
  requireSubset(
    rows(entities, 'expenseBudget').map((entity) => entity.data.categoryId),
    categoryIds,
    'expense budget',
  );

  const sourcesByPortfolio = new Map<string, EntityOf<'cashSource'>[]>();
  for (const source of rows(entities, 'cashSource')) {
    const group = sourcesByPortfolio.get(source.data.portfolioId) ?? [];
    group.push(source);
    sourcesByPortfolio.set(source.data.portfolioId, group);
  }
  for (const [portfolioId, sources] of sourcesByPortfolio) {
    const mains = sources.filter((source) => source.data.isMain);
    if (mains.length !== 1 || mains[0]!.data.archivedAt !== null) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        `portfolio ${portfolioId} must have exactly one active main cash source`,
      );
    }
  }

  const portfolioNameKeys = new Set<string>();
  for (const portfolio of rows(entities, 'portfolio')) {
    const key = `${userId}\u0000${portfolio.data.name}`;
    if (portfolioNameKeys.has(key)) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', 'portfolio names must be unique');
    }
    portfolioNameKeys.add(key);
  }
  const sourceNameKeys = new Set<string>();
  for (const source of rows(entities, 'cashSource')) {
    const key = `${source.data.portfolioId}\u0000${source.data.name}`;
    if (sourceNameKeys.has(key)) {
      throw new ParanoidRehydrationError('INVALID_REFERENCE', 'cash-source names must be unique');
    }
    sourceNameKeys.add(key);
  }

  for (const dividend of rows(entities, 'dividend')) {
    const source = sourcesById.get(dividend.data.cashSourceId)!;
    if (source.data.portfolioId !== dividend.data.portfolioId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'dividend cash source belongs to another portfolio',
      );
    }
  }

  const movements = rows(entities, 'cashMovement');
  requireSubset(
    movements.map((entity) => entity.data.portfolioId),
    portfolioIds,
    'cash movement',
  );
  requireSubset(
    movements.map((entity) => entity.data.sourceId),
    sourceIds,
    'cash movement',
  );
  requireSubset(
    movements.flatMap((entity) => (entity.data.transactionId ? [entity.data.transactionId] : [])),
    transactionIds,
    'cash movement',
  );
  requireSubset(
    movements.flatMap((entity) => (entity.data.dividendId ? [entity.data.dividendId] : [])),
    dividendIds,
    'cash movement',
  );
  requireSubset(
    movements.flatMap((entity) =>
      entity.data.counterpartSourceId ? [entity.data.counterpartSourceId] : [],
    ),
    sourceIds,
    'cash movement',
  );

  const transfersById = new Map<string, EntityOf<'cashMovement'>[]>();
  for (const movement of movements) {
    const source = sourcesById.get(movement.data.sourceId)!;
    if (source.data.portfolioId !== movement.data.portfolioId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'cash movement source belongs to another portfolio',
      );
    }
    if (movement.data.transactionId && movement.data.dividendId) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'cash movement cannot link both a transaction and a dividend',
      );
    }
    const isTransfer =
      movement.data.kind === 'transfer_out' || movement.data.kind === 'transfer_in';
    if (
      isTransfer !== (movement.data.transferId !== null) ||
      isTransfer !== (movement.data.counterpartSourceId !== null)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'cash-movement transfer links do not match its kind',
      );
    }
    const isTax = movement.data.kind === 'tax_withholding' || movement.data.kind === 'tax_refund';
    if (isTax !== (movement.data.taxYear !== null)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'cash-movement tax year does not match its kind',
      );
    }
    if (movement.data.kind === 'dividend' && movement.data.dividendId === null) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a dividend cash movement requires its dividend',
      );
    }
    if (movement.data.transactionId) {
      const transaction = transactionsById.get(movement.data.transactionId)!;
      const isValidTransactionMovement =
        (movement.data.kind === 'buy' && transaction.data.side === 'buy') ||
        (movement.data.kind === 'sell_proceeds' && transaction.data.side === 'sell') ||
        ((movement.data.kind === 'tax_withholding' || movement.data.kind === 'tax_refund') &&
          transaction.data.side === 'sell');
      if (!isValidTransactionMovement) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement kind does not match its transaction',
        );
      }
      if (transaction.data.portfolioId !== movement.data.portfolioId) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement transaction belongs to another portfolio',
        );
      }
      if (transaction.data.source !== movement.data.source) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement source tag must match its transaction',
        );
      }
    }
    if (movement.data.dividendId) {
      const dividend = dividendsById.get(movement.data.dividendId)!;
      const isValidDividendMovement =
        movement.data.kind === 'dividend' ||
        movement.data.kind === 'tax_withholding' ||
        movement.data.kind === 'tax_refund';
      if (!isValidDividendMovement) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement kind does not match its dividend',
        );
      }
      if (dividend.data.portfolioId !== movement.data.portfolioId) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement dividend belongs to another portfolio',
        );
      }
      if (dividend.data.cashSourceId !== movement.data.sourceId) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement source does not match its dividend',
        );
      }
      if (dividend.data.source !== movement.data.source) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement source tag must match its dividend',
        );
      }
    }
    if (movement.data.counterpartSourceId) {
      const counterpart = sourcesById.get(movement.data.counterpartSourceId)!;
      if (counterpart.data.portfolioId !== movement.data.portfolioId) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash movement counterpart source belongs to another portfolio',
        );
      }
    }
    if (
      (movement.data.kind === 'buy' || movement.data.kind === 'sell_proceeds') &&
      !movement.data.transactionId
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a buy or sell-proceeds cash movement requires its transaction',
      );
    }
    if (movement.data.transferId) {
      const transfer = transfersById.get(movement.data.transferId) ?? [];
      transfer.push(movement);
      transfersById.set(movement.data.transferId, transfer);
    }
  }

  for (const transfer of transfersById.values()) {
    const outgoing = transfer.filter((movement) => movement.data.kind === 'transfer_out');
    const incoming = transfer.filter((movement) => movement.data.kind === 'transfer_in');
    const [out] = outgoing;
    const [inbound] = incoming;
    if (
      transfer.length !== 2 ||
      outgoing.length !== 1 ||
      incoming.length !== 1 ||
      !out ||
      !inbound ||
      out.data.portfolioId !== inbound.data.portfolioId ||
      out.data.sourceId === inbound.data.sourceId ||
      out.data.counterpartSourceId !== inbound.data.sourceId ||
      inbound.data.counterpartSourceId !== out.data.sourceId ||
      persistedNumeric(out.data.amountEur, 20, 6, 'transfer amount') +
        persistedNumeric(inbound.data.amountEur, 20, 6, 'transfer amount') !==
        0n ||
      Date.parse(out.data.executedAt) !== Date.parse(inbound.data.executedAt)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'transfer movements do not form a valid pair',
      );
    }
  }

  const movementsByTransactionId = new Map<string, EntityOf<'cashMovement'>[]>();
  const movementsByDividendId = new Map<string, EntityOf<'cashMovement'>[]>();
  for (const movement of movements) {
    if (movement.data.transactionId) {
      const linked = movementsByTransactionId.get(movement.data.transactionId) ?? [];
      linked.push(movement);
      movementsByTransactionId.set(movement.data.transactionId, linked);
    }
    if (movement.data.dividendId) {
      const linked = movementsByDividendId.get(movement.data.dividendId) ?? [];
      linked.push(movement);
      movementsByDividendId.set(movement.data.dividendId, linked);
    }
  }

  for (const transaction of rows(entities, 'transaction')) {
    const linked = movementsByTransactionId.get(transaction.id) ?? [];
    const grossKind = transaction.data.side === 'buy' ? 'buy' : 'sell_proceeds';
    const gross = linked.filter((movement) => movement.data.kind === grossKind);
    if (gross.length > 1) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a transaction may have at most one linked gross cash movement',
      );
    }
    const [grossMovement] = gross;
    if (grossMovement) {
      const transactionAt = Date.parse(transaction.data.executedAt);
      const movementAt = Date.parse(grossMovement.data.executedAt);
      const invalidTimestamp =
        grossKind === 'sell_proceeds' ? movementAt !== transactionAt : movementAt < transactionAt;
      if (invalidTimestamp) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          grossKind === 'sell_proceeds'
            ? 'a sell-proceeds cash movement must share its transaction timestamp'
            : 'a buy cash movement must not precede its transaction',
        );
      }
    }
    // The persisted cash amount is authoritative. Normal writes calculate it
    // from the accepted client numbers (and, for foreign assets, that moment's
    // historical FX result) before PostgreSQL independently coerces the
    // transaction columns to their fixed scales. Recomputing from the stored
    // transaction cannot reproduce every valid row. Parent/source ownership,
    // kind/side, source tag, sign, uniqueness, and ledger solvency are all
    // validated around this loop without changing the frozen amount.
    const settlement = linked.filter(
      (movement) => movement.data.kind === 'tax_withholding' || movement.data.kind === 'tax_refund',
    );
    if (settlement.length > 1) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a transaction may have at most one linked tax settlement',
      );
    }
    if (
      settlement.some(
        (movement) =>
          Date.parse(movement.data.executedAt) !== Date.parse(transaction.data.executedAt),
      )
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a transaction tax settlement must share its transaction timestamp',
      );
    }
    const frozenTax = transaction.data.taxAmountEur;
    const frozenTaxAmount =
      frozenTax === null ? null : persistedNumeric(frozenTax, 20, 6, 'transaction tax amount');
    if (frozenTaxAmount !== null && frozenTaxAmount !== 0n) {
      const [movement] = settlement;
      if (
        !movement ||
        persistedNumeric(movement.data.amountEur, 20, 6, 'tax settlement amount') !==
          -frozenTaxAmount ||
        movement.data.taxYear !== viennaYearOf(transaction.data.executedAt)
      ) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'a nonzero transaction tax amount requires its matching tax settlement',
        );
      }
    } else if (settlement.length > 0) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a transaction tax settlement requires a nonzero frozen tax amount',
      );
    }
  }

  for (const dividend of rows(entities, 'dividend')) {
    const linked = movementsByDividendId.get(dividend.id) ?? [];
    const gross = linked.filter((movement) => movement.data.kind === 'dividend');
    if (
      gross.length !== 1 ||
      persistedNumeric(gross[0]!.data.amountEur, 20, 6, 'dividend cash amount') !==
        persistedNumeric(dividend.data.grossAmountEur, 20, 6, 'dividend gross amount') ||
      gross[0]!.data.sourceId !== dividend.data.cashSourceId ||
      Date.parse(gross[0]!.data.executedAt) !== Date.parse(dividend.data.executedAt)
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a dividend requires one matching gross cash movement',
      );
    }
    const settlement = linked.filter(
      (movement) => movement.data.kind === 'tax_withholding' || movement.data.kind === 'tax_refund',
    );
    if (settlement.length > 1) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a dividend may have at most one linked tax settlement',
      );
    }
    if (
      settlement.some(
        (movement) => Date.parse(movement.data.executedAt) !== Date.parse(dividend.data.executedAt),
      )
    ) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a dividend tax settlement must share its dividend timestamp',
      );
    }
    const frozenTax = dividend.data.taxAmountEur;
    const frozenTaxAmount =
      frozenTax === null ? null : persistedNumeric(frozenTax, 20, 6, 'dividend tax amount');
    if (frozenTaxAmount !== null && frozenTaxAmount !== 0n) {
      const [movement] = settlement;
      if (
        !movement ||
        persistedNumeric(movement.data.amountEur, 20, 6, 'tax settlement amount') !==
          -frozenTaxAmount ||
        movement.data.taxYear !== viennaYearOf(dividend.data.executedAt)
      ) {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'a nonzero dividend tax amount requires its matching tax settlement',
        );
      }
    } else if (settlement.length > 0) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'a dividend tax settlement requires a nonzero frozen tax amount',
      );
    }
  }

  const budgetCategoryIds = new Set<string>();
  for (const budget of rows(entities, 'expenseBudget')) {
    if (budgetCategoryIds.has(budget.data.categoryId)) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'each expense category has at most one budget',
      );
    }
    budgetCategoryIds.add(budget.data.categoryId);
  }

  // The repository's persisted replay order is `(executed_at, id)`, not the
  // arbitrary client array order. Preserve that ordering here so solvency checks
  // accept exactly the ledger history normal reads will replay after restore.
  const orderedMovements = [...movements].sort(
    (a, b) =>
      Date.parse(a.data.executedAt) - Date.parse(b.data.executedAt) || a.id.localeCompare(b.id),
  );
  // Replica application deliberately waives the ordinary solvency gate because
  // copy-local tax state can skew a source. Once that copy becomes a fork, its
  // sync-tagged rows are the only durable provenance available in the strict
  // vault document, so preserve that reachable ledger instead of stranding it.
  const mirrorReplicaSourceIds = new Set(
    movements
      .filter((movement) => movement.data.source === SOURCE_TAG_SYNC_MIRRORCHAIN)
      .map((movement) => movement.data.sourceId),
  );
  const storageRoundingSellIds = new Set<string>();

  try {
    const balancesBySource = new Map<string, bigint>();
    for (const movement of orderedMovements) {
      const amount = persistedNumeric(movement.data.amountEur, 20, 6, 'cash-movement amount');
      const requiredSign = CASH_MOVEMENT_SIGN[movement.data.kind];
      if (amount === 0n || (requiredSign === 1 ? amount < 0n : amount > 0n)) {
        throw new Error('cash-movement amount has the wrong sign');
      }
      const balance = (balancesBySource.get(movement.data.sourceId) ?? 0n) + amount;
      if (balance < 0n && !mirrorReplicaSourceIds.has(movement.data.sourceId)) {
        throw new Error('cash source would become negative');
      }
      balancesBySource.set(movement.data.sourceId, balance);
    }
    for (const sellId of storageRoundingSellIdsFor(
      rows(entities, 'transaction'),
      new Set(
        movements.flatMap((movement) =>
          movement.data.transactionId ? [movement.data.transactionId] : [],
        ),
      ),
      testOnlyRejectPersistedTransactionQuantity,
      testOnlyObserveQuantityReachabilityOrder,
      testOnlyTransactionQuantityRoundingTolerance,
    )) {
      storageRoundingSellIds.add(sellId);
    }
  } catch (error) {
    if (error instanceof ParanoidRehydrationError) throw error;
    throw new ParanoidRehydrationError(
      'INVALID_CASH_LEDGER',
      error instanceof Error ? error.message : 'cash ledger is invalid',
    );
  }
  return { storageRoundingSellIds };
}

interface ReferencedAsset {
  currency: string;
}

async function resolveReferencedAssets(
  sourceRows: ParanoidRehydrationSourceRepository,
  entities: readonly Entity[],
): Promise<ReadonlyMap<string, ReferencedAsset>> {
  const assetsById = new Map<string, ReferencedAsset>(
    rows(entities, 'customAsset').map((entity) => [entity.id, { currency: entity.data.currency }]),
  );
  const customAssetIds = new Set(assetsById.keys());
  const referencedAssetIds = new Set([
    ...rows(entities, 'transaction').map((entity) => entity.data.assetId),
    ...rows(entities, 'dividend').map((entity) => entity.data.assetId),
    ...rows(entities, 'standingOrder')
      .map((entity) => entity.data.assetId)
      .filter((assetId): assetId is string => assetId !== null),
  ]);
  const marketAssetIds = [...referencedAssetIds].filter((id) => !customAssetIds.has(id));
  if (marketAssetIds.length === 0) return assetsById;
  const found = await sourceRows.findReferencedGlobalAssets(marketAssetIds);
  requireSubset(marketAssetIds, new Set(found.map((asset) => asset.id)), 'restore source');
  for (const asset of found) {
    assetsById.set(asset.id, { currency: asset.currency });
  }
  return assetsById;
}

function validateStandingOrderCurrencies(
  entities: readonly Entity[],
  referencedAssets: ReadonlyMap<string, ReferencedAsset>,
): void {
  for (const order of rows(entities, 'standingOrder')) {
    if (order.data.kind !== 'buy-asset') {
      if (order.data.currency !== 'EUR') {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'cash standing orders must use EUR',
        );
      }
      continue;
    }
    const asset = order.data.assetId ? referencedAssets.get(order.data.assetId) : undefined;
    if (!asset || order.data.currency !== asset.currency) {
      throw new ParanoidRehydrationError(
        'INVALID_REFERENCE',
        'buy standing-order currency must match its asset',
      );
    }
  }
}

async function ensureNoExistingRestorableRows(
  sourceRows: ParanoidRehydrationSourceRepository,
  userId: string,
): Promise<void> {
  if (await sourceRows.hasExistingRestorableRows(userId)) {
    throw new ParanoidRehydrationError(
      'REHYDRATION_CONFLICT',
      'normal restore-source rows already exist for this account',
    );
  }
}

export function createParanoidRehydrationService(
  deps: ParanoidRehydrationServiceDeps,
): ParanoidRehydrationService {
  const now = deps.now ?? (() => new Date());
  if (
    deps.testOnlyTransactionQuantityRoundingTolerance !== undefined &&
    deps.testOnlyTransactionQuantityRoundingTolerance < 0n
  ) {
    throw new Error('transaction quantity rounding tolerance must not be negative');
  }
  const toCashEur =
    deps.toCashEur ??
    (async (amount, currency) => {
      if (currency !== 'EUR') {
        throw new ParanoidRehydrationError(
          'INVALID_REFERENCE',
          'non-EUR tax replay requires a historical EUR conversion',
        );
      }
      return amount;
    });
  const stage = async (name: ParanoidRehydrationStage): Promise<void> => {
    await deps.afterStage?.(name);
  };

  return {
    async rehydrate(userId, request) {
      const parsed = paranoidDisableRehydrationRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new ParanoidRehydrationError('INVALID_REFERENCE', 'rehydration request is malformed');
      }
      const normalizedRequest = parsed.data;
      validateCustomAssetFacts(userId, normalizedRequest.document.entities);
      // Tombstones exist for client-side merge convergence only. Construct and
      // validate the restore graph from live facts before any database mutation.
      const entities = liveEntities(normalizedRequest.document);
      const validatedGraph = validateGraph(
        userId,
        entities,
        deps.testOnlyRejectPersistedTransactionQuantity,
        deps.testOnlyObserveQuantityReachabilityOrder,
        deps.testOnlyTransactionQuantityRoundingTolerance,
      );

      return withParanoidRehydrationTransaction(deps.db, async (tx) => {
        const transition = createParanoidRehydrationTransactionRepository(tx);
        const state = await transition.getState(userId);
        if (!state)
          throw new ParanoidRehydrationError('ACCOUNT_NOT_FOUND', 'account does not exist');
        if (state.receipt) {
          if (state.receipt.rehydrationId !== normalizedRequest.rehydrationId) {
            throw new ParanoidRehydrationError(
              'REHYDRATION_CONFLICT',
              'a different rehydration is complete',
            );
          }
          return {
            rehydrationId: state.receipt.rehydrationId,
            completedAt: state.receipt.completedAt.toISOString(),
            idempotent: true,
            postCommit: POST_COMMIT,
          };
        }
        if (state.privacyMode !== 'paranoid') {
          throw new ParanoidRehydrationError('NOT_PARANOID', 'account is not in paranoid mode');
        }

        const sourceRows = createParanoidRehydrationSourceRepository(tx);
        await ensureNoExistingRestorableRows(sourceRows, userId);
        const retainedIdentityIds = await sourceRows.listRetainedCustomAssetIdentityIds(userId);
        const retireIdentityIds = retainedCustomAssetRetireIds(
          retainedIdentityIds,
          normalizedRequest.document.entities,
        );
        const referencedAssets = await resolveReferencedAssets(sourceRows, entities);
        validateStandingOrderCurrencies(entities, referencedAssets);

        await sourceRows.restoreCustomAssets(rows(entities, 'customAsset'));
        await sourceRows.retireRetainedCustomAssetIdentities(userId, retireIdentityIds);
        await sourceRows.restoreCustomAssetValues(rows(entities, 'customAssetValue'));
        await stage('customAssets');

        await sourceRows.restorePortfolios(rows(entities, 'portfolio'));
        await stage('portfolios');

        await sourceRows.restoreCashSources(rows(entities, 'cashSource'));
        await stage('cashSources');

        const taxSettings = rows(entities, 'taxSetting');
        if (taxSettings.length > 1) {
          throw new ParanoidRehydrationError(
            'INVALID_REFERENCE',
            'only one tax setting may be restored',
          );
        }
        await sourceRows.restoreTaxSettings(taxSettings[0]);
        await stage('taxSettings');

        await sourceRows.restorePortfolioSettings(rows(entities, 'portfolioSetting'));
        await stage('portfolioSettings');

        await sourceRows.restoreTransactions(rows(entities, 'transaction'));
        await stage('transactions');

        await sourceRows.restoreDividends(rows(entities, 'dividend'));
        await stage('dividends');

        await sourceRows.restoreCashMovements(rows(entities, 'cashMovement'));
        await stage('cashMovements');

        await replayRestoredTaxState(tx, {
          userId,
          portfolioIds: rows(entities, 'portfolio').map((portfolio) => portfolio.id),
          now: now(),
          toEur: toCashEur,
          storageRoundingSellIds: validatedGraph.storageRoundingSellIds,
        });
        await stage('taxReplay');

        const standingOrderRows = rows(entities, 'standingOrder');
        await sourceRows.restoreStandingOrders(standingOrderRows);
        await sourceRows.restoreStandingOrderRuns(rows(entities, 'standingOrderRun'));
        await stage('standingOrders');

        const categoryRepo = createExpenseCategoryRepository(tx);
        const expenseTransactionRepo = createExpenseTransactionRepository(tx);
        const expenseRuleRepo = createExpenseRuleRepository(tx);
        const expenseBudgetRepo = createExpenseBudgetRepository(tx);
        const expenseService = createExpenseService({
          categories: categoryRepo,
          transactions: expenseTransactionRepo,
          rules: expenseRuleRepo,
        });
        const expenseBudgetService = createExpenseBudgetService({
          categories: categoryRepo,
          transactions: expenseTransactionRepo,
          budgets: expenseBudgetRepo,
          notify: NO_REHYDRATION_NOTIFICATIONS,
          now,
        });

        await sourceRows.restoreExpenseCategories(rows(entities, 'expenseCategory'));
        await stage('expenseCategories');

        await sourceRows.restoreExpenseRules(rows(entities, 'expenseRule'));
        await stage('expenseRules');

        await sourceRows.restoreExpenseBudgets(rows(entities, 'expenseBudget'));
        await stage('expenseBudgets');

        const restoredExpenseTransactions = rows(entities, 'expenseTransaction').map((entity) => ({
          ...entity,
          categoryId: entity.data.categoryId,
          bookedOn: entity.data.bookedOn,
        }));
        await expenseService.restoreTransactions(userId, restoredExpenseTransactions, {
          ownsCategory: (ownerId, categoryId) => categoryRepo.ownsCategory(ownerId, categoryId),
          insertTransactions: (_ownerId, restoredRows) =>
            sourceRows.restoreExpenseTransactions(restoredRows),
          reconcileBudgets: (ownerId, periods) =>
            expenseBudgetService.reconcileRestore(ownerId, periods).then(() => undefined),
        });
        await stage('expenseTransactions');

        const completedAt = now();
        await transition.setNormalAndClearMedia(userId);
        await stage('normalMode');
        await transition.deleteServerCiphertext(userId);
        await stage('ciphertextDeleted');
        await transition.insertReceipt(userId, normalizedRequest.rehydrationId, completedAt);
        await stage('finish');

        return {
          rehydrationId: normalizedRequest.rehydrationId,
          completedAt: completedAt.toISOString(),
          idempotent: false,
          postCommit: POST_COMMIT,
        };
      });
    },
  };
}
