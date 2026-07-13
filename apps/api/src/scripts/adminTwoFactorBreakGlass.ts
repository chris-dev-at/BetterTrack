import { pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { Database } from '../data/db';
import { createAuditRepository } from '../data/repositories/auditRepository';
import { createTwoFactorRepository } from '../data/repositories/twoFactorRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import { AuditAction, createAuditService } from '../services/audit/auditService';

/**
 * Break-glass reset of an admin's 2FA enrollment (PROJECTPLAN.md §6.12, #400).
 *
 * Mandatory admin-login 2FA has NO web/API bypass of any kind (owner decision 4):
 * an admin who loses BOTH their authenticator and their 2FA email — and their
 * recovery codes — can only be recovered from a shell on the live box. Possession
 * of shell + DB access IS the authorization; there is deliberately no additional
 * secret. This clears every 2FA method for the named admin (TOTP secret + flags,
 * the email method + the 2FA email) and deletes their recovery codes, dropping the
 * account back into the mandatory-setup state — password login still works and the
 * forced enrollment wizard runs on next admin login.
 *
 * Refuses to touch a non-admin account: this must never be a way to strip a
 * user's 2FA.
 */

export interface BreakGlassResult {
  id: string;
  username: string;
  email: string;
}

/**
 * The reset itself, split out so it is unit/integration-testable against any
 * `Database` (PGlite in tests, real Postgres in {@link main}). Returns the reset
 * admin, or null when the identifier matches no ACTIVE-or-disabled ADMIN account
 * (unknown, or a user-kind account — which is left untouched).
 */
export async function resetAdminTwoFactorEnrollment(
  db: Database,
  identifier: string,
): Promise<BreakGlassResult | null> {
  const userRepo = createUserRepository(db);
  const twoFactorRepo = createTwoFactorRepository(db);
  const audit = createAuditService(createAuditRepository(db));

  const user = await userRepo.findByIdentifier(identifier);
  if (!user || user.role !== 'admin') return null;

  // Clear both methods + the 2FA email, then drop every recovery code. Order is
  // not load-bearing — the account simply ends with no 2FA state at all.
  await twoFactorRepo.clearTotpSecret(user.id);
  await twoFactorRepo.setEmailEnabled(user.id, false);
  await twoFactorRepo.setTwoFactorEmail(user.id, null);
  await twoFactorRepo.clearRecoveryCodes(user.id);

  // Security trail (§10): actorId is null — this ran from a shell, not a session.
  await audit.record({
    action: AuditAction.AdminTwoFactorReset,
    targetType: 'user',
    targetId: user.id,
    meta: { via: 'break_glass_script' },
  });

  return { id: user.id, username: user.username, email: user.email };
}

/** Parse the admin identifier (email or username) from argv; throws on misuse. */
export function parseIdentifier(argv: readonly string[]): string {
  const identifier = argv[2]?.trim();
  if (!identifier) {
    throw new Error(
      'Usage: pnpm --filter @bettertrack/api admin:break-glass <admin-email-or-username>',
    );
  }
  return identifier;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required — run this on the box with direct DB access.');
  }
  const identifier = parseIdentifier(process.argv);

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client) as unknown as Database;
  try {
    const result = await resetAdminTwoFactorEnrollment(db, identifier);
    if (!result) {
      console.error(`No admin account matches "${identifier}". No changes made.`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Reset 2FA enrollment for admin ${result.username} <${result.email}> (${result.id}).`,
    );
    console.log('They will be forced to re-enroll two-factor auth on their next admin login.');
  } finally {
    await client.end();
  }
}

// Run only when invoked directly (`tsx adminTwoFactorBreakGlass.ts <id>`); importing
// the module for its exported helpers (tests) must not connect to a database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
