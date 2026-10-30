import { createHash, randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  acknowledgeAnnouncementResponseSchema,
  activeAnnouncementListResponseSchema,
  createApiKeyResponseSchema,
  createOAuthClientResponseSchema,
  meResponseSchema,
  oauthTokenResponseSchema,
  userAnnouncementSchema,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { newId } from '../data/ids';
import { createAnnouncementReceiptRepository } from '../data/repositories/announcementReceiptRepository';
import { createOAuthRepository } from '../data/repositories/oauthRepository';
import * as schema from '../data/schema';
import { announcementContentSha256 } from '../services/announcements/announcementContent';
import { FIRST_PARTY_CLIENTS, seedFirstPartyClients } from '../services/oauth/firstPartyClients';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * The user side of announcements v2 (PROJECTPLAN §6.19, contract §4): who sees
 * what and when, the receipts each route writes, and the acknowledgement's
 * refusal order — including that only a person (a cookie session or the
 * first-party app) can acknowledge, never automation.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const DAY = 24 * 60 * 60 * 1000;
const THIRD_PARTY_REDIRECT = 'https://third-party.example/callback';
const MOBILE = FIRST_PARTY_CLIENTS.find((client) => client.clientId === 'btc_IbT1mzw_7kBiPHPkGfaE0Q')!;

type Agent = ReturnType<typeof request.agent>;
type TestUser = Awaited<ReturnType<TestHarness['seedUser']>>;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
  await seedFirstPartyClients(createOAuthRepository(harness.db));
});

interface Seed {
  kind?: 'notice' | 'once' | 'ack_required';
  audience?: 'everyone' | 'existing_at_publish';
  lifecycle?: 'draft' | 'published' | 'archived';
  startsAt?: Date | null;
  endsAt?: Date | null;
  cutoffAt?: Date;
  archivedAt?: Date | null;
  titleEn?: string;
  bodyEn?: string;
  titleDe?: string | null;
  bodyDe?: string | null;
  bodyFormat?: 'plain' | 'markdown';
}

async function seedAnnouncement(input: Seed = {}): Promise<schema.AnnouncementRow> {
  const lifecycle = input.lifecycle ?? 'published';
  const released = new Date(Date.now() - DAY);
  const [row] = await harness.db
    .insert(schema.announcements)
    .values({
      id: newId(),
      kind: input.kind ?? 'notice',
      audience: input.audience ?? 'everyone',
      lifecycle,
      active: lifecycle === 'published',
      bodyFormat: input.bodyFormat ?? 'markdown',
      titleEn: input.titleEn ?? 'Title',
      bodyEn: input.bodyEn ?? 'Body with **bold**.',
      titleDe: input.titleDe === undefined ? 'Titel' : input.titleDe,
      bodyDe: input.bodyDe === undefined ? 'Text mit **fett**.' : input.bodyDe,
      startsAt: input.startsAt === undefined ? null : input.startsAt,
      endsAt: input.endsAt === undefined ? null : input.endsAt,
      releasedAt: lifecycle === 'draft' ? null : released,
      audienceCutoffAt: lifecycle === 'draft' ? null : (input.cutoffAt ?? released),
      archivedAt:
        lifecycle === 'archived' ? (input.archivedAt ?? new Date(Date.now() - 1000)) : null,
    })
    .returning();
  return row!;
}

async function seedPerson(tag?: string): Promise<TestUser & { agent: Agent }> {
  const t = tag ?? randomBytes(4).toString('hex');
  const user = await harness.seedUser({ email: `ann-${t}@bt.test`, username: `ann${t}` });
  const agent = request.agent(harness.app);
  await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password })
    .expect(200);
  return { ...user, agent };
}

async function setCreatedAt(userId: string, createdAt: Date): Promise<void> {
  await harness.db.update(schema.users).set({ createdAt }).where(eq(schema.users.id, userId));
}

function list(agent: Agent, query = '') {
  return agent.get(`/api/v1/notifications/announcements${query}`);
}

function ack(agent: Agent, id: string, body: Record<string, unknown>) {
  return agent
    .post(`/api/v1/notifications/announcements/${id}/acknowledge`)
    .set(...XRW)
    .send(body);
}

const ackBody = (row: schema.AnnouncementRow, locale: 'en' | 'de' = 'en') => ({
  confirm: true,
  locale,
  contentSha256: announcementContentSha256(row, locale),
});

async function receiptOf(userId: string, announcementId: string) {
  const [row] = await harness.db
    .select()
    .from(schema.announcementReceipts)
    .where(
      and(
        eq(schema.announcementReceipts.userId, userId),
        eq(schema.announcementReceipts.announcementId, announcementId),
      ),
    );
  return row;
}

async function auditRows(action: string, targetId: string) {
  return harness.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.targetId, targetId)));
}

describe('GET /notifications/announcements — visibility (contract §4.1)', () => {
  it('lists published, open, in-audience items only, ack_required first, then once, then notice', async () => {
    const me = await seedPerson();
    const notice = await seedAnnouncement({ kind: 'notice', titleEn: 'notice' });
    const once = await seedAnnouncement({ kind: 'once', titleEn: 'once' });
    const ackOld = await seedAnnouncement({
      kind: 'ack_required',
      titleEn: 'ack old',
      cutoffAt: new Date(Date.now() - 3 * DAY),
    });
    const ackNew = await seedAnnouncement({
      kind: 'ack_required',
      titleEn: 'ack new',
      cutoffAt: new Date(Date.now() - DAY),
    });
    await seedAnnouncement({ lifecycle: 'draft', titleEn: 'draft' });
    await seedAnnouncement({ lifecycle: 'archived', titleEn: 'archived' });
    await seedAnnouncement({ startsAt: new Date(Date.now() + DAY), titleEn: 'scheduled' });
    await seedAnnouncement({ endsAt: new Date(Date.now() - 1000), titleEn: 'ended' });

    const res = await list(me.agent);
    expect(res.status).toBe(200);
    const items = activeAnnouncementListResponseSchema.parse(res.body).announcements;
    expect(items.map((i) => i.id)).toEqual([ackOld.id, ackNew.id, once.id, notice.id]);
    const first = items[0]!;
    expect(first).toMatchObject({
      kind: 'ack_required',
      dismissible: false,
      status: 'active',
      contentLocale: 'en',
      availableLocales: ['en', 'de'],
      bodyFormat: 'markdown',
    });
    expect(first.bodyDoc).toEqual({
      v: 1,
      blocks: [
        {
          t: 'p',
          c: [
            { t: 'text', v: 'Body with ' },
            { t: 'strong', c: [{ t: 'text', v: 'bold' }] },
            { t: 'text', v: '.' },
          ],
        },
      ],
    });
    expect(first.contentSha256).toBe(announcementContentSha256(ackOld, 'en'));
  });

  it('?locale=de renders German where it exists and falls back to English where it does not', async () => {
    const me = await seedPerson();
    const both = await seedAnnouncement({ titleEn: 'EN only?' });
    const enOnly = await seedAnnouncement({ titleEn: 'English', titleDe: null, bodyDe: null });
    const items = activeAnnouncementListResponseSchema.parse((await list(me.agent, '?locale=de')).body)
      .announcements;
    expect(items.find((i) => i.id === both.id)).toMatchObject({
      title: 'Titel',
      contentLocale: 'de',
      contentSha256: announcementContentSha256(both, 'de'),
    });
    expect(items.find((i) => i.id === enOnly.id)).toMatchObject({
      title: 'English',
      contentLocale: 'en',
      availableLocales: ['en'],
    });
    expect((await list(me.agent, '?locale=fr')).status).toBe(400);
  });

  it('the window is half-open: visible AT startsAt, gone AT endsAt', async () => {
    const me = await seedPerson();
    const startsAt = new Date('2026-11-01T10:00:00.000Z');
    const endsAt = new Date('2026-11-02T10:00:00.000Z');
    const row = await seedAnnouncement({ startsAt, endsAt, cutoffAt: startsAt });
    const repo = createAnnouncementReceiptRepository(harness.db);
    const viewer = { id: me.id, createdAt: new Date('2026-01-01T00:00:00Z') };
    const ids = async (at: Date) => (await repo.listOpenForViewer(viewer, at)).map((v) => v.row.id);
    expect(await ids(new Date(startsAt.getTime() - 1))).not.toContain(row.id);
    expect(await ids(startsAt)).toContain(row.id);
    expect(await ids(new Date(endsAt.getTime() - 1))).toContain(row.id);
    expect(await ids(endsAt)).not.toContain(row.id);
  });

  it('existing_at_publish: an account created one second AFTER the cutoff — or at it — is not in the audience', async () => {
    const cutoffAt = new Date(Date.now() - 2 * DAY);
    const row = await seedAnnouncement({
      kind: 'ack_required',
      audience: 'existing_at_publish',
      cutoffAt,
    });
    const before = await seedPerson();
    const at = await seedPerson();
    const after = await seedPerson();
    await setCreatedAt(before.id, new Date(cutoffAt.getTime() - 1000));
    await setCreatedAt(at.id, cutoffAt);
    await setCreatedAt(after.id, new Date(cutoffAt.getTime() + 1000));

    const visible = async (p: { agent: Agent }) =>
      activeAnnouncementListResponseSchema
        .parse((await list(p.agent)).body)
        .announcements.map((i) => i.id);
    expect(await visible(before)).toEqual([row.id]);
    expect(await visible(at)).toEqual([]);
    expect(await visible(after)).toEqual([]);
    // Every per-id route says not found, indistinguishably.
    for (const path of ['', '/seen', '/acknowledge']) {
      const res = path
        ? await after.agent
            .post(`/api/v1/notifications/announcements/${row.id}${path}`)
            .set(...XRW)
            .send(path === '/acknowledge' ? ackBody(row) : undefined)
        : await after.agent.get(`/api/v1/notifications/announcements/${row.id}`);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('ANNOUNCEMENT_NOT_FOUND');
    }
    // An `everyone` announcement reaches the late account too.
    const everyone = await seedAnnouncement({ cutoffAt });
    expect(await visible(after)).toEqual([everyone.id]);
  });

  it('dismissed notice/once and acknowledged ack_required items leave the list', async () => {
    const me = await seedPerson();
    const notice = await seedAnnouncement({ kind: 'notice' });
    const once = await seedAnnouncement({ kind: 'once' });
    const obligation = await seedAnnouncement({ kind: 'ack_required' });
    for (const row of [notice, once]) {
      await me.agent
        .post(`/api/v1/notifications/announcements/${row.id}/dismiss`)
        .set(...XRW)
        .expect(200);
    }
    expect((await ack(me.agent, obligation.id, ackBody(obligation))).status).toBe(200);
    expect(activeAnnouncementListResponseSchema.parse((await list(me.agent)).body).announcements)
      .toEqual([]);
  });
});

describe('GET /notifications/announcements/:id (contract §4.2)', () => {
  it('reads ended and archived items with their status and receipt; drafts, scheduled and archived-before-open are 404', async () => {
    const me = await seedPerson();
    const ended = await seedAnnouncement({ endsAt: new Date(Date.now() - 1000) });
    const archived = await seedAnnouncement({ lifecycle: 'archived' });
    const draft = await seedAnnouncement({ lifecycle: 'draft' });
    const scheduled = await seedAnnouncement({ startsAt: new Date(Date.now() + DAY) });
    const neverOpened = await seedAnnouncement({
      lifecycle: 'archived',
      startsAt: new Date(Date.now() - 1000),
      archivedAt: new Date(Date.now() - 2000),
    });
    const read = (id: string) => me.agent.get(`/api/v1/notifications/announcements/${id}`);

    expect(userAnnouncementSchema.parse((await read(ended.id)).body).status).toBe('ended');
    const archivedRes = userAnnouncementSchema.parse((await read(archived.id)).body);
    expect(archivedRes.status).toBe('archived');
    expect(archivedRes.receipt).toEqual({
      seenAt: null,
      dismissedAt: null,
      acknowledgedAt: null,
      lapsedAt: null,
      lapseReason: null,
    });
    for (const id of [draft.id, scheduled.id, neverOpened.id, newId()]) {
      const res = await read(id);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ANNOUNCEMENT_NOT_FOUND');
    }
  });
});

describe('POST …/:id/seen and …/:id/dismiss (contract §4.3, §4.4)', () => {
  it('seen is idempotent first-write-wins and 404s outside the current list', async () => {
    const me = await seedPerson();
    const row = await seedAnnouncement({ kind: 'once' });
    const seen = () =>
      me.agent.post(`/api/v1/notifications/announcements/${row.id}/seen`).set(...XRW);
    expect((await seen()).body).toEqual({ ok: true });
    const first = await receiptOf(me.id, row.id);
    await seen().expect(200);
    const second = await receiptOf(me.id, row.id);
    expect(second!.seenAt!.getTime()).toBe(first!.seenAt!.getTime());
    expect(second!.updatedAt.getTime()).toBe(first!.updatedAt.getTime());
    expect(second!.dismissedAt).toBeNull();

    const ended = await seedAnnouncement({ endsAt: new Date(Date.now() - 1000) });
    const res = await me.agent
      .post(`/api/v1/notifications/announcements/${ended.id}/seen`)
      .set(...XRW);
    expect(res.status).toBe(404);
  });

  it('dismiss: 200 and idempotent for notice/once, 409 for ack_required, 404 for a draft', async () => {
    const me = await seedPerson();
    const notice = await seedAnnouncement({ kind: 'notice' });
    const obligation = await seedAnnouncement({ kind: 'ack_required' });
    const draft = await seedAnnouncement({ lifecycle: 'draft' });
    const dismiss = (id: string) =>
      me.agent.post(`/api/v1/notifications/announcements/${id}/dismiss`).set(...XRW);

    await dismiss(notice.id).expect(200);
    const first = await receiptOf(me.id, notice.id);
    expect(first!.seenAt!.getTime()).toBe(first!.dismissedAt!.getTime());
    await dismiss(notice.id).expect(200);
    expect((await receiptOf(me.id, notice.id))!.dismissedAt!.getTime()).toBe(
      first!.dismissedAt!.getTime(),
    );

    const refused = await dismiss(obligation.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ANNOUNCEMENT_NOT_DISMISSIBLE');
    expect(await receiptOf(me.id, obligation.id)).toBeUndefined();

    const hidden = await dismiss(draft.id);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe('ANNOUNCEMENT_NOT_FOUND');
  });
});

describe('POST …/:id/acknowledge (contract §4.5)', () => {
  it('records once, replays the ORIGINAL whatever the replay says, and writes one minimal audit row', async () => {
    const me = await seedPerson();
    const row = await seedAnnouncement({ kind: 'ack_required' });
    const other = await seedAnnouncement({ kind: 'ack_required' });

    const res = await ack(me.agent, row.id, ackBody(row, 'de'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parsed = acknowledgeAnnouncementResponseSchema.parse(res.body);
    expect(parsed.acknowledgement).toMatchObject({
      announcementId: row.id,
      via: 'web_session',
      locale: 'de',
      contentSha256: announcementContentSha256(row, 'de'),
    });
    expect(parsed.pendingAcknowledgements.map((p) => p.id)).toEqual([other.id]);

    // A replay in the other locale with a WRONG hash still returns the original.
    const replay = await ack(me.agent, row.id, {
      confirm: true,
      locale: 'en',
      contentSha256: 'f'.repeat(64),
    });
    expect(replay.status).toBe(200);
    expect(replay.body.acknowledgement).toEqual(parsed.acknowledgement);

    const receipt = await receiptOf(me.id, row.id);
    expect(receipt).toMatchObject({
      acknowledgedVia: 'web_session',
      acknowledgedLocale: 'de',
      acknowledgedGrantId: null,
      acknowledgedContentSha256: announcementContentSha256(row, 'de'),
    });
    expect(receipt!.seenAt).toBeInstanceOf(Date);

    const audits = await auditRows('announcement.acknowledge', row.id);
    expect(audits).toHaveLength(1);
    // Data minimisation: the person, the announcement, the instant — nothing else.
    expect(audits[0]).toMatchObject({ actorId: me.id, targetType: 'announcement', ip: null });
    expect(audits[0]!.meta ?? null).toBeNull();
  });

  it('refuses in the contract order: notice 409, content changed 409, locale unavailable 400', async () => {
    const me = await seedPerson();
    const notice = await seedAnnouncement({ kind: 'notice' });
    const notAckable = await ack(me.agent, notice.id, ackBody(notice));
    expect(notAckable.status).toBe(409);
    expect(notAckable.body.error.code).toBe('ANNOUNCEMENT_NOT_ACKNOWLEDGEABLE');

    const row = await seedAnnouncement({ kind: 'ack_required' });
    const changed = await ack(me.agent, row.id, { ...ackBody(row), contentSha256: '0'.repeat(64) });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('ANNOUNCEMENT_CONTENT_CHANGED');
    // The hash of the OTHER locale is not this locale's text either.
    const crossed = await ack(me.agent, row.id, {
      confirm: true,
      locale: 'en',
      contentSha256: announcementContentSha256(row, 'de'),
    });
    expect(crossed.body.error.code).toBe('ANNOUNCEMENT_CONTENT_CHANGED');

    const enOnly = await seedAnnouncement({ kind: 'ack_required', titleDe: null, bodyDe: null });
    const noDe = await ack(me.agent, enOnly.id, { ...ackBody(enOnly), locale: 'de' });
    expect(noDe.status).toBe(400);
    expect(noDe.body.error.code).toBe('ANNOUNCEMENT_LOCALE_UNAVAILABLE');
    expect(await auditRows('announcement.acknowledge', row.id)).toEqual([]);
  });

  it('ended, archived and lapsed obligations are not pending any more (409)', async () => {
    const me = await seedPerson();
    const ended = await seedAnnouncement({ kind: 'ack_required', endsAt: new Date(Date.now() - 1000) });
    const archived = await seedAnnouncement({ kind: 'ack_required', lifecycle: 'archived' });
    const lapsed = await seedAnnouncement({ kind: 'ack_required' });
    await harness.db.insert(schema.announcementReceipts).values({
      userId: me.id,
      announcementId: lapsed.id,
      lapsedAt: new Date(),
      lapseReason: 'ended',
    });
    for (const row of [ended, archived, lapsed]) {
      const res = await ack(me.agent, row.id, ackBody(row));
      expect(res.status, row.id).toBe(409);
      expect(res.body.error.code).toBe('ANNOUNCEMENT_NOT_PENDING');
    }
    expect((await receiptOf(me.id, lapsed.id))!.acknowledgedAt).toBeNull();
  });

  it('the body is strict: confirm must be the literal true, no unknown fields', async () => {
    const me = await seedPerson();
    const row = await seedAnnouncement({ kind: 'ack_required' });
    for (const body of [
      { ...ackBody(row), confirm: false },
      { ...ackBody(row), confirm: 'true' },
      { ...ackBody(row), extra: 1 },
      { locale: 'en', contentSha256: announcementContentSha256(row, 'en') },
    ]) {
      const res = await ack(me.agent, row.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

// ── bearer callers: a person acknowledges, never automation ─────────────────

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function issueToken(
  agent: Agent,
  clientId: string,
  redirectUri: string,
  scopes: readonly ApiKeyScope[],
): Promise<string> {
  const { verifier, challenge } = pkce();
  const approved = await agent
    .post('/api/v1/oauth/authorize')
    .set(...XRW)
    .send({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const code = new URL(approved.body.redirectTo as string).searchParams.get('code');
  const exchanged = await request(harness.app).post('/api/v1/oauth/token').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
  return oauthTokenResponseSchema.parse(exchanged.body).access_token;
}

describe('acknowledge — bearer callers (first-party only, Chief ruling 2026-10-29)', () => {
  const SCOPES = ['notifications:read', 'notifications:write'] as const satisfies readonly ApiKeyScope[];

  it('a first-party OAuth token acknowledges, recorded via first_party_oauth with its grant', async () => {
    const me = await seedPerson();
    const row = await seedAnnouncement({ kind: 'ack_required' });
    const token = await issueToken(me.agent, MOBILE.clientId, MOBILE.redirectUris[0]!, SCOPES);
    const res = await request(harness.app)
      .post(`/api/v1/notifications/announcements/${row.id}/acknowledge`)
      .set('Authorization', `Bearer ${token}`)
      .send(ackBody(row));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.acknowledgement.via).toBe('first_party_oauth');
    const receipt = await receiptOf(me.id, row.id);
    const [grant] = await harness.db
      .select({ id: schema.oauthGrants.id })
      .from(schema.oauthGrants)
      .where(eq(schema.oauthGrants.userId, me.id));
    expect(receipt!.acknowledgedGrantId).toBe(grant!.id);
  });

  it('a third-party token holding the scope is refused API_KEY_FORBIDDEN and audited first-party-only', async () => {
    const me = await seedPerson();
    const row = await seedAnnouncement({ kind: 'ack_required' });
    const registered = await me.agent
      .post('/api/v1/settings/oauth-clients')
      .set(...XRW)
      .send({ name: 'Partner', redirectUris: [THIRD_PARTY_REDIRECT], scopes: SCOPES, public: true });
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    const client = createOAuthClientResponseSchema.parse(registered.body).client;
    const token = await issueToken(me.agent, client.clientId, THIRD_PARTY_REDIRECT, SCOPES);

    const res = await request(harness.app)
      .post(`/api/v1/notifications/announcements/${row.id}/acknowledge`)
      .set('Authorization', `Bearer ${token}`)
      .send(ackBody(row));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
    expect(await receiptOf(me.id, row.id)).toBeUndefined();
    const denials = await harness.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'api_key.scope_denied'), eq(schema.auditLog.actorId, me.id)));
    expect(denials.map((d) => (d.meta as { reason?: string }).reason)).toContain('first-party-only');
    // The same token still reads the list — the scope pair is intact.
    const read = await request(harness.app)
      .get('/api/v1/notifications/announcements')
      .set('Authorization', `Bearer ${token}`);
    expect(read.status).toBe(200);
  });

  it('a personal API key holding notifications:write is refused and audited the same way', async () => {
    const me = await seedPerson();
    const row = await seedAnnouncement({ kind: 'ack_required' });
    const minted = await me.agent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'automation', scopes: SCOPES });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const key = createApiKeyResponseSchema.parse(minted.body).token;
    const res = await request(harness.app)
      .post(`/api/v1/notifications/announcements/${row.id}/acknowledge`)
      .set('Authorization', `Bearer ${key}`)
      .send(ackBody(row));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('API_KEY_FORBIDDEN');
    expect(await receiptOf(me.id, row.id)).toBeUndefined();
    // …while the key may still mark the item seen (notifications:write, not first-party-only).
    await request(harness.app)
      .post(`/api/v1/notifications/announcements/${row.id}/seen`)
      .set('Authorization', `Bearer ${key}`)
      .expect(200);
  });
});

describe('MeResponse.pendingAcknowledgements (contract §4.6)', () => {
  it('lists what is owed, oldest first, in the stored locale; [] once acknowledged and for admins', async () => {
    const me = await seedPerson();
    await harness.db.update(schema.users).set({ locale: 'de' }).where(eq(schema.users.id, me.id));
    const older = await seedAnnouncement({
      kind: 'ack_required',
      cutoffAt: new Date(Date.now() - 3 * DAY),
      endsAt: new Date(Date.now() + 5 * DAY),
    });
    const newer = await seedAnnouncement({ kind: 'ack_required', cutoffAt: new Date(Date.now() - DAY) });
    await seedAnnouncement({ kind: 'notice' });

    const me1 = meResponseSchema.parse((await me.agent.get('/api/v1/auth/me')).body);
    expect(me1.pendingAcknowledgements).toEqual([
      {
        id: older.id,
        severity: 'info',
        title: 'Titel',
        startsAt: null,
        endsAt: older.endsAt!.toISOString(),
      },
      { id: newer.id, severity: 'info', title: 'Titel', startsAt: null, endsAt: null },
    ]);

    for (const row of [older, newer]) {
      expect((await ack(me.agent, row.id, ackBody(row, 'de'))).status).toBe(200);
    }
    const me2 = meResponseSchema.parse((await me.agent.get('/api/v1/auth/me')).body);
    expect(me2.pendingAcknowledgements).toEqual([]);

    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const adminMe = await adminAgent.get('/api/v1/auth/me');
    expect(adminMe.body.pendingAcknowledgements).toEqual([]);
  });
});

describe('inbox fan-out walks the audience only (§6.19.8, contract §6)', () => {
  it('existing_at_publish reaches accounts created before the cutoff — never admins, never later accounts', async () => {
    const cutoffAt = new Date(Date.now() - DAY);
    const early = await harness.seedUser({ email: 'early@bt.test', username: 'early' });
    const late = await harness.seedUser({ email: 'late@bt.test', username: 'late' });
    const admin = await harness.seedAdmin({ email: 'boss@bt.test', username: 'boss' });
    await setCreatedAt(early.id, new Date(cutoffAt.getTime() - 1000));
    await setCreatedAt(late.id, new Date(cutoffAt.getTime() + 1000));
    await setCreatedAt(admin.id, new Date(cutoffAt.getTime() - 1000));
    const long = `${'Read this. '.repeat(80)}**End.**`;
    const row = await seedAnnouncement({
      kind: 'ack_required',
      audience: 'existing_at_publish',
      cutoffAt,
      bodyEn: long,
      bodyDe: long,
    });

    const outcome = await harness.ctx.announcements.publishAnnouncement(row.id, 0);
    expect(outcome.status).toBe('published');

    const inbox = await harness.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.type, 'account.notice'));
    const mine = inbox.filter(
      (n) => (n.payload as { announcementId?: string }).announcementId === row.id,
    );
    expect(mine.map((n) => n.userId)).toEqual([early.id]);
    const [entry] = mine;
    expect(entry!.payload).toMatchObject({
      notice: 'announcement',
      announcementId: row.id,
      announcementKind: 'ack_required',
    });
    // The plain-text projection, cut to 500 characters plus an ellipsis — never markup.
    expect(entry!.body.endsWith('…')).toBe(true);
    expect(entry!.body.length).toBeLessThanOrEqual(501);
    expect(entry!.body).not.toContain('**');
  });
});
