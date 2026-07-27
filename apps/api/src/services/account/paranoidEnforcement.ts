import type { RequestHandler } from 'express';

import { PARANOID_TRANSITION_ERROR_CODES } from '@bettertrack/contracts';

import type { DomainEvent } from '../../events';
import { ApiError, forbidden } from '../../errors';

export type ParanoidKilledCapability =
  | 'publicProfile'
  | 'sharing'
  | 'mirrorchain'
  | 'portfolioServer'
  | 'imports'
  | 'portfolioApiScope'
  | 'standingOrderExecution'
  | 'portfolioJobs'
  | 'portfolioWebhooks';

export interface ParanoidRouteRule {
  readonly method?: string;
  readonly exact?: string;
  readonly prefix?: string;
  readonly pattern?: RegExp;
}

export type ParanoidServiceSubject =
  | 'userIdFirst'
  | 'userIdField'
  | 'portfolioIdFirst'
  | 'assetIdFirst'
  | 'portfolioEventUser'
  /**
   * The method itself resolves a live audience/profile predicate and returns a
   * uniform 404 when the target is not currently public.
   */
  | 'intrinsic';

export interface ParanoidServiceBinding {
  readonly capability: ParanoidKilledCapability;
  /** AppContext property holding the executable service. */
  readonly service: string;
  /** Exact method names, `*`, or a prefix glob such as `submit*`. */
  readonly methods: readonly string[];
  /** How the proxy resolves the account whose mode controls the call. */
  readonly subject: ParanoidServiceSubject;
  /** Portfolio webhook events are suppressed rather than surfaced as errors. */
  readonly action?: 'throw' | 'skip';
}

export interface ParanoidServiceExemption {
  readonly service: string;
  readonly methods: readonly string[];
  readonly handling: 'kept' | 'internallyFiltered';
}

const serviceBinding = (
  capability: ParanoidKilledCapability,
  service: string,
  subject: ParanoidServiceSubject,
  methods: readonly string[],
  action?: 'throw' | 'skip',
): ParanoidServiceBinding => ({
  capability,
  service,
  subject,
  methods,
  ...(action ? { action } : {}),
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
    'listFollowing',
    'listFollowers',
    'unfollowItem',
    'listItemFollows',
    'listSharedWithMe',
    'getSharedPortfolio',
    'getSharedConglomerate',
    'getSharedWatchlist',
    'listMyShared',
    'getAudience',
    'setAudience',
    'applyAudienceVisibility',
  ]),
  serviceBinding('sharing', 'social', 'intrinsic', ['getByPublicLink']),
  serviceBinding('mirrorchain', 'mirror', 'userIdFirst', [
    'convertToChain',
    'createChain',
    'convertChain',
    'listChainsForUser',
    'getMemberList',
    'getActivity',
    'listInvites',
    'inviteMember',
    'acceptInvite',
    'declineInvite',
    'revokeInvite',
    'setMemberRole',
    'transferOwnership',
    'removeMember',
    'leaveChain',
    'renameChain',
    'dissolveChain',
    'submit*',
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
  serviceBinding('portfolioServer', 'expenses', 'userIdFirst', ['*']),
  serviceBinding('portfolioServer', 'expenseBudgets', 'userIdFirst', ['*']),
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
    'get',
    'create',
    'update',
    'pause',
    'resume',
    'remove',
  ]),
  serviceBinding(
    'portfolioWebhooks',
    'webhookBridge',
    'portfolioEventUser',
    ['handleEvent'],
    'skip',
  ),
] as const;

/**
 * Explicit classifications for non-killed methods on every mixed service
 * above. App composition compares these plus the killed bindings with every
 * real method, so a new method cannot silently default open.
 */
export const PARANOID_SERVICE_EXEMPTIONS: readonly ParanoidServiceExemption[] = [
  {
    service: 'conglomerate',
    methods: [
      'list',
      'get',
      'create',
      'update',
      'replacePositions',
      'activate',
      'remove',
      'resolved',
      'allocate',
    ],
    handling: 'kept',
  },
  {
    service: 'workboard',
    methods: [
      'list',
      'listInWatchlist',
      'addItem',
      'removeItem',
      'reorder',
      'listWatchlists',
      'createWatchlist',
      'renameWatchlist',
      'deleteWatchlist',
    ],
    handling: 'kept',
  },
  {
    service: 'workboard',
    methods: ['itemsForSharedView'],
    handling: 'internallyFiltered',
  },
  {
    service: 'ideas',
    methods: ['list', 'get', 'create', 'update', 'remove'],
    handling: 'kept',
  },
  {
    service: 'backtest',
    methods: ['runPreview', 'runComparison'],
    handling: 'kept',
  },
  {
    service: 'social',
    methods: [
      'sendRequest',
      'listRequests',
      'accept',
      'decline',
      'cancel',
      'listFriends',
      'removeFriend',
      'followItem',
      'setActivityAlert',
      'getProfileSettings',
      'updateProfileSettings',
    ],
    handling: 'internallyFiltered',
  },
  {
    service: 'mirror',
    methods: [
      'syncedMembership',
      'enrichPortfolioSummaries',
      'overlayForPortfolio',
      'attachMemberCopy',
      'replicateChain',
      'notifyChainStalled',
      'handleAccountDeletion',
      'runConsistencySweep',
    ],
    handling: 'internallyFiltered',
  },
  {
    service: 'marketIntel',
    methods: ['capabilities', 'dividends', 'earnings', 'news', 'splits', 'earningsCalendar'],
    handling: 'kept',
  },
  {
    service: 'aiFeatures',
    methods: ['conglomerateDraft'],
    handling: 'kept',
  },
  {
    service: 'snapshots',
    methods: ['recomputeAll'],
    handling: 'internallyFiltered',
  },
  {
    service: 'imports',
    methods: ['listBrokers'],
    handling: 'kept',
  },
  {
    service: 'expenseImports',
    methods: ['listBanks'],
    handling: 'kept',
  },
  {
    service: 'standingOrders',
    methods: ['processDueOrders'],
    handling: 'internallyFiltered',
  },
] as const;

export type ParanoidJobMode =
  | 'kept'
  | 'portfolio'
  | 'perUser'
  | 'serviceFiltered'
  | 'transitionPrecondition'
  | 'event';

export interface ParanoidJobPolicy {
  readonly capability: ParanoidKilledCapability | null;
  readonly mode: ParanoidJobMode;
}

/**
 * Exhaustive job classification. Tests compare these keys with ALL_QUEUE_NAMES,
 * so adding a queue without choosing kept/killed behavior fails the matrix.
 */
export const PARANOID_JOB_POLICIES: Readonly<Record<string, ParanoidJobPolicy>> = {
  'alerts.evaluate': { capability: null, mode: 'kept' },
  'prices.refreshDaily': { capability: null, mode: 'kept' },
  'prices.backfill': { capability: null, mode: 'kept' },
  'fx.refreshSpot': { capability: null, mode: 'kept' },
  'notifications.dispatch': { capability: null, mode: 'kept' },
  'notifications.digestDaily': { capability: null, mode: 'kept' },
  'notifications.digestWeekly': { capability: null, mode: 'kept' },
  'notifications.deferredDelivery': { capability: null, mode: 'kept' },
  'data.export': { capability: null, mode: 'kept' },
  'data.exportCleanup': { capability: null, mode: 'kept' },
  'snapshots.recompute': { capability: 'portfolioJobs', mode: 'portfolio' },
  'snapshots.backfill': { capability: 'portfolioJobs', mode: 'serviceFiltered' },
  'usage.rollup': { capability: null, mode: 'kept' },
  'notifications.earningsRemind': { capability: 'portfolioJobs', mode: 'perUser' },
  'marketIntel.dividendScan': { capability: 'portfolioJobs', mode: 'perUser' },
  'standingOrders.process': { capability: 'standingOrderExecution', mode: 'perUser' },
  'mirror.replicate': { capability: 'mirrorchain', mode: 'transitionPrecondition' },
  'mirror.inviteCleanup': { capability: null, mode: 'kept' },
  'mirror.consistencySweep': { capability: null, mode: 'kept' },
  'webhooks.deliver': { capability: 'portfolioWebhooks', mode: 'event' },
  'webhooks.deliveryCleanup': { capability: null, mode: 'kept' },
  'apiKeys.requestLogCleanup': { capability: null, mode: 'kept' },
  'system.heartbeat': { capability: null, mode: 'kept' },
} as const;

export interface ParanoidKillRegistryEntry {
  readonly capability: ParanoidKilledCapability;
  readonly routes: readonly ParanoidRouteRule[];
  readonly services: readonly ParanoidServiceBinding[];
  readonly scopes: readonly string[];
  readonly jobs: readonly string[];
  readonly webhookEventTypes: readonly string[];
}

const servicesFor = (capability: ParanoidKilledCapability): readonly ParanoidServiceBinding[] =>
  PARANOID_SERVICE_BINDINGS.filter((binding) => binding.capability === capability);

const jobsFor = (capability: ParanoidKilledCapability): readonly string[] =>
  Object.entries(PARANOID_JOB_POLICIES)
    .filter(([, policy]) => policy.capability === capability)
    .map(([name]) => name);

/**
 * The one executable §8 registry. Routes, service proxies, scopes, jobs and
 * webhook event types are all consumed by production composition helpers.
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
      { exact: '/workboard/sharing' },
      { pattern: /^\/ideas\/[^/]+\/clone$/ },
      { prefix: '/backtest/shared/' },
    ],
    services: servicesFor('sharing'),
    scopes: [],
    jobs: jobsFor('sharing'),
    webhookEventTypes: [
      'portfolio.shared',
      'watchlist.shared',
      'conglomerate.shared',
      'friend.activity',
      'follow.published',
    ],
  },
  {
    capability: 'mirrorchain',
    routes: [{ prefix: '/mirrorchain/' }],
    services: servicesFor('mirrorchain'),
    scopes: [],
    jobs: jobsFor('mirrorchain'),
    webhookEventTypes: [
      'mirror.invite',
      'mirror.member_joined',
      'mirror.member_left',
      'mirror.member_removed',
      'mirror.removed',
      'mirror.ownership_transferred',
      'mirror.chain_dissolved',
      'mirror.sync_stalled',
    ],
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
      { exact: '/assets/portfolio/dividend-calendar' },
      { exact: '/assets/portfolio/dividend-projection' },
      { exact: '/assets/portfolio/news-digest' },
      { method: 'POST', exact: '/ai/insights' },
      { exact: '/settings/taxes' },
    ],
    services: servicesFor('portfolioServer'),
    scopes: [],
    jobs: jobsFor('portfolioServer'),
    webhookEventTypes: ['portfolio.changed', 'dividend.event', 'budget.exceeded'],
  },
  {
    capability: 'imports',
    routes: [{ exact: '/imports' }, { prefix: '/imports/' }, { prefix: '/expenses/import/' }],
    services: servicesFor('imports'),
    scopes: [
      'portfolio:read',
      'portfolio:write',
      'tax:read',
      'tax:write',
      'import:read',
      'import:write',
    ],
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
      'tax:read',
      'tax:write',
      'import:read',
      'import:write',
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
    webhookEventTypes: [
      'portfolio.changed',
      'portfolio.shared',
      'friend.activity',
      'dividend.event',
      'budget.exceeded',
      'mirror.invite',
      'mirror.member_joined',
      'mirror.member_left',
      'mirror.member_removed',
      'mirror.removed',
      'mirror.ownership_transferred',
      'mirror.chain_dissolved',
      'mirror.sync_stalled',
    ],
  },
] as const;

/**
 * Explicit kept classification for route groups that mix with killed routes.
 * Whole kept routers use compact prefixes; mixed routers enumerate their kept
 * families so a newly mounted path cannot silently default to allowed.
 */
export const PARANOID_KEPT_ROUTE_RULES: readonly ParanoidRouteRule[] = [
  { exact: '/version' },
  { exact: '/health' },
  { exact: '/feature-flags' },
  { exact: '/search' },
  { prefix: '/auth/' },
  { exact: '/account' },
  { prefix: '/account/' },
  { prefix: '/admin/' },
  { prefix: '/oauth/' },
  { exact: '/conglomerates' },
  { prefix: '/conglomerates/' },
  { exact: '/chat/conversations' },
  { prefix: '/chat/conversations/' },
  { exact: '/notifications' },
  { prefix: '/notifications/' },
  { exact: '/alerts' },
  { prefix: '/alerts/' },
  { exact: '/vault' },
  { prefix: '/vault/' },
  { exact: '/workboard' },
  { exact: '/workboard/watchlists' },
  { prefix: '/workboard/watchlists/' },
  { exact: '/workboard/reorder' },
  { pattern: /^\/workboard\/(?!sharing$)[^/]+$/ },
  {
    pattern:
      /^\/assets\/[^/]+(?:\/(?:quote|history|daily-closes|intel(?:\/(?:dividends|earnings|news|splits))?))?$/,
  },
  { exact: '/assets/intel/earnings-calendar' },
  { exact: '/backtest/preview' },
  { exact: '/backtest/compare' },
  { exact: '/ideas' },
  { pattern: /^\/ideas\/[^/]+$/ },
  { exact: '/social/requests' },
  { prefix: '/social/requests/' },
  { exact: '/social/friends' },
  { prefix: '/social/friends/' },
  { exact: '/social/profile' },
  { exact: '/ai/capability' },
  { method: 'POST', exact: '/ai/conglomerate-draft' },
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
] as const;

const KILLED_SCOPES = new Set(PARANOID_KILL_REGISTRY.flatMap((entry) => entry.scopes));
const PORTFOLIO_WEBHOOK_EVENTS = new Set(
  PARANOID_KILL_REGISTRY.filter((entry) => entry.capability === 'portfolioWebhooks').flatMap(
    (entry) => entry.webhookEventTypes,
  ),
);

function routeMatches(rule: ParanoidRouteRule, method: string, path: string): boolean {
  if (rule.method && rule.method !== method) return false;
  if (rule.exact !== undefined && rule.exact !== path) return false;
  if (rule.prefix !== undefined && !path.startsWith(rule.prefix)) return false;
  if (rule.pattern !== undefined && !rule.pattern.test(path)) return false;
  return rule.exact !== undefined || rule.prefix !== undefined || rule.pattern !== undefined;
}

export function paranoidCapabilityForRoute(
  method: string,
  path: string,
): ParanoidKilledCapability | null {
  for (const entry of PARANOID_KILL_REGISTRY) {
    if (entry.routes.some((rule) => routeMatches(rule, method, path))) return entry.capability;
  }
  return null;
}

export type ParanoidRouteClassification = ParanoidKilledCapability | 'kept';

/** All classifications for completeness/overlap tests (exactly one is valid). */
export function paranoidClassificationsForRoute(
  method: string,
  path: string,
): ParanoidRouteClassification[] {
  const matches: ParanoidRouteClassification[] = [];
  for (const entry of PARANOID_KILL_REGISTRY) {
    if (entry.routes.some((rule) => routeMatches(rule, method, path))) {
      matches.push(entry.capability);
    }
  }
  if (PARANOID_KEPT_ROUTE_RULES.some((rule) => routeMatches(rule, method, path))) {
    matches.push('kept');
  }
  return matches;
}

export function isParanoidKilledScope(scope: string): boolean {
  return KILLED_SCOPES.has(scope);
}

export function isPortfolioContentWebhookEvent(event: DomainEvent): boolean {
  if (!PORTFOLIO_WEBHOOK_EVENTS.has(event.type)) return false;
  if (event.type === 'friend.activity') return event.itemKind === 'portfolio';
  return true;
}

export class ParanoidModeError extends ApiError {
  constructor(readonly capability: ParanoidKilledCapability) {
    super(
      403,
      PARANOID_TRANSITION_ERROR_CODES.mode,
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

export interface ParanoidServiceGuardResolvers {
  portfolioOwner(portfolioId: string): Promise<{ exists: boolean; userId: string | null }>;
  assetOwner(assetId: string): Promise<{ exists: boolean; userId: string | null }>;
}

export async function isParanoidOwnedSubjectBlocked(
  subject: { exists: boolean; userId: string | null },
  guard: Pick<ParanoidModeGuard, 'isParanoid'>,
): Promise<boolean> {
  return !subject.exists || (subject.userId !== null && (await guard.isParanoid(subject.userId)));
}

/** Transition-serialized action for a portfolio/asset-owned subject. */
export async function runIfParanoidOwnedSubjectAllowed(
  subject: { exists: boolean; userId: string | null },
  guard: Pick<ParanoidModeGuard, 'runAllowed'>,
  capability: ParanoidKilledCapability,
  action: () => Promise<void>,
): Promise<boolean> {
  if (!subject.exists) return false;
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
  if (binding.subject === 'intrinsic') return invoke();

  if (binding.subject === 'portfolioEventUser') {
    const event = args[0];
    if (
      !event ||
      typeof event !== 'object' ||
      !('type' in event) ||
      !isPortfolioContentWebhookEvent(event as DomainEvent)
    ) {
      return invoke();
    }
    const userId = 'userId' in event && typeof event.userId === 'string' ? event.userId : undefined;
    if (!userId) return invoke();
    try {
      return await guard.runAllowed(userId, binding.capability, invoke);
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
  if (binding.subject === 'userIdFirst') {
    return guard.runAllowed(subjectId, binding.capability, invoke);
  }

  const owner =
    binding.subject === 'portfolioIdFirst'
      ? await resolvers.portfolioOwner(subjectId)
      : await resolvers.assetOwner(subjectId);
  // A stale queued/deferred id is deliberately denied: after enable the source
  // portfolio is gone, so absence must not turn into "normal account".
  if (!owner.exists) throw new ParanoidModeError(binding.capability);
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

export function paranoidJobPolicy(name: string): ParanoidJobPolicy {
  const policy = PARANOID_JOB_POLICIES[name];
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
    next(
      forbidden(
        'This server-side feature is unavailable while paranoid mode is active.',
        PARANOID_TRANSITION_ERROR_CODES.mode,
      ),
    );
  };
}
