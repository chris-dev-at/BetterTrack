import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { loadConfig } from '../config/env';
import { createAssetRepository } from '../data/repositories/assetRepository';
import { createOAuthRepository } from '../data/repositories/oauthRepository';
import { createPortfolioRepository } from '../data/repositories/portfolioRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import * as schema from '../data/schema';
import { seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createPasswordHasher } from '../services/password/passwordHasher';
import { COMMON_SYMBOLS_SEED, seedAssetCatalog } from '../services/search/catalogSeed';
import { generateTempPassword } from '../services/password/tempPassword';

/**
 * The separate demo *user* account (§3, §5.5): admins are management-only and
 * have no portfolio/workboard/social surface, so trying out the app is done
 * with a normal user account rather than the admin. Created once, portfolio-
 * backed, alongside the portfolio-less first admin.
 */
const DEMO_EMAIL = 'demo@bettertrack.local';
const DEMO_USERNAME = 'demo';

const config = loadConfig();

if (!config.admin.email || !config.admin.password) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD must be set to seed the first admin.');
  process.exit(1);
}

const client = postgres(config.databaseUrl, { max: 1 });
const db = drizzle(client, { schema });
const userRepo = createUserRepository(db);
const portfolioRepo = createPortfolioRepository(db);
const hasher = createPasswordHasher();

// First-boot only: do nothing if the admin already exists (PROJECTPLAN.md §11).
// The first admin is management-only — no default portfolio is provisioned (§5.5).
const existing = await userRepo.findByEmail(config.admin.email);
if (existing) {
  console.log(`Admin ${config.admin.email} already exists — skipping seed.`);
} else {
  const localPart = config.admin.email.split('@')[0] ?? 'admin';
  const username = localPart.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40) || 'admin';
  const passwordHash = await hasher.hash(config.admin.password);
  const admin = await userRepo.create({
    email: config.admin.email,
    username,
    passwordHash,
    role: 'admin',
    status: 'active',
    mustChangePassword: false,
  });
  console.log(`Created admin account: ${admin.email} (username: ${admin.username}).`);
}

// The separate demo *user* (§3, §5.5), idempotent like the admin above. Gets a
// one-time temp password (printed once) and a default portfolio, so a fresh
// deploy has a real account for trying the app without touching the admin.
const existingDemo = await userRepo.findByEmail(DEMO_EMAIL);
if (existingDemo) {
  console.log(`Demo user ${DEMO_EMAIL} already exists — skipping.`);
} else {
  const demoPassword = generateTempPassword();
  const passwordHash = await hasher.hash(demoPassword);
  const demo = await userRepo.create({
    email: DEMO_EMAIL,
    username: DEMO_USERNAME,
    passwordHash,
    role: 'user',
    status: 'active',
    mustChangePassword: true,
  });
  await portfolioRepo.createDefault(demo.id);
  console.log(
    `Created demo user: ${demo.email} (username: ${demo.username}) with a default portfolio.`,
  );
  console.log(`  Temporary password (change on first login): ${demoPassword}`);
}

// Shipped common-symbols catalog (§6.2(c)) — idempotent, so re-seeding is safe.
const assetRepo = createAssetRepository(db);
const catalogSeed = await seedAssetCatalog(assetRepo, COMMON_SYMBOLS_SEED);
console.log(
  `Asset catalog seed: ${catalogSeed.created} created, ${catalogSeed.existing} already present.`,
);

// First-party OAuth clients (#395): idempotently upsert the known official apps
// (currently BetterTrackMobile) from their code-defined single source of truth,
// so a fresh database always has the mobile OAuth client — no manual admin step,
// and no "unknown client" on a reset-without-restore. Never narrows an existing
// row's scopes or redirect URIs (see seedFirstPartyClients).
const oauthRepo = createOAuthRepository(db);
const clientResults = await seedFirstPartyClients(oauthRepo);
for (const result of clientResults) {
  console.log(
    `First-party OAuth client ${result.clientId}: ${result.action} (${result.scopes.length} scopes).`,
  );
}

await client.end();
