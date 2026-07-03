import type { Redis } from 'ioredis';

import type { AppConfig } from '../config/env';
import type { Database } from '../data/db';
import { createAssetRepository } from '../data/repositories/assetRepository';
import { createAuditRepository } from '../data/repositories/auditRepository';
import { createConglomerateRepository } from '../data/repositories/conglomerateRepository';
import { createCustomAssetRepository } from '../data/repositories/customAssetRepository';
import { createInviteRepository } from '../data/repositories/inviteRepository';
import { createPortfolioRepository } from '../data/repositories/portfolioRepository';
import { createTransactionRepository } from '../data/repositories/transactionRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import { createWorkboardRepository } from '../data/repositories/workboardRepository';
import {
  createBackfillScheduler,
  createQueueRegistry,
  noopBackfillScheduler,
  type BackfillScheduler,
} from '../jobs';
import type { Logger } from '../logger';
import { createMarketData } from '../providers';
import type { MarketDataService } from '../providers';
import { createAdminService, type AdminService } from '../services/admin/adminService';
import { createAssetService, type AssetService } from '../services/assets/assetService';
import { createReferenceBackfill } from '../services/assets/referenceBackfill';
import { createBacktestService, type BacktestService } from '../services/backtest/backtestService';
import { createAuditService } from '../services/audit/auditService';
import {
  createConglomerateService,
  type ConglomerateService,
} from '../services/conglomerate/conglomerateService';
import { createAuthService, type AuthService } from '../services/auth/authService';
import { createCurrencyService } from '../services/currency/currencyService';
import {
  createCustomAssetService,
  type CustomAssetService,
} from '../services/customAssets/customAssetService';
import { createMarketDataFxSource } from '../services/currency/marketDataFxSource';
import { createEmailService } from '../services/email/emailService';
import { createSmtpTransport, type MailTransport } from '../services/email/transport';
import { createPasswordHasher } from '../services/password/passwordHasher';
import {
  createPortfolioService,
  type PortfolioService,
} from '../services/portfolio/portfolioService';
import { createCatalogEnrichment } from '../services/search/catalogEnrichment';
import { createSearchService, type SearchService } from '../services/search/searchService';
import { createSessionService } from '../services/sessions/sessionService';
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
  admin: AdminService;
  workboard: WorkboardService;
  /** Cached, resilience-wrapped market data over the Yahoo + manual providers (§5.1). */
  marketData: MarketDataService;
  /** Asset detail/quote/history over the market-data layer (§6.3). */
  assets: AssetService;
  /** Local-first catalog search + background provider enrichment (§6.2). */
  search: SearchService;
  /** Transactions, holdings/totals and the value-over-time series (§6.9). */
  portfolio: PortfolioService;
  /** Custom investments + their value-points editor (§6.9). */
  customAssets: CustomAssetService;
  /** Conglomerate CRUD — user-defined weighted asset baskets (§6.5). */
  conglomerate: ConglomerateService;
  /** Backtest preview over inline draft baskets for the Builder (§6.5, §6.6). */
  backtest: BacktestService;
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
}

/** Composition root: repositories → services → context. */
export function buildContext(deps: BuildContextDeps): AppContext {
  const { config, db, redis, logger } = deps;

  const userRepo = createUserRepository(db);
  const inviteRepo = createInviteRepository(db);
  const auditRepo = createAuditRepository(db);
  // Shared by auth/admin (default-portfolio provisioning at account creation,
  // §5.5) and the portfolio service below.
  const portfolioRepo = createPortfolioRepository(db);

  const sessions = createSessionService(redis, Math.floor(config.cookie.maxAgeMs / 1000));
  const audit = createAuditService(auditRepo);
  const passwordHasher = createPasswordHasher();

  // Only open a real SMTP connection when the channel is configured (§11).
  const transport =
    deps.emailTransport !== undefined
      ? deps.emailTransport
      : config.email.enabled
        ? createSmtpTransport(config.email)
        : null;
  const email = createEmailService({ config, logger, audit, transport });

  const auth = createAuthService({
    config,
    redis,
    userRepo,
    inviteRepo,
    portfolioRepo,
    sessions,
    audit,
    passwordHasher,
    email,
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
  const workboard = createWorkboardService({ repo: workboardRepo, referenceBackfill });

  // Local-first search (§6.2): answers from the Postgres catalog; a thin result
  // set triggers a background, coalesced provider search that enriches it.
  const enrichment = createCatalogEnrichment({ marketData, assetRepo, backfill, redis, logger });
  const search = createSearchService({ assetRepo, enrichment });

  // Portfolio + custom investments (§6.9). The custom-asset service records its
  // optional initial purchase through the portfolio service and shares its
  // value-series cache invalidation.
  const transactionRepo = createTransactionRepository(db);
  const portfolio = createPortfolioService({
    portfolioRepo,
    transactionRepo,
    marketData,
    currencyService: currency,
    referenceBackfill,
    redis,
  });
  const customAssetRepo = createCustomAssetRepository(db);
  const customAssets = createCustomAssetService({ repo: customAssetRepo, portfolio });

  // Conglomerates: user-defined weighted asset baskets, owner-scoped CRUD (§6.5).
  const conglomerateRepo = createConglomerateRepository(db);
  const conglomerate = createConglomerateService({ repo: conglomerateRepo });

  // Backtest preview (§6.5/§6.6): reuses the market-data history + currency
  // keystones to feed the pure engine over inline draft positions.
  const backtestPreview = createBacktestService({
    assetRepo,
    marketData,
    currencyService: currency,
    redis,
  });

  return {
    config,
    redis,
    logger,
    auth,
    admin,
    workboard,
    marketData,
    assets,
    search,
    portfolio,
    customAssets,
    conglomerate,
    backtest: backtestPreview,
  };
}
