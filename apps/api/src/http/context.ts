import type { Redis } from 'ioredis';

import type { AppConfig } from '../config/env';
import type { Database } from '../data/db';
import { createAlertRepository } from '../data/repositories/alertRepository';
import { createAppSettingsRepository } from '../data/repositories/appSettingsRepository';
import { createApiKeyRepository } from '../data/repositories/apiKeyRepository';
import { createOAuthRepository } from '../data/repositories/oauthRepository';
import { createAssetRepository } from '../data/repositories/assetRepository';
import { createAuditRepository } from '../data/repositories/auditRepository';
import { createConglomerateRepository } from '../data/repositories/conglomerateRepository';
import { createCustomAssetRepository } from '../data/repositories/customAssetRepository';
import { createEmailLogRepository } from '../data/repositories/emailLogRepository';
import { createFriendshipRepository } from '../data/repositories/friendshipRepository';
import { createProfileRepository } from '../data/repositories/profileRepository';
import { createShareAudienceRepository } from '../data/repositories/shareAudienceRepository';
import { createInviteRepository } from '../data/repositories/inviteRepository';
import { createPasswordResetTokenRepository } from '../data/repositories/passwordResetTokenRepository';
import { createTwoFactorRepository } from '../data/repositories/twoFactorRepository';
import { createNotificationRepository } from '../data/repositories/notificationRepository';
import { createCashMovementRepository } from '../data/repositories/cashMovementRepository';
import { createCashSourceRepository } from '../data/repositories/cashSourceRepository';
import { createPortfolioRepository } from '../data/repositories/portfolioRepository';
import { createTaxRepository } from '../data/repositories/taxRepository';
import { createTransactionRepository } from '../data/repositories/transactionRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import { createWorkboardRepository } from '../data/repositories/workboardRepository';
import { createEventBus, type EventBus } from '../events';
import {
  createBackfillScheduler,
  createQueueRegistry,
  noopBackfillScheduler,
  type BackfillScheduler,
} from '../jobs';
import type { Logger } from '../logger';
import { createRealtimeGateway, type RealtimeGateway } from '../realtime';
import { createMarketData } from '../providers';
import type { MarketDataService } from '../providers';
import {
  createAccountSettingsService,
  type AccountSettingsService,
} from '../services/account/accountSettingsService';
import { createAlertService, type AlertService } from '../services/alerts/alertService';
import { createAdminService, type AdminService } from '../services/admin/adminService';
import { createApiKeyService, type ApiKeyService } from '../services/apiKeys/apiKeyService';
import { createOAuthService, type OAuthService } from '../services/oauth/oauthService';
import { createAppSettingsService } from '../services/appSettings/appSettingsService';
import { createAssetService, type AssetService } from '../services/assets/assetService';
import { createReferenceBackfill } from '../services/assets/referenceBackfill';
import { createBacktestService, type BacktestService } from '../services/backtest/backtestService';
import { createAuditService } from '../services/audit/auditService';
import {
  createConglomerateService,
  type ConglomerateService,
} from '../services/conglomerate/conglomerateService';
import { createAuthService, type AuthService } from '../services/auth/authService';
import { createTwoFactorService, type TwoFactorService } from '../services/auth/twoFactorService';
import { createCurrencyService } from '../services/currency/currencyService';
import { createAudienceService } from '../services/social/audienceService';
import {
  createCustomAssetService,
  type CustomAssetService,
} from '../services/customAssets/customAssetService';
import { createMarketDataFxSource } from '../services/currency/marketDataFxSource';
import { createEmailService } from '../services/email/emailService';
import {
  createNotificationDispatcher,
  type NotificationDispatcher,
} from '../services/notifications/notificationDispatcher';
import {
  createNotificationService,
  type NotificationService,
} from '../services/notifications/notificationService';
import {
  createNotificationSettingsService,
  type NotificationSettingsService,
} from '../services/notifications/notificationSettingsService';
import { createSmtpTransport, type MailTransport } from '../services/email/transport';
import { createPasswordHasher, type PasswordHasher } from '../services/password/passwordHasher';
import {
  createPortfolioService,
  type PortfolioService,
} from '../services/portfolio/portfolioService';
import {
  createLiveModeService,
  type LiveModeService,
  type LiveModeServiceOptions,
} from '../services/liveMode';
import { createCatalogEnrichment } from '../services/search/catalogEnrichment';
import { createSearchService, type SearchService } from '../services/search/searchService';
import { createSessionService } from '../services/sessions/sessionService';
import { createSocialService, type SocialService } from '../services/social/socialService';
import { createTaxService, type TaxService } from '../services/tax/taxService';
import {
  createWorkboardService,
  type WorkboardService,
} from '../services/workboard/workboardService';

/** What the HTTP layer needs from the wired application. */
export interface AppContext {
  config: AppConfig;
  redis: Redis;
  logger: Logger;
  auth: AuthService;
  /** TOTP enroll/confirm/disable + recovery codes — the Settings → Security 2FA core (§6.1). */
  twoFactor: TwoFactorService;
  admin: AdminService;
  /** Personal API keys — issuance, listing, revocation + bearer resolution (§6.13, V2-P12). */
  apiKeys: ApiKeyService;
  /** OAuth 2.0 provider — app registration, authorize/consent, token exchange, grants (§6.13, V2-P12). */
  oauth: OAuthService;
  workboard: WorkboardService;
  /** Cached, resilience-wrapped market data over the Yahoo + manual providers (§5.1). */
  marketData: MarketDataService;
  /** Asset detail/quote/history over the market-data layer (§6.3). */
  assets: AssetService;
  /** Local-first catalog search + background provider enrichment (§6.2). */
  search: SearchService;
  /** Transactions, holdings/totals and the value-over-time series (§6.9). */
  portfolio: PortfolioService;
  /** Realized P/L, tax modes, dividends + the per-year report (§13.3 V3-P4). */
  tax: TaxService;
  /** Custom investments + their value-points editor (§6.9). */
  customAssets: CustomAssetService;
  /** Conglomerate CRUD — user-defined weighted asset baskets (§6.5). */
  conglomerate: ConglomerateService;
  /** Backtest preview over inline draft baskets for the Builder (§6.5, §6.6). */
  backtest: BacktestService;
  /** Friend requests + friendships — the V1 social graph (§6.9). */
  social: SocialService;
  /** User-scoped notification read/mark-read — the bell + Settings list (§6.10). */
  notifications: NotificationService;
  /** Per-user notification type × channel matrix — Settings → Notifications (§6.10, §6.11). */
  notificationSettings: NotificationSettingsService;
  /** Per-user account defaults — Settings → Account default portfolio visibility (§6.9, V2-P9). */
  accountSettings: AccountSettingsService;
  /** Price-alert CRUD — the §14 alerts surface (V3-P10 arc b). Firing lives in the worker. */
  alerts: AlertService;
  /**
   * Notification dispatcher (§6.10, §9): the bus subscriber that turns the social
   * domain events into in-app rows + emails. Built here and started by the API
   * bootstrap (`server.ts`) so notifications are produced **in the API process**
   * that handles the request, rather than depending on the separate worker being
   * healthy — the #248 fix. Not started by `buildContext` itself, so tests that
   * only need the HTTP surface don't accrue bus subscriptions.
   */
  notificationDispatcher: NotificationDispatcher;
  /**
   * Realtime gateway (§4.5, V3-P7a): the second designed bus subscriber —
   * Socket.IO at /ws mapping domain events to room emissions. Built here but
   * only *attached* by the API bootstrap (`server.ts`), which owns the HTTP
   * server; with REALTIME_ENABLED=false attach is a no-op. Tests that only need
   * the HTTP surface never attach it, so no socket server or bus subscription
   * exists for them.
   */
  realtime: RealtimeGateway;
  /**
   * Live Mode core (§6.3, V3-P7b): hot-asset watcher counts, one shared poll
   * loop per hot asset, Redis ring buffer. Driven entirely by the gateway's
   * `live.watch`/`live.unwatch`; held on the context so shutdown can stop any
   * remaining loops and tests can introspect watcher counts.
   */
  liveMode: LiveModeService;
  /**
   * Typed domain event bus (§9, §4.5). Producers publish here; the notification
   * dispatcher subscribes. Held on the context so the process can close its Redis
   * pub/sub connections on shutdown.
   */
  events: EventBus;
}

export interface BuildContextDeps {
  config: AppConfig;
  db: Database;
  redis: Redis;
  logger: Logger;
  /** Test seam: inject a fake transport instead of a real SMTP connection. */
  emailTransport?: MailTransport | null;
  /** Test seam: inject a stubbed market-data service instead of the live providers. */
  marketData?: MarketDataService;
  /** Test seam: inject a backfill scheduler (e.g. a recording fake). */
  backfill?: BackfillScheduler;
  /** Test seam: a down-tuned hasher — §10's parameters are pure overhead in tests. */
  passwordHasher?: PasswordHasher;
  /** Test seam: fast poll cadence / small ring for Live Mode tests (V3-P7b). */
  liveModeOptions?: LiveModeServiceOptions;
}

/** Composition root: repositories → services → context. */
export function buildContext(deps: BuildContextDeps): AppContext {
  const { config, db, redis, logger } = deps;

  const userRepo = createUserRepository(db);
  const inviteRepo = createInviteRepository(db);
  const passwordResetRepo = createPasswordResetTokenRepository(db);
  const twoFactorRepo = createTwoFactorRepository(db);
  const auditRepo = createAuditRepository(db);
  // Shared by auth/admin (default-portfolio provisioning at account creation,
  // §5.5) and the portfolio service below.
  const portfolioRepo = createPortfolioRepository(db);

  const sessions = createSessionService(redis, Math.floor(config.cookie.maxAgeMs / 1000));
  const audit = createAuditService(auditRepo);

  // Personal API keys (§6.13, V2-P12): issuance/list/revoke + bearer-token
  // resolution for the auth middleware. Owns only issuance + audit; scope
  // enforcement lives in the HTTP layer.
  const apiKeys = createApiKeyService({ repo: createApiKeyRepository(db), audit, redis });

  // OAuth 2.0 provider (§6.13, V2-P12): app registration, authorize/consent +
  // token exchange, grant management, and access-token resolution for the bearer
  // middleware. Reuses the personal-key scope taxonomy + audit patterns.
  const oauth = createOAuthService({ repo: createOAuthRepository(db), audit, redis });
  const passwordHasher = deps.passwordHasher ?? createPasswordHasher();

  // Global app settings (§6.12): registration-mode enforcement + beta toggle,
  // read by the auth register guard and the admin settings API.
  const appSettings = createAppSettingsService({ repo: createAppSettingsRepository(db) });

  // Typed domain event bus (§9, §4.5). Pub/sub needs a dedicated subscriber
  // connection, so publisher and subscriber each get their own duplicated Redis
  // connection. The API only *publishes* (producers); the notification dispatcher
  // subscribes in the worker process.
  const events = createEventBus({
    publisher: redis.duplicate(),
    subscriber: redis.duplicate(),
    logger,
  });

  // Social graph (§6.9): shared by the social service and the portfolio service
  // (the latter resolves the owner's friends when a portfolio is shared, §6.10).
  const friendshipRepo = createFriendshipRepository(db);
  // Public-profile settings + per-viewer activity-alert prefs (§6.9, §14, V3-P6).
  const profileRepo = createProfileRepository(db);

  // The ONE sharing-enforcement layer (§13.3 V3-P5, §6.9): the audience model +
  // authorization-is-the-join queries behind every social read path, plus
  // hash-only public-link minting. Injected into workboard/conglomerate/social
  // and the realtime room-join check so authorization is decided in ONE place.
  const shareAudienceRepo = createShareAudienceRepository(db);
  const audience = createAudienceService({ repo: shareAudienceRepo });

  // Only open a real SMTP connection when the channel is configured (§11).
  const transport =
    deps.emailTransport !== undefined
      ? deps.emailTransport
      : config.email.enabled
        ? createSmtpTransport(config.email)
        : null;
  const emailLogRepo = createEmailLogRepository(db);
  const email = createEmailService({ config, logger, audit, emailLog: emailLogRepo, transport });

  // TOTP two-factor (§6.1, §13.2 V2-P5): enroll/confirm/disable + recovery codes,
  // plus the login-challenge factor checks the auth service calls. Secret
  // encrypted at rest with the config's 2FA key; recovery codes hashed. Built
  // before auth so the login flow can gate on it.
  const twoFactor = createTwoFactorService({
    config,
    userRepo,
    twoFactorRepo,
    audit,
    redis,
    email,
  });

  const auth = createAuthService({
    config,
    redis,
    userRepo,
    inviteRepo,
    passwordResetRepo,
    portfolioRepo,
    sessions,
    audit,
    passwordHasher,
    email,
    appSettings,
    twoFactor,
  });
  const admin = createAdminService({
    config,
    redis,
    userRepo,
    inviteRepo,
    portfolioRepo,
    sessions,
    audit,
    passwordHasher,
    email,
    emailLog: emailLogRepo,
    appSettings,
  });

  // Registers the Yahoo + manual providers and wraps them in caching/resilience
  // (§5.1–§5.2). `registry.for(asset)` lives inside; routes use the service.
  const marketData =
    deps.marketData ??
    createMarketData({
      db,
      redis,
      queueOptions: {
        concurrency: config.providers.maxConcurrency,
        minSpacingMs: config.providers.minSpacingMs,
      },
      options: {
        // Failed background revalidations never surface to callers (§5.3 — they
        // already got the stale copy), so the log line is their only trace.
        onBackgroundError: (key, err) =>
          logger.warn({ key, err }, 'market-data background refresh failed'),
      },
    }).service;

  // First-touch backfill enqueue (§6.2/§9). In tests no BullMQ worker runs, so
  // default to a no-op; production enqueues onto the shared Redis-backed queue.
  const backfill =
    deps.backfill ??
    (config.isTest ? noopBackfillScheduler : createBackfillScheduler(createQueueRegistry(redis)));

  // Single conversion keystone (§5.4): spot FX sourced from cached Yahoo quotes.
  const currencySource = createMarketDataFxSource(marketData);
  const currency = createCurrencyService({ source: currencySource });

  const assetRepo = createAssetRepository(db);
  const assets = createAssetService({
    marketData,
    assetRepo,
    currencyService: currency,
  });

  // First-reference history warming (§6.2/§9): the first workboard add or
  // transaction on a history-less asset enqueues its max-range backfill —
  // this is how seeded catalog rows (§6.2(c)) get price history at all.
  const referenceBackfill = createReferenceBackfill({ assetRepo, backfill, logger });

  const workboardRepo = createWorkboardRepository(db);
  const workboard = createWorkboardService({ repo: workboardRepo, referenceBackfill, audience });

  // Local-first search (§6.2): answers from the Postgres catalog; a thin result
  // set triggers a background, coalesced provider search that enriches it.
  const enrichment = createCatalogEnrichment({ marketData, assetRepo, backfill, redis, logger });
  const search = createSearchService({ assetRepo, enrichment });

  // Portfolio + custom investments (§6.9). The custom-asset service records its
  // optional initial purchase through the portfolio service and shares its
  // value-series cache invalidation.
  const transactionRepo = createTransactionRepository(db);
  const cashMovementRepo = createCashMovementRepository(db);
  const cashSourceRepo = createCashSourceRepository(db);
  // Tax engine (V3-P4): built before the portfolio service, which folds its
  // per-sell tax plans into transaction writes.
  const taxRepo = createTaxRepository(db);
  const tax = createTaxService({
    taxRepo,
    transactionRepo,
    cashMovementRepo,
    cashSourceRepo,
    portfolioRepo,
    currencyService: currency,
    redis,
    logger,
  });
  const portfolio = createPortfolioService({
    portfolioRepo,
    transactionRepo,
    cashMovementRepo,
    cashSourceRepo,
    userRepo,
    marketData,
    currencyService: currency,
    referenceBackfill,
    redis,
    taxService: tax,
    friendshipRepo,
    events,
    logger,
  });
  const customAssetRepo = createCustomAssetRepository(db);
  const customAssets = createCustomAssetService({ repo: customAssetRepo, portfolio });

  // Conglomerates: user-defined weighted asset baskets, owner-scoped CRUD (§6.5).
  const conglomerateRepo = createConglomerateRepository(db);
  const conglomerate = createConglomerateService({
    repo: conglomerateRepo,
    assetRepo,
    marketData,
    currencyService: currency,
    audience,
  });

  // Backtest preview (§6.5/§6.6): reuses the market-data history + currency
  // keystones to feed the pure engine over inline draft positions.
  const backtestPreview = createBacktestService({
    assetRepo,
    marketData,
    currencyService: currency,
    redis,
  });

  // Friend requests + friendships (§6.9): no-enumeration request creation,
  // accept/decline/cancel/remove, all authorization enforced at query time.
  // Publishes friend.request / friend.accepted for the notification dispatcher.
  const social = createSocialService({
    repo: friendshipRepo,
    profile: profileRepo,
    audience,
    portfolio,
    conglomerate,
    workboard,
    events,
    logger,
  });

  // Notification read/mark-read (§6.10): user-scoped over the dispatcher's rows.
  const notificationRepo = createNotificationRepository(db);
  const notifications = createNotificationService({ repo: notificationRepo });
  // Notification channel toggles (§6.10, §6.11): in-app always on, email on by
  // default; writes the settings rows the dispatcher reads.
  const notificationSettings = createNotificationSettingsService({ repo: notificationRepo });

  // Account defaults (§6.9, V2-P9): Settings → Account default portfolio
  // visibility, applied by the portfolio service at create time.
  const accountSettings = createAccountSettingsService({ userRepo });

  // Price alerts (§14, V3-P10 arc b): user-scoped CRUD; the minute evaluator in
  // the worker fires them and publishes `alert.triggered`, which the dispatcher
  // below fans out via the notification matrix.
  const alertRepo = createAlertRepository(db);
  const alerts = createAlertService({ repo: alertRepo, assetRepo, marketData, logger });

  // Notification dispatcher (§6.10, §9): fans the V1 social events out to the
  // recipient's in-app + email channels, consulting the per-type × channel
  // matrix. Built with the API's own email + user deps and started by the API
  // bootstrap so notifications are delivered in-process (the #248 fix — the API
  // no longer relies on the worker to persist friend-request notifications).
  const notificationDispatcher = createNotificationDispatcher({
    bus: events,
    repo: notificationRepo,
    email,
    users: userRepo,
    // Resolves an `alert.triggered` event's asset + rule for rendering (§14).
    resolveAlert: (alertId) => alertRepo.findNotificationContext(alertId),
    logger,
  });

  // Realtime gateway (§4.5, V3-P7a): session auth reuses the auth service's
  // cookie→user resolution verbatim; `portfolio:{id}` room joins enforce
  // owner-or-shared with the same repository checks the shared-view HTTP
  // endpoints use (§6.9), recomputed at join time.
  // Live Mode core (§6.3, V3-P7b). Hosted in the API process next to the
  // gateway that drives its watcher counts — the ring buffer lives in Redis, so
  // moving the loop into the worker later is wiring, not a data-path change.
  const liveMode = createLiveModeService({
    marketData,
    redis,
    logger,
    options: deps.liveModeOptions,
  });

  const realtime = createRealtimeGateway({
    config,
    bus: events,
    logger,
    resolveSession: (sessionId, userAgent) => auth.resolveSession(sessionId, userAgent),
    canViewPortfolio: async (userId, portfolioId) => {
      if (await portfolioRepo.findByIdForUser(userId, portfolioId)) return true;
      // Friend-share access goes through the SAME single enforcement layer the
      // HTTP shared-view uses (§13.3 V3-P5), recomputed at join time (§6.9).
      return Boolean(await audience.authorizePortfolioRead(userId, portfolioId));
    },
    liveMode,
    // Global asset or the caller's own custom asset (§10) → provider ref for
    // the shared loop; anything else is a NOT_FOUND-indistinguishable null.
    resolveWatchableAsset: async (userId, assetId) => {
      const row = await assetRepo.findByIdForUser(assetId, userId);
      return row ? { providerId: row.providerId, providerRef: row.providerRef } : null;
    },
  });

  return {
    config,
    redis,
    logger,
    auth,
    twoFactor,
    admin,
    apiKeys,
    oauth,
    workboard,
    marketData,
    assets,
    search,
    portfolio,
    tax,
    customAssets,
    conglomerate,
    backtest: backtestPreview,
    social,
    notifications,
    notificationSettings,
    accountSettings,
    alerts,
    notificationDispatcher,
    realtime,
    liveMode,
    events,
  };
}
