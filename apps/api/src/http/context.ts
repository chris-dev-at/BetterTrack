import type { Redis } from 'ioredis';

import type { AppConfig } from '../config/env';
import type { Database } from '../data/db';
import { createAssetRepository } from '../data/repositories/assetRepository';
import { createAuditRepository } from '../data/repositories/auditRepository';
import { createInviteRepository } from '../data/repositories/inviteRepository';
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
import { createAuditService } from '../services/audit/auditService';
import { createAuthService, type AuthService } from '../services/auth/authService';
import { createEmailService } from '../services/email/emailService';
import { createSmtpTransport, type MailTransport } from '../services/email/transport';
import { createPasswordHasher } from '../services/password/passwordHasher';
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
  /** Search + asset detail/quote/history over the market-data layer (§6.2, §6.3). */
  assets: AssetService;
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
    sessions,
    audit,
    passwordHasher,
    email,
  });

  const workboardRepo = createWorkboardRepository(db);
  const workboard = createWorkboardService({ repo: workboardRepo });

  // Registers the Yahoo + manual providers and wraps them in caching/resilience
  // (§5.1–§5.2). `registry.for(asset)` lives inside; routes use the service.
  const marketData = deps.marketData ?? createMarketData({ db, redis }).service;

  // First-touch backfill enqueue (§6.2/§9). In tests no BullMQ worker runs, so
  // default to a no-op; production enqueues onto the shared Redis-backed queue.
  const backfill =
    deps.backfill ??
    (config.isTest ? noopBackfillScheduler : createBackfillScheduler(createQueueRegistry(redis)));

  const assetRepo = createAssetRepository(db);
  const assets = createAssetService({ marketData, assetRepo, backfill });

  return { config, redis, logger, auth, admin, workboard, marketData, assets };
}
