import type { DomainEvent, MirrorNotificationEvent } from '../../events';
import { ApiError } from '../../errors';

/** Stable refusal returned by every server boundary that targets a locked stub. */
export const VAULTED_PORTFOLIO_ERROR_CODE = 'VAULTED_PORTFOLIO' as const;

export class VaultedPortfolioError extends ApiError {
  constructor() {
    super(
      403,
      VAULTED_PORTFOLIO_ERROR_CODE,
      'This server-side feature is unavailable for a vaulted portfolio.',
    );
    this.name = 'VaultedPortfolioError';
  }
}

/** Identity-only portfolio state; `vaultId !== null` is the locked-stub boundary. */
export interface VaultedPortfolioSubject {
  readonly exists: boolean;
  readonly userId: string | null;
  readonly vaultId: string | null;
}

export interface VaultedPortfolioGuardDependencies {
  /** A narrow lookup suitable for request-level defense in depth. */
  readonly portfolioSubject: (portfolioId: string) => Promise<VaultedPortfolioSubject>;
  /**
   * Optional production lock seam. For an existing portfolio, it must hold the
   * owner's account privacy lock for the complete callback and re-resolve the
   * subject after acquiring it. E4 move-in takes the conflicting exclusive lock
   * on that same account row before setting `portfolios.vault_id`, so the
   * callback and move-in serialize.
   */
  readonly withLockedPortfolioSubject?: <T>(
    portfolioId: string,
    action: (subject: VaultedPortfolioSubject) => Promise<T>,
  ) => Promise<T>;
  /** Conservative telemetry policy for per-asset market reads with no portfolio id. */
  readonly userOwnsVaultedPortfolio?: (userId: string) => Promise<boolean>;
}

export interface VaultedPortfolioGuard {
  /** Owner-scoped identity check; foreign/missing ids both return false. */
  isOwnedPortfolioVaulted(userId: string, portfolioId: string): Promise<boolean>;
  /** True when an unattributed quote read could have been caused by a vault. */
  userOwnsVaultedPortfolio(userId: string): Promise<boolean>;
  /**
   * Owner-scoped assertion for an HTTP/service target. Missing and foreign rows
   * deliberately fall through so the existing owner-scoped repository emits its
   * normal opaque 404 instead of turning vault membership into an oracle.
   */
  assertOwnedPortfolioAllowed(userId: string, portfolioId: string): Promise<void>;
  /** The action form holds the optional owner-account privacy lock through the full operation. */
  runOwnedPortfolioAllowed<T>(
    userId: string,
    portfolioId: string,
    action: () => Promise<T>,
  ): Promise<T>;
  /**
   * Job/deferred-work primitive. Missing rows and vaulted rows both skip, so a
   * stale id can never become an accidental allow after move-in or deletion.
   */
  runJobIfAllowed(portfolioId: string, action: () => Promise<void>): Promise<boolean>;
}

export function createVaultedPortfolioGuard(
  dependencies: VaultedPortfolioGuardDependencies,
): VaultedPortfolioGuard {
  const withSubject = <T>(
    portfolioId: string,
    action: (subject: VaultedPortfolioSubject) => Promise<T>,
  ): Promise<T> => {
    if (dependencies.withLockedPortfolioSubject) {
      return dependencies.withLockedPortfolioSubject(portfolioId, action);
    }
    return dependencies.portfolioSubject(portfolioId).then(action);
  };

  const ownedVaulted = (subject: VaultedPortfolioSubject, userId: string): boolean =>
    subject.exists && subject.userId === userId && subject.vaultId !== null;

  return {
    async isOwnedPortfolioVaulted(userId, portfolioId) {
      return withSubject(portfolioId, async (subject) => ownedVaulted(subject, userId));
    },

    async userOwnsVaultedPortfolio(userId) {
      return dependencies.userOwnsVaultedPortfolio?.(userId) ?? false;
    },

    async assertOwnedPortfolioAllowed(userId, portfolioId) {
      await withSubject(portfolioId, async (subject) => {
        if (ownedVaulted(subject, userId)) throw new VaultedPortfolioError();
      });
    },

    async runOwnedPortfolioAllowed(userId, portfolioId, action) {
      return withSubject(portfolioId, async (subject) => {
        if (ownedVaulted(subject, userId)) throw new VaultedPortfolioError();
        return action();
      });
    },

    async runJobIfAllowed(portfolioId, action) {
      return withSubject(portfolioId, async (subject) => {
        if (!subject.exists || subject.userId === null || subject.vaultId !== null) return false;
        await action();
        return true;
      });
    },
  };
}

/**
 * Direct portfolio identity carried by content events. Asset-only scans and
 * standing-order notices must be filtered before production because their
 * event payload intentionally contains no portfolio identity.
 */
export function portfolioIdForPortfolioContentEvent(event: DomainEvent): string | null {
  if (event.type === 'portfolio.changed' || event.type === 'portfolio.shared') {
    return event.portfolioId;
  }
  if (
    (event.type === 'friend.activity' ||
      event.type === 'follow.published' ||
      event.type === 'comment.created') &&
    event.itemKind === 'portfolio'
  ) {
    return event.itemId;
  }
  if (event.type === 'budget.exceeded' && event.portfolioId) return event.portfolioId;
  return null;
}

export interface VaultedPortfolioWebhookSubjects {
  portfolioSubject(portfolioId: string): Promise<VaultedPortfolioSubject>;
  standingOrderPortfolio?(
    userId: string,
    standingOrderId: string,
  ): Promise<VaultedPortfolioSubject>;
  cashBudgetPortfolio?(userId: string, budgetId: string): Promise<VaultedPortfolioSubject>;
  legacyExpenseBudgetExists?(userId: string, budgetId: string): Promise<boolean>;
  userHasPlainHolding?(userId: string, assetId: string): Promise<boolean>;
  /**
   * The current (active, otherwise latest ended) chain membership for each
   * supplied mirror-event principal. The caller already holds those exact
   * accounts' transition locks; resolving any broader historical set here
   * would both race unrelated accounts and let an old fork kill a plain chain.
   */
  mirrorMemberPortfolios?(
    chainId: string,
    principalUserIds: readonly string[],
  ): Promise<readonly VaultedMirrorMemberPortfolioSubject[]>;
}

export interface VaultedMirrorMemberPortfolioSubject {
  readonly memberUserId: string;
  readonly memberPortfolioId: string | null;
  readonly portfolio: VaultedPortfolioSubject;
}

function isMirrorNotificationEvent(event: DomainEvent): event is MirrorNotificationEvent {
  // Keep this prefix-driven rather than maintaining a second event list: a new
  // mirror notification must inherit fail-closed portfolio attribution until
  // its producer and privacy-principal policy prove the concrete shape.
  return event.type.startsWith('mirror.');
}

/**
 * Attribute every portfolio-content webhook from authoritative state. Callers
 * run this after taking the recipient account lock, so a queued event cannot
 * outlive E4 move-in and disclose content from the new locked stub.
 */
export async function isVaultedPortfolioContentEventAllowed(
  event: DomainEvent,
  subjects: VaultedPortfolioWebhookSubjects,
): Promise<boolean> {
  const portfolioId = portfolioIdForPortfolioContentEvent(event);
  if (portfolioId) {
    const subject = await subjects.portfolioSubject(portfolioId);
    return subject.exists && subject.vaultId === null;
  }

  if (event.type === 'dividend.event') {
    return (await subjects.userHasPlainHolding?.(event.userId, event.assetId)) ?? false;
  }

  if (event.type === 'standing_order.skipped') {
    const subject = await subjects.standingOrderPortfolio?.(event.userId, event.standingOrderId);
    return Boolean(subject?.exists && subject.userId === event.userId && subject.vaultId === null);
  }

  if (event.type === 'budget.exceeded') {
    const subject = await subjects.cashBudgetPortfolio?.(event.userId, event.budgetId);
    if (subject?.exists) {
      return subject.userId === event.userId && subject.vaultId === null;
    }
    // Events queued before cash fusion name an account-common expense budget
    // and intentionally carry no portfolioId. Preserve that legacy kept path,
    // but deny an unknown id (including a cash budget purged by E4).
    return (await subjects.legacyExpenseBudgetExists?.(event.userId, event.budgetId)) ?? false;
  }

  if (isMirrorNotificationEvent(event)) {
    const principalUserIds = [
      event.userId,
      ...(event.actorId ? [event.actorId] : []),
      ...(event.ownerId ? [event.ownerId] : []),
      ...event.subjectUserIds,
    ];
    const memberPortfolios = await subjects.mirrorMemberPortfolios?.(event.chainId, [
      ...new Set(principalUserIds),
    ]);
    if (!memberPortfolios || memberPortfolios.length === 0) return false;
    return memberPortfolios.every(
      ({ memberUserId, memberPortfolioId, portfolio }) =>
        memberPortfolioId !== null &&
        portfolio.exists &&
        portfolio.userId === memberUserId &&
        portfolio.vaultId === null,
    );
  }

  return true;
}
