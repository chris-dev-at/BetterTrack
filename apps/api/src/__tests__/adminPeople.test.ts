import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ADMIN_USER_NOTE_MAX_LENGTH,
  adminUserAccessResponseSchema,
  adminUserListResponseSchema,
  adminUserNoteListResponseSchema,
  adminUserNoteSchema,
  adminUserSchema,
  adminUserSharingResponseSchema,
  adminUserSupportResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** An admin agent plus the seeded admin row, the shape most tests here need. */
async function adminSession() {
  const admin = await harness.seedAdmin();
  const agent = await harness.loginAdmin(admin);
  return { admin, agent };
}

/**
 * Seed a user directly through the repository (not the admin API) so the row's
 * `created_at` ordering is under the test's control and no audit noise lands.
 */
async function seedPerson(input: {
  email: string;
  username: string;
  status?: 'active' | 'disabled';
  role?: 'user' | 'admin';
}) {
  const user = await harness.seedUser({ email: input.email, username: input.username });
  const patch: Partial<{ status: 'active' | 'disabled'; role: 'user' | 'admin' }> = {};
  if (input.status) patch.status = input.status;
  if (input.role) patch.role = input.role;
  if (Object.keys(patch).length > 0) {
    await harness.db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));
  }
  return user;
}

describe('GET /admin/users — filter, sort, page (#1406 W2)', () => {
  it('pages the list and reports the total for the FILTER, not the page', async () => {
    const { agent } = await adminSession();
    for (let i = 0; i < 5; i += 1) {
      await seedPerson({ email: `page${i}@test.dev`, username: `page-user-${i}` });
    }

    const first = await agent.get(
      '/api/v1/admin/users?limit=2&offset=0&sort=username&direction=asc',
    );
    expect(first.status).toBe(200);
    const firstPage = adminUserListResponseSchema.parse(first.body);
    expect(firstPage.users).toHaveLength(2);
    // 5 seeded people + the admin itself.
    expect(firstPage.page).toEqual({ total: 6, limit: 2, offset: 0 });

    const second = await agent.get(
      '/api/v1/admin/users?limit=2&offset=2&sort=username&direction=asc',
    );
    const secondPage = adminUserListResponseSchema.parse(second.body);
    expect(secondPage.users).toHaveLength(2);
    expect(secondPage.page.offset).toBe(2);

    // The window really moved: no row appears on both pages.
    const overlap = firstPage.users
      .map((u) => u.id)
      .filter((id) => secondPage.users.some((u) => u.id === id));
    expect(overlap).toEqual([]);
  });

  it('orders by the requested column in the requested direction', async () => {
    const { agent } = await adminSession();
    await seedPerson({ email: 'zulu@test.dev', username: 'zulu' });
    await seedPerson({ email: 'alpha@test.dev', username: 'alpha' });

    const asc = adminUserListResponseSchema.parse(
      (await agent.get('/api/v1/admin/users?sort=username&direction=asc')).body,
    );
    const desc = adminUserListResponseSchema.parse(
      (await agent.get('/api/v1/admin/users?sort=username&direction=desc')).body,
    );

    expect(asc.users[0]?.username).toBe('admin');
    expect(desc.users[0]?.username).toBe('zulu');
    expect(asc.users.map((u) => u.username)).toEqual(
      [...desc.users.map((u) => u.username)].reverse(),
    );
  });

  it('filters by account kind and by state, independently', async () => {
    const { agent } = await adminSession();
    await seedPerson({ email: 'active@test.dev', username: 'active-one' });
    await seedPerson({ email: 'off@test.dev', username: 'disabled-one', status: 'disabled' });

    const admins = adminUserListResponseSchema.parse(
      (await agent.get('/api/v1/admin/users?role=admin')).body,
    );
    expect(admins.users.map((u) => u.username)).toEqual(['admin']);
    expect(admins.page.total).toBe(1);

    const disabled = adminUserListResponseSchema.parse(
      (await agent.get('/api/v1/admin/users?status=disabled')).body,
    );
    expect(disabled.users.map((u) => u.username)).toEqual(['disabled-one']);

    const activeUsers = adminUserListResponseSchema.parse(
      (await agent.get('/api/v1/admin/users?role=user&status=active')).body,
    );
    expect(activeUsers.users.map((u) => u.username)).toEqual(['active-one']);
  });

  it('filters by privacy mode without exposing anything inside the vault', async () => {
    const { agent } = await adminSession();
    const normal = await seedPerson({ email: 'normal@test.dev', username: 'normal-one' });
    const paranoid = await seedPerson({ email: 'para@test.dev', username: 'paranoid-one' });
    await harness.db
      .update(schema.users)
      .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
      .where(eq(schema.users.id, paranoid.id));

    const encryptedRes = await agent.get('/api/v1/admin/users?privacyMode=paranoid');
    const encrypted = adminUserListResponseSchema.parse(encryptedRes.body);
    expect(encrypted.users.map((u) => u.username)).toEqual(['paranoid-one']);
    expect(encrypted.page.total).toBe(1);

    // Metadata only — the mode and the media set. §16 (2026-07-21): "admin sees
    // mode/media/blob metadata only". Asserted on the RAW body, not the parsed
    // object: a zod parse strips unknown keys, so parsing first would make this
    // check unable to catch a leak the route actually shipped.
    expect(encrypted.users[0]?.privacyMode).toBe('paranoid');
    expect(encrypted.users[0]?.paranoid?.mediaSet).toEqual(['server']);
    const rawBody = JSON.stringify(encryptedRes.body);
    for (const forbidden of ['blob', 'ciphertext', 'passwordHash', 'driveFileId', 'wrappedKey']) {
      expect(rawBody).not.toContain(forbidden);
    }

    const plain = adminUserListResponseSchema.parse(
      (await agent.get('/api/v1/admin/users?privacyMode=normal')).body,
    );
    expect(plain.users.map((u) => u.id)).toContain(normal.id);
    expect(plain.users.map((u) => u.id)).not.toContain(paranoid.id);
  });

  it('rejects an unknown sort column instead of interpolating it', async () => {
    const { agent } = await adminSession();
    const res = await agent.get('/api/v1/admin/users?sort=passwordHash');
    expect(res.status).toBe(400);
  });

  it('rejects a page size above the contract maximum', async () => {
    const { agent } = await adminSession();
    expect((await agent.get('/api/v1/admin/users?limit=201')).status).toBe(400);
  });
});

describe('GET /admin/users/:id — the single-account read (#1406 W2)', () => {
  it('returns one account to an admin', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'one@test.dev', username: 'just-one' });

    const res = await agent.get(`/api/v1/admin/users/${person.id}`);
    expect(res.status).toBe(200);
    expect(adminUserSchema.parse(res.body).username).toBe('just-one');
  });

  it('404s for an unknown id, for anonymous callers and for a user-kind session', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'scoped@test.dev', username: 'scoped' });
    const userAgent = await loginAgent(harness.app, person.email, person.password);

    expect(
      (await agent.get('/api/v1/admin/users/11111111-1111-4111-8111-111111111111')).status,
    ).toBe(404);
    expect((await request(harness.app).get(`/api/v1/admin/users/${person.id}`)).status).toBe(404);
    expect((await userAgent.get(`/api/v1/admin/users/${person.id}`)).status).toBe(404);
  });
});

describe('GET /admin/users/:id/access — sessions, keys, grants, identities', () => {
  it("lists the account's live sessions by public handle, never by session id", async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'devices@test.dev', username: 'devices' });
    await loginAgent(harness.app, person.email, person.password);

    const res = await agent.get(`/api/v1/admin/users/${person.id}/access`);
    expect(res.status).toBe(200);
    const access = adminUserAccessResponseSchema.parse(res.body);
    expect(access.sessions).toHaveLength(1);

    // The raw session id lives in Redis under `sess:<id>`. It must appear
    // nowhere in this response: a handle that could be replayed as a cookie
    // would turn an operator read into account takeover.
    const rawIds = (await harness.ctx.redis.keys('sess:*')).map((key) => key.slice('sess:'.length));
    expect(rawIds.length).toBeGreaterThan(0);
    const payload = JSON.stringify(access);
    for (const rawId of rawIds) expect(payload).not.toContain(rawId);
  });

  it("reports the account's API keys, OAuth grants and linked identities", async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'access@test.dev', username: 'access' });

    await harness.db.insert(schema.apiKeys).values({
      userId: person.id,
      name: 'home dashboard',
      tokenHash: 'hash-for-the-access-test',
      scopes: ['read:portfolio'],
    });
    await harness.db.insert(schema.externalIdentities).values({
      userId: person.id,
      provider: 'google',
      subject: 'google-subject-that-must-not-leak',
      email: 'different-address@gmail.test',
      emailVerified: true,
    });

    const access = adminUserAccessResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${person.id}/access`)).body,
    );

    expect(access.apiKeys).toHaveLength(1);
    expect(access.apiKeys[0]).toMatchObject({ name: 'home dashboard', scopes: ['read:portfolio'] });
    expect(access.identities).toEqual([
      expect.objectContaining({ provider: 'google', emailVerified: true }),
    ]);

    // Neither the key material nor the provider subject nor the provider's own
    // address is anywhere in the projection.
    const payload = JSON.stringify(access);
    expect(payload).not.toContain('hash-for-the-access-test');
    expect(payload).not.toContain('google-subject-that-must-not-leak');
    expect(payload).not.toContain('different-address@gmail.test');
  });

  it('404s the whole read for a non-admin', async () => {
    await adminSession();
    const person = await seedPerson({ email: 'nope@test.dev', username: 'nope' });
    const userAgent = await loginAgent(harness.app, person.email, person.password);
    expect((await userAgent.get(`/api/v1/admin/users/${person.id}/access`)).status).toBe(404);
  });
});

describe('GET /admin/users/:id/sharing — counts, never an inventory', () => {
  it('counts portfolios, shared portfolios and the social graph', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'sharer@test.dev', username: 'sharer' });
    const friend = await seedPerson({ email: 'friend@test.dev', username: 'friend' });

    // TWO portfolios, only ONE of them shared — so `sharedPortfolioCount` is
    // isolated from `portfolioCount` and cannot pass by counting everything.
    // The shared one's NAME must never travel.
    await harness.db.insert(schema.portfolios).values([
      { userId: person.id, name: 'Kept To Myself', visibility: 'private' },
      { userId: person.id, name: 'Secret Retirement Plan', visibility: 'friends' },
    ]);
    const [a, b] = [person.id, friend.id].sort();
    await harness.db.insert(schema.friendships).values({ userA: a!, userB: b! });
    await harness.db
      .insert(schema.userFollows)
      .values({ followerId: friend.id, followedId: person.id });

    const res = await agent.get(`/api/v1/admin/users/${person.id}/sharing`);
    expect(res.status).toBe(200);
    const sharing = adminUserSharingResponseSchema.parse(res.body);

    expect(sharing.portfolioCount).toBe(2);
    expect(sharing.sharedPortfolioCount).toBe(1);
    expect(sharing.friendCount).toBe(1);
    expect(sharing.followerCount).toBe(1);
    expect(sharing.followingCount).toBe(0);

    // The whole point of the tab: a number, not the thing itself.
    expect(JSON.stringify(sharing)).not.toContain('Secret Retirement Plan');
  });
});

describe('GET /admin/users/:id/support — summaries without message bodies', () => {
  it('summarizes the submissions and counts the open ones', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'support@test.dev', username: 'support-user' });

    await harness.db.insert(schema.feedback).values([
      {
        userId: person.id,
        category: 'bug',
        subject: 'Dividend rounding',
        message: 'PLEASE-DO-NOT-SHIP-THIS-BODY',
        status: 'new',
      },
      {
        userId: person.id,
        category: 'feature',
        subject: 'Dark mode',
        message: 'another body',
        // `shipped` carries its version by DB constraint (feedback_status_metadata_pair).
        status: 'shipped',
        shippedVersion: '1.4.0',
      },
    ]);

    const res = await agent.get(`/api/v1/admin/users/${person.id}/support`);
    expect(res.status).toBe(200);
    const support = adminUserSupportResponseSchema.parse(res.body);

    expect(support.total).toBe(2);
    // `shipped` is terminal, so exactly one thread is open — the same predicate
    // the 20-submission cap enforces.
    expect(support.openCount).toBe(1);
    expect(support.items.map((item) => item.subject)).toEqual(['Dark mode', 'Dividend rounding']);
    expect(support.items.every((item) => item.unreadByAdmin)).toBe(true);

    expect(JSON.stringify(support)).not.toContain('PLEASE-DO-NOT-SHIP-THIS-BODY');
  });
});

describe('Operator notes (#1406 W2) — the one additive write', () => {
  it('creates, lists and deletes a note, auditing both writes without the body', async () => {
    const { admin, agent } = await adminSession();
    const person = await seedPerson({ email: 'noted@test.dev', username: 'noted' });

    const created = await agent
      .post(`/api/v1/admin/users/${person.id}/notes`)
      .set(...XRW)
      .send({ body: 'Prefers German copy. Check DE strings before replying.' });
    expect(created.status).toBe(201);
    const note = adminUserNoteSchema.parse(created.body);
    expect(note.authorId).toBe(admin.id);
    expect(note.authorUsername).toBe('admin');

    const listed = adminUserNoteListResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${person.id}/notes`)).body,
    );
    expect(listed.notes.map((n) => n.id)).toEqual([note.id]);

    const addedAudit = await harness.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, 'user.note_added'), eq(schema.auditLog.targetId, person.id)),
      );
    expect(addedAudit).toHaveLength(1);
    expect(addedAudit[0]?.actorId).toBe(admin.id);
    // The audit trail records THAT a note was written, never the prose — a copy
    // in the audit log would outlive the delete below.
    expect(JSON.stringify(addedAudit[0]?.meta)).toBe(JSON.stringify({ noteId: note.id }));
    expect(JSON.stringify(addedAudit[0]?.meta)).not.toContain('German');

    const removed = await agent
      .delete(`/api/v1/admin/users/${person.id}/notes/${note.id}`)
      .set(...XRW);
    expect(removed.status).toBe(200);

    const afterDelete = adminUserNoteListResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${person.id}/notes`)).body,
    );
    expect(afterDelete.notes).toEqual([]);

    const deletedAudit = await harness.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'user.note_deleted'));
    expect(deletedAudit).toHaveLength(1);
  });

  it('scopes a note to its own account — a note on A is invisible on B and undeletable through B', async () => {
    const { agent } = await adminSession();
    const a = await seedPerson({ email: 'a@test.dev', username: 'person-a' });
    const b = await seedPerson({ email: 'b@test.dev', username: 'person-b' });

    const note = adminUserNoteSchema.parse(
      (
        await agent
          .post(`/api/v1/admin/users/${a.id}/notes`)
          .set(...XRW)
          .send({ body: 'Only about A.' })
      ).body,
    );

    const bNotes = adminUserNoteListResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${b.id}/notes`)).body,
    );
    expect(bNotes.notes).toEqual([]);

    // Deleting A's note through B's id must not reach across accounts.
    const crossDelete = await agent
      .delete(`/api/v1/admin/users/${b.id}/notes/${note.id}`)
      .set(...XRW);
    expect(crossDelete.status).toBe(404);

    const aNotes = adminUserNoteListResponseSchema.parse(
      (await agent.get(`/api/v1/admin/users/${a.id}/notes`)).body,
    );
    expect(aNotes.notes.map((n) => n.id)).toEqual([note.id]);
  });

  it('rejects a blank note and one past the length cap', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'limits@test.dev', username: 'limits' });

    const blank = await agent
      .post(`/api/v1/admin/users/${person.id}/notes`)
      .set(...XRW)
      .send({ body: '   ' });
    expect(blank.status).toBe(400);

    const tooLong = await agent
      .post(`/api/v1/admin/users/${person.id}/notes`)
      .set(...XRW)
      .send({ body: 'x'.repeat(ADMIN_USER_NOTE_MAX_LENGTH + 1) });
    expect(tooLong.status).toBe(400);
  });

  it('never exposes notes to the account they are about, or to any user session', async () => {
    const { agent } = await adminSession();
    const person = await seedPerson({ email: 'private@test.dev', username: 'private-one' });
    await agent
      .post(`/api/v1/admin/users/${person.id}/notes`)
      .set(...XRW)
      .send({ body: 'Operator-only observation.' });

    const userAgent = await loginAgent(harness.app, person.email, person.password);
    expect((await userAgent.get(`/api/v1/admin/users/${person.id}/notes`)).status).toBe(404);
    expect(
      (
        await userAgent
          .post(`/api/v1/admin/users/${person.id}/notes`)
          .set(...XRW)
          .send({ body: 'I should not be able to write this.' })
      ).status,
    ).toBe(404);
  });

  it('404s a note on an account that does not exist', async () => {
    const { agent } = await adminSession();
    const missing = '22222222-2222-4222-8222-222222222222';
    expect((await agent.get(`/api/v1/admin/users/${missing}/notes`)).status).toBe(404);
  });
});

describe('Registration applicants expose how they applied (#1406 W2)', () => {
  it('carries the provider so an operator can tell Google from password', async () => {
    const { agent } = await adminSession();
    await harness.db.insert(schema.registrationRequests).values([
      {
        email: 'google-applicant@test.dev',
        username: 'google-applicant',
        provider: 'google',
        providerSubject: 'subject-stays-server-side',
      },
      {
        email: 'password-applicant@test.dev',
        username: 'password-applicant',
        passwordHash: 'not-a-real-hash',
      },
    ]);

    const res = await agent.get('/api/v1/admin/registration-requests');
    expect(res.status).toBe(200);
    const byUsername = new Map(
      (res.body.requests as { username: string; provider: string | null }[]).map((row) => [
        row.username,
        row.provider,
      ]),
    );
    expect(byUsername.get('google-applicant')).toBe('google');
    expect(byUsername.get('password-applicant')).toBeNull();
    // The subject is the one part that stays behind.
    expect(JSON.stringify(res.body)).not.toContain('subject-stays-server-side');
  });
});
