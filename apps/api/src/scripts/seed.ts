import { pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { type AppConfig, loadConfig } from '../config/env';
import { createAssetRepository } from '../data/repositories/assetRepository';
import { createOAuthRepository } from '../data/repositories/oauthRepository';
import { createPortfolioRepository } from '../data/repositories/portfolioRepository';
import { type CreateUserInput, createUserRepository } from '../data/repositories/userRepository';
import * as schema from '../data/schema';
import { seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { isKnownSecretPlaceholder } from '../services/password/knownPlaceholders';
import { createPasswordHasher } from '../services/password/passwordHasher';
import { checkPasswordPolicy } from '../services/password/passwordPolicy';
import { COMMON_SYMBOLS_SEED, seedAssetCatalog } from '../services/search/catalogSeed';

/**
 * The separate demo *user* account (§3, §5.5): admins are management-only and
 * have no portfolio/workboard/social surface, so trying out the app is done
 * with a normal user account rather than the admin. Created once, portfolio-
 * backed, alongside the portfolio-less first admin.
 */
const DEMO_EMAIL = 'demo@bettertrack.local';
const DEMO_USERNAME = 'demo';

export interface SeedAccount {
  id: string;
  email: string;
  username: string;
}

export interface SeedOptions {
  nodeEnv: AppConfig['nodeEnv'];
  adminEmail?: string;
  adminPassword?: string;
  demoEnabled: boolean;
  demoPassword?: string;
}

export interface SeedDependencies {
  users: {
    findByEmail(email: string): Promise<SeedAccount | undefined>;
    create(input: CreateUserInput): Promise<SeedAccount>;
  };
  portfolios: {
    createDefault(userId: string): Promise<unknown>;
  };
  hasher: {
    hash(password: string): Promise<string>;
  };
  seedCatalog(): Promise<{ created: number; existing: number }>;
  seedOAuthClients(): Promise<
    Array<{ clientId: string; action: string; scopes: readonly string[] }>
  >;
}

export interface SeedOutput {
  info(message: string): void;
  error(message: string): void;
}

class SeedOperatorError extends Error {}

function parseDemoFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'false') return false;
  if (normalized === 'true') return true;
  throw new SeedOperatorError('BT_SEED_DEMO must be exactly "true" or "false".');
}

/** Read seed-only controls without retaining demo credentials in the app config. */
export function seedOptionsFromEnv(
  config: Pick<AppConfig, 'nodeEnv' | 'admin'>,
  env: NodeJS.ProcessEnv = process.env,
): SeedOptions {
  return {
    nodeEnv: config.nodeEnv,
    adminEmail: config.admin.email,
    adminPassword: config.admin.password,
    demoEnabled: parseDemoFlag(env.BT_SEED_DEMO),
    demoPassword: env.BT_DEMO_PASSWORD,
  };
}

function validateProductionPassword(name: 'ADMIN_PASSWORD' | 'BT_DEMO_PASSWORD', value: string) {
  if (isKnownSecretPlaceholder(value)) {
    throw new SeedOperatorError(
      `${name} is a known published placeholder; generate a unique password before seeding.`,
    );
  }

  const policy = checkPasswordPolicy(value);
  if (!policy.ok) {
    throw new SeedOperatorError(`${name} does not meet the password policy: ${policy.reason}`);
  }
}

/**
 * Idempotently seed bootstrap accounts and shared catalog rows.
 *
 * Existing accounts are looked up before password gates run. This preserves
 * safe re-runs for deployed installations whose one-use bootstrap password has
 * since been removed or changed. For new accounts, every applicable credential
 * is validated before the first write.
 */
export async function seedDatabase(
  options: SeedOptions,
  dependencies: SeedDependencies,
  output: SeedOutput,
): Promise<void> {
  const adminEmail = options.adminEmail?.trim();
  if (!adminEmail) {
    throw new SeedOperatorError('ADMIN_EMAIL must be set to seed the first admin.');
  }

  const existingAdmin = await dependencies.users.findByEmail(adminEmail);
  const existingDemo = options.demoEnabled
    ? await dependencies.users.findByEmail(DEMO_EMAIL)
    : undefined;

  if (!existingAdmin) {
    if (!options.adminPassword) {
      throw new SeedOperatorError(
        'ADMIN_PASSWORD must be set when seeding the first admin. No accounts were created.',
      );
    }
    if (options.nodeEnv === 'production') {
      validateProductionPassword('ADMIN_PASSWORD', options.adminPassword);
    }
  }

  if (options.demoEnabled && !existingDemo) {
    if (!options.demoPassword) {
      throw new SeedOperatorError(
        'BT_DEMO_PASSWORD must be set when BT_SEED_DEMO=true. No accounts were created.',
      );
    }
    if (options.nodeEnv === 'production') {
      validateProductionPassword('BT_DEMO_PASSWORD', options.demoPassword);
    }
  }

  // First-boot only: do nothing if the admin already exists (PROJECTPLAN.md §11).
  // The first admin is management-only — no default portfolio is provisioned (§5.5).
  if (existingAdmin) {
    output.info(`Admin ${adminEmail} already exists — skipping seed.`);
  } else {
    const localPart = adminEmail.split('@')[0] ?? 'admin';
    const username = localPart.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40) || 'admin';
    const passwordHash = await dependencies.hasher.hash(options.adminPassword!);
    const admin = await dependencies.users.create({
      email: adminEmail,
      username,
      passwordHash,
      role: 'admin',
      status: 'active',
      mustChangePassword: false,
    });
    output.info(`Created admin account: ${admin.email} (username: ${admin.username}).`);
  }

  // Demo data is an explicit opt-in in every environment. An existing demo row
  // is left untouched, and a new credential must come from BT_DEMO_PASSWORD.
  if (options.demoEnabled) {
    if (existingDemo) {
      output.info(`Demo user ${DEMO_EMAIL} already exists — skipping.`);
    } else {
      const passwordHash = await dependencies.hasher.hash(options.demoPassword!);
      const demo = await dependencies.users.create({
        email: DEMO_EMAIL,
        username: DEMO_USERNAME,
        passwordHash,
        role: 'user',
        status: 'active',
        mustChangePassword: true,
      });
      await dependencies.portfolios.createDefault(demo.id);
      output.info(
        `Created demo user: ${demo.email} (username: ${demo.username}) with a default portfolio.`,
      );
    }
  }

  // Shipped common-symbols catalog (§6.2(c)) — idempotent, so re-seeding is safe.
  const catalogSeed = await dependencies.seedCatalog();
  output.info(
    `Asset catalog seed: ${catalogSeed.created} created, ${catalogSeed.existing} already present.`,
  );

  // First-party OAuth clients (#395): idempotently upsert the known official
  // apps. Never narrows an existing row's scopes or redirect URIs.
  const clientResults = await dependencies.seedOAuthClients();
  for (const result of clientResults) {
    output.info(
      `First-party OAuth client ${result.clientId}: ${result.action} (${result.scopes.length} scopes).`,
    );
  }
}

function safeSeedError(error: unknown): string {
  if (error instanceof SeedOperatorError) return error.message;
  if (error instanceof Error && error.message.startsWith('Invalid environment configuration:')) {
    return error.message;
  }
  return 'Seed failed unexpectedly. Check database connectivity and retry; no credential values were printed.';
}

/** Convert seed failures into a non-zero command result with secret-safe output. */
export async function runSeedCommand(
  options: SeedOptions,
  dependencies: SeedDependencies,
  output: SeedOutput,
): Promise<0 | 1> {
  try {
    await seedDatabase(options, dependencies, output);
    return 0;
  } catch (error) {
    output.error(safeSeedError(error));
    return 1;
  }
}

async function main(): Promise<0 | 1> {
  let client: ReturnType<typeof postgres> | undefined;
  const output: SeedOutput = {
    info: (message) => console.log(message),
    error: (message) => console.error(message),
  };

  try {
    const config = loadConfig();
    const options = seedOptionsFromEnv(config);
    client = postgres(config.databaseUrl, { max: 1 });
    const db = drizzle(client, { schema });
    const userRepo = createUserRepository(db);
    const portfolioRepo = createPortfolioRepository(db);
    const hasher = createPasswordHasher();
    const assetRepo = createAssetRepository(db);
    const oauthRepo = createOAuthRepository(db);

    return await runSeedCommand(
      options,
      {
        users: userRepo,
        portfolios: portfolioRepo,
        hasher,
        seedCatalog: () => seedAssetCatalog(assetRepo, COMMON_SYMBOLS_SEED),
        seedOAuthClients: () => seedFirstPartyClients(oauthRepo),
      },
      output,
    );
  } catch (error) {
    output.error(safeSeedError(error));
    return 1;
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        output.error('Seed database connection did not close cleanly.');
      }
    }
  }
}

// Importing helpers in tests must never connect to a database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
