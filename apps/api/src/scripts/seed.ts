import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { loadConfig } from '../config/env';
import { createUserRepository } from '../data/repositories/userRepository';
import * as schema from '../data/schema';
import { createPasswordHasher } from '../services/password/passwordHasher';

const config = loadConfig();

if (!config.admin.email || !config.admin.password) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD must be set to seed the first admin.');
  process.exit(1);
}

const client = postgres(config.databaseUrl, { max: 1 });
const db = drizzle(client, { schema });
const userRepo = createUserRepository(db);
const hasher = createPasswordHasher();

// First-boot only: do nothing if the admin already exists (PROJECTPLAN.md §11).
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

await client.end();
