import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import * as schema from '../data/schema';
import { createNotificationRepository } from '../data/repositories/notificationRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import { announceLeanEmailDefaults } from '../services/notifications/leanEmailAnnouncement';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema });

await migrate(db, { migrationsFolder });

// One-time data migration (V4-P0c, §16): announce the lean email defaults to
// every existing user. Idempotent via the fixed announcement eventKey, so a
// re-run on a later deploy is a no-op for anyone already notified.
const announced = await announceLeanEmailDefaults({
  users: createUserRepository(db),
  notifications: createNotificationRepository(db),
});

await client.end();

console.log(
  `Migrations applied. Lean-email-defaults announcement: ${announced.inserted} new of ${announced.users} users.`,
);
