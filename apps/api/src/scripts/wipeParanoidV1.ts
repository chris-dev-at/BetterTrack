import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

import * as schema from '../data/schema';
import {
  PARANOID_V1_WIPE_CANDIDATES_SQL,
  resultRows,
} from '../services/account/paranoidV1TransitionSql';
import {
  wipeParanoidV1Account,
  type ParanoidV1WipeRefusal,
} from '../services/account/paranoidV1WipeService';

/**
 * PARANOID E9 — the operator entry point for §17 step 2.
 *
 * `docs/paranoid-design.md` §17 makes the transition an OWNER-RUN sequence:
 *
 *   1. `node scripts/ops/export-paranoid-v1-backup.mjs`
 *        → dumps every v1 blob, verifies the archive off disk, records an
 *          attestation. Destroys nothing.
 *   2. copy the archive offsite, digest the copy, then
 *      `node scripts/ops/export-paranoid-v1-backup.mjs --confirm-offsite <sha> --archive <path>`
 *        → §17's "offsite copy confirmed". Still destroys nothing.
 *   3. `pnpm --filter @bettertrack/api wipe:paranoid-v1 --execute`
 *        → THIS script. The only step that destroys anything.
 *
 * There is no HTTP route into the wipe, by design (see `paranoidV1WipeService`),
 * so this file plus a shell on the prod host is the entire attack surface of the
 * destructive path.
 *
 * Default mode is a read-only listing. `--execute` is required to destroy, and
 * even then every account is re-checked against the gate inside its own
 * transaction: a listing that says "eligible" is a hint, never a promise, and the
 * service is the only authority. Accounts are processed one at a time and a
 * refusal on one never aborts the others.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const argv = process.argv.slice(2);
const execute = argv.includes('--execute');
const unknown = argv.filter((a) => a !== '--execute');
if (unknown.length > 0) {
  throw new Error(`Unknown argument(s): ${unknown.join(', ')}`);
}

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema });

const candidates = resultRows<{ user_id: string; attestation_id: string }>(
  await db.execute(sql.raw(PARANOID_V1_WIPE_CANDIDATES_SQL)),
);

console.log(
  `${candidates.length} account(s) covered by an offsite-confirmed backup and not yet wiped.`,
);

if (!execute) {
  for (const row of candidates)
    console.log(`  ${row.user_id}  (attestation ${row.attestation_id})`);
  console.log(
    '\nRead-only listing — nothing was destroyed.\n' +
      'Re-run with --execute to perform the §17 wipe. Make sure the archive really ' +
      'is offsite first: the wipe is irreversible and the legacy passphrase dies with it.',
  );
  await client.end({ timeout: 5 });
  process.exit(0);
}

let wiped = 0;
const refusals = new Map<ParanoidV1WipeRefusal, number>();

for (const row of candidates) {
  const outcome = await wipeParanoidV1Account(db, row.user_id);
  if (outcome.ok) {
    wiped += 1;
    console.log(`  wiped   ${row.user_id}`);
  } else {
    const refusal = outcome.refusal!;
    refusals.set(refusal, (refusals.get(refusal) ?? 0) + 1);
    console.log(`  refused ${row.user_id}  (${refusal})`);
  }
}

console.log(`\nWiped ${wiped} account(s).`);
for (const [refusal, count] of refusals) console.log(`  ${refusal}: ${count}`);
console.log(
  'Each wiped account now has a `paranoid_v1_wipe_receipts` row: its rows are in the ' +
    '`zz_paranoid_v1_backup_*` quarantine, its `privacy_mode` is `normal`, and it owes ' +
    'the one-time §17 fresh-start notice at next login.',
);

await client.end({ timeout: 5 });
