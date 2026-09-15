import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_MODERATION_REASON_MAX_LENGTH,
  adminModerationListResponseSchema,
  adminUserSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { collectUserExport } from '../services/export/collector';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

/**
 * Moderation depth (#1907 ADMIN-W5, PROJECTPLAN.md §6.12).
 *
 * The property under test is one sentence: **a moderation action cannot exist
 * without its reason and its operator.** Everything below is that sentence from
 * a different angle — the contract refuses the unreasoned request, the
 * transaction refuses the half-written one, the repository refuses to answer
 * about the wrong account, and the export refuses to hand the record to the
 * person it is about.
 *
 * What this wave deliberately does NOT build is as load-bearing as what it
 * does: no portfolio/watchlist/share browsing, no admin session revoke, no
 * suspension tier beyond `disabled` (§6.12 kill list, re-asserted by the §16
 * row of 2026-08-29). `adminUserSeparation.test.ts` holds the structural guard
 * for that; the flag below is non-destructive precisely so it is not a tier.
 */

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function adminSession() {
  const admin = await harness.seedAdmin();
  const agent = await harness.loginAdmin(admin);
  return { admin, agent };
}

async function seedPerson(input: { email: string; username: string }) {
  return harness.seedUser(input);
}

/** Every moderation row the database holds for one account, oldest first. */
async function moderationRows(userId: string) {
  return harness.db
    .select()
    .from(schema.adminModerationActions)
    .where(eq(schema.adminModerationActions.userId, userId))
    .orderBy(schema.adminModerationActions.createdAt, schema.adminModerationActions.id);
}

describe('PATCH /admin/users/:id — a reason on every moderating write (#1907)', () => {
  it('refuses a suspension, a chat ban and a role change with no reason, and says nothing about the account', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'noreason@test.dev', username: 'no_reason' });

    for (const body of [{ status: 'disabled' }, { chatBanned: true }, { role: 'admin' }]) {
      const res = await agent
        .patch(`/api/v1/admin/users/${person.id}`)
        .set(...XRW)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      // §10: the refusal is about the REQUEST. It must not disclose the
      // account's status, role or chat state on the way out.
      const serialized = JSON.stringify(res.body).toLowerCase();
      for (const leak of ['active', 'disabled', person.email, person.username]) {
        expect(serialized, leak).not.toContain(leak.toLowerCase());
      }
    }

    // Nothing moved, and nothing was recorded about an action nobody took.
    const [row] = await harness.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, person.id));
    expect(row!.status).toBe('active');
    expect(row!.chatBanned).toBe(false);
    expect(row!.role).toBe('user');
    expect(await moderationRows(person.id)).toHaveLength(0);
  });

  it('lets a pure rename and an e-mail correction through without one', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'rename@test.dev', username: 'rename_me' });

    const res = await agent
      .patch(`/api/v1/admin/users/${person.id}`)
      .set(...XRW)
      .send({ username: 'renamed_ok', email: 'renamed@test.dev' });
    expect(res.status).toBe(200);
    expect(adminUserSchema.parse(res.body).username).toBe('renamed_ok');

    // Administration is not moderation: the record stays empty rather than
    // filling with rows an operator would learn to scroll past.
    expect(await moderationRows(person.id)).toHaveLength(0);
  });

  it('rejects a blank reason and one past the cap, at the contract and at the column', async () => {
    const { agent, admin } = await adminSession();
    const person = await seedPerson({ email: 'bounds@test.dev', username: 'bounds_user' });

    for (const reason of ['   ', 'x'.repeat(ADMIN_MODERATION_REASON_MAX_LENGTH + 1)]) {
      const res = await agent
        .patch(`/api/v1/admin/users/${person.id}`)
        .set(...XRW)
        .send({ status: 'disabled', reason });
      expect(res.status).toBe(400);
    }

    // The column repeats both bounds, so nothing that bypasses the route can
    // write unbounded prose into the record either.
    await expect(
      harness.db.insert(schema.adminModerationActions).values({
        userId: person.id,
        actorId: admin.id,
        action: 'disable',
        reason: '   ',
      }),
    ).rejects.toThrow();
    await expect(
      harness.db.insert(schema.adminModerationActions).values({
        userId: person.id,
        actorId: admin.id,
        action: 'not_a_known_action',
        reason: 'Anything.',
      }),
    ).rejects.toThrow();
    // `previous_value` / `next_value` are STATE LABELS. Unbounded, they would be
    // a second prose column beside the one the CHECK above bounds.
    await expect(
      harness.db.insert(schema.adminModerationActions).values({
        userId: person.id,
        actorId: admin.id,
        action: 'disable',
        reason: 'Suspended pending review.',
        previousValue: 'x'.repeat(65),
      }),
    ).rejects.toThrow();
  });

  it('records the suspension, the chat ban and the role change with the operator who decided', async () => {
    const { agent, admin } = await adminSession();
    const person = await seedPerson({ email: 'recorded@test.dev', username: 'recorded_user' });

    const banned = await agent
      .patch(`/api/v1/admin/users/${person.id}`)
      .set(...XRW)
      .send({ chatBanned: true, reason: 'Harassment reported by two accounts.' });
    expect(banned.status).toBe(200);

    const promoted = await agent
      .patch(`/api/v1/admin/users/${person.id}`)
      .set(...XRW)
      .send({ role: 'admin', reason: 'Second operator for the on-call rotation.' });
    expect(promoted.status).toBe(200);

    const rows = await moderationRows(person.id);
    expect(rows.map((row) => row.action)).toEqual(['chat_ban', 'role_change']);
    expect(rows.every((row) => row.actorId === admin.id)).toBe(true);
    expect(rows[0]!.reason).toBe('Harassment reported by two accounts.');
    expect({ previous: rows[0]!.previousValue, next: rows[0]!.nextValue }).toEqual({
      previous: 'allowed',
      next: 'banned',
    });
    expect({ previous: rows[1]!.previousValue, next: rows[1]!.nextValue }).toEqual({
      previous: 'user',
      next: 'admin',
    });

    // The audit row points AT the moderation row and never copies the prose:
    // the reason is a bounded column that lives in exactly one place.
    const audit = await harness.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetId, person.id),
          eq(schema.auditLog.action, 'user.chat_banned'),
        ),
      );
    expect(audit[0]!.meta).toEqual({ moderationId: rows[0]!.id });
    expect(JSON.stringify(audit)).not.toContain('Harassment reported');
  });

  it('commits the suspension and its reason atomically — a later failure leaves neither', async () => {
    const { agent } = await adminSession();
    const taken = await seedPerson({ email: 'taken@test.dev', username: 'taken_user' });
    const person = await seedPerson({ email: 'atomic@test.dev', username: 'atomic_user' });

    // One request that suspends AND re-addresses the account. The status change
    // and its moderation row are written first; the e-mail collision then
    // aborts the transaction. Nothing may survive it — neither half.
    const res = await agent
      .patch(`/api/v1/admin/users/${person.id}`)
      .set(...XRW)
      .send({ status: 'disabled', email: taken.email, reason: 'Suspended for review.' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');

    const [row] = await harness.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, person.id));
    expect(row!.status).toBe('active');
    expect(await moderationRows(person.id)).toHaveLength(0);
  });

  it('keeps the record of a suspension whose post-commit cleanup fails', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'halfway@test.dev', username: 'halfway_user' });

    const revoke = vi
      .spyOn(harness.ctx.apiKeys, 'revokeAllForUser')
      .mockRejectedValueOnce(new Error('simulated revocation failure'));
    const res = await agent
      .patch(`/api/v1/admin/users/${person.id}`)
      .set(...XRW)
      .send({ status: 'disabled', reason: 'Suspended while the report is checked.' });
    expect(res.status).toBe(500);
    revoke.mockRestore();

    // The suspension is durable and fail-closed; the reason is durable with it.
    // A half-applied suspension that nobody can explain is the exact failure
    // this wave exists to remove.
    const [row] = await harness.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, person.id));
    expect(row!.status).toBe('disabled');
    const rows = await moderationRows(person.id);
    expect(rows.map((entry) => entry.action)).toEqual(['disable']);
    expect(rows[0]!.reason).toBe('Suspended while the report is checked.');
  });
});

describe('POST /admin/users/bulk — one reason, one row per affected account (#1907)', () => {
  it('refuses a batch with no reason', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'batch@test.dev', username: 'batch_user' });

    const res = await agent
      .post('/api/v1/admin/users/bulk')
      .set(...XRW)
      .send({ action: 'disable', userIds: [person.id] });
    expect(res.status).toBe(400);

    const [row] = await harness.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, person.id));
    expect(row!.status).toBe('active');
  });

  it('writes one row per affected account, all with the same reason and actor — and none for a skipped id', async () => {
    const { agent, admin } = await adminSession();
    const a = await seedPerson({ email: 'bulk-a@test.dev', username: 'bulk_a' });
    const b = await seedPerson({ email: 'bulk-b@test.dev', username: 'bulk_b' });

    const res = await agent
      .post('/api/v1/admin/users/bulk')
      .set(...XRW)
      .send({
        action: 'disable',
        // The actor is in the batch and must be skipped — a skipped row is not
        // an affected row and must leave no record behind.
        userIds: [a.id, b.id, admin.id],
        reason: 'Coordinated spam wave 2026-09-15.',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ disabled: 2, skipped: 1 });

    for (const person of [a, b]) {
      const rows = await moderationRows(person.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('disable');
      expect(rows[0]!.reason).toBe('Coordinated spam wave 2026-09-15.');
      expect(rows[0]!.actorId).toBe(admin.id);
      expect(rows[0]!.nextValue).toBe('disabled');
    }
    expect(await moderationRows(admin.id)).toHaveLength(0);
  });

  it('still records the row of a batch member whose cleanup failed', async () => {
    const { agent } = await adminSession();
    const doomed = await seedPerson({ email: 'doomed@test.dev', username: 'doomed_user' });

    const revoke = vi
      .spyOn(harness.ctx.apiKeys, 'revokeAllForUser')
      .mockRejectedValueOnce(new Error('simulated revocation failure'));
    const res = await agent
      .post('/api/v1/admin/users/bulk')
      .set(...XRW)
      .send({ action: 'disable', userIds: [doomed.id], reason: 'Batch suspension under review.' });
    revoke.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ userId: doomed.id, outcome: 'cleanup_failed' }]);
    const rows = await moderationRows(doomed.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('Batch suspension under review.');
  });
});

describe('GET /admin/users/:id/moderation — the record (#1907)', () => {
  it('returns it newest-first with a stable tiebreak, pages, and never mixes two accounts', async () => {
    const { agent, admin } = await adminSession();
    const subject = await seedPerson({ email: 'record@test.dev', username: 'record_user' });
    const other = await seedPerson({ email: 'other@test.dev', username: 'other_user' });

    // Two actions from ONE request: they share a transaction timestamp by
    // construction, which is exactly what the `id` tiebreak is for.
    const both = await agent
      .patch(`/api/v1/admin/users/${subject.id}`)
      .set(...XRW)
      .send({ status: 'disabled', chatBanned: true, reason: 'Abuse report, both levers.' });
    expect(both.status).toBe(200);
    const enabled = await agent
      .patch(`/api/v1/admin/users/${subject.id}`)
      .set(...XRW)
      .send({ status: 'active', reason: 'Report withdrawn.' });
    expect(enabled.status).toBe(200);

    // A different account's record, to prove the read is scoped.
    const otherPatch = await agent
      .patch(`/api/v1/admin/users/${other.id}`)
      .set(...XRW)
      .send({ chatBanned: true, reason: 'UNRELATED-ACCOUNT-REASON' });
    expect(otherPatch.status).toBe(200);

    const page = adminModerationListResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${subject.id}/moderation`)).body,
    );
    expect(page.page).toEqual({ total: 3, limit: 25, offset: 0 });
    expect(page.actions[0]!.action).toBe('enable');
    expect(
      page.actions
        .map((entry) => entry.action)
        .slice(1)
        .sort(),
    ).toEqual(['chat_ban', 'disable']);
    // Ownership scoping lives in the repository, not the controller (§10): the
    // other account's row is unreachable from this id.
    expect(JSON.stringify(page)).not.toContain('UNRELATED-ACCOUNT-REASON');
    expect(page.actions.every((entry) => entry.actorUsername === admin.username)).toBe(true);
    expect(page.actions.every((entry) => entry.actorId === admin.id)).toBe(true);

    // Paging over the two rows that share a timestamp: the tiebreak must give
    // every row exactly once across the two windows.
    const first = adminModerationListResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${subject.id}/moderation?limit=2&offset=0`)).body,
    );
    const second = adminModerationListResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${subject.id}/moderation?limit=2&offset=2`)).body,
    );
    expect(first.actions).toHaveLength(2);
    expect(second.actions).toHaveLength(1);
    const ids = [...first.actions, ...second.actions].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(page.actions.map((entry) => entry.id));
  });

  /**
   * The scoping probe, isolated so it can only fail for ONE reason. Proven red
   * by deleting the `user_id` condition from `listFor` in
   * `adminModerationRepository.ts`: the read then answers with the other
   * account's rows and this test fails on the leaked reason, not on an
   * ordering assertion that happened to notice.
   */
  it('never answers a request for one account with another account’s rows', async () => {
    const { agent } = await adminSession();
    const subject = await seedPerson({ email: 'scoped-a@test.dev', username: 'scoped_a' });
    const other = await seedPerson({ email: 'scoped-b@test.dev', username: 'scoped_b' });

    // Asserted, or the probe passes when the SEEDING request silently failed and
    // there was never another account's row to leak in the first place.
    const seeded = await agent
      .patch(`/api/v1/admin/users/${other.id}`)
      .set(...XRW)
      .send({ chatBanned: true, reason: 'OTHER-ACCOUNT-ONLY-REASON' });
    expect(seeded.status).toBe(200);
    expect(await moderationRows(other.id)).toHaveLength(1);

    const page = adminModerationListResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${subject.id}/moderation`)).body,
    );
    expect(page.actions).toEqual([]);
    expect(page.page.total).toBe(0);
    expect(JSON.stringify(page)).not.toContain('OTHER-ACCOUNT-ONLY-REASON');
  });

  it('renders a tombstone instead of failing when the acting operator is gone', async () => {
    const { agent } = await adminSession();
    const departing = await harness.seedAdmin({
      email: 'departing@test.dev',
      username: 'departing_admin',
    });
    const subject = await seedPerson({ email: 'outlives@test.dev', username: 'outlives_user' });

    // Acted through the service so the record carries the OTHER operator.
    await harness.ctx.admin.updateUser(
      subject.id,
      { status: 'disabled', reason: 'Suspended by the operator who later left.' },
      { id: departing.id },
    );
    await harness.db.delete(schema.users).where(eq(schema.users.id, departing.id));

    const page = adminModerationListResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${subject.id}/moderation`)).body,
    );
    expect(page.actions).toHaveLength(1);
    expect(page.actions[0]!.actorId).toBeNull();
    expect(page.actions[0]!.actorUsername).toBeNull();
    // The record outlives the operator: the reason is still readable.
    expect(page.actions[0]!.reason).toBe('Suspended by the operator who later left.');
  });

  it('404s for an unknown account exactly as every other per-account read does', async () => {
    const { agent } = await adminSession();
    const res = await agent.get(
      '/api/v1/admin/users/00000000-0000-7000-8000-0000000000ff/moderation',
    );
    expect(res.status).toBe(404);
  });

  it('is invisible to a non-admin session and to an anonymous caller', async () => {
    const { agent, admin } = await adminSession();
    const person = await seedPerson({ email: 'guarded@test.dev', username: 'guarded_user' });
    expect((await agent.get(`/api/v1/admin/users/${person.id}/moderation`)).status).toBe(200);

    const userAgent = request.agent(harness.app);
    const login = await userAgent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: person.email, password: 'user-strong-password-1' });
    expect(login.status).toBe(200);
    // 404, never 403: the admin surface does not confirm its own existence.
    expect((await userAgent.get(`/api/v1/admin/users/${admin.id}/moderation`)).status).toBe(404);
    expect(
      (await request(harness.app).get(`/api/v1/admin/users/${person.id}/moderation`)).status,
    ).toBe(404);
  });
});

describe('review flags — "watch this" without suspending anything (#1907, §6.12)', () => {
  it('flags idempotently: one flag row with the latest reason, one action per decision', async () => {
    const { agent, admin } = await adminSession();
    const person = await seedPerson({ email: 'flagged@test.dev', username: 'flagged_user' });

    const first = await agent
      .post(`/api/v1/admin/users/${person.id}/flag`)
      .set(...XRW)
      .send({ reason: 'Two chargebacks in a week.' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });

    const second = await agent
      .post(`/api/v1/admin/users/${person.id}/flag`)
      .set(...XRW)
      .send({ reason: 'Third chargeback — watching closely.' });
    expect(second.status).toBe(200);

    const flags = await harness.db
      .select()
      .from(schema.adminUserFlags)
      .where(eq(schema.adminUserFlags.userId, person.id));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.reason).toBe('Third chargeback — watching closely.');
    expect(flags[0]!.flaggedBy).toBe(admin.id);

    const rows = await moderationRows(person.id);
    expect(rows.map((row) => row.action)).toEqual(['flag', 'flag']);
    expect(rows.map((row) => row.previousValue)).toEqual(['unflagged', 'flagged']);

    // A flag is NOT a suspension tier (§6.12): nothing the account can observe
    // has moved.
    const [row] = await harness.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, person.id));
    expect(row!.status).toBe('active');
    expect(row!.chatBanned).toBe(false);
  });

  it('refuses a flag with no reason or a blank one', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'blankflag@test.dev', username: 'blank_flag' });

    for (const body of [{}, { reason: '   ' }]) {
      const res = await agent
        .post(`/api/v1/admin/users/${person.id}/flag`)
        .set(...XRW)
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(await moderationRows(person.id)).toHaveLength(0);
  });

  it('unflags idempotently: a no-op on an unflagged account writes no action', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'unflag@test.dev', username: 'unflag_user' });

    const noop = await agent.delete(`/api/v1/admin/users/${person.id}/flag`).set(...XRW);
    expect(noop.status).toBe(200);
    expect(noop.body).toEqual({ ok: true });
    expect(await moderationRows(person.id)).toHaveLength(0);

    await agent
      .post(`/api/v1/admin/users/${person.id}/flag`)
      .set(...XRW)
      .send({ reason: 'Looks like a bot ring.' });
    const cleared = await agent.delete(`/api/v1/admin/users/${person.id}/flag`).set(...XRW);
    expect(cleared.status).toBe(200);

    expect(
      await harness.db
        .select()
        .from(schema.adminUserFlags)
        .where(eq(schema.adminUserFlags.userId, person.id)),
    ).toHaveLength(0);
    const rows = await moderationRows(person.id);
    expect(rows.map((row) => row.action)).toEqual(['flag', 'unflag']);
    // The cleared flag keeps the suspicion it was raised on, rather than
    // inventing prose on the operator's behalf.
    expect(rows[1]!.reason).toBe('Looks like a bot ring.');
  });

  it('appends nothing when a concurrent unflag already removed the row', async () => {
    const { agent, admin } = await adminSession();
    const person = await seedPerson({ email: 'race@test.dev', username: 'race_user' });
    await agent
      .post(`/api/v1/admin/users/${person.id}/flag`)
      .set(...XRW)
      .send({ reason: 'Looks like a bot ring.' });

    // Two operators clearing the same flag: both read it, one DELETE removes
    // it. The loser must not append an `unflag` for something it did not do.
    const [first, second] = await Promise.all([
      harness.ctx.admin.unflagUser(person.id, undefined, { id: admin.id }),
      harness.ctx.admin.unflagUser(person.id, undefined, { id: admin.id }),
    ]);
    expect([first, second]).toEqual([undefined, undefined]);

    const rows = await moderationRows(person.id);
    expect(rows.map((row) => row.action)).toEqual(['flag', 'unflag']);
  });

  it('marks the flag on the account payload and nowhere else', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'marker@test.dev', username: 'marker_user' });

    const before = adminUserSchema.parse(
      (await agent.get(`/api/v1/admin/users/${person.id}`)).body,
    );
    // Additive: an unflagged account's payload is what it always was.
    expect(before.flagged).toBeUndefined();

    await agent
      .post(`/api/v1/admin/users/${person.id}/flag`)
      .set(...XRW)
      .send({ reason: 'Duplicate signups from one address.' });

    const after = adminUserSchema.parse((await agent.get(`/api/v1/admin/users/${person.id}`)).body);
    expect(after.flagged).toBe(true);
    // The marker is a boolean. The REASON is not smuggled onto the row, so a
    // list of accounts never renders operator prose next to a username.
    expect(JSON.stringify(after)).not.toContain('Duplicate signups');
  });
});

describe('an interrupted delete leaves an explainable suspension (#1907)', () => {
  it('keeps both the reserved suspension and its moderation row when cleanup fails', async () => {
    const { agent, admin } = await adminSession();
    const person = await seedPerson({ email: 'halfdelete@test.dev', username: 'half_delete' });

    // The succession hand-off runs after the reservation commits and before the
    // row is removed — the exact window that leaves a durable suspension behind.
    const succession = vi
      .spyOn(harness.ctx.mirror, 'handleAccountDeletion')
      .mockRejectedValueOnce(new Error('simulated succession failure'));
    const res = await agent
      .delete(`/api/v1/admin/users/${person.id}`)
      .set(...XRW)
      .send({ confirmUsername: person.username });
    succession.mockRestore();
    expect(res.status).toBe(500);

    const [row] = await harness.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, person.id));
    expect(row!.status).toBe('disabled');

    // Before #1907's fix round this account was locked out with a Moderation
    // tab that said "no moderation action has been taken".
    const rows = await moderationRows(person.id);
    expect(rows.map((entry) => entry.action)).toEqual(['delete_reservation']);
    expect(rows[0]!.reason).toMatch(/deletion reserved/i);
    expect(rows[0]!.previousValue).toBe('active');
    expect(rows[0]!.nextValue).toBe('disabled');
    expect(rows[0]!.actorId).toBe(admin.id);

    const page = adminModerationListResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${person.id}/moderation`)).body,
    );
    expect(page.actions[0]!.action).toBe('delete_reservation');

    // The audit row points at it rather than repeating its text.
    const audit = await harness.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.targetId, person.id), eq(schema.auditLog.action, 'user.disabled')),
      );
    expect(audit[0]!.meta).toMatchObject({ moderationId: rows[0]!.id, cleanup: 'incomplete' });
  });

  it('leaves no reservation row behind when the delete actually completes', async () => {
    const { admin } = await adminSession();
    const person = await seedPerson({ email: 'fulldelete@test.dev', username: 'full_delete' });

    await harness.ctx.admin.deleteUser(person.id, person.username, { id: admin.id });
    // The row cascades with the account: the reservation record self-cleans and
    // only an INTERRUPTED delete leaves a trace.
    expect(await moderationRows(person.id)).toHaveLength(0);
  });
});

describe('the moderation record is admin workspace, not the account’s content (#1907)', () => {
  it('cascades away with the account and never reaches its own export', async () => {
    const { agent, admin } = await adminSession();
    const person = await seedPerson({ email: 'cascade@test.dev', username: 'cascade_user' });

    await agent
      .patch(`/api/v1/admin/users/${person.id}`)
      .set(...XRW)
      .send({ chatBanned: true, reason: 'MODERATION-PROSE-MUST-NOT-LEAK' });
    await agent
      .post(`/api/v1/admin/users/${person.id}/flag`)
      .set(...XRW)
      .send({ reason: 'MODERATION-PROSE-MUST-NOT-LEAK' });
    // The chat ban and the flag: two decisions, two rows.
    expect((await moderationRows(person.id)).map((row) => row.action)).toEqual([
      'chat_ban',
      'flag',
    ]);

    // The account's OWN export (§16 2026-08-29, the operator-note ruling): the
    // record is one operator writing for the next, not content the account
    // authored, so it is not theirs to receive.
    const collected = await collectUserExport(harness.db, person.id);
    expect(JSON.stringify(collected)).not.toContain('MODERATION-PROSE-MUST-NOT-LEAK');

    // Withholding is about DISCLOSURE, never retention: deletion stays total.
    await harness.ctx.admin.deleteUser(person.id, person.username, { id: admin.id });
    expect(await moderationRows(person.id)).toHaveLength(0);
    expect(
      await harness.db
        .select()
        .from(schema.adminUserFlags)
        .where(eq(schema.adminUserFlags.userId, person.id)),
    ).toHaveLength(0);
  });
});
