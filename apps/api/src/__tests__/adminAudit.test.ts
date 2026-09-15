import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminSecuritySignalsResponseSchema,
  auditLogListResponseSchema,
  type AuditLogEntry,
} from '@bettertrack/contracts';

import { createAuditRepository } from '../data/repositories/auditRepository';
import { withFreshLockedPrivacyModes } from '../data/repositories/paranoidEnforcementRepository';
import * as schema from '../data/schema';
import { createAuditService } from '../services/audit/auditService';
import { resetAdminTwoFactorEnrollment } from '../scripts/adminTwoFactorBreakGlass';
import { AUDIT_REDACTED } from '../services/audit/auditRedaction';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

/**
 * Ids are crafted so `ORDER BY id DESC` is a deterministic, readable order in
 * the assertions below: the real column is a UUIDv7 (time-sortable), and these
 * differ only in their trailing counter.
 */
const seededId = (n: number) =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as const;

interface SeedRow {
  n: number;
  action: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  meta?: unknown;
  createdAt?: Date;
}

async function seedAudit(rows: readonly SeedRow[]): Promise<void> {
  await harness.db.insert(schema.auditLog).values(
    rows.map((row) => ({
      id: seededId(row.n),
      actorId: row.actorId ?? null,
      action: row.action,
      targetType: row.targetType ?? null,
      targetId: row.targetId ?? null,
      ip: null,
      meta: row.meta ?? null,
      createdAt: row.createdAt ?? new Date('2026-06-01T12:00:00.000Z'),
    })),
  );
}

const actionsOf = (body: unknown): string[] =>
  auditLogListResponseSchema.parse(body).entries.map((entry) => entry.action);

/**
 * The audit service wired exactly as `buildContext` wires it, privacy lock
 * included — the paranoid assertions below are worthless against a service
 * whose privacy resolution is a stub that always answers "not normal".
 */
const auditServiceFor = (h: TestHarness) =>
  createAuditService(createAuditRepository(h.db), (userId, run) =>
    withFreshLockedPrivacyModes(h.db, [userId], (modes) => run(modes.get(userId) ?? null)),
  );

describe('audit filters (#1908 §1)', () => {
  it('matches an action exactly and anchors a domain prefix at the dot', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await seedAudit([
      { n: 1, action: 'user.disabled' },
      { n: 2, action: 'user.enabled' },
      // The adversarial row: a bare `LIKE 'user%'` would return this, a
      // dot-anchored prefix cannot. It is seeded through the repository's own
      // table rather than written by the product, precisely because the product
      // has no `users.*` action — the defect it proves absent is one a future
      // action could introduce.
      { n: 3, action: 'users.something' },
      { n: 4, action: 'invite.created' },
    ]);

    const exact = await agent.get('/api/v1/admin/audit?action=user.disabled');
    expect(exact.status).toBe(200);
    expect(actionsOf(exact.body)).toEqual(['user.disabled']);

    const prefix = await agent.get('/api/v1/admin/audit?action=user.');
    expect(prefix.status).toBe(200);
    const prefixed = actionsOf(prefix.body);
    expect(prefixed).toContain('user.disabled');
    expect(prefixed).toContain('user.enabled');
    expect(prefixed).not.toContain('users.something');
    expect(prefixed).not.toContain('invite.created');
  });

  it('cannot be turned into a wildcard by the filter value', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    // (1) A LIKE metacharacter never reaches the repository at all: the
    // contract's charset refuses it, so the value cannot become a pattern.
    for (const value of ['%', 'user.%', 'user.\\', "user.'", 'user.a%b', 'USER.']) {
      const res = await agent.get(`/api/v1/admin/audit?action=${encodeURIComponent(value)}`);
      expect(res.status, value).toBe(400);
    }

    // (2) `_` IS legal — the vocabulary is snake_case, so `api_key.` is a real
    // domain prefix — which means it does reach the pattern and MUST be escaped
    // there. Unescaped it is a single-character wildcard and `apiXkey.rotated`
    // comes back too. This is the probe for the escape, not for the charset.
    await seedAudit([
      { n: 1, action: 'api_key.created' },
      { n: 2, action: 'apiXkey.created' },
    ]);
    const res = await agent.get('/api/v1/admin/audit?action=api_key.');
    expect(res.status).toBe(200);
    expect(actionsOf(res.body)).toEqual(['api_key.created']);
  });

  it('filters by actor, target id and target type, and composes them', async () => {
    const admin = await harness.seedAdmin();
    const other = await harness.seedUser({ email: 'a@test.dev', username: 'actor_two' });
    const agent = await harness.loginAdmin(admin);
    const targetA = seededId(900);
    const targetB = seededId(901);
    await seedAudit([
      { n: 1, action: 'x.one', actorId: admin.id, targetType: 'user', targetId: targetA },
      { n: 2, action: 'x.two', actorId: other.id, targetType: 'user', targetId: targetA },
      { n: 3, action: 'x.three', actorId: admin.id, targetType: 'app_settings', targetId: targetB },
    ]);

    const byActor = await agent.get(`/api/v1/admin/audit?actorId=${other.id}`);
    expect(actionsOf(byActor.body)).toEqual(['x.two']);

    const byTarget = await agent.get(`/api/v1/admin/audit?targetId=${targetA}`);
    expect(actionsOf(byTarget.body).sort()).toEqual(['x.one', 'x.two']);

    const byType = await agent.get('/api/v1/admin/audit?targetType=app_settings');
    expect(actionsOf(byType.body)).toEqual(['x.three']);

    const composed = await agent.get(
      `/api/v1/admin/audit?actorId=${admin.id}&targetId=${targetA}&targetType=user`,
    );
    expect(actionsOf(composed.body)).toEqual(['x.one']);
  });

  it('treats the date range as half-open [from, to)', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const from = new Date('2026-06-01T00:00:00.000Z');
    const to = new Date('2026-06-02T00:00:00.000Z');
    await seedAudit([
      { n: 1, action: 'range.before', createdAt: new Date('2026-05-31T23:59:59.999Z') },
      { n: 2, action: 'range.at_from', createdAt: from },
      { n: 3, action: 'range.inside', createdAt: new Date('2026-06-01T12:00:00.000Z') },
      // Exactly `to`: belongs to the NEXT window, so two adjacent windows never
      // double-count one row.
      { n: 4, action: 'range.at_to', createdAt: to },
    ]);

    const res = await agent.get(
      `/api/v1/admin/audit?from=${from.toISOString()}&to=${to.toISOString()}`,
    );
    const actions = actionsOf(res.body);
    expect(actions.sort()).toEqual(['range.at_from', 'range.inside']);
  });

  it('refuses an inverted range, an unknown preset and an unknown key', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const inverted = await agent.get(
      '/api/v1/admin/audit?from=2026-06-02T00:00:00.000Z&to=2026-06-01T00:00:00.000Z',
    );
    expect(inverted.status).toBe(400);
    expect(inverted.body.error.code).toBe('VALIDATION_ERROR');

    const equal = await agent.get(
      '/api/v1/admin/audit?from=2026-06-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z',
    );
    expect(equal.status).toBe(400);

    expect((await agent.get('/api/v1/admin/audit?preset=everything')).status).toBe(400);
    // `.strict()` preserved: the additive filters did not open the schema up.
    expect((await agent.get('/api/v1/admin/audit?q=secret')).status).toBe(400);
  });

  it('pages a filtered set by keyset with no duplicate and no gap', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const wanted = Array.from({ length: 7 }, (_, index) => ({
      n: 100 + index * 2,
      action: 'paged.wanted',
    }));
    const noise = Array.from({ length: 7 }, (_, index) => ({
      n: 101 + index * 2,
      action: 'paged.other',
    }));
    await seedAudit([...wanted, ...noise]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query: string = `limit=3&action=paged.wanted${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await agent.get(`/api/v1/admin/audit?${query}`);
      expect(res.status).toBe(200);
      const parsed = auditLogListResponseSchema.parse(res.body);
      expect(parsed.entries.every((entry) => entry.action === 'paged.wanted')).toBe(true);
      seen.push(...parsed.entries.map((entry) => entry.id));
      cursor = parsed.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length); // no duplicate
    expect(seen).toEqual(
      wanted
        .map((row) => seededId(row.n))
        .sort()
        .reverse(),
    ); // no gap
  });

  it('answers listForTarget identically to list with targetId set', async () => {
    const admin = await harness.seedAdmin();
    const target = await harness.seedUser({ email: 't@test.dev', username: 'target_user' });
    const agent = await harness.loginAdmin(admin);
    await seedAudit([
      { n: 1, action: 'refactor.one', targetType: 'user', targetId: target.id },
      { n: 2, action: 'refactor.two', targetType: 'user', targetId: target.id },
      { n: 3, action: 'refactor.other', targetType: 'user', targetId: admin.id },
    ]);

    const scoped = await agent.get(`/api/v1/admin/users/${target.id}/audit`);
    const unified = await agent.get(`/api/v1/admin/audit?targetId=${target.id}`);
    expect(scoped.status).toBe(200);
    expect(auditLogListResponseSchema.parse(scoped.body)).toEqual(
      auditLogListResponseSchema.parse(unified.body),
    );
  });

  it('never lets a query key widen the per-user audit beyond its account', async () => {
    const admin = await harness.seedAdmin();
    const target = await harness.seedUser({ email: 's@test.dev', username: 'scoped_user' });
    const other = await harness.seedUser({ email: 'o@test.dev', username: 'other_user' });
    const agent = await harness.loginAdmin(admin);
    await seedAudit([
      { n: 1, action: 'scope.mine', targetType: 'user', targetId: target.id },
      { n: 2, action: 'scope.theirs', targetType: 'user', targetId: other.id },
    ]);

    // The account scope is applied by the repository, so a `targetId` naming a
    // DIFFERENT account can only narrow this page to empty — never re-point it,
    // and never be silently dropped (which would render as "no such rows").
    const crossed = await agent.get(`/api/v1/admin/users/${target.id}/audit?targetId=${other.id}`);
    expect(crossed.status).toBe(200);
    expect(actionsOf(crossed.body)).toEqual([]);

    // Naming the SAME account is a no-op, not a refusal.
    const same = await agent.get(`/api/v1/admin/users/${target.id}/audit?targetId=${target.id}`);
    expect(actionsOf(same.body)).toEqual(['scope.mine']);
  });
});

describe('audit presets (#1908 §3)', () => {
  it('scopes break_glass to rows the shell script stamped', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await seedAudit([
      { n: 1, action: 'admin.two_factor_reset', meta: { via: 'break_glass_script' } },
      // Same action, console-initiated: not break-glass.
      { n: 2, action: 'admin.two_factor_reset', actorId: admin.id, meta: { via: 'console' } },
      { n: 3, action: 'login.fail', meta: { reason: 'unknown_user' } },
    ]);

    const res = await agent.get('/api/v1/admin/audit?preset=break_glass');
    const parsed = auditLogListResponseSchema.parse(res.body);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.id).toBe(seededId(1));
    expect(parsed.entries[0]!.actorKind).toBe('shell');
  });

  it('collects failed authentication signals and admin actions', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await seedAudit([
      { n: 1, action: 'login.fail', meta: { reason: 'bad_password' } },
      { n: 2, action: 'two_factor.verify_fail' },
      { n: 3, action: 'login.success' },
      { n: 4, action: 'settings.updated', actorId: admin.id },
    ]);

    const failures = actionsOf((await agent.get('/api/v1/admin/audit?preset=auth_failures')).body);
    expect(failures).toContain('login.fail');
    expect(failures).toContain('two_factor.verify_fail');
    expect(failures).not.toContain('login.success');

    const adminActions = actionsOf(
      (await agent.get('/api/v1/admin/audit?preset=admin_actions')).body,
    );
    expect(adminActions).toContain('settings.updated');
    expect(adminActions).toContain('admin.login'); // written by the harness login
    expect(adminActions).not.toContain('login.fail');
  });

  it('composes a preset with an explicit action rather than replacing it', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await seedAudit([
      { n: 1, action: 'user.disabled', actorId: admin.id },
      { n: 2, action: 'settings.updated', actorId: admin.id },
    ]);

    const res = await agent.get('/api/v1/admin/audit?preset=admin_actions&action=user.');
    expect(actionsOf(res.body)).toEqual(['user.disabled']);
  });
});

describe('actor attribution (#1908 §3)', () => {
  it('resolves the actor to a username and kind in ONE statement per page', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await seedAudit(
      Array.from({ length: 50 }, (_, index) => ({
        n: 200 + index,
        action: 'join.row',
        actorId: admin.id,
      })),
    );

    const res = await agent.get('/api/v1/admin/audit?limit=50&action=join.row');
    const parsed = auditLogListResponseSchema.parse(res.body);
    expect(parsed.entries).toHaveLength(50);
    for (const entry of parsed.entries) {
      expect(entry.actor).toEqual({ id: admin.id, username: admin.username, kind: 'admin' });
      expect(entry.actorKind).toBe('account');
    }

    // The 51-statement shape this replaces would show up here: the repository
    // issues one `select(...).leftJoin(users)` for the whole page.
    const select = vi.spyOn(harness.db, 'select');
    await createAuditRepository(harness.db).list({ limit: 50, filters: { action: 'join.row' } });
    expect(select).toHaveBeenCalledTimes(1);
    select.mockRestore();
  });

  it('never ships the actor’s e-mail', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await seedAudit([{ n: 1, action: 'email.leak_probe', actorId: admin.id }]);

    const res = await agent.get('/api/v1/admin/audit?action=email.leak_probe');
    expect(JSON.stringify(res.body)).not.toContain(admin.email);
  });

  it('keeps the row when the acting account is deleted, labelled unresolvable', async () => {
    const admin = await harness.seedAdmin();
    const actor = await harness.seedUser({ email: 'gone@test.dev', username: 'departing' });
    const agent = await harness.loginAdmin(admin);
    await seedAudit([{ n: 1, action: 'survivor.row', actorId: actor.id }]);

    await harness.db.delete(schema.users).where(eq(schema.users.id, actor.id));

    const res = await agent.get('/api/v1/admin/audit?action=survivor.row');
    const parsed = auditLogListResponseSchema.parse(res.body);
    expect(parsed.entries).toHaveLength(1);
    // The security trail outlives the account by design (`ON DELETE SET NULL`).
    expect(parsed.entries[0]!.actorId).toBeNull();
    expect(parsed.entries[0]!.actor).toBeNull();
    expect(parsed.entries[0]!.actorKind).toBe('unattributed');
  });

  /**
   * Review of PR #1942, low 2: `actor_id` is a foreign key the server set,
   * `meta.via` is a string inside a free-form payload. The column wins, or a row
   * a real operator produced would be labelled as having come from a shell.
   */
  it('lets an attributed actor outrank the break-glass marker', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await seedAudit([
      {
        n: 1,
        action: 'admin.two_factor_reset',
        actorId: admin.id,
        meta: { via: 'break_glass_script' },
      },
      {
        n: 2,
        action: 'admin.two_factor_reset',
        actorId: null,
        meta: { via: 'break_glass_script' },
      },
    ]);

    const res = await agent.get('/api/v1/admin/audit?action=admin.two_factor_reset');
    const parsed = auditLogListResponseSchema.parse(res.body);
    const attributed = parsed.entries.find((entry) => entry.id === seededId(1));
    const actorless = parsed.entries.find((entry) => entry.id === seededId(2));

    expect(attributed?.actorKind).toBe('account');
    expect(attributed?.actor?.username).toBe(admin.username);
    expect(actorless?.actorKind).toBe('shell');

    // And neither the preset nor the banner count is affected by the ordering:
    // both filter on action + meta.via in the repository, never on actorKind, so
    // an actor id cannot hide a row from them.
    const preset = auditLogListResponseSchema.parse(
      (await agent.get('/api/v1/admin/audit?preset=break_glass')).body,
    );
    expect(preset.entries.map((entry) => entry.id).sort()).toEqual(
      [seededId(1), seededId(2)].sort(),
    );
    const signals = adminSecuritySignalsResponseSchema.parse(
      (await agent.get('/api/v1/admin/security/signals')).body,
    );
    expect(signals.breakGlassRetentionTotal).toBe(2);
  });

  it('separates a shell break-glass row from a system row and an anonymous login failure', async () => {
    const admin = await harness.seedAdmin();
    // Sign in once so an `admin.login` row exists, then break-glass over it.
    await harness.loginAdmin(admin);
    await resetAdminTwoFactorEnrollment(harness.db, admin.username);
    await seedAudit([{ n: 1, action: 'login.fail', meta: { reason: 'unknown_user' } }]);

    // The break-glass reset cleared this admin's factors, so log in afresh.
    const reader = await harness.loginAdmin(admin);
    const res = await reader.get('/api/v1/admin/audit?limit=100');
    const parsed = auditLogListResponseSchema.parse(res.body);

    const breakGlass = parsed.entries.filter(
      (entry) => entry.action === 'admin.two_factor_reset' && entry.actorKind === 'shell',
    );
    expect(breakGlass).toHaveLength(1);

    const anonymous = parsed.entries.find((entry) => entry.action === 'login.fail');
    expect(anonymous?.actorKind).toBe('unattributed');
    expect(anonymous?.actor).toBeNull();
  });
});

describe('audit indexes (#1908 §2)', () => {
  it('creates the three filter indexes and retires the bare actor index', async () => {
    // Both drivers this suite runs on shape `execute` differently (PGlite
    // returns `{ rows }`, postgres-js an array), exactly as `schema.test.ts`
    // handles it.
    const indexes = await harness.db.execute(
      sql`select indexname from pg_indexes where tablename = 'audit_log'`,
    );
    const names = (
      Array.isArray(indexes) ? indexes : ((indexes as { rows?: unknown[] }).rows ?? [])
    )
      .map((entry) => String((entry as { indexname: unknown }).indexname))
      .sort();

    expect(names).toContain('audit_log_action_id_idx');
    expect(names).toContain('audit_log_target_id_id_idx');
    expect(names).toContain('audit_log_actor_id_id_idx');
    // Superseded by the composite, whose leading column answers the same
    // lookups — including the foreign-key coverage `check:schema-drift` wants.
    expect(names).not.toContain('audit_log_actor_id_idx');
  });
});

describe('meta redaction on the write path (#1908 §4)', () => {
  it('replaces a secret-shaped value before the row is written', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const secret = 'sk-live-do-not-persist-4f9a1c';

    await auditServiceFor(harness).record({
      actorId: admin.id,
      action: 'settings.updated',
      targetType: 'app_settings',
      meta: {
        endpoint: 'http://ollama.local:11434',
        apiToken: secret,
        nested: { clientSecret: secret, keep: 'visible' },
        list: [{ password: secret }],
      },
    });

    // (1) The DATABASE, not the projection: a renderer-side filter would leave
    // the value readable here for the full 400-day retention.
    const [row] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'settings.updated'));
    const stored = JSON.stringify(row?.meta);
    expect(stored).not.toContain(secret);
    // Not even a PREFIX of it survives: the value is replaced, not truncated.
    expect(stored).not.toContain('sk-live');
    expect(row?.meta).toEqual({
      endpoint: 'http://ollama.local:11434',
      apiToken: AUDIT_REDACTED,
      nested: { clientSecret: AUDIT_REDACTED, keep: 'visible' },
      list: [{ password: AUDIT_REDACTED }],
    });

    // (2) And therefore nothing to leak on the way out.
    const res = await agent.get('/api/v1/admin/audit?action=settings.updated');
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  /**
   * The regression the substring policy caused (review of PR #1942, B1).
   *
   * `user.created` records `meta.tokenId` — the registration-token ROW ID, the
   * only link between a new account and the token that admitted it (§6.12
   * registration modes). A `token` SUBSTRING root blanked it irreversibly on
   * every token and invite signup. Driven through the real registration flow,
   * not through the helper, so it pins the fact rather than the function.
   */
  it('keeps the registration token id on user.created — a row id, not a secret', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    expect(
      (
        await agent
          .patch('/api/v1/admin/settings')
          .set(...XRW)
          .send({ registrationMode: 'invite_token' })
      ).status,
    ).toBe(200);

    const created = await agent
      .post('/api/v1/admin/registration-tokens')
      .set(...XRW)
      .send({});
    expect(created.status).toBe(201);
    const rawToken = new URL(created.body.registerUrl as string).searchParams.get('token');

    const registered = await request(harness.app)
      .post('/api/v1/auth/register')
      .set(...XRW)
      .send({
        email: 'admitted@test.dev',
        username: 'admitted_user',
        password: 'a-sufficiently-long-password',
        inviteToken: rawToken,
      });
    expect(registered.status).toBe(201);

    const [row] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'user.created'));
    const meta = row?.meta as Record<string, unknown>;
    expect(meta.via).toBe('registration');
    expect(meta.mode).toBe('invite_token');
    // The fact under test: present, unredacted, and the real row id.
    expect(meta.tokenId).toBeTypeOf('string');
    expect(meta.tokenId).not.toBe(AUDIT_REDACTED);
    const [token] = await harness.db
      .select({ id: schema.registrationTokens.id })
      .from(schema.registrationTokens);
    expect(meta.tokenId).toBe(token?.id);
  });

  /**
   * The policy is §10's, whole-key — so every name `logger.ts` documents as a
   * deliberate KEEP has to survive here too. Each of these is prefixed by, or
   * contains, a redacted name; only exact matching tells them apart.
   */
  it('keeps every key the §10 policy documents as a deliberate keep', async () => {
    const admin = await harness.seedAdmin();
    const kept = {
      tokenId: 'rt_00000000-0000-7000-8000-00000000abcd',
      tokens: 3,
      token_type: 'bearer',
      tokenEndpoint: 'https://oauth.example.test/token',
      credentialId: 'cred_1234',
      recoveryCodeCount: 8,
      encryptionKeyId: 'kek-2026-01',
      accessTokenExpiresAt: '2026-07-01T12:00:00.000Z',
      passwordChangedAt: '2026-06-01T12:00:00.000Z',
      // The console needs these two specifically: the flag name and W5's link.
      key: 'chat',
      moderationId: 'mod_5678',
    };
    await auditServiceFor(harness).record({
      actorId: admin.id,
      action: 'keeps.probe',
      meta: { ...kept },
    });

    const [row] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'keeps.probe'));
    expect(row?.meta).toEqual(kept);
  });

  it('still redacts the exact credential names, including the spellings a form invents', async () => {
    const admin = await harness.seedAdmin();
    const secret = 'sk-live-exact-name-probe';
    await auditServiceFor(harness).record({
      actorId: admin.id,
      action: 'exact.probe',
      // `API-KEY` / `Client_Secret` are separator/case variants of names §10
      // enumerates; `credentials` is the audit-specific addition. `credentialId`
      // sits beside them to prove the fold did not widen into a prefix match.
      meta: {
        token: secret,
        'API-KEY': secret,
        Client_Secret: secret,
        credentials: secret,
        credentialId: 'cred_9999',
      },
    });

    const [row] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'exact.probe'));
    expect(row?.meta).toEqual({
      token: AUDIT_REDACTED,
      'API-KEY': AUDIT_REDACTED,
      Client_Secret: AUDIT_REDACTED,
      credentials: AUDIT_REDACTED,
      credentialId: 'cred_9999',
    });
    expect(JSON.stringify(row?.meta)).not.toContain(secret);
  });

  it('keeps the paranoid resource-path redaction exactly as it was', async () => {
    const admin = await harness.seedAdmin();
    const user = await harness.seedUser({ email: 'p@test.dev', username: 'paranoid_user' });
    const agent = await harness.loginAdmin(admin);
    await harness.db
      .update(schema.users)
      .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
      .where(eq(schema.users.id, user.id));

    await auditServiceFor(harness).record({
      actorId: user.id,
      action: 'api_key.scope_denied',
      meta: { path: '/api/v1/portfolios/secret-slug', method: 'GET' },
    });

    const [row] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'api_key.scope_denied'));
    expect(row?.meta).toEqual({ path: '[redacted-resource-path]', method: 'GET' });

    // No new filter or projection reconstructs it: the drawer renders the row,
    // and the row no longer holds the path.
    const res = await agent.get('/api/v1/admin/audit?action=api_key.scope_denied');
    expect(JSON.stringify(res.body)).not.toContain('secret-slug');
    expect(JSON.stringify(res.body)).toContain('[redacted-resource-path]');
  });
});

describe('before/after on the converted config writes (#1908 §4)', () => {
  it('records what settings.updated changed, not just the submitted body', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const before = await agent.get('/api/v1/admin/settings');
    expect(before.status).toBe(200);
    const nextBeta = !(before.body.betaMode as boolean);
    const res = await agent
      .patch('/api/v1/admin/settings')
      .set(...XRW)
      .send({ betaMode: nextBeta });
    expect(res.status).toBe(200);

    const [row] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'settings.updated'));
    expect(row?.meta).toEqual({ before: { betaMode: !nextBeta }, after: { betaMode: nextBeta } });
    // The shape this replaces.
    expect(row?.meta).not.toHaveProperty('changed');
  });

  it('records the previous role on a role change', async () => {
    const admin = await harness.seedAdmin();
    const target = await harness.seedUser({ email: 'r@test.dev', username: 'promoted_user' });
    const agent = await harness.loginAdmin(admin);

    // ADMIN-W5 (#1907) made a reason mandatory on every moderating write,
    // a role change included.
    const reason = 'promoting the on-call operator for the quarter';
    const res = await agent
      .patch(`/api/v1/admin/users/${target.id}`)
      .set(...XRW)
      .send({ role: 'admin', reason });
    expect(res.status).toBe(200);

    const [row] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'user.role_changed'));
    expect(row?.meta).toMatchObject({
      before: { role: 'user' },
      after: { role: 'admin' },
    });
    // W5's moderation-action id rides alongside the pair; the operator's PROSE
    // stays in the moderation record and never enters the audit row's `meta`.
    expect(row?.meta).toHaveProperty('moderationId');
    expect(JSON.stringify(row?.meta)).not.toContain(reason);
  });

  it('records the previous lifetime on an admin session-policy change', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const current = await agent.get('/api/v1/admin/security/session-policy');
    const previous = current.body.sessionLifetimeHours as number;
    const next = previous === 12 ? 8 : 12;
    const res = await agent
      .patch('/api/v1/admin/security/session-policy')
      .set(...XRW)
      .send({ sessionLifetimeHours: next });
    expect(res.status).toBe(200);

    const [row] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'admin_session_policy.updated'));
    expect(row?.meta).toEqual({
      before: { sessionLifetimeHours: previous },
      after: { sessionLifetimeHours: next },
    });
  });

  it('records the previous state of a feature-flag flip', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const res = await agent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: false });
    expect(res.status).toBe(200);

    const [row] = await harness.db
      .select({ meta: schema.auditLog.meta })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'feature_flag.changed'));
    expect(row?.meta).toMatchObject({
      key: 'chat',
      enabled: false,
      before: { enabled: true },
      after: { enabled: false },
    });
  });
});

describe('GET /admin/security/signals (#1908 §5)', () => {
  it('counts failed signals over the window and names the range it counted', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000);
    const old = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    await seedAudit([
      { n: 1, action: 'login.fail', meta: { reason: 'bad_password' }, createdAt: recent },
      { n: 2, action: 'login.fail', meta: { reason: 'bad_password' }, createdAt: recent },
      { n: 3, action: 'login.fail', meta: { reason: 'unknown_user' }, createdAt: recent },
      { n: 4, action: 'login.fail', meta: { reason: 'bad_password' }, createdAt: old },
      { n: 5, action: 'two_factor.verify_fail', createdAt: recent },
      { n: 6, action: 'pin.verify_fail', createdAt: recent },
      { n: 7, action: 'passkey.login_fail', createdAt: recent },
      { n: 8, action: 'auth.reauth_fail', createdAt: recent },
      { n: 9, action: 'api_key.scope_denied', createdAt: recent },
      {
        n: 10,
        action: 'admin.two_factor_reset',
        meta: { via: 'break_glass_script' },
        createdAt: recent,
      },
    ]);

    const day = await agent.get('/api/v1/admin/security/signals?window=24h');
    expect(day.status).toBe(200);
    const parsed = adminSecuritySignalsResponseSchema.parse(day.body);
    expect(parsed.window).toBe('24h');
    expect(Date.parse(parsed.from)).toBeLessThan(Date.parse(parsed.to));
    expect(parsed.loginFailures.total).toBe(3); // the 3-day-old row is outside
    expect(parsed.loginFailures.byReason).toEqual([
      { reason: 'unknown_user', count: 1 },
      { reason: 'bad_password', count: 2 },
    ]);
    expect(parsed.twoFactorVerifyFail).toBe(1);
    expect(parsed.pinVerifyFail).toBe(1);
    expect(parsed.passkeyLoginFail).toBe(1);
    expect(parsed.reauthFail).toBe(1);
    expect(parsed.apiKeyScopeDenied).toBe(1);
    expect(parsed.breakGlass).toBe(1);
    expect(parsed.adminLogins).toBeGreaterThanOrEqual(1);
    expect(parsed.adminActors).toBe(1);

    const week = await agent.get('/api/v1/admin/security/signals?window=7d');
    expect(adminSecuritySignalsResponseSchema.parse(week.body).loginFailures.total).toBe(4);
  });

  it('buckets an unrecognised login-failure reason instead of echoing it', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    await seedAudit([
      {
        n: 1,
        action: 'login.fail',
        meta: { reason: 'a-reason-this-build-does-not-know' },
        createdAt: new Date(),
      },
    ]);

    const res = await agent.get('/api/v1/admin/security/signals?window=24h');
    const parsed = adminSecuritySignalsResponseSchema.parse(res.body);
    expect(parsed.loginFailures.byReason).toEqual([{ reason: 'other', count: 1 }]);
    expect(JSON.stringify(res.body)).not.toContain('a-reason-this-build-does-not-know');
  });

  it('refuses any window longer than 7 days, and any unknown key', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    for (const query of ['window=30d', 'window=400d', 'window=1y', 'days=30']) {
      expect((await agent.get(`/api/v1/admin/security/signals?${query}`)).status, query).toBe(400);
    }
  });

  it('carries no identifier of any kind', async () => {
    // Distinctive values on purpose: a probe for "admin" would match the
    // `adminLogins` FIELD NAME and pass (or fail) for the wrong reason.
    const admin = await harness.seedAdmin({
      email: 'zq-operator@test.dev',
      username: 'zq_operator',
    });
    const user = await harness.seedUser({ email: 'zq-subject@test.dev', username: 'zq_subject' });
    const agent = await harness.loginAdmin(admin);
    await seedAudit([
      {
        n: 1,
        action: 'login.fail',
        targetId: user.id,
        actorId: null,
        meta: { reason: 'bad_password' },
        createdAt: new Date(),
      },
    ]);

    const res = await agent.get('/api/v1/admin/security/signals?window=24h');
    const body = JSON.stringify(res.body);
    // Counts only (#1908 §5): no account id, no username, no e-mail, no IP, no
    // device label, no geo. `.strict()` on the contract is the other half.
    for (const identifier of [user.id, user.username, user.email, admin.id, admin.username]) {
      expect(body, identifier).not.toContain(identifier);
    }
    expect(body).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/); // no IPv4 anywhere
  });

  it('is invisible to a non-admin, like every other admin route', async () => {
    const user = await harness.seedUser({ email: 'u@test.dev', username: 'plain_user' });
    const agent = request.agent(harness.app);
    const login = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(login.status).toBe(200);

    // 404, never 403: the admin surface is undetectable (§6.12).
    expect((await agent.get('/api/v1/admin/security/signals')).status).toBe(404);
    expect((await request(harness.app).get('/api/v1/admin/security/signals')).status).toBe(404);
  });
});

describe('break-glass visibility (#1908 §3)', () => {
  it('raises the standing banner count and is reachable via the preset', async () => {
    const admin = await harness.seedAdmin();
    await harness.loginAdmin(admin);
    await resetAdminTwoFactorEnrollment(harness.db, admin.username);
    const agent = await harness.loginAdmin(admin);

    const signals = adminSecuritySignalsResponseSchema.parse(
      (await agent.get('/api/v1/admin/security/signals?window=24h')).body,
    );
    expect(signals.breakGlassRetentionTotal).toBe(1);
    expect(signals.breakGlassRetentionCapped).toBe(false);

    const preset = auditLogListResponseSchema.parse(
      (await agent.get('/api/v1/admin/audit?preset=break_glass')).body,
    );
    expect(preset.entries).toHaveLength(1);
    expect(preset.entries[0]!.action).toBe('admin.two_factor_reset');
    expect(preset.entries[0]!.actorKind).toBe('shell');
  });

  it('reports zero on a deployment that has never used it', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const signals = adminSecuritySignalsResponseSchema.parse(
      (await agent.get('/api/v1/admin/security/signals')).body,
    );
    expect(signals.breakGlassRetentionTotal).toBe(0);
    expect(signals.breakGlassRetentionCapped).toBe(false);
  });
});

describe('the audit read is unchanged for callers that predate the filters', () => {
  it('still answers an unfiltered page, and still 404s a non-admin', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent.get('/api/v1/admin/audit');
    expect(res.status).toBe(200);
    const parsed: { entries: AuditLogEntry[] } = auditLogListResponseSchema.parse(res.body);
    expect(parsed.entries.map((entry) => entry.action)).toContain('admin.login');
    expect((await request(harness.app).get('/api/v1/admin/audit')).status).toBe(404);
  });
});
