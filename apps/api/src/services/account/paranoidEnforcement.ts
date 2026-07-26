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

export interface ParanoidKillRegistryEntry {
  readonly capability: ParanoidKilledCapability;
  readonly routes: readonly ParanoidRouteRule[];
  readonly serviceEntryPoints: readonly string[];
  readonly scopes: readonly string[];
  readonly jobs: readonly string[];
  readonly webhookEventTypes: readonly string[];
}

/**
 * The one executable §8 registry. A capability is not considered covered unless
 * it names its HTTP routes and every below-HTTP rail that applies. Tests iterate
 * these arrays, not a second expectation list.
 */
export const PARANOID_KILL_REGISTRY: readonly ParanoidKillRegistryEntry[] = [
  {
    capability: 'publicProfile',
    routes: [{ prefix: '/social/profiles/' }],
    serviceEntryPoints: ['social.getPublicProfile', 'social.getPublicProfileItem'],
    scopes: [],
    jobs: [],
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
    serviceEntryPoints: [
      'audience.setAudience',
      'audience.authorizeRead',
      'social.sharedWithMe',
      'social.mySharedItems',
      'social.followUser',
      'social.followItem',
      'comments.*',
    ],
    scopes: [],
    jobs: [],
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
    serviceEntryPoints: [
      'mirror.createChain',
      'mirror.inviteMember',
      'mirror.acceptInvite',
      'mirror.submit*',
    ],
    scopes: [],
    jobs: ['mirror.replicate'],
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
    serviceEntryPoints: [
      'portfolio.*',
      'snapshots.*',
      'analytics.overview',
      'portfolioMarketIntel.*',
      'marketIntel.newsDigest',
      'aiFeatures.insights',
      'tax.*',
      'expenses.*',
    ],
    scopes: [],
    jobs: [],
    webhookEventTypes: ['portfolio.changed', 'dividend.event', 'budget.exceeded'],
  },
  {
    capability: 'imports',
    routes: [{ exact: '/imports' }, { prefix: '/imports/' }, { prefix: '/expenses/import/' }],
    serviceEntryPoints: ['imports.*', 'expenseImports.*'],
    scopes: [
      'portfolio:read',
      'portfolio:write',
      'tax:read',
      'tax:write',
      'import:read',
      'import:write',
    ],
    jobs: [],
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioApiScope',
    routes: [],
    serviceEntryPoints: ['bearerAuth.enforceApiKeyScope'],
    scopes: [
      'portfolio:read',
      'portfolio:write',
      'tax:read',
      'tax:write',
      'import:read',
      'import:write',
    ],
    jobs: [],
    webhookEventTypes: [],
  },
  {
    capability: 'standingOrderExecution',
    routes: [{ exact: '/standing-orders' }, { prefix: '/standing-orders/' }],
    serviceEntryPoints: ['standingOrders.processDueOrders'],
    scopes: [],
    jobs: ['standingOrders.process'],
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioJobs',
    routes: [],
    serviceEntryPoints: [
      'snapshots.recompute',
      'snapshots.recomputeAll',
      'marketIntel.holdingScans',
      'offsiteBackup.portfolioRows',
    ],
    scopes: [],
    jobs: [
      'snapshots.recompute',
      'snapshots.backfill',
      'notifications.earningsRemind',
      'marketIntel.dividendScan',
    ],
    webhookEventTypes: [],
  },
  {
    capability: 'portfolioWebhooks',
    routes: [],
    serviceEntryPoints: ['webhookBridge.handleEvent'],
    scopes: [],
    jobs: ['webhooks.deliver'],
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
}

export function createParanoidModeGuard(input: {
  privacyModeFor(userId: string): Promise<'normal' | 'paranoid' | null>;
}): ParanoidModeGuard {
  return {
    async isParanoid(userId) {
      return (await input.privacyModeFor(userId)) === 'paranoid';
    },
    async assertAllowed(userId, capability) {
      if (await this.isParanoid(userId)) throw new ParanoidModeError(capability);
    },
  };
}

/**
 * Guard selected async service methods whose first argument is the acting user
 * id. This keeps direct service calls on the same registry rail as HTTP without
 * changing normal-account results or the wrapped service's public type.
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
        await guard.assertAllowed(userId, capability);
        return Reflect.apply(value, target, args);
      };
    },
  });
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
