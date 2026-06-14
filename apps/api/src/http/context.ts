import type { Redis } from 'ioredis';

import type { AppConfig } from '../config/env';
import type { Database } from '../data/db';
import { createAuditRepository } from '../data/repositories/auditRepository';
import { createInviteRepository } from '../data/repositories/inviteRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import type { Logger } from '../logger';
import { createAdminService, type AdminService } from '../services/admin/adminService';
import { createAuditService } from '../services/audit/auditService';
import { createAuthService, type AuthService } from '../services/auth/authService';
import { createPasswordHasher } from '../services/password/passwordHasher';
import { createSessionService } from '../services/sessions/sessionService';

/** What the HTTP layer needs from the wired application. */
export interface AppContext {
  config: AppConfig;
  redis: Redis;
  logger: Logger;
  auth: AuthService;
  admin: AdminService;
}

export interface BuildContextDeps {
  config: AppConfig;
  db: Database;
  redis: Redis;
  logger: Logger;
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

  const auth = createAuthService({
    config,
    redis,
    userRepo,
    inviteRepo,
    sessions,
    audit,
    passwordHasher,
  });
  const admin = createAdminService({
    config,
    redis,
    userRepo,
    inviteRepo,
    sessions,
    audit,
    passwordHasher,
  });

  return { config, redis, logger, auth, admin };
}
