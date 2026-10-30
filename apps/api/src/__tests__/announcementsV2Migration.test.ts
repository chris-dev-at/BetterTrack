import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration `0122_announcements_v2` (PROJECTPLAN §6.19.5).
 *
 * The load-bearing property is a NEGATIVE one: merge is deploy, so this file
 * runs unattended against production the moment it lands — and it must not
 * lose a single dismissal. Every `announcement_dismissals` row has to come out
 * the other side as a `notice` dismissal with the same user, announcement and
 * instant. The rest pins the backfill of every legacy row shape, that a second
 * application changes nothing, that every CHECK refuses its illegal
 * combination, and that the RESTRICT keys refuse a delete that would lose
 * evidence.
 */

const drizzleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const TAG = '0122_announcements_v2';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

function journal(): JournalEntry[] {
  const parsed = JSON.parse(readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return parsed.entries;
}

/** Apply one migration file the way drizzle's migrator does: statement chunks, one transaction. */
async function applyMigration(client: PGlite, tag: string): Promise<void> {
  const sql = readFileSync(path.join(drizzleDir, `${tag}.sql`), 'utf8');
  const chunks = sql
    .split(/-->\s*statement-breakpoint\s*/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  await client.exec('BEGIN');
  try {
    for (const chunk of chunks) await client.exec(chunk);
    await client.exec('COMMIT');
  } catch (err) {
    await client.exec('ROLLBACK');
    throw err;
  }
}

/** Boot a PGlite with every migration BEFORE `TAG` (array order) applied. */
async function bootBefore(): Promise<PGlite> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const entries = journal();
  const index = entries.findIndex((e) => e.tag === TAG);
  if (index < 1) throw new Error(`${TAG} is not in the journal`);
  for (const entry of entries.slice(0, index)) await applyMigration(client, entry.tag);
  return client;
}

const U1 = '019756a0-0000-7000-8000-00000000a101';
const U2 = '019756a0-0000-7000-8000-00000000a102';
const ADMIN = '019756a0-0000-7000-8000-00000000a1ad';
/** Legacy shapes. */
const LIVE = '019756a0-0000-7000-8000-00000000a201'; //   active, delivered
const SCHEDULED = '019756a0-0000-7000-8000-00000000a202'; // active, window not open
const WITHDRAWN = '019756a0-0000-7000-8000-00000000a203'; // inactive, delivered
const SEEN_DRAFT = '019756a0-0000-7000-8000-00000000a204'; // inactive, never delivered, dismissed
const DRAFT = '019756a0-0000-7000-8000-00000000a205'; //     inactive, never delivered, untouched
const OPEN_UNSTAMPED = '019756a0-0000-7000-8000-00000000a206'; // active, no window, not yet walked

async function seedLegacy(client: PGlite): Promise<void> {
  await client.exec(`
    INSERT INTO "users" ("id", "email", "username", "password_hash", "role")
    VALUES ('${U1}', 'u1@example.test', 'u1', 'x', 'user'),
           ('${U2}', 'u2@example.test', 'u2', 'x', 'user'),
           ('${ADMIN}', 'ad@example.test', 'ad', 'x', 'admin');
    INSERT INTO "announcements"
      ("id", "severity", "title_en", "body_en", "title_de", "body_de", "starts_at", "ends_at",
       "active", "published_at", "created_by", "created_at", "updated_at")
    VALUES
      ('${LIVE}', 'info', 'Live', 'Body', 'Live DE', 'Text', '2026-09-01T08:00:00Z', NULL,
        true, '2026-09-01T08:05:00Z', '${ADMIN}', '2026-08-30T00:00:00Z', '2026-09-01T08:05:00Z'),
      ('${SCHEDULED}', 'warning', 'Later', 'Body', 'Später', 'Text', '2027-01-01T00:00:00Z', NULL,
        true, NULL, '${ADMIN}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
      ('${WITHDRAWN}', 'critical', 'Gone', 'Body', 'Weg', 'Text', NULL, NULL,
        false, '2026-07-01T10:00:00Z', '${ADMIN}', '2026-07-01T09:00:00Z', '2026-07-20T12:00:00Z'),
      ('${SEEN_DRAFT}', 'info', 'Seen draft', 'Body', 'Entwurf', 'Text', NULL, NULL,
        false, NULL, '${ADMIN}', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z'),
      ('${DRAFT}', 'info', 'Draft', 'Body', 'Entwurf', 'Text', NULL, NULL,
        false, NULL, '${ADMIN}', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'),
      ('${OPEN_UNSTAMPED}', 'info', 'Open', 'Body', 'Offen', 'Text', NULL, NULL,
        true, NULL, NULL, '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z');
    INSERT INTO "announcement_dismissals" ("user_id", "announcement_id", "dismissed_at")
    VALUES ('${U1}', '${LIVE}', '2026-09-02T10:00:00Z'),
           ('${U2}', '${LIVE}', '2026-09-03T11:00:00Z'),
           ('${U1}', '${WITHDRAWN}', '2026-07-02T10:00:00Z'),
           ('${U2}', '${SEEN_DRAFT}', '2026-06-03T10:00:00Z');
  `);
}

interface AnnouncementState {
  id: string;
  kind: string;
  audience: string;
  lifecycle: string;
  body_format: string;
  active: boolean;
  released_at: Date | null;
  audience_cutoff_at: Date | null;
  archived_at: Date | null;
  title_de: string | null;
  notify_by_email: boolean;
  notify_by_email_after_days: number;
}

async function announcementStates(client: PGlite): Promise<Map<string, AnnouncementState>> {
  const res = await client.query<AnnouncementState>(`
    SELECT "id", "kind", "audience", "lifecycle", "body_format", "active", "released_at",
           "audience_cutoff_at", "archived_at", "title_de", "notify_by_email",
           "notify_by_email_after_days"
      FROM "announcements" ORDER BY "id"`);
  return new Map(res.rows.map((row) => [row.id, row]));
}

interface ReceiptState {
  id: string;
  user_id: string | null;
  announcement_id: string;
  dismissed_at: Date | null;
  seen_at: Date | null;
  acknowledged_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

async function receiptStates(client: PGlite): Promise<ReceiptState[]> {
  const res = await client.query<ReceiptState>(`
    SELECT "id", "user_id", "announcement_id", "dismissed_at", "seen_at", "acknowledged_at",
           "created_at", "updated_at"
      FROM "announcement_receipts" ORDER BY "announcement_id", "user_id"`);
  return res.rows;
}

async function constraintNames(client: PGlite): Promise<string[]> {
  const res = await client.query<{ name: string }>(`
    SELECT c.conname AS name FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname IN ('announcements', 'announcement_receipts') ORDER BY 1`);
  return res.rows.map((row) => row.name);
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

describe('migration 0122_announcements_v2', () => {
  let client: PGlite;

  beforeAll(async () => {
    client = await bootBefore();
    await seedLegacy(client);
    await applyMigration(client, TAG);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
  });

  it('is appended: idx 122 with a `when` above every earlier entry', () => {
    const entries = journal();
    const index = entries.findIndex((e) => e.tag === TAG);
    const mine = entries[index]!;
    expect(mine.idx).toBe(122);
    for (const earlier of entries.slice(0, index)) {
      expect(mine.when, earlier.tag).toBeGreaterThan(earlier.when);
    }
  });

  it('loses no dismissal: every legacy row survives as a notice dismissal at its original instant', async () => {
    const rows = await receiptStates(client);
    expect(
      rows.map((r) => [r.announcement_id, r.user_id, iso(r.dismissed_at), iso(r.seen_at)]),
    ).toEqual(
      [
        [LIVE, U1, '2026-09-02T10:00:00.000Z', null],
        [LIVE, U2, '2026-09-03T11:00:00.000Z', null],
        [WITHDRAWN, U1, '2026-07-02T10:00:00.000Z', null],
        [SEEN_DRAFT, U2, '2026-06-03T10:00:00.000Z', null],
      ].sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)),
    );
    for (const row of rows) {
      // The dismissal instant, not the deploy instant.
      expect(iso(row.created_at)).toBe(iso(row.dismissed_at));
      expect(iso(row.updated_at)).toBe(iso(row.dismissed_at));
      expect(row.acknowledged_at).toBeNull();
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const kinds = await client.query<{ kind: string }>(`
      SELECT DISTINCT a."kind" FROM "announcement_receipts" r
        JOIN "announcements" a ON a."id" = r."announcement_id"`);
    expect(kinds.rows).toEqual([{ kind: 'notice' }]);
    const old = await client.query(`SELECT to_regclass('public.announcement_dismissals') AS t`);
    expect(old.rows).toEqual([{ t: null }]);
  });

  it('backfills each legacy row shape into the lifecycle the CHECKs demand', async () => {
    const states = await announcementStates(client);
    const shape = (id: string) => {
      const row = states.get(id)!;
      return {
        lifecycle: row.lifecycle,
        active: row.active,
        released: iso(row.released_at),
        cutoff: iso(row.audience_cutoff_at),
        archived: iso(row.archived_at),
      };
    };
    expect(shape(LIVE)).toEqual({
      lifecycle: 'published',
      active: true,
      released: '2026-09-01T08:05:00.000Z', // published_at
      cutoff: '2026-09-01T08:05:00.000Z', // later of published_at and starts_at
      archived: null,
    });
    expect(shape(SCHEDULED)).toEqual({
      lifecycle: 'published',
      active: true,
      released: '2027-01-01T00:00:00.000Z', // starts_at (never delivered)
      cutoff: '2027-01-01T00:00:00.000Z',
      archived: null,
    });
    expect(shape(WITHDRAWN)).toEqual({
      lifecycle: 'archived',
      active: false,
      released: '2026-07-01T10:00:00.000Z',
      cutoff: '2026-07-01T10:00:00.000Z',
      archived: '2026-07-20T12:00:00.000Z', // updated_at: when it was switched off
    });
    // CEO addendum 2026-10-30: never stamped, but users saw (and dismissed) it
    // → archived, so the RESTRICT key can never block deleting a "draft".
    expect(shape(SEEN_DRAFT)).toEqual({
      lifecycle: 'archived',
      active: false,
      released: '2026-06-01T00:00:00.000Z', // created_at
      cutoff: '2026-06-01T00:00:00.000Z',
      archived: '2026-06-02T00:00:00.000Z',
    });
    expect(shape(DRAFT)).toEqual({
      lifecycle: 'draft',
      active: false,
      released: null,
      cutoff: null,
      archived: null,
    });
    expect(shape(OPEN_UNSTAMPED)).toEqual({
      lifecycle: 'published',
      active: true,
      released: '2026-10-29T00:00:00.000Z',
      cutoff: '2026-10-29T00:00:00.000Z',
      archived: null,
    });
    for (const row of states.values()) {
      expect(row.kind).toBe('notice');
      expect(row.audience).toBe('everyone');
      expect(row.body_format).toBe('plain');
      expect(row.notify_by_email).toBe(false);
      expect(row.notify_by_email_after_days).toBe(7);
      expect(row.title_de).not.toBeNull();
      // The one-release lockstep.
      expect(row.active).toBe(row.lifecycle === 'published');
    }
  });

  it('is re-runnable: a second application changes no row and no constraint', async () => {
    const before = {
      announcements: [...(await announcementStates(client)).values()],
      receipts: await receiptStates(client),
      constraints: await constraintNames(client),
    };
    await applyMigration(client, TAG);
    expect({
      announcements: [...(await announcementStates(client)).values()],
      receipts: await receiptStates(client),
      constraints: await constraintNames(client),
    }).toEqual(before);
  });

  it('new rows take the v2 defaults: markdown, e-mail off at 7 days, a generated receipt id', async () => {
    const id = '019756a0-0000-7000-8000-00000000a2ff';
    await client.exec(`
      INSERT INTO "announcements" ("id", "title_en", "body_en") VALUES ('${id}', 'New', 'Body');
      INSERT INTO "announcement_receipts" ("user_id", "announcement_id", "seen_at")
      VALUES ('${U1}', '${id}', now());`);
    const states = await announcementStates(client);
    expect(states.get(id)).toMatchObject({
      kind: 'notice',
      audience: 'everyone',
      lifecycle: 'draft',
      body_format: 'markdown',
      notify_by_email: false,
      notify_by_email_after_days: 7,
      title_de: null,
    });
    const receipt = await client.query<{ id: string }>(
      `SELECT "id" FROM "announcement_receipts" WHERE "announcement_id" = '${id}'`,
    );
    expect(receipt.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    await client.exec(`DELETE FROM "announcement_receipts" WHERE "announcement_id" = '${id}';
                       DELETE FROM "announcements" WHERE "id" = '${id}';`);
  });

  /** Run `statement` in a savepoint and return the SQLSTATE it failed with, or null. */
  async function refusal(statement: string): Promise<string | null> {
    await client.exec('BEGIN');
    try {
      await client.exec(statement);
      return null;
    } catch (err) {
      return String((err as { code?: string }).code ?? (err as Error).message);
    } finally {
      await client.exec('ROLLBACK');
    }
  }

  const insertAnnouncement = (columns: string) =>
    `INSERT INTO "announcements" ("id", "title_en", "body_en", ${columns.split('|')[0]})
     VALUES ('019756a0-0000-7000-8000-00000000a3ff', 'T', 'B', ${columns.split('|')[1]})`;

  it.each([
    ['a draft that was released', `"released_at"|now()`],
    ['a published row without a cutoff', `"lifecycle", "released_at"|'published', now()`],
    ['a draft with a cutoff', `"audience_cutoff_at"|now()`],
    [
      'an archived row without archived_at',
      `"lifecycle", "released_at", "audience_cutoff_at"|'archived', now(), now()`,
    ],
    ['archived_at on a non-archived row', `"archived_at"|now()`],
    ['a lapse claim on a notice', `"lapse_recorded_at"|now()`],
    ['the e-mail toggle on a notice', `"notify_by_email"|true`],
    ['the e-mail toggle on a once', `"kind", "notify_by_email"|'once', true`],
    ['an e-mail delay above 365', `"kind", "notify_by_email_after_days"|'ack_required', 366`],
    ['a negative e-mail delay', `"kind", "notify_by_email_after_days"|'ack_required', -1`],
    ['a configured e-mail delay on a notice', `"notify_by_email_after_days"|3`],
    [
      'an e-mail pass claim without the toggle',
      `"kind", "email_pass_recorded_at"|'ack_required', now()`,
    ],
    [
      'a window that ends before it starts',
      `"starts_at", "ends_at"|now(), now() - interval '1 day'`,
    ],
  ])('announcements CHECK refuses %s', async (_name, columns) => {
    expect(await refusal(insertAnnouncement(columns))).toBe('23514');
  });

  it('announcements accept the legal ack_required shape (toggle, delay, claims)', async () => {
    expect(
      await refusal(
        insertAnnouncement(
          `"kind", "lifecycle", "released_at", "audience_cutoff_at", "notify_by_email", "notify_by_email_after_days", "email_pass_recorded_at", "lapse_recorded_at"|'ack_required', 'published', now(), now(), true, 0, now(), now()`,
        ),
      ),
    ).toBeNull();
  });

  const SHA = 'a'.repeat(64);
  const TOKEN = 'b'.repeat(64);
  const insertReceipt = (columns: string) =>
    `INSERT INTO "announcement_receipts" ("announcement_id", ${columns.split('|')[0]})
     VALUES ('${LIVE}', ${columns.split('|')[1]})`;

  it.each([
    ['a receipt that records nothing', `"user_id"|'${ADMIN}'`],
    [
      'acknowledged AND lapsed',
      `"user_id", "acknowledged_at", "acknowledged_via", "acknowledged_locale", "acknowledged_content_sha256", "lapsed_at", "lapse_reason"|'${ADMIN}', now(), 'web_session', 'en', '${SHA}', now(), 'ended'`,
    ],
    ['a lapse without a reason', `"user_id", "lapsed_at"|'${ADMIN}', now()`],
    ['a reason without a lapse', `"user_id", "seen_at", "lapse_reason"|'${ADMIN}', now(), 'ended'`],
    [
      'a live acknowledgement without its channel',
      `"user_id", "acknowledged_at", "acknowledged_locale", "acknowledged_content_sha256"|'${ADMIN}', now(), 'en', '${SHA}'`,
    ],
    [
      'a live acknowledgement without its hash',
      `"user_id", "acknowledged_at", "acknowledged_via", "acknowledged_locale"|'${ADMIN}', now(), 'web_session', 'en'`,
    ],
    [
      'a pseudonym token on a live row',
      `"user_id", "seen_at", "subject_token", "subject_key_id", "pseudonymized_at"|'${ADMIN}', now(), '${TOKEN}', 'k1', now()`,
    ],
    [
      'an anonymous row without a token',
      `"acknowledged_at", "acknowledged_content_sha256", "subject_key_id", "pseudonymized_at"|now(), '${SHA}', 'k1', now()`,
    ],
    [
      'an anonymous row without its key id',
      `"acknowledged_at", "acknowledged_content_sha256", "subject_token", "pseudonymized_at"|now(), '${SHA}', '${TOKEN}', now()`,
    ],
    [
      'a half-pseudonymised row that kept seen_at',
      `"acknowledged_at", "acknowledged_content_sha256", "subject_token", "subject_key_id", "pseudonymized_at", "seen_at"|now(), '${SHA}', '${TOKEN}', 'k1', now(), now()`,
    ],
    [
      'a half-pseudonymised row that kept the locale',
      `"acknowledged_at", "acknowledged_content_sha256", "subject_token", "subject_key_id", "pseudonymized_at", "acknowledged_locale"|now(), '${SHA}', '${TOKEN}', 'k1', now(), 'en'`,
    ],
    [
      'a half-pseudonymised row that kept the channel',
      `"acknowledged_at", "acknowledged_content_sha256", "subject_token", "subject_key_id", "pseudonymized_at", "acknowledged_via"|now(), '${SHA}', '${TOKEN}', 'k1', now(), 'web_session'`,
    ],
    [
      'an anonymous row that is not an acknowledgement',
      `"dismissed_at", "subject_token", "subject_key_id", "pseudonymized_at"|now(), '${TOKEN}', 'k1', now()`,
    ],
    [
      'an unknown acknowledgement locale',
      `"user_id", "acknowledged_at", "acknowledged_via", "acknowledged_locale", "acknowledged_content_sha256"|'${ADMIN}', now(), 'web_session', 'fr', '${SHA}'`,
    ],
    [
      'a hash that is not 64 lowercase hex',
      `"user_id", "acknowledged_at", "acknowledged_via", "acknowledged_locale", "acknowledged_content_sha256"|'${ADMIN}', now(), 'web_session', 'en', '${'A'.repeat(64)}'`,
    ],
    [
      'a token that is not 64 lowercase hex',
      `"acknowledged_at", "acknowledged_content_sha256", "subject_token", "subject_key_id", "pseudonymized_at"|now(), '${SHA}', 'xyz', 'k1', now()`,
    ],
  ])('announcement_receipts CHECK refuses %s', async (_name, columns) => {
    expect(await refusal(insertReceipt(columns))).toBe('23514');
  });

  it('two pseudonymised rows of one announcement never collide (NULL user ids are distinct)', async () => {
    const pseudonymised = `"acknowledged_at", "acknowledged_content_sha256", "subject_token", "subject_key_id", "pseudonymized_at"|now(), '${SHA}', '${TOKEN}', 'k1', now()`;
    expect(
      await refusal(`${insertReceipt(pseudonymised)}; ${insertReceipt(pseudonymised)}`),
    ).toBeNull();
  });

  it('a live user still has at most one receipt per announcement', async () => {
    expect(await refusal(insertReceipt(`"user_id", "seen_at"|'${U1}', now()`))).toBe('23505');
  });

  it('RESTRICT: a raw DELETE FROM users with a receipt left is refused', async () => {
    expect(await refusal(`DELETE FROM "users" WHERE "id" = '${U1}'`)).toBe('23503');
  });

  it('RESTRICT: deleting an announcement that holds receipts is refused', async () => {
    expect(await refusal(`DELETE FROM "announcements" WHERE "id" = '${LIVE}'`)).toBe('23503');
  });
});
