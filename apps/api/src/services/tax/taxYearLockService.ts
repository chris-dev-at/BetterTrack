import type { Redis } from 'ioredis';

import type { TaxYearLockStateResponse } from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { TaxRepository } from '../../data/repositories/taxRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { viennaYearOf } from '../../domain/tax';
import { badRequest, conflict, tooManyRequests, unauthorized } from '../../errors';
import { AuditAction, type AuditService } from '../audit/auditService';
import { ACCOUNT_TAX_YEAR_UNLOCK_NAMESPACE } from '../auth/loginThrottle';
import type { PasswordHasher } from '../password/passwordHasher';
import { createProgressiveLimiter } from '../security/progressiveLimiter';

/**
 * Tax year locking (owner directive 2026-08-07, PROJECTPLAN.md §16): "the tax
 * should never be changeable after the year has passed."
 *
 * The lock is API-layer POLICY sitting strictly in FRONT of the tax engine —
 * `packages/domain` and the closed-year ΔF settlement machinery
 * (`closedSettlement.ts`, #635/#669) are untouched:
 *
 *  - A Vienna tax year is LOCKED exactly when it lies before the current year
 *    and the user has not explicitly unlocked it. Locked is the DEFAULT state
 *    of every elapsed year (the `tax_year_unlocks` table stores only the
 *    exceptions), so rollover locks the ending year with no job and the
 *    migration locked all history with no backfill.
 *  - While locked, every mutation dated into the year — transactions,
 *    dividends, cash movements; create, edit, delete — is refused with
 *    409 `TAX_YEAR_LOCKED` BEFORE any planning or correction posting
 *    ({@link TaxYearLockGuard.assertYearsAmendable}). MIRRORCHAIN replica
 *    applies bypass the guard (`force`, design §2): the origin actor's own
 *    lock state already gated the op before it entered the chain.
 *  - Amendments are legal reality (AT/DE), so there is an explicit ritual:
 *    {@link TaxYearLockService.unlock} re-verifies the account password
 *    (cookie-session only — the route layer enforces "never bearer") and
 *    opens ONE named year, which stays amendable until {@link relock}. Both
 *    transitions are audit-logged.
 *  - An amendment into an unlocked year can still RESHAPE later locked years
 *    (a backdated trade shifts cost bases under later frozen sells; DE pots /
 *    custom carry chain forward). {@link assertReshapeAmendable} refuses
 *    those too — deliberately on the settlement scope's over-approximation
 *    (`scopeClosedMutation`, #669): over-refusal names a year to unlock;
 *    under-refusal would let a locked year's tax move. Years BEFORE the
 *    amended one are never refused (realizations are prefix-stable — a later
 *    trade cannot change an earlier year).
 *
 * The current (open) year is never lockable, and the guard never queries the
 * database for mutations dated entirely in open years — the hot path costs
 * nothing.
 */

/** The year named by a 409 refusal, plus the unlock path the client can offer. */
export const taxYearUnlockPath = (year: number): string =>
  `/api/v1/settings/taxes/years/${year}/unlock`;

/** 409 for a mutation dated into a locked year. */
export const taxYearLockedError = (year: number) =>
  conflict(
    `Tax year ${year} is locked — a year that has ended no longer changes. ` +
      `To record an amendment, unlock year ${year} first (Tax Report → Unlock, ` +
      `or POST ${taxYearUnlockPath(year)}), then re-lock it when you are done.`,
    'TAX_YEAR_LOCKED',
    { year, unlockPath: taxYearUnlockPath(year) },
  );

/** 409 for an amendment whose reshape would reach a LATER locked year. */
export const taxYearReshapeLockedError = (year: number, amendedYear: number) =>
  conflict(
    `This change to ${amendedYear} could also reshape tax year ${year}, which is ` +
      `locked — carried-over cost bases and pools feed later years. Unlock year ` +
      `${year} as well (Tax Report → Unlock, or POST ${taxYearUnlockPath(year)}) ` +
      `before recording this amendment.`,
    'TAX_YEAR_LOCKED',
    { year, amendedYear, unlockPath: taxYearUnlockPath(year) },
  );

/**
 * The narrow slice the mutation gates depend on (portfolio + tax services).
 * Everything here is read-only against the lock state.
 */
export interface TaxYearLockGuard {
  /** The current Vienna tax year per the injected clock (the lock boundary). */
  currentTaxYear(): number;
  /** The user's explicitly-unlocked elapsed years. */
  unlockedYears(userId: string): Promise<Set<number>>;
  /**
   * Refuse (409 `TAX_YEAR_LOCKED`) when any of the mutation's DATED Vienna
   * years is locked. Call at the top of every user-facing mutation path,
   * before planning; skip for MIRRORCHAIN replica applies (`force`).
   */
  assertYearsAmendable(userId: string, years: Iterable<number>): Promise<void>;
  /**
   * Refuse when an amendment dated into `amendedYear` would reshape a LATER
   * locked year (`reshapedYears` = the settlement scope's affected closed
   * years; years ≤ `amendedYear` and open years are ignored here).
   */
  assertReshapeAmendable(
    userId: string,
    input: { amendedYear: number; reshapedYears: Iterable<number> },
  ): Promise<void>;
}

export interface TaxYearLockService extends TaxYearLockGuard {
  /** The caller's lock state (`GET /settings/taxes/years`). */
  lockState(userId: string): Promise<TaxYearLockStateResponse>;
  /**
   * The unlock ritual: password re-auth (per-account throttled), then open
   * ONE named elapsed year for amendments. Audited. Idempotent on an already
   * unlocked year (no second audit row).
   */
  unlock(input: {
    userId: string;
    year: number;
    password: string;
    ip?: string | null;
  }): Promise<TaxYearLockStateResponse>;
  /** Close the year again. Audited; idempotent on an already locked year. */
  relock(input: {
    userId: string;
    year: number;
    ip?: string | null;
  }): Promise<TaxYearLockStateResponse>;
}

export interface TaxYearLockServiceDeps {
  config: AppConfig;
  redis: Redis;
  taxRepo: Pick<TaxRepository, 'listUnlockedTaxYears' | 'unlockTaxYear' | 'relockTaxYear'>;
  userRepo: Pick<UserRepository, 'findById'>;
  passwordHasher: Pick<PasswordHasher, 'verify'>;
  audit: AuditService;
  /**
   * Injectable clock — MUST be the same seam as the tax service's (`taxNow`),
   * so the lock boundary and the open/closed derivation boundary can never
   * disagree about which year is current.
   */
  now?: () => number;
}

export function createTaxYearLockService(deps: TaxYearLockServiceDeps): TaxYearLockService {
  const { taxRepo, userRepo, passwordHasher, audit } = deps;
  const now = deps.now ?? Date.now;
  const throttle = createProgressiveLimiter(
    deps.redis,
    ACCOUNT_TAX_YEAR_UNLOCK_NAMESPACE,
    deps.config.rateLimits.loginAccount,
  );

  const currentTaxYear = (): number => viennaYearOf(new Date(now()).toISOString());

  async function unlockedYears(userId: string): Promise<Set<number>> {
    return new Set(await taxRepo.listUnlockedTaxYears(userId));
  }

  /** Locked = elapsed AND not explicitly unlocked. */
  async function lockedAmong(userId: string, years: Iterable<number>): Promise<number[]> {
    const boundary = currentTaxYear();
    const elapsed = [...new Set(years)].filter((year) => year < boundary).sort((a, b) => a - b);
    if (elapsed.length === 0) return []; // hot path: open-year mutations never query
    const unlocked = await unlockedYears(userId);
    return elapsed.filter((year) => !unlocked.has(year));
  }

  async function lockState(userId: string): Promise<TaxYearLockStateResponse> {
    const boundary = currentTaxYear();
    const unlocked = await taxRepo.listUnlockedTaxYears(userId);
    // Rows for years that have since become current/future are unreachable by
    // construction (unlock refuses them); filter defensively anyway.
    return { currentYear: boundary, unlockedYears: unlocked.filter((y) => y < boundary) };
  }

  /** Wrong-password accounting: consume throttle, audit, raise (mirrors export/deletion). */
  async function failReauth(userId: string, year: number, ip: string | null | undefined) {
    const decision = await throttle.consume(userId);
    await audit.record({
      actorId: userId,
      action: AuditAction.TaxYearUnlockReauthFail,
      targetType: 'user',
      targetId: userId,
      ip,
      meta: { year, locked: !decision.allowed },
    });
    if (!decision.allowed) {
      throw tooManyRequests(decision.retryAfterSec, 'Too many attempts. Please wait and retry.');
    }
    throw unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS');
  }

  const assertLockableYear = (year: number): void => {
    if (year < currentTaxYear()) return;
    throw badRequest(
      `Tax year ${year} has not ended — only years that have passed lock, and the current year is always open.`,
      'TAX_YEAR_NOT_LOCKABLE',
      { year, currentYear: currentTaxYear() },
    );
  };

  return {
    currentTaxYear,
    unlockedYears,
    lockState,

    async assertYearsAmendable(userId, years) {
      const locked = await lockedAmong(userId, years);
      if (locked.length > 0) throw taxYearLockedError(locked[0]!);
    },

    async assertReshapeAmendable(userId, { amendedYear, reshapedYears }) {
      const later = [...reshapedYears].filter((year) => year > amendedYear);
      const locked = await lockedAmong(userId, later);
      if (locked.length > 0) throw taxYearReshapeLockedError(locked[0]!, amendedYear);
    },

    async unlock({ userId, year, password, ip }) {
      assertLockableYear(year);
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      // Reject an already-cooling account before any verify, so a blocked
      // retry — even with the correct password — cannot ride through.
      const cooling = await throttle.peek(userId);
      if (cooling > 0) {
        throw tooManyRequests(cooling, 'Too many attempts. Please wait and retry.');
      }
      const ok = await passwordHasher.verify(user.passwordHash, password);
      if (!ok) await failReauth(userId, year, ip);
      await throttle.reset(userId);

      const changed = await taxRepo.unlockTaxYear(userId, year);
      if (changed) {
        await audit.record({
          actorId: userId,
          action: AuditAction.TaxYearUnlocked,
          targetType: 'user',
          targetId: userId,
          ip,
          meta: { year },
        });
      }
      return lockState(userId);
    },

    async relock({ userId, year, ip }) {
      assertLockableYear(year);
      const changed = await taxRepo.relockTaxYear(userId, year);
      if (changed) {
        await audit.record({
          actorId: userId,
          action: AuditAction.TaxYearRelocked,
          targetType: 'user',
          targetId: userId,
          ip,
          meta: { year },
        });
      }
      return lockState(userId);
    },
  };
}
