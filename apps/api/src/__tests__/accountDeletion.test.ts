import request from 'supertest';
import type { Application } from 'express';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  chatConversationListResponseSchema,
  chatThreadResponseSchema,
  createApiKeyResponseSchema,
  twoFactorEnrollResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { generateTotpCode } from '../services/auth/totp';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Self-service account deletion (PROJECTPLAN.md §13.4 V4-P2c, #362). The
 * acceptance criteria are the point: re-auth (password or fresh 2FA) + typed
 * confirmation are REQUIRED; post-deletion a schema-wide sweep finds zero rows
 * keyed to the user and login is dead; both the cookie (web) and bearer
 * (mobile, `account:security`) paths complete deletion; chat messages
 * anonymize for the partner instead of vanishing (§16 2026-07-09).
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

interface Person {
  id: string;
  email: string;
  username: string;
  password: string;
  agent: Agent;
}

async function seedPerson(username: string): Promise<Person> {
  const seeded = await harness.seedUser({ email: `${username}@bt.test`, username });
  const agent = await loginAgent(harness.app, seeded.email, seeded.password);
  return { ...seeded, agent };
}

/** Form a friendship: `a` requests `b`, `b` accepts. */
async function befriend(a: Person, b: Person): Promise<void> {
  const sent = await a.agent
    .post('/api/v1/social/requests')
    .set(...XRW)
    .send({ identifier: b.username });
  expect(sent.status).toBe(202);
  const inbox = await b.agent.get('/api/v1/social/requests');
  const req = inbox.body.incoming.find((r: { user: { id: string } }) => r.user.id === a.id);
  const accepted = await b.agent
    .post(`/api/v1/social/requests/${req.id}/accept`)
    .set(...XRW)
    .send();
  expect(accepted.status).toBe(200);
}

function deleteAccount(agent: Agent, body: Record<string, unknown>): request.Test {
  return agent
    .delete('/api/v1/account')
    .set(...XRW)
    .send(body);
}

/**
 * Every FK column in the schema that references `users(id)`, discovered from
 * the live catalog — so a future table joins the sweep automatically and the
 * acceptance check ("zero rows keyed to the user") can never silently narrow.
 */
async function userFkColumns(): Promise<{ table: string; column: string }[]> {
  const res: { rows?: unknown[] } & unknown[] = (await harness.db.execute(sql`
    select tc.table_name as "table", kcu.column_name as "column"
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and ccu.table_name = 'users'
      and ccu.column_name = 'id'
    order by 1, 2
  `)) as never;
  const rows = (res.rows ?? res) as { table: string; column: string }[];
  return rows;
}

/** Rows in `table.column` still keyed to `userId` — must be zero everywhere post-delete. */
async function countKeyedRows(table: string, column: string, userId: string): Promise<number> {
  const res: { rows?: unknown[] } & unknown[] = (await harness.db.execute(
    sql.raw(`select count(*)::int as "n" from "${table}" where "${column}" = '${userId}'`),
  )) as never;
  const rows = (res.rows ?? res) as { n: number }[];
  return rows[0]!.n;
}

describe('DELETE /account — gates (V4-P2c, #362)', () => {
  it('requires a credential, a matching typed confirmation, and a user-kind caller', async () => {
    const user = await seedPerson('gate_user');

    // No credential at all → contract-level rejection before any check.
    const noCred = await deleteAccount(user.agent, { confirmUsername: user.username });
    expect(noCred.status).toBe(400);

    // Wrong typed confirmation → explicit mismatch, nothing deleted.
    const badConfirm = await deleteAccount(user.agent, {
      confirmUsername: 'somebody_else',
      password: user.password,
    });
    expect(badConfirm.status).toBe(400);
    expect(badConfirm.body.error.code).toBe('CONFIRMATION_MISMATCH');

    // Wrong password → re-auth fails, nothing deleted.
    const badPassword = await deleteAccount(user.agent, {
      confirmUsername: user.username,
      password: 'not-the-password',
    });
    expect(badPassword.status).toBe(401);
    expect(badPassword.body.error.code).toBe('INVALID_CREDENTIALS');

    // The account survived every failed attempt.
    const me = await user.agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);

    // Admin-kind accounts don't self-delete here (admin area owns their lifecycle).
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);
    const adminAttempt = await deleteAccount(adminAgent, {
      confirmUsername: admin.username,
      password: admin.password,
    });
    expect(adminAttempt.status).toBe(403);

    // A 2FA code for an account with no 2FA enrolled is never a match.
    const codeAttempt = await deleteAccount(user.agent, {
      confirmUsername: user.username,
      code: '123456',
    });
    expect(codeAttempt.status).toBe(401);
    expect(codeAttempt.body.error.code).toBe('TWO_FACTOR_NOT_ENABLED');
  });

  it('accepts the typed confirmation case-insensitively (matches the admin guard)', async () => {
    const user = await seedPerson('case_user');
    const res = await deleteAccount(user.agent, {
      confirmUsername: user.username.toUpperCase(),
      password: user.password,
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /account — hard delete (acceptance sweep)', () => {
  it('password re-auth deletes everything: schema-wide zero rows, session + login + bearer dead', async () => {
    const user = await seedPerson('doomed');
    const friend = await seedPerson('survivor');
    await befriend(user, friend);

    // Spread data across the graph: a personal API key, a 2FA enrollment with
    // recovery codes, and a chat thread (the friend request above already wrote
    // notifications + social edges; seeding provisioned the Main portfolio).
    const keyRes = await user.agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'sweep', scopes: ['portfolio:read'] });
    expect(keyRes.status).toBe(201);
    const bearer = createApiKeyResponseSchema.parse(keyRes.body).token;

    const enroll = await user.agent.post('/api/v1/auth/2fa/enroll').set(...XRW);
    const { secret } = twoFactorEnrollResponseSchema.parse(enroll.body);
    const confirm = await user.agent
      .post('/api/v1/auth/2fa/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(confirm.status).toBe(200);

    const open = await user.agent
      .post('/api/v1/chat/conversations')
      .set(...XRW)
      .send({ userId: friend.id });
    expect(open.status).toBe(201);
    const conversationId = open.body.conversation.id as string;
    const sent = await user.agent
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set(...XRW)
      .send({ body: 'about to vanish' });
    expect(sent.status).toBe(201);

    // The bearer works before deletion.
    const bearerBefore = await request(harness.app)
      .get('/api/v1/portfolios')
      .set('Authorization', `Bearer ${bearer}`);
    expect(bearerBefore.status).toBe(200);

    // Password is still valid re-auth for a 2FA-enrolled account (§13.4: "password or fresh 2FA").
    const res = await deleteAccount(user.agent, {
      confirmUsername: user.username,
      password: user.password,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // The schema-wide sweep: every FK column referencing users(id) holds zero
    // rows keyed to the deleted user. Sanity-check the discovery actually saw
    // the graph (it must include portfolios, api_keys, chat, social, ...).
    const fkColumns = await userFkColumns();
    expect(fkColumns.length).toBeGreaterThan(20);
    for (const { table, column } of fkColumns) {
      expect(
        await countKeyedRows(table, column, user.id),
        `${table}.${column} still keyed to the deleted user`,
      ).toBe(0);
    }

    // The cookie session is dead.
    expect((await user.agent.get('/api/v1/auth/me')).status).toBe(401);

    // Login is dead.
    const relogin = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(relogin.status).toBe(401);

    // The personal API key died with its row — a hard 401, not a scope error.
    const bearerAfter = await request(harness.app)
      .get('/api/v1/portfolios')
      .set('Authorization', `Bearer ${bearer}`);
    expect(bearerAfter.status).toBe(401);

    // The audit trail records the self-delete without an actor FK.
    const audits = await harness.db.select().from(schema.auditLog);
    const entry = audits.find((a) => a.action === 'user.deleted' && a.targetId === user.id);
    expect(entry).toBeDefined();
    expect(entry!.actorId).toBeNull();
    expect(entry!.meta).toMatchObject({ username: user.username, via: 'self' });
  });

  it('a fresh TOTP code is valid re-auth on its own', async () => {
    const user = await seedPerson('totp_user');
    const enroll = await user.agent.post('/api/v1/auth/2fa/enroll').set(...XRW);
    const { secret } = twoFactorEnrollResponseSchema.parse(enroll.body);
    const confirm = await user.agent
      .post('/api/v1/auth/2fa/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(confirm.status).toBe(200);

    // A wrong code is rejected and deletes nothing.
    const bad = await deleteAccount(user.agent, {
      confirmUsername: user.username,
      code: '000000',
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');

    const res = await deleteAccount(user.agent, {
      confirmUsername: user.username,
      code: generateTotpCode(secret),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const relogin = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(relogin.status).toBe(401);
  });
});

describe('DELETE /account — chat anonymization for the partner (§16 2026-07-09)', () => {
  it('the partner keeps the thread anonymized and read-only; both gone purges it', async () => {
    const a = await seedPerson('keeper');
    const b = await seedPerson('leaver');
    await befriend(a, b);

    const open = await a.agent
      .post('/api/v1/chat/conversations')
      .set(...XRW)
      .send({ userId: b.id });
    expect(open.status).toBe(201);
    const conversationId = open.body.conversation.id as string;
    for (const [agent, body] of [
      [a.agent, 'hi from keeper'],
      [b.agent, 'hi from leaver'],
    ] as const) {
      const sent = await agent
        .post(`/api/v1/chat/conversations/${conversationId}/messages`)
        .set(...XRW)
        .send({ body });
      expect(sent.status).toBe(201);
    }

    const gone = await deleteAccount(b.agent, {
      confirmUsername: b.username,
      password: b.password,
    });
    expect(gone.status).toBe(200);

    // The list still carries the thread — anonymized (`user: null`) — and the
    // deleted side's message still counts as unread for the survivor.
    const list = chatConversationListResponseSchema.parse(
      (await a.agent.get('/api/v1/chat/conversations')).body,
    );
    expect(list.conversations).toHaveLength(1);
    expect(list.conversations[0]!.user).toBeNull();
    expect(list.conversations[0]!.unreadCount).toBe(1);

    // Full history stays readable; the deleted sender is null, the survivor's
    // own message keeps their id.
    const thread = chatThreadResponseSchema.parse(
      (await a.agent.get(`/api/v1/chat/conversations/${conversationId}/messages`)).body,
    );
    expect(thread.conversation.user).toBeNull();
    expect(thread.messages).toHaveLength(2);
    const bodies = Object.fromEntries(thread.messages.map((m) => [m.body, m.senderId]));
    expect(bodies['hi from keeper']).toBe(a.id);
    expect(bodies['hi from leaver']).toBeNull();

    // Closed to new messages — like unfriending.
    const send = await a.agent
      .post(`/api/v1/chat/conversations/${conversationId}/read`)
      .set(...XRW)
      .send();
    expect(send.status).toBe(200);
    const blocked = await a.agent
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set(...XRW)
      .send({ body: 'anyone there?' });
    expect(blocked.status).toBe(403);

    // The survivor leaves too → nobody can ever read the thread; it is purged.
    const alsoGone = await deleteAccount(a.agent, {
      confirmUsername: a.username,
      password: a.password,
    });
    expect(alsoGone.status).toBe(200);
    expect(await harness.db.select().from(schema.chatConversations)).toHaveLength(0);
    expect(await harness.db.select().from(schema.chatMessages)).toHaveLength(0);
  });
});

describe('DELETE /account — bearer path (mobile, account:security)', () => {
  it('a bearer holding account:security deletes; a key without it is denied', async () => {
    const user = await seedPerson('mobile_user');
    const keyRes = await user.agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'app', scopes: ['account:security'] });
    expect(keyRes.status).toBe(201);
    const token = createApiKeyResponseSchema.parse(keyRes.body).token;

    const other = await seedPerson('scoped_out');
    const otherKey = await other.agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'app', scopes: ['portfolio:read'] });
    const weakToken = createApiKeyResponseSchema.parse(otherKey.body).token;

    // Missing scope → audited denial, account intact.
    const denied = await request(harness.app)
      .delete('/api/v1/account')
      .set('Authorization', `Bearer ${weakToken}`)
      .send({ confirmUsername: other.username, password: other.password });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_SCOPE');
    expect((await other.agent.get('/api/v1/auth/me')).status).toBe(200);

    // Re-auth still applies on the bearer path.
    const badReauth = await request(harness.app)
      .delete('/api/v1/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirmUsername: user.username, password: 'wrong-password' });
    expect(badReauth.status).toBe(401);

    const res = await request(harness.app)
      .delete('/api/v1/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirmUsername: user.username, password: user.password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const relogin = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(relogin.status).toBe(401);
  });
});
