import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CI guard (#606): released migrations are immutable — only appends are allowed.
 *
 * drizzle's postgres migrator does not evaluate migrations individually. It
 * reads `max(created_at)` from `drizzle.__drizzle_migrations` and re-runs every
 * journal entry whose `when` is greater. So bumping the `when` of a migration a
 * deployed DB has ALREADY applied makes it permanently "in the future": that DB
 * re-runs it forever and dies on `CREATE TABLE ... already exists`. A fresh DB
 * (the CI `integration` job) applies everything in order and never notices —
 * which is exactly why only a deployed database can break, and why the
 * fresh-Postgres job can't catch this. On 2026-07-16 a rebase let drizzle-kit
 * regenerate `_journal.json` and rewrite the `when` of two already-released
 * migrations; live re-ran them and failed 585 consecutive deploys over 2 days.
 *
 * This compares the PR's journal + migration SQL against the base branch and
 * fails on any change to an existing entry (its `when`, `tag`, or `.sql`
 * content) or a deletion. Deterministic, network-free, git-only.
 *
 * Needs the base branch present: the `verify` job checks out with
 * `fetch-depth: 0` and the CI step fetches `origin/main` before running this.
 */

const DIR = 'apps/api/drizzle';
const JOURNAL = `${DIR}/meta/_journal.json`;

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

interface Journal {
  entries: JournalEntry[];
}

const baseRef = process.argv[2] ?? 'origin/main';
const headRef = process.argv[3] ?? null;

// Anchor filesystem reads to the repo root so the check works regardless of the
// process cwd (pnpm --filter runs it from apps/api, git paths are repo-relative).
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const show = (ref: string, path: string): string =>
  execFileSync('git', ['show', `${ref}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

const readHead = (path: string): string =>
  headRef ? show(headRef, path) : readFileSync(join(repoRoot, path), 'utf8');

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

let baseJournal: Journal;
try {
  baseJournal = JSON.parse(show(baseRef, JOURNAL)) as Journal;
} catch {
  console.log(`No journal at ${baseRef} — nothing to compare against.`);
  process.exit(0);
}
const headJournal = JSON.parse(readHead(JOURNAL)) as Journal;

const headByIdx = new Map(headJournal.entries.map((e) => [e.idx, e]));
const violations: string[] = [];

for (const base of baseJournal.entries) {
  const head = headByIdx.get(base.idx);
  if (!head) {
    violations.push(`${base.tag}: entry idx ${base.idx} was DELETED from the journal`);
    continue;
  }
  if (head.tag !== base.tag) {
    violations.push(`idx ${base.idx}: tag changed ${base.tag} -> ${head.tag}`);
    continue;
  }
  if (head.when !== base.when) {
    violations.push(
      `${base.tag}: \`when\` changed ${base.when} -> ${head.when} ` +
        `(a deployed DB already recorded ${base.when} and will re-run this migration)`,
    );
  }
  const p = `${DIR}/${base.tag}.sql`;
  let baseSql: string;
  try {
    baseSql = show(baseRef, p);
  } catch {
    continue; // entry present without a file at base — nothing to freeze
  }
  let headSql: string;
  try {
    headSql = readHead(p);
  } catch {
    violations.push(`${base.tag}: ${p} was DELETED`);
    continue;
  }
  if (sha(baseSql) !== sha(headSql)) {
    violations.push(`${base.tag}: ${p} was MODIFIED after release (content hash changed)`);
  }
}

const appended = headJournal.entries.length - baseJournal.entries.length;

if (violations.length > 0) {
  console.error('Released migrations are immutable — these entries changed:\n');
  for (const v of violations) console.error(`  x ${v}`);
  console.error(
    `\nFix: restore the original \`when\`/content and put your change in a NEW migration.\n` +
      `If drizzle-kit regenerated the journal during a rebase, revert ${JOURNAL} to the\n` +
      `base version and re-append only your own entry.\n`,
  );
  process.exit(1);
}

console.log(
  `Migrations immutable OK — ${baseJournal.entries.length} released entries unchanged` +
    (appended > 0 ? `, ${appended} appended.` : '.'),
);
