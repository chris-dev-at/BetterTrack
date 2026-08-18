/**
 * Declarative paranoid-mode enforcement inventory AND its executable
 * composition (#907 built the inventory, #884 wired the guards onto it).
 *
 * The inventory half is still the single source of truth: the completeness
 * harness proves every mounted route, callable context method and registered
 * job carries exactly one policy, and the composition half below consumes those
 * same arrays — there is no second hand-maintained kill list. Dependencies stay
 * limited to the contract taxonomy, narrow enforcement helpers and types so the
 * data remains readable without dragging in a service graph.
 */

import type { RequestHandler } from 'express';

import {
  PARANOID_KILLED_WEBHOOK_EVENT_TYPES,
  type ApiKeyScope,
  type ParanoidKilledCapability,
} from '@bettertrack/contracts';

import type { DomainEvent } from '../../events';
import { ApiError, forbidden, notFound } from '../../errors';
import { normalizeRoutePath } from '../security/routePath';

/** Stable error code for every server-side surface killed in paranoid mode. */
export const PARANOID_MODE_ERROR_CODE = 'PARANOID_MODE' as const;

/**
 * Vaults v2 (`docs/VAULTS_V2_DESIGN.md` §3): the capabilities that are ALSO
 * killed for a single VAULTED PORTFOLIO on an otherwise normal account.
 *
 * The account-level rails stay exactly as they are — this set only widens the
 * SUBJECT of an already-declared capability from "the account is paranoid" to
 * "the account is paranoid OR this portfolio lives in a vault". It applies to
 * every registry binding whose subject is a portfolio id, so a new
 * portfolio-scoped binding inherits it without a second registration.
 *
 * Membership rationale, capability by capability:
 * - `portfolioServer`  — the portfolio's cleartext rows were purged at join;
 *                        a server read would answer an honest-looking zero.
 * - `portfolioJobs`    — snapshot/scan jobs would recompute over that void.
 * - `sharing`          — there is nothing to share and a share would leak the
 *                        portfolio's existence and name.
 * - `mirrorchain`      — replication writes ledger rows; join already refuses
 *                        while a membership is active, this holds the reverse.
 * - `imports`          — a broker import is server-side parsing of money data.
 * - `standingOrderExecution` — the server cannot book into a vaulted ledger.
 *
 * NOT in this set: `publicProfile` and `portfolioApiScope` are account-wide
 * decisions with no portfolio subject, and `portfolioWebhooks` is filtered by
 * event subject rather than by a portfolio-id argument.
 */
export const PARANOID_PORTFOLIO_SCOPED_CAPABILITIES: ReadonlySet<ParanoidKilledCapability> =
  new Set([
    'portfolioServer',
    'portfolioJobs',
    'sharing',
    'mirrorchain',
    'imports',
    'standingOrderExecution',
  ]);

/** Whether a vaulted portfolio kills this capability even on a normal account. */
export function isVaultedPortfolioKilledCapability(capability: ParanoidKilledCapability): boolean {
  return PARANOID_PORTFOLIO_SCOPED_CAPABILITIES.has(capability);
}

export interface ParanoidSurfaceSource {
  readonly file: string;
  readonly symbol: string;
}

export interface ParanoidRouteSurface {
  readonly kind: 'route';
  readonly source: ParanoidSurfaceSource;
  readonly method: string;
  /**
   * API-relative under `/api/v1` (for example `/portfolios/{portfolioId}`),
   * or root-relative for endpoints mounted outside that prefix.
   */
  readonly path: string;
}

/** Synthetic method identity for an explicit-path opaque `app.use` leaf mount. */
export const PARANOID_OPAQUE_MOUNT_METHOD = '<opaque-mount>';

/** Synthetic method identity for an `app.all`/`router.all` route. */
export const PARANOID_ALL_METHODS_ROUTE_METHOD = '<all-methods>';

export interface ParanoidServiceSurface {
  readonly kind: 'service';
  readonly source: ParanoidSurfaceSource;
  readonly service: string;
  readonly method: string;
}

/** Synthetic method identity used when an AppContext field is directly callable. */
export const PARANOID_DIRECT_SERVICE_CALL = '<call>';

export interface ParanoidJobSurface {
  readonly kind: 'job';
  readonly source: ParanoidSurfaceSource;
  readonly name: string;
}

/** A named internal account path that needs a tracked temporary exception. */
export interface ParanoidInternalSurface {
  readonly kind: 'internal';
  readonly source: ParanoidSurfaceSource;
}

export type ParanoidSurface =
  | ParanoidRouteSurface
  | ParanoidServiceSurface
  | ParanoidJobSurface
  | ParanoidInternalSurface;

export interface ParanoidGuardedClassification {
  readonly disposition: 'guarded';
  readonly capability: ParanoidKilledCapability;
}

export interface ParanoidExemptClassification {
  readonly disposition: 'exempt';
  /** Why keeping this surface available does not expose server-side portfolio data. */
  readonly reason: string;
  /** Temporary exceptions remain visible to the follow-up that closes them. */
  readonly knownGapIssue?: 884;
  readonly knownGapId?: string;
}

export type ParanoidSurfaceClassification =
  | ParanoidGuardedClassification
  | ParanoidExemptClassification;

export interface ParanoidRouteRule {
  readonly method?: string;
  readonly exact?: string;
  readonly prefix?: string;
  readonly pattern?: RegExp;
  /** Required for exemptions that apply only to one known opaque handler. */
  readonly source?: ParanoidSurfaceSource;
}

export interface ParanoidExemptRouteRule extends ParanoidRouteRule {
  readonly reason: string;
}

export type ParanoidServiceSubject =
  | 'userIdFirst'
  | 'userIdFirstAndDynamicPrincipals'
  | 'userIdField'
  | 'portfolioIdFirst'
  | 'portfolioIdFirstAllowMissing'
  | 'assetIdFirst'
  | 'paranoidWebhookSubjects'
  | 'dynamicPrincipals'
  | 'intrinsic';

export type ParanoidSemanticCoverage =
  | 'accountMode'
  | 'dynamicPrincipals'
  | 'ownedAssetProvenance'
  | 'queuedPrincipals';

/** One executable proxy binding, applied by {@link guardRegisteredServices}. */
export interface ParanoidServiceBinding {
  readonly capability: ParanoidKilledCapability;
  readonly service: string;
  /** Exact method names, `*`, or a prefix glob such as `submit*`. */
  readonly methods: readonly string[];
  readonly subject: ParanoidServiceSubject;
  readonly action?: 'throw' | 'skip';
  readonly coverage?: readonly ParanoidSemanticCoverage[];
}

/** Explicit non-killed policy for a context service method. */
export interface ParanoidServiceExemption {
  readonly service: string;
  readonly methods: readonly string[];
  readonly handling: 'kept' | 'internallyFiltered' | 'dynamicPrincipals';
  readonly reason: string;
  readonly coverage?: readonly ParanoidSemanticCoverage[];
}

export type ParanoidJobMode =
  | 'kept'
  | 'internallyFiltered'
  | 'portfolio'
  | 'perUser'
  | 'serviceFiltered'
  | 'event';

export type ParanoidJobPolicy =
  | {
      readonly capability: ParanoidKilledCapability;
      readonly mode: ParanoidJobMode;
    }
  | {
      readonly capability: null;
      readonly mode: ParanoidJobMode;
      readonly reason: string;
      readonly knownGapId?: string;
    };

export interface ParanoidJobPolicyEntry {
  readonly surface: ParanoidJobSurface;
  readonly policy: ParanoidJobPolicy;
}

export interface ParanoidKillRegistryEntry {
  readonly capability: ParanoidKilledCapability;
  readonly routes: readonly ParanoidRouteRule[];
  readonly services: readonly ParanoidServiceBinding[];
  readonly scopes: readonly ApiKeyScope[];
  readonly jobs: readonly string[];
  readonly webhookEventTypes: readonly string[];
}

export interface ParanoidApiScopeClassification {
  readonly disposition: 'killed' | 'allowed';
  readonly reason: string;
}

export const PARANOID_ROUTE_TABLE_SOURCE: ParanoidSurfaceSource = {
  file: 'apps/api/src/app.ts',
  symbol: 'createApp',
};

export const PARANOID_ACCOUNT_CONTEXT_SOURCE: ParanoidSurfaceSource = {
  file: 'apps/api/src/http/context.ts',
  symbol: 'AppContext',
};

const serviceBinding = (
  capability: ParanoidKilledCapability,
  service: string,
  subject: ParanoidServiceSubject,
  methods: readonly string[],
  action?: 'throw' | 'skip',
  coverage?: readonly ParanoidSemanticCoverage[],
): ParanoidServiceBinding => ({
  capability,
  service,
  subject,
  methods,
  ...(action ? { action } : {}),
  ...(coverage ? { coverage } : {}),
});

const serviceExemption = (
  service: string,
  methods: readonly string[],
  handling: ParanoidServiceExemption['handling'],
  reason: string,
  coverage?: readonly ParanoidSemanticCoverage[],
): ParanoidServiceExemption => ({
  service,
  methods,
  handling,
  reason,
  ...(coverage ? { coverage } : {}),
});

/**
 * Executable below-HTTP bindings. The context composition root consumes this
 * array directly; there is no second hand-maintained method list. Exact/prefix
 * patterns are resolved against each real service object at startup, and a
 * dangling method aborts composition.
 */
export const PARANOID_SERVICE_BINDINGS: readonly ParanoidServiceBinding[] = [
  serviceBinding('publicProfile', 'social', 'intrinsic', [
    'getPublicProfile',
    'getPublicProfileItem',
  ]),
  serviceBinding('sharing', 'workboard', 'userIdFirst', ['getSharing', 'setSharing']),
  serviceBinding('sharing', 'conglomerate', 'userIdFirst', ['updateWithVisibility']),
  serviceBinding('sharing', 'ideas', 'userIdFirst', ['clone']),
  serviceBinding('sharing', 'backtest', 'userIdFirst', ['runSharedSandboxPreview']),
  serviceBinding('sharing', 'comments', 'userIdFirst', ['*']),
  serviceBinding('sharing', 'alerts', 'userIdFirst', ['getSharing', 'setSharing']),
  serviceBinding('sharing', 'social', 'userIdFirst', [
    'listGroups',
    'createGroup',
    'renameGroup',
    'deleteGroup',
    'addGroupMember',
    'removeGroupMember',
    'followUser',
    'unfollowUser',
    'updateFollow',
    'unfollowItem',
    'listItemFollows',
    'listMyShared',
    'getAudience',
    'setAudience',
    'applyAudienceVisibility',
  ]),
  serviceBinding('sharing', 'social', 'intrinsic', ['getByPublicLink']),
  serviceBinding('mirrorchain', 'mirror', 'userIdFirst', [
    'enrichPortfolioSummaries',
    'convertToChain',
    'createChain',
    'convertChain',
    'declineInvite',
    'revokeInvite',
  ]),
  serviceBinding(
    'mirrorchain',
    'mirror',
    'dynamicPrincipals',
    [
      'listChainsForUser',
      'getMemberList',
      'getActivity',
      'listInvites',
      'setMemberRole',
      'transferOwnership',
      'removeMember',
      'leaveChain',
      'renameChain',
      'dissolveChain',
    ],
    undefined,
    ['dynamicPrincipals'],
  ),
  serviceBinding(
    'mirrorchain',
    'mirror',
    'userIdFirstAndDynamicPrincipals',
    ['submit*'],
    undefined,
    ['dynamicPrincipals'],
  ),
  serviceBinding('mirrorchain', 'mirror', 'portfolioIdFirstAllowMissing', [
    'syncedMembership',
    'overlayForPortfolio',
  ]),
  serviceBinding('portfolioServer', 'portfolio', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'customAssets', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'analytics', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'portfolioMarketIntel', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'marketIntel', 'userIdFirst', ['newsDigest']),
  serviceBinding('portfolioServer', 'tax', 'userIdFirst', [
    'getSettings',
    'updateSettings',
    'getEffectiveSettings',
    'getPortfolioTaxSettings',
    'setPortfolioTaxOverride',
    'clearPortfolioTaxOverride',
    'planTransactionDeleteCorrections',
    'recordDividend',
    'listDividends',
    'deleteDividend',
    'getYearReports',
    'getYearReport',
  ]),
  serviceBinding('portfolioServer', 'tax', 'userIdField', ['planTransactionTaxes']),
  // The Home board is UI configuration, but its widget settings carry portfolio
  // ids, asset ids and the captured asset LABEL (a ticker). Storing that on the
  // server for an account whose portfolio exists only in the client-encrypted
  // vault is exactly the leak this mode exists to prevent, so a paranoid account
  // keeps its board on the device instead of on the account.
  serviceBinding('portfolioServer', 'homeLayout', 'userIdFirst', ['*']),
  // The per-namespace widget compositions (mobile board #68 item 3) are the same
  // document class as the Home board and carry the same content — a composition
  // names the portfolios and assets it renders. The server cannot even inspect
  // this one (it is opaque by contract), which makes it strictly less safe to
  // keep, not more: an opaque document must be assumed to hold everything the
  // board it replaces holds. So a paranoid account keeps its widget layouts on
  // the device, exactly as it keeps its Home board there.
  serviceBinding('portfolioServer', 'widgetLayouts', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'expenses', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'expenseBudgets', 'userIdFirst', ['*']),
  // V5 cash fusion: classification ON the portfolio cash ledger, so it dies with
  // the same capability the ledger does. Auto-tagging itself needs no binding —
  // it runs inside the movement INSERT (see `data/repositories/cashSystemTagStamp`),
  // which the ledger's own capability already governs.
  serviceBinding('portfolioServer', 'cashTags', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'cashBudgets', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'aiFeatures', 'userIdFirst', ['insights']),
  serviceBinding('portfolioServer', 'snapshots', 'portfolioIdFirst', [
    'getSeries',
    'getOverlays',
    'invalidate',
    'getStateUpdatedAt',
    'recompute',
  ]),
  serviceBinding('portfolioServer', 'snapshots', 'assetIdFirst', [
    'resolveAssetReferences',
    'invalidateForAsset',
  ]),
  serviceBinding('imports', 'imports', 'userIdFirst', [
    'createBatch',
    'getBatch',
    'applyBatch',
    'discardBatch',
  ]),
  serviceBinding('imports', 'expenseImports', 'userIdFirst', ['preview', 'apply']),
  serviceBinding('standingOrderExecution', 'standingOrders', 'userIdFirst', [
    'list',
    'listRuns',
    'get',
    'create',
    'update',
    'pause',
    'resume',
    'remove',
    'skipDuePeriodsForPortfolioRestore',
    'rollbackSkippedPeriodsForPortfolioRestore',
  ]),
  serviceBinding(
    'portfolioWebhooks',
    'webhookBridge',
    'paranoidWebhookSubjects',
    ['handleEvent'],
    'skip',
  ),
] as const;

/**
 * Explicit non-killed policy for every mixed service above. `reason` is
 * deliberately mandatory: "not guarded" is never an implicit default.
 */
export const PARANOID_SERVICE_EXEMPTIONS: readonly ParanoidServiceExemption[] = [
  serviceExemption(
    'conglomerate',
    ['create', 'remove'],
    'kept',
    'A fresh basket has no constituents and delete surfaces no asset row, so neither can carry the owner custom-asset provenance.',
  ),
  serviceExemption(
    'taxYearLock',
    ['*'],
    'kept',
    'Tax-year lock state (§16 2026-08-07) is account-level POLICY about server-mode tax data and stores only year numbers — no portfolio content to leak. Its whole HTTP surface (/settings/taxes/years*) is killed for paranoid accounts by the portfolioServer route rules above, and the guard methods only ever execute inside portfolio/tax service entry points that are themselves killed for paranoid accounts.',
  ),
  serviceExemption(
    'conglomerate',
    ['list', 'get', 'update', 'replacePositions', 'activate', 'resolved', 'allocate'],
    'internallyFiltered',
    'Private baskets stay usable, but a CONSTITUENT may be the account own custom asset; every branch that would surface, embed or price one is scoped to global market assets under the caller transition lock.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'workboard',
    ['removeItem', 'reorder', 'createWatchlist', 'deleteWatchlist'],
    'kept',
    'Local workboard organization remains available and does not expose server-side portfolio values.',
  ),
  serviceExemption(
    'workboard',
    ['list', 'listInWatchlist', 'listWatchlists', 'addItem', 'renameWatchlist'],
    'internallyFiltered',
    'The service filters account-owned asset provenance before returning or accepting workboard rows.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'workboard',
    ['itemsForSharedView'],
    'internallyFiltered',
    'Shared-view discovery resolves its audience principals before exposing any item.',
    ['dynamicPrincipals', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'ideas',
    ['list', 'get', 'create', 'update', 'remove'],
    'kept',
    'Ideas stay private local notes.',
  ),
  serviceExemption(
    'backtest',
    ['runPreview', 'runComparison'],
    'internallyFiltered',
    'Draft backtests resolve only allowed assets and never require a server portfolio read.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  // The social service is deliberately split three ways rather than carrying one
  // blanket `internallyFiltered` claim: friendship and the caller's own profile
  // read are plain repository passthroughs that filter nothing, and declaring a
  // `dynamicPrincipals` coverage for them would be a label without an
  // implementation — the same hole the `ownedAssetProvenance` probe set closes.
  serviceExemption(
    'social',
    [
      'sendRequest',
      'listRequests',
      'accept',
      'decline',
      'cancel',
      'listFriends',
      'removeFriend',
      'getProfileSettings',
    ],
    'kept',
    'Friendship lifecycle and the caller own profile settings are kept surfaces holding no server-side portfolio content; they perform no filtering and claim none.',
  ),
  serviceExemption(
    'social',
    [
      'followItem',
      'listFollowing',
      'listFollowers',
      'setActivityAlert',
      'listSharedWithMe',
      'getSharedPortfolio',
      'getSharedConglomerate',
      'getSharedWatchlist',
    ],
    'internallyFiltered',
    'These reads and item follows resolve the affected owner/counterpart principals under their locks and preserve no-leak behavior for unavailable content.',
    ['dynamicPrincipals'],
  ),
  serviceExemption(
    'social',
    ['updateProfileSettings'],
    'internallyFiltered',
    'A public opt-in holds the caller own account transition lock through the final write, so an update started before enable cannot republish after it commits.',
    ['accountMode'],
  ),
  serviceExemption(
    'mirror',
    [
      'attachMemberCopy',
      'inviteMember',
      'acceptInvite',
      'replicateChain',
      'notifyChainStalled',
      'handleAccountDeletion',
      'runConsistencySweep',
    ],
    'dynamicPrincipals',
    'Membership lifecycle work resolves every affected chain principal before applying its action.',
    ['dynamicPrincipals', 'queuedPrincipals'],
  ),
  serviceExemption(
    'assets',
    ['*'],
    'internallyFiltered',
    'Asset reads enforce global-or-owned asset provenance and hide foreign custom assets.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'search',
    ['search', 'searchWithFreshness', 'catalogFreshness'],
    'internallyFiltered',
    'Search and freshness reads filter custom-asset provenance before returning a result.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'search',
    ['enrichmentSettled'],
    'kept',
    'The enrichment wait primitive carries no account or portfolio content.',
  ),
  serviceExemption(
    'marketIntel',
    ['capabilities', 'dividends', 'earnings', 'news', 'splits', 'earningsCalendar', 'fundamentals'],
    'internallyFiltered',
    'Market-intelligence reads scope each asset to global-or-owned provenance before querying providers.',
    ['accountMode', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'chat',
    ['openConversation', 'listConversations', 'markRead'],
    'kept',
    'Private chat metadata remains separate from portfolio data.',
  ),
  serviceExemption(
    'chat',
    ['getThread', 'sendMessage'],
    'internallyFiltered',
    'Thread access resolves both conversation principals before it reads or writes a message.',
    ['dynamicPrincipals', 'ownedAssetProvenance'],
  ),
  serviceExemption(
    'aiFeatures',
    ['conglomerateDraft'],
    'kept',
    'The NL builder produces a reviewed draft from catalog search rather than reading a server portfolio.',
  ),
  serviceExemption(
    'snapshots',
    ['recomputeAll'],
    'internallyFiltered',
    'The bulk snapshot repair skips paranoid accounts before it materializes a portfolio series.',
    ['accountMode'],
  ),
  serviceExemption(
    'imports',
    ['listBrokers'],
    'kept',
    'Available broker mapper metadata contains no user data.',
  ),
  serviceExemption(
    'expenseImports',
    ['listBanks'],
    'kept',
    'Available bank mapper metadata contains no user data.',
  ),
  serviceExemption(
    'alerts',
    ['remove'],
    'kept',
    'Deleting an existing alert does not read or create server-side portfolio content.',
  ),
  serviceExemption(
    'alerts',
    ['list', 'create', 'update', 'rearm'],
    'internallyFiltered',
    'Alert operations resolve asset provenance and affected followers before returning or mutating data.',
    ['accountMode', 'ownedAssetProvenance', 'dynamicPrincipals'],
  ),
  serviceExemption(
    'standingOrders',
    ['processDueOrders'],
    'internallyFiltered',
    'The scheduler skips accounts whose privacy mode forbids server-side portfolio execution.',
    ['accountMode'],
  ),
] as const;

/**
 * The remainder of the callable AppContext is deliberately enumerated too.
 * These are not §8 portfolio rails, but making every one explicit means a new
 * context service cannot silently bypass the completeness gate.
 */
export const PARANOID_CONTEXT_SERVICE_EXEMPTIONS: readonly ParanoidServiceExemption[] = [
  serviceExemption(
    'redis',
    ['*'],
    'kept',
    'Infrastructure Redis client; it has no account-facing policy of its own.',
  ),
  serviceExemption(
    'logger',
    ['*'],
    'kept',
    'Process logging infrastructure; it does not expose account content.',
  ),
  serviceExemption(
    'auth',
    ['*'],
    'kept',
    'Authentication, sessions, and recovery remain available to a paranoid account.',
  ),
  serviceExemption(
    'google',
    ['*'],
    'kept',
    'Identity-provider linking is account security metadata, not portfolio data.',
  ),
  serviceExemption(
    'twoFactor',
    ['*'],
    'kept',
    'Two-factor enrollment and verification remain available for account security.',
  ),
  serviceExemption(
    'passkeys',
    ['*'],
    'kept',
    'Passkey management is authentication material, not portfolio content.',
  ),
  serviceExemption(
    'adminTwoFactor',
    ['*'],
    'kept',
    'Administrator assurance is an admin-security rail, not a user portfolio rail.',
  ),
  serviceExemption(
    'admin',
    ['*'],
    'kept',
    'Administrator operations are independently authorized and do not run as a user portfolio surface.',
  ),
  serviceExemption(
    'apiKeys',
    ['*'],
    'kept',
    'API-key governance is credential management; portfolio scopes are classified separately.',
  ),
  serviceExemption(
    'oauth',
    ['*'],
    'kept',
    'OAuth client and grant lifecycle is credential management; portfolio scopes are classified separately.',
  ),
  serviceExemption(
    'feedback',
    ['*'],
    'kept',
    'Voluntary user feedback and bounded client diagnostics remain available without reading or deriving server portfolio data.',
  ),
  serviceExemption(
    'marketData',
    ['*'],
    'kept',
    'Provider/cache primitives operate on public market references, not account portfolio rows.',
  ),
  serviceExemption(
    'reauth',
    ['*'],
    'kept',
    'Generic session step-up verifies the caller’s own password and mints nothing. It reads no portfolio row, and paranoid-design §8 keeps the full auth stack — a paranoid account must be able to re-authenticate for the vault’s own QR handoff, which is precisely what this verifier gates.',
  ),
  serviceExemption(
    'paranoidVault',
    ['*'],
    'kept',
    'The opaque ciphertext vault is the deliberate paranoid-mode data home.',
  ),
  serviceExemption(
    'vaults',
    ['*'],
    'kept',
    'Vaults v2 (docs/VAULTS_V2_DESIGN.md §3): the multi-vault ciphertext store is the v2 paranoid data home, and every method is ownership-scoped in its repository. The server stores and returns ciphertext without ever parsing it, so no method can expose portfolio content; the join/leave transitions are additionally pinned to the owning browser session at the HTTP layer.',
  ),
  serviceExemption(
    'paranoidTransitions',
    ['*'],
    'kept',
    'The transition orchestrator owns the exclusive account lock and is the only path that changes privacy mode; enable, disable, and safe metadata reads must remain reachable for idempotent retries.',
  ),
  serviceExemption(
    'paranoidGuard',
    ['*'],
    'kept',
    'The transition guard IS the enforcement primitive every killed surface routes through; guarding it with itself would be circular.',
  ),
  serviceExemption(
    'webhooks',
    ['*'],
    'kept',
    'Webhook subscription metadata is separate from the event bridge that suppresses portfolio events.',
  ),
  serviceExemption(
    'notifications',
    ['*'],
    'kept',
    'Notification inbox and device settings remain available while server alerts continue to operate.',
  ),
  serviceExemption(
    'notificationSettings',
    ['*'],
    'kept',
    'Notification preferences are account metadata, not portfolio content.',
  ),
  serviceExemption(
    'telegramSetup',
    ['*'],
    'kept',
    'Telegram channel setup is account notification configuration.',
  ),
  serviceExemption(
    'discordSetup',
    ['*'],
    'kept',
    'Discord channel setup is account notification configuration.',
  ),
  serviceExemption(
    'accountSettings',
    ['*'],
    'kept',
    'Account defaults are profile metadata rather than portfolio content.',
  ),
  serviceExemption(
    'accountDeletion',
    ['*'],
    'kept',
    'A user must always be able to delete their account.',
  ),
  serviceExemption(
    'dataExport',
    ['*'],
    'kept',
    'Export lifecycle metadata stays available; payload policy is handled by the paranoid vault/export flow.',
  ),
  serviceExemption(
    'announcements',
    ['*'],
    'kept',
    'Announcement delivery is global product communication, not portfolio data.',
  ),
  serviceExemption(
    'notificationDispatcher',
    ['*'],
    'kept',
    'Notification delivery infrastructure is independent of the portfolio rails it receives.',
  ),
  serviceExemption(
    'digestService',
    ['*'],
    'kept',
    'Digest scheduling is delivery infrastructure; portfolio-producing jobs are classified separately.',
  ),
  serviceExemption(
    'notify',
    ['*'],
    'kept',
    'The notification entry point is transport infrastructure, not a portfolio read surface.',
  ),
  serviceExemption(
    'presence',
    ['*'],
    'kept',
    'Presence is transient UI metadata and contains no portfolio data.',
  ),
  serviceExemption(
    'realtime',
    ['*'],
    'kept',
    'Gateway lifecycle methods are transport infrastructure; room authorization has its own tracked gap below.',
  ),
  serviceExemption(
    'liveMode',
    ['*'],
    'kept',
    'Live quote polling is market-data transport over allowed assets, not a portfolio read surface.',
  ),
  serviceExemption(
    'events',
    ['*'],
    'kept',
    'The typed event bus is process infrastructure; event payload policies are classified separately.',
  ),
  serviceExemption(
    'idempotency',
    ['*'],
    'kept',
    'Idempotency bookkeeping is transient request infrastructure.',
  ),
  serviceExemption(
    'queues',
    ['*'],
    'kept',
    'The BullMQ queue registry is producer infrastructure; each queued portfolio operation has its own policy.',
  ),
  serviceExemption(
    'observability',
    ['*'],
    'kept',
    'Observability is operator infrastructure and does not expose user portfolio content.',
  ),
  serviceExemption(
    'health',
    ['*'],
    'kept',
    'Health checks are operational diagnostics, not portfolio data.',
  ),
  serviceExemption(
    'readiness',
    ['*'],
    'kept',
    'Readiness checks are dependency diagnostics, not portfolio data.',
  ),
  serviceExemption(
    'problems',
    ['*'],
    'kept',
    'Problems-page capture is operational diagnostics, not a user portfolio rail.',
  ),
  serviceExemption('monitoring', ['*'], 'kept', 'Monitoring controls are operator infrastructure.'),
  serviceExemption(
    'usageAnalytics',
    ['*'],
    'kept',
    'Usage analytics is first-party aggregate telemetry, not portfolio content.',
  ),
  serviceExemption(
    'featureFlags',
    ['*'],
    'kept',
    'Feature-flag evaluation is runtime configuration infrastructure.',
  ),
  serviceExemption(
    'ai',
    ['*'],
    'kept',
    'AI provider controls are capability/configuration plumbing; user portfolio insight calls are classified on aiFeatures.',
  ),
] as const;

const jobPolicy = (
  file: string,
  symbol: string,
  name: string,
  policy: ParanoidJobPolicy,
): ParanoidJobPolicyEntry => ({
  surface: {
    kind: 'job',
    source: {
      file: `apps/api/src/jobs/definitions/${file}`,
      symbol,
    },
    name,
  },
  policy,
});

/**
 * Every production registration must declare its paranoid-mode handling by
 * concrete definition source as well as queue name. A replacement handler on
 * an existing queue is therefore a new, unclassified candidate.
 */
export const PARANOID_JOB_POLICIES: readonly ParanoidJobPolicyEntry[] = [
  jobPolicy('heartbeat.ts', 'heartbeatJob', 'system.heartbeat', {
    capability: null,
    mode: 'kept',
    reason: 'The heartbeat is deployment-health infrastructure.',
  }),
  jobPolicy('marketDataJobs.ts', 'createPricesRefreshDailyJob', 'prices.refreshDaily', {
    capability: null,
    mode: 'kept',
    reason: 'Global market-price refresh has no account-owned input.',
  }),
  jobPolicy('marketDataJobs.ts', 'createPricesBackfillJob', 'prices.backfill', {
    capability: null,
    mode: 'kept',
    reason: 'Global market-history backfill has no account-owned input.',
  }),
  jobPolicy('marketDataJobs.ts', 'createFxRefreshSpotJob', 'fx.refreshSpot', {
    capability: null,
    mode: 'kept',
    reason: 'Global FX refresh has no account-owned input.',
  }),
  // Known gap #884: custom-asset alerts are still enumerated by the evaluator.
  // Keep this explicit temporary exemption visible until #884 adds the guard.
  jobPolicy('alertsJob.ts', 'createAlertsEvaluateJob', 'alerts.evaluate', {
    capability: null,
    mode: 'internallyFiltered',
    reason:
      'The queue survives paranoid mode: the handler splits itself into an unguarded global-asset rail and a per-owner custom-asset rail that runs inside the owning account transition lock. The binding is the executable proof that filtering exists.',
  }),
  jobPolicy('notificationsJob.ts', 'createNotificationsDispatchJob', 'notifications.dispatch', {
    capability: null,
    mode: 'kept',
    reason:
      'Notification delivery is transport infrastructure; event ownership is handled at its producer.',
  }),
  jobPolicy('digestJobs.ts', 'createDigestDailyJob', 'notifications.digestDaily', {
    capability: null,
    mode: 'kept',
    reason:
      'Digest delivery is notification transport; portfolio-producing jobs are classified separately.',
  }),
  jobPolicy('digestJobs.ts', 'createDigestWeeklyJob', 'notifications.digestWeekly', {
    capability: null,
    mode: 'kept',
    reason:
      'Digest delivery is notification transport; portfolio-producing jobs are classified separately.',
  }),
  jobPolicy('digestJobs.ts', 'createDeferredDeliveryJob', 'notifications.deferredDelivery', {
    capability: null,
    mode: 'kept',
    reason: 'Deferred delivery only releases already-classified notifications.',
  }),
  jobPolicy('exportJobs.ts', 'createExportBuildJob', 'data.export', {
    capability: null,
    mode: 'kept',
    reason: 'Export job metadata is handled by the vault/export protocol.',
  }),
  jobPolicy('exportJobs.ts', 'createExportCleanupJob', 'data.exportCleanup', {
    capability: null,
    mode: 'kept',
    reason: 'Expired export cleanup is retention infrastructure.',
  }),
  jobPolicy('snapshotJobs.ts', 'createSnapshotsRecomputeJob', 'snapshots.recompute', {
    capability: 'portfolioJobs',
    mode: 'portfolio',
  }),
  jobPolicy('snapshotJobs.ts', 'createSnapshotsBackfillJob', 'snapshots.backfill', {
    capability: 'portfolioJobs',
    mode: 'serviceFiltered',
  }),
  jobPolicy('usageAnalyticsJobs.ts', 'createUsageRollupJob', 'usage.rollup', {
    capability: null,
    mode: 'kept',
    reason:
      'The rollup writes `usage_daily`, keyed (day, feature) across ALL accounts — ' +
      'no user id, no asset id — so it is aggregate telemetry, not portfolio ' +
      'content. Note the narrower claim (PR #1344): the RAW `usage_events` rows it ' +
      'reads were portfolio-identifying, one per (user, feature, asset, day), and a ' +
      'paranoid client prices every holding itself — which is why that table is ' +
      '`purge`-classified and a paranoid account has no rows here to aggregate.',
  }),
  jobPolicy('earningsReminderJob.ts', 'createEarningsReminderJob', 'notifications.earningsRemind', {
    capability: 'portfolioJobs',
    mode: 'perUser',
  }),
  jobPolicy('dividendEventsJob.ts', 'createDividendEventsScanJob', 'marketIntel.dividendScan', {
    capability: 'portfolioJobs',
    mode: 'perUser',
  }),
  jobPolicy('standingOrdersJob.ts', 'createStandingOrdersJob', 'standingOrders.process', {
    capability: 'standingOrderExecution',
    mode: 'perUser',
  }),
  jobPolicy('mirrorJobs.ts', 'createMirrorReplicateJob', 'mirror.replicate', {
    capability: 'mirrorchain',
    mode: 'serviceFiltered',
  }),
  jobPolicy('mirrorJobs.ts', 'createMirrorInviteCleanupJob', 'mirror.inviteCleanup', {
    capability: null,
    mode: 'kept',
    reason: 'Expired invite cleanup only removes stale security tokens.',
  }),
  jobPolicy('mirrorJobs.ts', 'createMirrorConsistencySweepJob', 'mirror.consistencySweep', {
    capability: 'mirrorchain',
    mode: 'serviceFiltered',
  }),
  jobPolicy('webhookJobs.ts', 'createWebhookDeliverJob', 'webhooks.deliver', {
    capability: 'portfolioWebhooks',
    mode: 'event',
  }),
  jobPolicy('webhookJobs.ts', 'createWebhookDeliveryCleanupJob', 'webhooks.deliveryCleanup', {
    capability: null,
    mode: 'kept',
    reason: 'Webhook delivery-log cleanup is retention infrastructure.',
  }),
  jobPolicy('apiKeyJobs.ts', 'createApiKeyRequestLogCleanupJob', 'apiKeys.requestLogCleanup', {
    capability: null,
    mode: 'kept',
    reason: 'API-key audit-log cleanup is retention infrastructure.',
  }),
  jobPolicy('retentionJobs.ts', 'createDataRetentionCleanupJob', 'data.retentionCleanup', {
    capability: null,
    mode: 'kept',
    reason: 'Audit and email-log cleanup is global retention infrastructure.',
  }),
] as const;

const servicesFor = (capability: ParanoidKilledCapability): readonly ParanoidServiceBinding[] =>
  PARANOID_SERVICE_BINDINGS.filter((binding) => binding.capability === capability);

const jobsFor = (capability: ParanoidKilledCapability): readonly string[] =>
  PARANOID_JOB_POLICIES.filter((entry) => entry.policy.capability === capability).map(
    (entry) => entry.surface.name,
  );

/**
 * The typed §8 kill registry. It is intentionally declarative in this issue;
 * #884 will consume it to mount the actual route/service/job enforcement.
 */
export const PARANOID_KILL_REGISTRY: readonly ParanoidKillRegistryEntry[] = [
  {
    capability: 'publicProfile',
    routes: [{ prefix: '/social/profiles/' }],
    services: servicesFor('publicProfile'),
    scopes: [],
    jobs: jobsFor('publicProfile'),
    webhookEventTypes: [],
  },
  {
    capability: 'sharing',
    routes: [
      { prefix: '/social/links/' },
      { exact: '/social/groups' },
      { prefix: '/social/groups/' },
      { exact: '/social/follows' },
      { prefix: '/social/follows/' },
      { exact: '/social/followers' },
      { exact: '/social/item-follows' },
      { prefix: '/social/item-follows/' },
      { exact: '/social/shared' },
      { prefix: '/social/shared/' },
      { exact: '/social/my-shared' },
      { prefix: '/social/audience/' },
      { prefix: '/social/items/' },
      { prefix: '/social/comments/' },
      { exact: '/alerts/sharing' },
      { exact: '/workboard/sharing' },
      { pattern: /^\/ideas\/[^/]+\/clone$/ },
      { prefix: '/backtest/shared/' },
    ],
    services: servicesFor('sharing'),
    scopes: [],
    jobs: jobsFor('sharing'),
    webhookEventTypes: [],
  },
  {
    capability: 'mirrorchain',
    routes: [{ prefix: '/mirrorchain/' }],
    services: servicesFor('mirrorchain'),
    scopes: [],
    jobs: jobsFor('mirrorchain'),
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioServer',
    routes: [
      { exact: '/portfolios' },
      { prefix: '/portfolios/' },
      { exact: '/custom-assets' },
      { prefix: '/custom-assets/' },
      { prefix: '/analytics/' },
      { prefix: '/expenses/categories' },
      { prefix: '/expenses/transactions' },
      { prefix: '/expenses/rules' },
      { prefix: '/expenses/summary' },
      { prefix: '/expenses/trends' },
      { prefix: '/expenses/budgets' },
      // V5 cash fusion: classification ON the portfolio cash ledger, so it
      // belongs to the same capability the ledger itself does. Enumerated by
      // family (not a bare `/cash` prefix) so a later endpoint under it cannot
      // fall through to an implicit allow.
      { prefix: '/cash/tags' },
      { prefix: '/cash/movements/' },
      { prefix: '/cash/budgets' },
      { prefix: '/cash/rules' },
      { prefix: '/cash/summary' },
      { prefix: '/cash/trends' },
      { exact: '/assets/portfolio/dividend-calendar' },
      { exact: '/assets/portfolio/dividend-projection' },
      { exact: '/assets/portfolio/news-digest' },
      { method: 'POST', exact: '/ai/insights' },
      { exact: '/settings/taxes' },
      // Tax year locking (§16 2026-08-07): the lock state + unlock/relock
      // ritual govern SERVER-side tax data, which a paranoid account does not
      // have — same capability, fail closed like the settings above.
      { exact: '/settings/taxes/years' },
      { prefix: '/settings/taxes/years/' },
      { exact: '/settings/home' },
      // Every namespace of the widget-composition surface, by prefix: a client
      // surface added later inherits the kill instead of quietly opening a new
      // cleartext channel for the same content.
      { prefix: '/settings/widget-layout/' },
    ],
    services: servicesFor('portfolioServer'),
    scopes: [],
    jobs: jobsFor('portfolioServer'),
    webhookEventTypes: [],
  },
  {
    capability: 'imports',
    routes: [{ exact: '/imports' }, { prefix: '/imports/' }, { prefix: '/expenses/import/' }],
    services: servicesFor('imports'),
    scopes: [],
    jobs: jobsFor('imports'),
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioApiScope',
    routes: [],
    services: servicesFor('portfolioApiScope'),
    scopes: [
      'portfolio:read',
      'portfolio:write',
      'cash:read',
      'cash:write',
      'mirrorchain:read',
      'mirrorchain:write',
    ],
    jobs: jobsFor('portfolioApiScope'),
    webhookEventTypes: [],
  },
  {
    capability: 'standingOrderExecution',
    routes: [{ exact: '/standing-orders' }, { prefix: '/standing-orders/' }],
    services: servicesFor('standingOrderExecution'),
    scopes: [],
    jobs: jobsFor('standingOrderExecution'),
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioJobs',
    routes: [],
    services: servicesFor('portfolioJobs'),
    scopes: [],
    jobs: jobsFor('portfolioJobs'),
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioWebhooks',
    routes: [],
    services: servicesFor('portfolioWebhooks'),
    scopes: [],
    jobs: jobsFor('portfolioWebhooks'),
    // `portfolio.changed` is an internal domain event, not a subscribable
    // contract event; every subscribable decision comes from the exhaustive
    // contracts policy instead of a second registry list.
    webhookEventTypes: ['portfolio.changed', ...PARANOID_KILLED_WEBHOOK_EVENT_TYPES],
  },
] as const;

const keptRoutes = (
  reason: string,
  rules: readonly ParanoidRouteRule[],
): readonly ParanoidExemptRouteRule[] => rules.map((rule) => ({ ...rule, reason }));

const productionOpaqueRoute = ({
  mountedPath,
  normalizedPath,
  handler,
  occurrence = 1,
}: {
  readonly mountedPath: string;
  readonly normalizedPath: string;
  readonly handler: string;
  readonly occurrence?: number;
}): ParanoidRouteRule => ({
  method: PARANOID_OPAQUE_MOUNT_METHOD,
  exact: normalizedPath,
  source: {
    ...PARANOID_ROUTE_TABLE_SOURCE,
    symbol: `${PARANOID_ROUTE_TABLE_SOURCE.symbol}.${handler}[${occurrence}]@${mountedPath}`,
  },
});

/**
 * Explicit kept route classification. Mixed routers enumerate their allowed
 * families so a newly mounted endpoint cannot fall through to an implicit allow.
 */
export const PARANOID_KEPT_ROUTE_RULES: readonly ParanoidExemptRouteRule[] = [
  ...keptRoutes(
    'These origin-root opaque mounts are the known instrumentation, browser-security, parsing, and terminal error middleware; concrete operations are classified separately.',
    [
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: '<anonymous>',
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: 'helmetMiddleware',
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: '<anonymous>',
        occurrence: 2,
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: 'jsonParser',
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: 'cookieParser',
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: '<anonymous>',
        occurrence: 3,
      }),
      productionOpaqueRoute({
        mountedPath: '/',
        normalizedPath: '/',
        handler: '<anonymous>',
        occurrence: 4,
      }),
    ],
  ),
  ...keptRoutes(
    'These API-root opaque mounts are the known authentication, audit, rate-limit, request-policy and paranoid-capability middleware; concrete operations are classified separately.',
    [
      // Ten now: #884 added the registry-driven paranoid route guard
      // ({@link createParanoidRouteGuard}) after the request-policy middleware,
      // and Vaults v2 adds its PORTFOLIO-scoped counterpart
      // ({@link createVaultedPortfolioRouteGuard}) immediately after that. Both
      // are the enforcement points for the killed route families below, so both
      // are themselves kept — a guard that killed its own mount would 403 every
      // request a paranoid account makes.
      ...Array.from({ length: 10 }, (_, index) =>
        productionOpaqueRoute({
          mountedPath: '/api/v1',
          normalizedPath: '/',
          handler: '<anonymous>',
          occurrence: index + 1,
        }),
      ),
      productionOpaqueRoute({
        mountedPath: '/api/v1',
        normalizedPath: '/',
        handler: 'enforcePasswordChange',
      }),
    ],
  ),
  ...keptRoutes(
    'These exact opaque mounts are the production session-admission middleware; concrete operations are classified separately.',
    [
      productionOpaqueRoute({
        mountedPath: '/api/v1/assets',
        normalizedPath: '/assets',
        handler: 'requireUser',
      }),
      productionOpaqueRoute({
        mountedPath: '/api/v1/assets',
        normalizedPath: '/assets',
        handler: 'requireUser',
        occurrence: 2,
      }),
      // V5 cash fusion: the expense area's write-retirement gate (410 on any
      // non-read verb) sits beside its `requireUser`, so `/expenses` carries a
      // second opaque mount. It only ever refuses requests.
      productionOpaqueRoute({
        mountedPath: '/api/v1/expenses',
        normalizedPath: '/expenses',
        handler: 'refuseRetiredExpenseWrite',
      }),
      ...[
        '/backtest',
        '/expenses',
        '/cash',
        '/analytics',
        '/social',
        '/mirrorchain',
        '/chat',
        '/ai',
        '/settings',
        '/oauth',
      ].map((normalizedPath) =>
        productionOpaqueRoute({
          mountedPath: `/api/v1${normalizedPath}`,
          normalizedPath,
          handler: 'requireUser',
        }),
      ),
    ],
  ),
  ...keptRoutes(
    'This exact opaque mount is the MIRRORCHAIN bearer participation allowlist; it only refuses unlisted bearer routes, while concrete mirrorchain operations remain classified separately.',
    [
      productionOpaqueRoute({
        mountedPath: '/api/v1/mirrorchain',
        normalizedPath: '/mirrorchain',
        handler: 'enforceMirrorchainBearerAllowlist',
      }),
    ],
  ),
  ...keptRoutes(
    'This exact opaque mount is the production chat feature gate; concrete chat operations are classified separately.',
    [
      productionOpaqueRoute({
        mountedPath: '/api/v1/chat',
        normalizedPath: '/chat',
        handler: '<anonymous>',
      }),
    ],
  ),
  ...keptRoutes('Public self-documenting API documentation contains no account data.', [
    { method: 'GET', exact: '/docs' },
    { method: 'GET', exact: '/openapi.json' },
  ]),
  ...keptRoutes('Public deployment metadata contains no account data.', [
    { exact: '/version' },
    { exact: '/health' },
    { exact: '/health/ready' },
    { exact: '/feature-flags' },
  ]),
  ...keptRoutes('Catalog search is provenance-filtered and has no server portfolio read.', [
    { exact: '/search' },
  ]),
  ...keptRoutes('Authentication and recovery remain available to a paranoid account.', [
    { prefix: '/auth/' },
  ]),
  ...keptRoutes('Account lifecycle and export metadata remain available.', [
    { exact: '/account' },
    { prefix: '/account/' },
  ]),
  ...keptRoutes('Administrator routes are independently authorized operational surfaces.', [
    { exact: '/admin' },
    { prefix: '/admin/' },
  ]),
  ...keptRoutes('OAuth credential lifecycle is separate from portfolio scopes.', [
    { prefix: '/oauth/' },
  ]),
  ...keptRoutes(
    'Conglomerate definitions are local configuration; sharing is classified separately.',
    [{ exact: '/conglomerates' }, { prefix: '/conglomerates/' }],
  ),
  ...keptRoutes('Private chat remains separate from server-side portfolio content.', [
    { exact: '/chat/conversations' },
    { prefix: '/chat/conversations/' },
  ]),
  ...keptRoutes('Notification inbox and device preferences remain available.', [
    { exact: '/notifications' },
    { prefix: '/notifications/' },
  ]),
  ...keptRoutes(
    'Authenticated feedback and its caller-owned status history contain no server portfolio data.',
    [{ exact: '/feedback' }, { exact: '/feedback/mine' }],
  ),
  ...keptRoutes('Alert CRUD is provenance-filtered; sharing settings are classified separately.', [
    { exact: '/alerts' },
    { pattern: /^\/alerts\/(?!sharing$)[^/]+(?:\/rearm)?$/ },
  ]),
  ...keptRoutes('The opaque ciphertext vault is the paranoid-mode data home.', [
    { exact: '/vault' },
    { prefix: '/vault/' },
  ]),
  // Vaults v2 (`docs/VAULTS_V2_DESIGN.md` §3). Same reasoning as `/vault`
  // above and then some: these routes move ciphertext and cleartext vault
  // NAMES, nothing else. They are the data home in the v2 model, so killing
  // them for an account-level paranoid account would strand it mid-migration.
  ...keptRoutes('Multi-vault ciphertext containers are the v2 paranoid data home.', [
    { exact: '/vaults' },
    { prefix: '/vaults/' },
  ]),
  ...keptRoutes(
    'Local workboard organization remains available; sharing settings are classified separately.',
    [
      { exact: '/workboard' },
      { prefix: '/workboard/watchlists/' },
      { pattern: /^\/workboard\/(?!sharing$)[^/]+$/ },
    ],
  ),
  ...keptRoutes(
    'Aggregate market reads run every id through the same global-or-owned asset provenance check as the per-asset reads.',
    [{ exact: '/assets/quotes' }, { exact: '/assets/sparklines' }],
  ),
  ...keptRoutes('Per-asset market reads enforce global-or-owned asset provenance.', [
    {
      // The aggregate routes above are classified explicitly, so the id segment
      // deliberately excludes them rather than swallowing them incidentally.
      pattern:
        /^\/assets\/(?!quotes$|sparklines$)[^/]+(?:\/(?:quote|history|daily-closes|intel(?:\/(?:dividends|earnings|news|splits|fundamentals))?))?$/,
    },
    { exact: '/assets/intel/earnings-calendar' },
  ]),
  ...keptRoutes(
    'Local draft backtests do not read a server portfolio; shared previews are classified separately.',
    [{ exact: '/backtest/preview' }, { exact: '/backtest/compare' }],
  ),
  ...keptRoutes(
    'Ideas remain private local notes; cloning a shared idea is classified separately.',
    [{ exact: '/ideas' }, { pattern: /^\/ideas\/[^/]+$/ }],
  ),
  ...keptRoutes(
    'Friendship and profile-settings operations preserve their no-leak authorization semantics.',
    [
      { exact: '/social/requests' },
      { prefix: '/social/requests/' },
      { exact: '/social/friends' },
      { prefix: '/social/friends/' },
      { exact: '/social/profile' },
    ],
  ),
  ...keptRoutes('AI capability and reviewed draft endpoints do not read a server portfolio.', [
    { exact: '/ai/capability' },
    { method: 'POST', exact: '/ai/conglomerate-draft' },
  ]),
  ...keptRoutes(
    'Notification, account, API-key, OAuth, and webhook settings are account configuration.',
    [
      { exact: '/settings/webhooks' },
      { prefix: '/settings/webhooks/' },
      { exact: '/settings/notifications' },
      { exact: '/settings/telegram' },
      { prefix: '/settings/telegram/' },
      { exact: '/settings/discord' },
      { prefix: '/settings/discord/' },
      { exact: '/settings/account' },
      { exact: '/settings/api-keys' },
      { prefix: '/settings/api-keys/' },
      { exact: '/settings/oauth-clients' },
      { prefix: '/settings/oauth-clients/' },
      { exact: '/settings/oauth-grants' },
      { prefix: '/settings/oauth-grants/' },
    ],
  ),
];

export interface ParanoidKnownGap {
  readonly id: string;
  readonly issue: 884;
  readonly label: string;
  readonly surface: ParanoidSurface;
  readonly classification: ParanoidExemptClassification;
}

/**
 * Review findings that were classified as temporary exemptions until #884 could
 * close them. All four are now closed by the enforcement composition in this
 * module and its call sites, so the list is empty — the type and the accessor
 * stay so a future finding can be tracked the same way rather than becoming an
 * implicit permanent exemption.
 *
 * Closed by #884:
 *  - `market-intel-watch-only-queries` — the watch-only market-intelligence
 *    reads now carry `isNull(assets.ownerId)` and pick account-owned rows up per
 *    user inside that account's transition lock.
 *  - `alerts-evaluate-custom-asset-enumeration` — `alerts.evaluate` runs a
 *    global rail plus an owner-guarded custom rail discovered from identity-only
 *    metadata, and its definition carries the `internallyFiltered` binding.
 *  - `mirror-member-copy-owner-anchor` — the join anchor is chosen from the
 *    guarded principal set, current owner first.
 *  - `portfolio-room-authorization-window` — `handleRoomJoin` holds the viewer's
 *    account lock across `canViewPortfolio`, `socket.join` and the ack, and
 *    `portfolio.changed` reauthorizes every established viewer.
 */
export const PARANOID_KNOWN_GAPS: readonly ParanoidKnownGap[] = [] as const;

/** True only when a mounted route surface meets one complete declarative rule. */
export function routeMatches(rule: ParanoidRouteRule, surface: ParanoidRouteSurface): boolean {
  if (rule.method && rule.method !== surface.method) return false;
  if (rule.exact !== undefined && rule.exact !== surface.path) return false;
  if (rule.prefix !== undefined && !surface.path.startsWith(rule.prefix)) return false;
  if (rule.pattern !== undefined && !rule.pattern.test(surface.path)) return false;
  if (
    rule.source &&
    (rule.source.file !== surface.source.file || rule.source.symbol !== surface.source.symbol)
  ) {
    return false;
  }
  return (
    rule.exact !== undefined ||
    rule.prefix !== undefined ||
    rule.pattern !== undefined ||
    rule.source !== undefined
  );
}

/** Match an exact method, all methods, or a suffix `*` method family. */
export function serviceMethodMatches(pattern: string, method: string): boolean {
  return (
    pattern === '*' ||
    (pattern.endsWith('*') && method.startsWith(pattern.slice(0, -1))) ||
    pattern === method
  );
}

function guarded(capability: ParanoidKilledCapability): ParanoidGuardedClassification {
  return { disposition: 'guarded', capability };
}

function exempt(
  reason: string,
  knownGapIssue?: 884,
  knownGapId?: string,
): ParanoidExemptClassification {
  return {
    disposition: 'exempt',
    reason,
    ...(knownGapIssue ? { knownGapIssue } : {}),
    ...(knownGapId ? { knownGapId } : {}),
  };
}

/** All route classifications so the harness can detect missing or overlapping rules. */
export function paranoidRouteClassifications(
  surface: ParanoidRouteSurface,
): readonly ParanoidSurfaceClassification[] {
  const classifications: ParanoidSurfaceClassification[] = [];
  for (const entry of PARANOID_KILL_REGISTRY) {
    if (entry.routes.some((rule) => routeMatches(rule, surface))) {
      classifications.push(guarded(entry.capability));
    }
  }
  for (const rule of PARANOID_KEPT_ROUTE_RULES) {
    if (routeMatches(rule, surface)) classifications.push(exempt(rule.reason));
  }
  return classifications;
}

/** All service classifications so the harness can detect missing or overlapping methods. */
export function paranoidServiceClassifications(
  service: string,
  method: string,
): readonly ParanoidSurfaceClassification[] {
  const classifications: ParanoidSurfaceClassification[] = [];
  for (const binding of PARANOID_SERVICE_BINDINGS) {
    if (
      binding.service === service &&
      binding.methods.some((pattern) => serviceMethodMatches(pattern, method))
    ) {
      classifications.push(guarded(binding.capability));
    }
  }
  for (const exemptionRule of [
    ...PARANOID_SERVICE_EXEMPTIONS,
    ...PARANOID_CONTEXT_SERVICE_EXEMPTIONS,
  ]) {
    if (
      exemptionRule.service === service &&
      exemptionRule.methods.some((pattern) => serviceMethodMatches(pattern, method))
    ) {
      classifications.push(exempt(exemptionRule.reason));
    }
  }
  return classifications;
}

/** All job classifications, matched by queue and concrete production source. */
export function paranoidJobClassifications(
  surface: ParanoidJobSurface,
): readonly ParanoidSurfaceClassification[] {
  return PARANOID_JOB_POLICIES.filter(
    (entry) =>
      entry.surface.name === surface.name &&
      entry.surface.source.file === surface.source.file &&
      entry.surface.source.symbol === surface.source.symbol,
  ).map(({ policy }) => {
    if (policy.capability) return guarded(policy.capability);
    const knownGap = PARANOID_KNOWN_GAPS.find((gap) => gap.id === policy.knownGapId);
    return exempt(policy.reason, knownGap?.issue, policy.knownGapId);
  });
}

/**
 * Typed completeness accessor. It never applies a guard: callers can ask the
 * registry whether a discovered route, context method, job, or named internal
 * review finding has exactly one policy without recreating the kill set.
 */
export function paranoidSurfaceClassifications(
  surface: ParanoidSurface,
): readonly ParanoidSurfaceClassification[] {
  if (surface.kind === 'route') return paranoidRouteClassifications(surface);
  if (surface.kind === 'service') {
    return paranoidServiceClassifications(surface.service, surface.method);
  }
  if (surface.kind === 'job') return paranoidJobClassifications(surface);
  return PARANOID_KNOWN_GAPS.filter(
    (gap) =>
      gap.surface.kind === 'internal' &&
      gap.surface.source.file === surface.source.file &&
      gap.surface.source.symbol === surface.source.symbol,
  ).map((gap) => gap.classification);
}

/** Returns the one policy, or `undefined` when a surface is missing or overlaps. */
export function paranoidSurfaceClassification(
  surface: ParanoidSurface,
): ParanoidSurfaceClassification | undefined {
  const classifications = paranoidSurfaceClassifications(surface);
  return classifications.length === 1 ? classifications[0] : undefined;
}

/** Convenience predicate for future composition and the completeness harness. */
export function isParanoidSurfaceClassified(surface: ParanoidSurface): boolean {
  return paranoidSurfaceClassification(surface) !== undefined;
}

const KILLED_SCOPES = new Set(PARANOID_KILL_REGISTRY.flatMap((entry) => entry.scopes));

/**
 * Explicit paranoid-mode policy for every public API-key scope. This remains a
 * Partial record deliberately: adding a contract scope must compile far enough
 * for the completeness test to report the missing policy decision.
 */
export const PARANOID_API_SCOPE_CLASSIFICATIONS: Readonly<
  Partial<Record<ApiKeyScope, ParanoidApiScopeClassification>>
> = {
  'portfolio:read': {
    disposition: 'killed',
    reason: 'Server-held portfolio data is unavailable in paranoid mode.',
  },
  'portfolio:write': {
    disposition: 'killed',
    reason: 'Server-held portfolio data is unavailable in paranoid mode.',
  },
  'workboard:read': {
    disposition: 'allowed',
    reason: 'Private workboard configuration remains available; sharing is killed separately.',
  },
  'workboard:write': {
    disposition: 'allowed',
    reason: 'Private workboard configuration remains available; sharing is killed separately.',
  },
  'market:read': {
    disposition: 'allowed',
    reason: 'Global market data does not expose account-owned portfolio bytes.',
  },
  'social:read': {
    disposition: 'allowed',
    reason: 'Friendship and profile settings remain available; sharing is killed separately.',
  },
  'social:write': {
    disposition: 'allowed',
    reason: 'Friendship and profile settings remain available; sharing is killed separately.',
  },
  'notifications:read': {
    disposition: 'allowed',
    reason: 'Notification inbox and preferences remain available for server alert delivery.',
  },
  'notifications:write': {
    disposition: 'allowed',
    reason: 'Notification inbox and preferences remain available for server alert delivery.',
  },
  'chat:read': {
    disposition: 'allowed',
    reason: 'Private chat remains separate from server-side portfolio content.',
  },
  'chat:write': {
    disposition: 'allowed',
    reason: 'Private chat remains separate from server-side portfolio content.',
  },
  'account:security': {
    disposition: 'allowed',
    reason: 'Credential and session security operations do not expose portfolio content.',
  },
  'alerts:read': {
    disposition: 'allowed',
    reason: 'Alert CRUD is provenance-filtered; alert sharing is killed separately.',
  },
  'alerts:write': {
    disposition: 'allowed',
    reason: 'Alert CRUD is provenance-filtered; alert sharing is killed separately.',
  },
  'cash:read': {
    disposition: 'killed',
    reason: 'Cash records are encrypted portfolio data and unavailable server-side.',
  },
  'cash:write': {
    disposition: 'killed',
    reason: 'Cash records are encrypted portfolio data and unavailable server-side.',
  },
  'mirrorchain:read': {
    disposition: 'killed',
    reason: 'Group-portfolio participation is unavailable because sharing is disabled.',
  },
  'mirrorchain:write': {
    disposition: 'killed',
    reason: 'Group-portfolio participation is unavailable because sharing is disabled.',
  },
  'vault:sync': {
    disposition: 'allowed',
    reason: 'Vault sync transports only opaque ciphertext for paranoid clients.',
  },
  'feedback:write': {
    disposition: 'allowed',
    reason: 'Voluntary feedback submission reads no server-held portfolio data.',
  },
  'feedback:read': {
    disposition: 'allowed',
    reason: 'Caller-owned feedback status history contains no server-held portfolio data.',
  },
};

const PARANOID_WEBHOOK_EVENTS = new Set(
  PARANOID_KILL_REGISTRY.flatMap((entry) => entry.webhookEventTypes),
);

/**
 * Event-specific account ownership for every killed webhook type. This stays
 * separate from the registry union so its completeness test catches a new event
 * that was kill-listed without deciding whether its actor also owns content.
 */
export const PARANOID_WEBHOOK_SUBJECT_POLICIES = {
  'portfolio.shared': 'recipientAndActor',
  'watchlist.shared': 'recipientAndActor',
  'conglomerate.shared': 'recipientAndActor',
  'friend.activity': 'recipientAndActor',
  'follow.published': 'recipientAndActor',
  'follow.alert.created': 'recipientAndActor',
  'follow.alert.fired': 'recipientAndActor',
  'mirror.invite': 'mirrorPrincipals',
  'mirror.member_joined': 'mirrorPrincipals',
  'mirror.member_left': 'mirrorPrincipals',
  'mirror.member_removed': 'mirrorPrincipals',
  'mirror.removed': 'mirrorPrincipals',
  'mirror.ownership_transferred': 'mirrorPrincipals',
  'mirror.chain_dissolved': 'mirrorPrincipals',
  'mirror.sync_stalled': 'mirrorPrincipals',
  'portfolio.changed': 'recipient',
  'dividend.event': 'recipient',
  'budget.exceeded': 'recipient',
  'standing_order.skipped': 'recipient',
} as const satisfies Partial<
  Record<DomainEvent['type'], 'recipient' | 'recipientAndActor' | 'mirrorPrincipals'>
>;

/**
 * The live request's (method, path) as a route surface. The runtime guard has
 * no source identity to offer, so a rule that pins one (the opaque middleware
 * mounts) can never match a real API request — exactly right, since those are
 * `app.use` leaves rather than endpoints.
 */
const requestSurface = (method: string, path: string): ParanoidRouteSurface => ({
  kind: 'route',
  source: PARANOID_ROUTE_TABLE_SOURCE,
  method,
  path: normalizeRoutePath(path),
});

export function paranoidCapabilityForRoute(
  method: string,
  path: string,
): ParanoidKilledCapability | null {
  const surface = requestSurface(method, path);
  for (const entry of PARANOID_KILL_REGISTRY) {
    if (entry.routes.some((rule) => routeMatches(rule, surface))) return entry.capability;
  }
  return null;
}

export type ParanoidRouteClassification = ParanoidKilledCapability | 'kept';

/** All classifications for completeness/overlap tests (exactly one is valid). */
export function paranoidClassificationsForRoute(
  method: string,
  path: string,
): ParanoidRouteClassification[] {
  const surface = requestSurface(method, path);
  const matches: ParanoidRouteClassification[] = [];
  for (const entry of PARANOID_KILL_REGISTRY) {
    if (entry.routes.some((rule) => routeMatches(rule, surface))) {
      matches.push(entry.capability);
    }
  }
  if (PARANOID_KEPT_ROUTE_RULES.some((rule) => routeMatches(rule, surface))) {
    matches.push('kept');
  }
  return matches;
}

export function isParanoidKilledScope(scope: string): boolean {
  for (const killedScope of KILLED_SCOPES) {
    if (killedScope === scope) return true;
  }
  return false;
}

export function isParanoidKilledWebhookEvent(event: DomainEvent): boolean {
  return PARANOID_WEBHOOK_EVENTS.has(event.type);
}

/**
 * Every account whose privacy mode can make a subscribable event unsafe.
 * `userId` is the subscription owner/recipient. Sharing events additionally
 * carry `actorId`, the shared item's owner. MIRRORCHAIN events carry the action
 * actor, chain owner, and every other affected principal. A stale queued event
 * must be dropped if any relevant account entered paranoid mode.
 */
export function paranoidWebhookSubjectIds(event: DomainEvent): string[] {
  if (!isParanoidKilledWebhookEvent(event)) return [];
  const policy =
    PARANOID_WEBHOOK_SUBJECT_POLICIES[event.type as keyof typeof PARANOID_WEBHOOK_SUBJECT_POLICIES];
  if (!policy) throw new Error(`missing paranoid webhook subject policy for ${event.type}`);
  if (!('userId' in event) || typeof event.userId !== 'string') {
    throw new Error(`missing paranoid webhook recipient for ${event.type}`);
  }
  const ids = [event.userId];
  if (policy === 'recipientAndActor') {
    if (!('actorId' in event) || typeof event.actorId !== 'string') {
      throw new Error(`missing paranoid webhook owner for ${event.type}`);
    }
    ids.push(event.actorId);
  } else if (policy === 'mirrorPrincipals') {
    if (
      !('actorId' in event) ||
      (event.actorId !== null && typeof event.actorId !== 'string') ||
      !('ownerId' in event) ||
      (event.ownerId !== null && typeof event.ownerId !== 'string') ||
      !('subjectUserIds' in event) ||
      !Array.isArray(event.subjectUserIds) ||
      event.subjectUserIds.some((userId) => typeof userId !== 'string')
    ) {
      throw new Error(`missing paranoid webhook mirror principals for ${event.type}`);
    }
    if (event.actorId) ids.push(event.actorId);
    if (event.ownerId) ids.push(event.ownerId);
    ids.push(...event.subjectUserIds);
  }
  return [...new Set(ids)];
}

export class ParanoidModeError extends ApiError {
  constructor(readonly capability: ParanoidKilledCapability) {
    super(
      403,
      PARANOID_MODE_ERROR_CODE,
      'This server-side feature is unavailable while paranoid mode is active.',
    );
    this.name = 'ParanoidModeError';
  }
}

export interface ParanoidModeGuard {
  isParanoid(userId: string): Promise<boolean>;
  assertAllowed(userId: string, capability: ParanoidKilledCapability): Promise<void>;
  runAllowed<T>(
    userId: string,
    capability: ParanoidKilledCapability,
    action: () => Promise<T>,
  ): Promise<T>;
  runAllowedMany<T>(
    userIds: readonly string[],
    capability: ParanoidKilledCapability,
    action: () => Promise<T>,
  ): Promise<T>;
  /**
   * Hold every required and optional account lock together, rejecting when a
   * required account is not normal while handing the action only the optional
   * accounts that are normal. This is the list-read primitive: a paranoid
   * counterpart is filtered without making the caller's whole list fail, and
   * no counterpart can change mode between filtering and response construction.
   */
  runAllowedWithOptional<T>(
    requiredUserIds: readonly string[],
    optionalUserIds: readonly string[],
    capability: ParanoidKilledCapability,
    action: (allowedOptionalUserIds: ReadonlySet<string>) => Promise<T>,
  ): Promise<T>;
}

export function createParanoidModeGuard(input: {
  privacyModeFor(userId: string): Promise<'normal' | 'paranoid' | null>;
  withLockedPrivacyModes<T>(
    userIds: readonly string[],
    run: (modes: ReadonlyMap<string, 'normal' | 'paranoid' | null>) => Promise<T>,
  ): Promise<T>;
}): ParanoidModeGuard {
  return {
    async isParanoid(userId) {
      return (await input.privacyModeFor(userId)) === 'paranoid';
    },
    async assertAllowed(userId, capability) {
      if (await this.isParanoid(userId)) throw new ParanoidModeError(capability);
    },
    async runAllowed(userId, capability, action) {
      return this.runAllowedMany([userId], capability, action);
    },
    async runAllowedMany(userIds, capability, action) {
      return input.withLockedPrivacyModes(userIds, async (modes) => {
        for (const userId of userIds) {
          if (modes.get(userId) !== 'normal') throw new ParanoidModeError(capability);
        }
        return action();
      });
    },
    async runAllowedWithOptional(requiredUserIds, optionalUserIds, capability, action) {
      const allUserIds = [...new Set([...requiredUserIds, ...optionalUserIds])];
      return input.withLockedPrivacyModes(allUserIds, async (modes) => {
        for (const userId of requiredUserIds) {
          if (modes.get(userId) !== 'normal') throw new ParanoidModeError(capability);
        }
        return action(new Set(optionalUserIds.filter((userId) => modes.get(userId) === 'normal')));
      });
    },
  };
}

/**
 * Guard selected async service methods whose first argument is the acting user
 * id. Kept as a small standalone primitive; AppContext uses the registry-driven
 * multi-service composer below.
 */
export function guardUserService<T extends object>(
  service: T,
  guard: ParanoidModeGuard,
  capability: ParanoidKilledCapability,
  methods: readonly (keyof T & string)[],
): T {
  const guarded = new Set<string>(methods);
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !guarded.has(property) || typeof value !== 'function') {
        return value;
      }
      return async (...args: unknown[]) => {
        const userId = args[0];
        if (typeof userId !== 'string') {
          throw new Error(`paranoid guard ${String(property)} requires a user id`);
        }
        return guard.runAllowed(userId, capability, () => Reflect.apply(value, target, args));
      };
    },
  });
}

export function serviceMethodNames(service: object): string[] {
  return Object.keys(service).filter(
    (name) => typeof (service as Record<string, unknown>)[name] === 'function',
  );
}

/** Resolve a binding against a concrete service, throwing on every dangling glob. */
export function registeredServiceMethods(
  service: object,
  binding: Pick<ParanoidServiceBinding, 'service' | 'methods'>,
): string[] {
  const available = serviceMethodNames(service);
  const resolved = new Set<string>();
  for (const pattern of binding.methods) {
    const matches =
      pattern === '*'
        ? available
        : pattern.endsWith('*')
          ? available.filter((name) => name.startsWith(pattern.slice(0, -1)))
          : available.filter((name) => name === pattern);
    if (matches.length === 0) {
      throw new Error(`paranoid service registry dangling entry: ${binding.service}.${pattern}`);
    }
    for (const match of matches) resolved.add(match);
  }
  return [...resolved].sort();
}

export interface ParanoidOwnedSubjectView {
  exists: boolean;
  userId: string | null;
  /** Vaults v2 (§3): set when a portfolio subject lives in a vault. */
  vaultId?: string | null;
}

export interface ParanoidServiceGuardResolvers {
  portfolioOwner(portfolioId: string): Promise<ParanoidOwnedSubjectView>;
  assetOwner(assetId: string): Promise<ParanoidOwnedSubjectView>;
}

export async function isParanoidOwnedSubjectBlocked(
  subject: { exists: boolean; userId: string | null; vaultId?: string | null },
  guard: Pick<ParanoidModeGuard, 'isParanoid'>,
  // Vaults v2 (§3): the capability the caller is about to exercise. Optional so
  // existing call sites keep their exact account-level behaviour; supplying it
  // additionally blocks a VAULTED portfolio whose owner account is normal.
  capability?: ParanoidKilledCapability,
): Promise<boolean> {
  if (!subject.exists) return true;
  if (
    subject.vaultId != null &&
    (capability === undefined || isVaultedPortfolioKilledCapability(capability))
  ) {
    return true;
  }
  return subject.userId !== null && (await guard.isParanoid(subject.userId));
}

/** Transition-serialized action for a portfolio/asset-owned subject. */
export async function runIfParanoidOwnedSubjectAllowed(
  subject: { exists: boolean; userId: string | null; vaultId?: string | null },
  guard: Pick<ParanoidModeGuard, 'runAllowed'>,
  capability: ParanoidKilledCapability,
  action: () => Promise<void>,
): Promise<boolean> {
  if (!subject.exists) return false;
  // A vaulted portfolio has no cleartext left to act on; the job/read is
  // skipped for it exactly as it is for a paranoid account.
  if (subject.vaultId != null && isVaultedPortfolioKilledCapability(capability)) return false;
  if (subject.userId === null) {
    await action();
    return true;
  }
  try {
    await guard.runAllowed(subject.userId, capability, action);
    return true;
  } catch (error) {
    if (error instanceof ParanoidModeError) return false;
    throw error;
  }
}

async function invokeServiceSubject<T>(
  binding: ParanoidServiceBinding,
  args: readonly unknown[],
  guard: ParanoidModeGuard,
  resolvers: ParanoidServiceGuardResolvers,
  invoke: () => Promise<T>,
): Promise<T | undefined> {
  if (binding.subject === 'intrinsic' || binding.subject === 'dynamicPrincipals') return invoke();

  if (binding.subject === 'paranoidWebhookSubjects') {
    const event = args[0];
    if (
      !event ||
      typeof event !== 'object' ||
      !('type' in event) ||
      !isParanoidKilledWebhookEvent(event as DomainEvent)
    ) {
      return invoke();
    }
    const subjectIds = paranoidWebhookSubjectIds(event as DomainEvent);
    if (subjectIds.length === 0) return invoke();
    try {
      return await guard.runAllowedMany(subjectIds, binding.capability, invoke);
    } catch (error) {
      if (binding.action === 'skip' && error instanceof ParanoidModeError) return undefined;
      throw error;
    }
  }

  if (binding.subject === 'userIdField') {
    const input = args[0];
    const userId =
      input && typeof input === 'object' && 'userId' in input && typeof input.userId === 'string'
        ? input.userId
        : null;
    if (!userId) throw new Error(`paranoid guard ${binding.service} requires input.userId`);
    return guard.runAllowed(userId, binding.capability, invoke);
  }

  const subjectId = args[0];
  if (typeof subjectId !== 'string') {
    throw new Error(`paranoid guard ${binding.service} requires a string subject id`);
  }
  if (binding.subject === 'userIdFirst' || binding.subject === 'userIdFirstAndDynamicPrincipals') {
    return guard.runAllowed(subjectId, binding.capability, invoke);
  }

  const owner =
    binding.subject === 'portfolioIdFirst' || binding.subject === 'portfolioIdFirstAllowMissing'
      ? await resolvers.portfolioOwner(subjectId)
      : await resolvers.assetOwner(subjectId);
  // A stale queued/deferred id is deliberately denied: after enable the source
  // portfolio is gone, so absence must not turn into "normal account".
  if (!owner.exists) {
    if (binding.subject === 'portfolioIdFirstAllowMissing') return invoke();
    throw new ParanoidModeError(binding.capability);
  }
  // Vaults v2 (§3): a VAULTED portfolio kills the portfolio-scoped capabilities
  // on an otherwise normal account. Checked before the account guard because it
  // is the stricter of the two — the account may be perfectly normal while this
  // one portfolio's cleartext has already been purged into a vault. `action:
  // 'skip'` bindings (job fan-outs) skip the portfolio instead of throwing,
  // exactly as they do for a paranoid account.
  if (owner.vaultId != null && isVaultedPortfolioKilledCapability(binding.capability)) {
    if (binding.action === 'skip') return undefined;
    throw new ParanoidModeError(binding.capability);
  }
  // Global market assets have no owner and are valid for asset-level kept paths.
  if (owner.userId === null) return invoke();
  return guard.runAllowed(owner.userId, binding.capability, invoke);
}

/**
 * Apply every executable service binding to the real context services. Registry
 * service names and method patterns are validated here at startup, so omitted
 * composition or dangling names cannot survive until a test happens to call it.
 */
export function guardRegisteredServices<T extends Record<string, object>>(
  services: T,
  guard: ParanoidModeGuard,
  resolvers: ParanoidServiceGuardResolvers,
): T {
  const byService = new Map<string, Map<string, ParanoidServiceBinding>>();
  const classified = new Map<string, Set<string>>();
  for (const binding of PARANOID_SERVICE_BINDINGS) {
    const service = services[binding.service];
    if (!service) {
      throw new Error(`paranoid service registry missing executable service: ${binding.service}`);
    }
    const methods = registeredServiceMethods(service, binding);
    const map = byService.get(binding.service) ?? new Map<string, ParanoidServiceBinding>();
    for (const method of methods) {
      if (map.has(method)) {
        throw new Error(`paranoid service registry overlaps at ${binding.service}.${method}`);
      }
      map.set(method, binding);
      const classifiedMethods = classified.get(binding.service) ?? new Set<string>();
      classifiedMethods.add(method);
      classified.set(binding.service, classifiedMethods);
    }
    byService.set(binding.service, map);
  }

  for (const exemption of PARANOID_SERVICE_EXEMPTIONS) {
    const service = services[exemption.service];
    if (!service) {
      throw new Error(`paranoid service registry missing exempt service: ${exemption.service}`);
    }
    const classifiedMethods = classified.get(exemption.service) ?? new Set<string>();
    for (const method of registeredServiceMethods(service, exemption)) {
      if (classifiedMethods.has(method)) {
        throw new Error(`paranoid service registry overlaps at ${exemption.service}.${method}`);
      }
      classifiedMethods.add(method);
    }
    classified.set(exemption.service, classifiedMethods);
  }

  for (const [serviceName, service] of Object.entries(services)) {
    const classifiedMethods = classified.get(serviceName) ?? new Set<string>();
    const omitted = serviceMethodNames(service).filter((method) => !classifiedMethods.has(method));
    if (omitted.length > 0) {
      throw new Error(
        `paranoid service registry omitted ${serviceName}.${omitted.join(`, ${serviceName}.`)}`,
      );
    }
  }

  const guarded = { ...services } as T;
  for (const [serviceName, methods] of byService) {
    const raw = services[serviceName]!;
    guarded[serviceName as keyof T] = new Proxy(raw, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        const binding = typeof property === 'string' ? methods.get(property) : undefined;
        if (!binding || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          return invokeServiceSubject(binding, args, guard, resolvers, async () =>
            Reflect.apply(value, target, args),
          );
        };
      },
    }) as T[keyof T];
  }
  return guarded;
}

/**
 * Queue-name index over the source-keyed policy array. Each production queue is
 * classified exactly once, so the runtime lookups (`bindParanoidJob`, the
 * per-user filter) can stay keyed by name while the completeness harness keeps
 * matching on the concrete definition source as well.
 */
const JOB_POLICY_BY_NAME: ReadonlyMap<string, ParanoidJobPolicy> = (() => {
  const byName = new Map<string, ParanoidJobPolicy>();
  for (const entry of PARANOID_JOB_POLICIES) {
    if (byName.has(entry.surface.name)) {
      throw new Error(`paranoid job registry classifies ${entry.surface.name} twice`);
    }
    byName.set(entry.surface.name, entry.policy);
  }
  return byName;
})();

/** Every classified queue name, for the registry-vs-queue-catalog drift check. */
export function paranoidJobPolicyNames(): string[] {
  return [...JOB_POLICY_BY_NAME.keys()];
}

export function hasParanoidJobPolicy(name: string): boolean {
  return JOB_POLICY_BY_NAME.has(name);
}

export function paranoidJobPolicy(name: string): ParanoidJobPolicy {
  const policy = JOB_POLICY_BY_NAME.get(name);
  if (!policy) throw new Error(`paranoid job registry omitted ${name}`);
  return policy;
}

/** Global authenticated route guard driven exclusively by the registry above. */
export function createParanoidRouteGuard(): RequestHandler {
  return (req, _res, next) => {
    if (req.authUser?.privacyMode !== 'paranoid') {
      next();
      return;
    }
    const capability = paranoidCapabilityForRoute(req.method, req.path);
    if (!capability) {
      next();
      return;
    }
    // Public profiles deliberately preserve the same opaque 404 for a
    // paranoid authenticated caller as they do for a missing/private target.
    // Returning the generic PARANOID_MODE 403 here would turn this otherwise
    // public lookup into an account-mode oracle before its intrinsic service
    // authorization has a chance to run.
    if (capability === 'publicProfile') {
      next(notFound('This profile is not available.', 'PROFILE_NOT_FOUND'));
      return;
    }
    next(
      forbidden(
        'This server-side feature is unavailable while paranoid mode is active.',
        PARANOID_MODE_ERROR_CODE,
      ),
    );
  };
}
