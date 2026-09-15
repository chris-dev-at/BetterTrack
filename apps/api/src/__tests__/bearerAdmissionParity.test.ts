import { randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApiKeyResponseSchema } from '@bettertrack/contracts';

import * as schema from '../data/schema';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * #1951 — the bearer admission set, pinned as a golden table.
 *
 * #1951 converts the four router-local bearer twins into `ctx` factories that
 * write their own `api_key.scope_denied` row. Adding an audit write to a refusal
 * path is exactly the kind of change that can quietly move a decision: reorder a
 * branch and a route that answered `API_KEY_FORBIDDEN` starts answering
 * `INSUFFICIENT_SCOPE` — or, far worse, starts answering 200.
 *
 * So this file asserts no new behavior at all. It replays the #361 route × scope
 * matrix, the #1324 widened account-security routes, the WebAuthn ceremonies the
 * passkey twin must keep closed, and the surfaces behind the grant, passkey,
 * portfolio-vault and per-vault twins — pinning the EXACT (status, error code)
 * each yields both with and without its scope.
 *
 * Its whole value is being byte-identical before and after the change and green
 * on both. It is deliberately written against the HTTP surface only and imports
 * nothing #1951 touches, so this very file can be run against the parent commit
 * to prove the admission set did not move.
 *
 * Personal keys throughout: `enforceApiKeyScope` is one rail for both credential
 * kinds, and the OAuth-specific decisions (first-party grant management) are
 * pinned against real registered clients in `oauthGrantBearer.test.ts`.
 *
 * #1958 extends it the same way, for the same reason: converting the FIFTH twin
 * (tax-year documentation) to a `ctx` factory and giving all five twins the
 * portfolio-vault twin's `admin → 404` backstop are both refusal-path changes,
 * so the table grows the rows that would catch either one moving a decision —
 * the tax-year route's off-allowlist siblings, and an admin-role principal of
 * BOTH kinds on every one of the five twin surfaces. Still no new behavior, and
 * still importing nothing either issue touches, so this file keeps running
 * unmodified against the parent commit.
 *
 * #1965 does it once more for the SIXTH twin — `requireCookieSessionOrVaultSync`
 * on the legacy account-singleton `/vault` surface. That twin gates the only
 * bearer-reachable READ AND WRITE of vault bytes, so "did the refusal path move
 * a decision" is the highest-stakes version of this question in the file: every
 * allowlisted sync route is pinned with and without `vault:sync`, together with
 * the off-allowlist method, the non-integer `{version}` sibling and the media
 * transition that must all stay session-only.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Seed a fresh account and mint a personal key holding exactly these scopes. */
async function mintKeyForUser(scopes: string[]): Promise<{ token: string; userId: string }> {
  const tag = randomBytes(5).toString('hex');
  const user = await harness.seedUser({
    email: `parity-${tag}@bettertrack.test`,
    username: `parity${tag}`,
  });
  const agent = request.agent(harness.app);
  const loggedIn = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(loggedIn.status, JSON.stringify(loggedIn.body)).toBe(200);
  const created = await agent
    .post('/api/v1/settings/api-keys')
    .set(...XRW)
    .send({ name: 'parity', scopes });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { token: createApiKeyResponseSchema.parse(created.body).token, userId: user.id };
}

const mintKey = async (scopes: string[]): Promise<string> => (await mintKeyForUser(scopes)).token;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface ParityRow {
  name: string;
  method: Method;
  path: string;
  /** The scope under test for this route. */
  scope: string;
  body?: Record<string, unknown>;
  /** The answer to a key holding an UNRELATED scope. */
  without: readonly [status: number, code: string];
  /**
   * The answer to a key holding `scope`. A non-403 proves the scope rail let the
   * request through to the handler; a 403 here is a deliberate refusal that
   * scope alone never lifts (a session-only route, or a first-party-only one).
   */
  with: readonly [status: number, code: string | null];
}

/**
 * Every row is a golden observation of the SHIPPED behavior, captured from the
 * parent commit — never an aspiration. `null` in the `with` column means the
 * response carried no error envelope (the request reached its handler).
 */
const ROWS: readonly ParityRow[] = [
  // ── #361 route × scope matrix ───────────────────────────────────────────
  {
    name: 'notifications inbox',
    method: 'get',
    path: '/notifications',
    scope: 'notifications:read',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'notifications mark-read',
    method: 'post',
    path: '/notifications/mark-read',
    scope: 'notifications:write',
    body: { all: true },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'notification archive (mutate)',
    method: 'post',
    path: `/notifications/${MISSING_ID}/archive`,
    scope: 'notifications:write',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'NOTIFICATION_NOT_FOUND'],
  },
  {
    name: 'notifications bulk delete',
    method: 'delete',
    path: '/notifications?scope=archived',
    scope: 'notifications:write',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [204, null],
  },
  {
    name: 'notification prefs read',
    method: 'get',
    path: '/settings/notifications',
    scope: 'notifications:read',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'notification prefs write',
    method: 'patch',
    path: '/settings/notifications',
    scope: 'notifications:write',
    body: { email: { friendRequest: false } },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [400, 'VALIDATION_ERROR'],
  },
  {
    name: 'friends list',
    method: 'get',
    path: '/social/friends',
    scope: 'social:read',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'friend request (mutate graph)',
    method: 'post',
    path: '/social/requests',
    scope: 'social:write',
    body: { username: 'someone-else' },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [400, 'VALIDATION_ERROR'],
  },
  {
    name: 'chat conversations list',
    method: 'get',
    path: '/chat/conversations',
    scope: 'chat:read',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'chat open conversation (mutate)',
    method: 'post',
    path: '/chat/conversations',
    scope: 'chat:write',
    body: { userId: MISSING_ID },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'NOT_FOUND'],
  },
  {
    name: 'alerts list',
    method: 'get',
    path: '/alerts',
    scope: 'alerts:read',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'alerts create (mutate)',
    method: 'post',
    path: '/alerts',
    scope: 'alerts:write',
    body: { assetId: MISSING_ID, kind: 'price_above', threshold: 100 },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'ASSET_NOT_FOUND'],
  },
  {
    name: 'own feedback status history',
    method: 'get',
    path: '/feedback/mine',
    scope: 'feedback:read',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'feedback submission',
    method: 'post',
    path: '/feedback',
    scope: 'feedback:write',
    body: { category: 'other', message: 'Bearer matrix feedback' },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [201, null],
  },
  {
    name: 'own feedback deletion',
    method: 'delete',
    path: `/feedback/${MISSING_ID}`,
    scope: 'feedback:write',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'NOT_FOUND'],
  },
  {
    name: 'feedback thread',
    method: 'get',
    path: `/feedback/${MISSING_ID}/messages`,
    scope: 'feedback:read',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'NOT_FOUND'],
  },
  {
    name: 'feedback thread reply',
    method: 'post',
    path: `/feedback/${MISSING_ID}/messages`,
    scope: 'feedback:write',
    body: { body: 'Bearer matrix reply' },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'NOT_FOUND'],
  },
  {
    name: 'feedback thread mark-read',
    method: 'post',
    path: `/feedback/${MISSING_ID}/read`,
    scope: 'feedback:write',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'NOT_FOUND'],
  },
  {
    name: '2fa status',
    method: 'get',
    path: '/auth/2fa/status',
    scope: 'account:security',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'sessions list',
    method: 'get',
    path: '/auth/sessions',
    scope: 'account:security',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'change password',
    method: 'post',
    path: '/auth/change-password',
    scope: 'account:security',
    body: {},
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [400, 'VALIDATION_ERROR'],
  },
  {
    name: 'pin status',
    method: 'get',
    path: '/auth/pin/status',
    scope: 'account:security',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'pin verify',
    method: 'post',
    path: '/auth/pin/verify',
    scope: 'account:security',
    body: { pin: '0000' },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [400, 'PIN_NOT_ENABLED'],
  },

  // ── #1324 widened account-security routes (the passkey twin's surface) ───
  {
    name: 'passkey list',
    method: 'get',
    path: '/auth/passkeys',
    scope: 'account:security',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'passkey rename',
    method: 'patch',
    path: `/auth/passkeys/${MISSING_ID}`,
    scope: 'account:security',
    body: { name: 'Phone' },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'PASSKEY_NOT_FOUND'],
  },
  {
    name: 'passkey delete',
    method: 'delete',
    path: `/auth/passkeys/${MISSING_ID}`,
    scope: 'account:security',
    body: { password: 'irrelevant-before-scope-check' },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [401, 'INVALID_CREDENTIALS'],
  },
  {
    name: 'tax-year documentation',
    method: 'get',
    path: '/settings/taxes/years',
    scope: 'account:security',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },

  // ── #1958: the fifth twin's surface, and the three things around it that
  //    must NOT inherit the carve-out. The twin is method- and path-aware, so
  //    an off-allowlist method or a `/{year}/…` sibling is session-only — not a
  //    scope denial, and never audited. `account:security` is likewise not a
  //    key to the tax REGIME next door, which is portfolio-scoped (#1730).
  {
    name: 'tax-year documentation, off-allowlist method',
    method: 'post',
    path: '/settings/taxes/years',
    scope: 'account:security',
    without: [403, 'API_KEY_FORBIDDEN'],
    with: [403, 'API_KEY_FORBIDDEN'],
  },
  {
    name: 'tax-year documentation, future per-year sibling',
    method: 'get',
    path: '/settings/taxes/years/2025/export',
    scope: 'account:security',
    without: [403, 'API_KEY_FORBIDDEN'],
    with: [403, 'API_KEY_FORBIDDEN'],
  },
  {
    name: 'tax regime read never inherits the documentation carve-out',
    method: 'get',
    path: '/settings/taxes',
    scope: 'account:security',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [403, 'INSUFFICIENT_SCOPE'],
  },
  {
    name: 'tax regime read on its own portfolio scope',
    method: 'get',
    path: '/settings/taxes',
    scope: 'portfolio:read',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'first-run completion',
    method: 'post',
    path: '/auth/first-run/complete',
    scope: 'account:security',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },

  // ── The ceremonies the passkey twin must keep closed to ANY bearer ───────
  {
    name: 'passkey register options (ceremony)',
    method: 'post',
    path: '/auth/passkeys/register/options',
    scope: 'account:security',
    without: [403, 'API_KEY_FORBIDDEN'],
    with: [403, 'API_KEY_FORBIDDEN'],
  },
  {
    name: 'passkey login options (ceremony)',
    method: 'post',
    path: '/auth/passkeys/login/options',
    scope: 'account:security',
    body: {},
    without: [403, 'API_KEY_FORBIDDEN'],
    with: [403, 'API_KEY_FORBIDDEN'],
  },

  // ── The grant twin: first-party-only, so a personal key never gets in ────
  {
    name: 'oauth grant list (first-party only)',
    method: 'get',
    path: '/settings/oauth-grants',
    scope: 'account:security',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [403, 'API_KEY_FORBIDDEN'],
  },
  {
    name: 'oauth grant revoke (first-party only)',
    method: 'delete',
    path: `/settings/oauth-grants/${MISSING_ID}`,
    scope: 'account:security',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [403, 'API_KEY_FORBIDDEN'],
  },

  // ── The portfolio-vault and per-vault twins ──────────────────────────────
  {
    name: 'portfolio vault revision (portfolio twin)',
    method: 'get',
    path: `/portfolios/${MISSING_ID}/vault/revision`,
    scope: 'account:security',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'PORTFOLIO_VAULT_NOT_FOUND'],
  },
  {
    name: 'vault config read (vault twin)',
    method: 'get',
    path: `/vaults/${MISSING_ID}`,
    scope: 'vault:sync',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'VAULT_NOT_FOUND'],
  },
  {
    name: 'vault doc read (vault twin, sync scope)',
    method: 'get',
    path: `/vaults/${MISSING_ID}/docs/${MISSING_ID}`,
    scope: 'vault:sync',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [404, 'VAULT_NOT_FOUND'],
  },
  {
    name: 'vault media patch (vault twin, session-only)',
    method: 'patch',
    path: `/vaults/${MISSING_ID}/media`,
    scope: 'account:security',
    body: {},
    without: [403, 'API_KEY_FORBIDDEN'],
    with: [403, 'API_KEY_FORBIDDEN'],
  },

  // ── #1965: the sixth twin — the legacy account-singleton `/vault` surface.
  //    The four allowlisted sync routes below are the entire bearer-reachable
  //    vault-byte surface; the three after them are the siblings that must stay
  //    session-only. The `with` answers deliberately reach PAST the scope rail
  //    into the vault's own state machine (409 while the server medium is
  //    inactive, 403 VAULT_PARANOID_MODE_REQUIRED for history on a normal
  //    account) — that is what proves admission happened rather than a refusal
  //    that merely happens to share a status code.
  {
    name: 'vault envelope read (vault-sync twin)',
    method: 'get',
    path: '/vault',
    scope: 'vault:sync',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [409, 'VAULT_SERVER_MEDIUM_INACTIVE'],
  },
  {
    name: 'vault envelope write (vault-sync twin)',
    method: 'put',
    path: '/vault',
    scope: 'vault:sync',
    body: { not: 'an envelope' },
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [409, 'VAULT_SERVER_MEDIUM_INACTIVE'],
  },
  {
    name: 'vault media state read (vault-sync twin)',
    method: 'get',
    path: '/vault/media',
    scope: 'vault:sync',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [200, null],
  },
  {
    name: 'vault history list (vault-sync twin)',
    method: 'get',
    path: '/vault/history',
    scope: 'vault:sync',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [403, 'VAULT_PARANOID_MODE_REQUIRED'],
  },
  {
    name: 'vault history version (vault-sync twin)',
    method: 'get',
    path: '/vault/history/12',
    scope: 'vault:sync',
    without: [403, 'INSUFFICIENT_SCOPE'],
    with: [403, 'VAULT_PARANOID_MODE_REQUIRED'],
  },
  {
    name: 'vault envelope, off-allowlist method',
    method: 'post',
    path: '/vault',
    scope: 'vault:sync',
    body: {},
    without: [403, 'API_KEY_FORBIDDEN'],
    with: [403, 'API_KEY_FORBIDDEN'],
  },
  {
    name: 'vault history, non-integer version sibling',
    method: 'get',
    path: '/vault/history/latest',
    scope: 'vault:sync',
    without: [403, 'API_KEY_FORBIDDEN'],
    with: [403, 'API_KEY_FORBIDDEN'],
  },
  {
    name: 'vault media transition (vault-sync twin, session-only)',
    method: 'patch',
    path: '/vault/media',
    scope: 'account:security',
    body: {},
    without: [403, 'API_KEY_FORBIDDEN'],
    with: [403, 'API_KEY_FORBIDDEN'],
  },
];

const send = (token: string, row: ParityRow) => {
  const url = `/api/v1${row.path}`;
  const base = request(harness.app);
  const started =
    row.method === 'get'
      ? base.get(url)
      : row.method === 'post'
        ? base.post(url)
        : row.method === 'put'
          ? base.put(url)
          : row.method === 'delete'
            ? base.delete(url)
            : base.patch(url);
  const withAuth = started.set(bearer(token));
  return row.body ? withAuth.send(row.body) : withAuth;
};

const answerOf = (response: request.Response): [number, string | null] => [
  response.status,
  (response.body as { error?: { code?: string } } | undefined)?.error?.code ?? null,
];

describe('#1951 bearer admission parity (golden — must not move)', () => {
  it('has no duplicate row names, so the golden table cannot silently lose one', () => {
    expect(new Set(ROWS.map((row) => row.name)).size).toBe(ROWS.length);
  });

  it.each(ROWS)('refuses $name identically without its scope', async (row) => {
    // A valid token that authenticates but holds an unrelated scope. Refusal has
    // to be on the scope/policy rail, never on authentication.
    const token = await mintKey([row.scope === 'social:read' ? 'market:read' : 'social:read']);
    expect(answerOf(await send(token, row)), `${row.method} ${row.path}`).toEqual([
      row.without[0],
      row.without[1],
    ]);
  });

  it.each(ROWS)('answers $name identically with its scope', async (row) => {
    const token = await mintKey([row.scope]);
    expect(answerOf(await send(token, row)), `${row.method} ${row.path}`).toEqual([
      row.with[0],
      row.with[1],
    ]);
  });
});

/**
 * #1958 / #1965 — the account-kind boundary on all six twins, both principal
 * kinds.
 *
 * The portfolio-vault and per-vault twins already carried an `admin → 404`
 * backstop; #1958 gives the passkey, grant and tax-year twins the same one
 * through a shared predicate, and #1965 the vault-sync twin. That is a
 * narrowing *inside* four handlers, so the thing to prove is that it narrows
 * NOTHING an HTTP caller can observe: on both sides of the change an admin-role
 * principal is refused before routing — a bearer by the global rail, a session
 * by `requireUser` — and the answers below are byte-identical on the parent
 * commit.
 *
 * Which is exactly why the backstop is worth adding: it is unreachable today,
 * and it exists for the day one of those two rails is remounted or regresses.
 */
const TWIN_SURFACES = [
  { name: 'tax-year documentation twin', path: '/settings/taxes/years' },
  { name: 'oauth grant twin', path: '/settings/oauth-grants' },
  { name: 'passkey management twin', path: '/auth/passkeys' },
  { name: 'portfolio-vault twin', path: `/portfolios/${MISSING_ID}/vault/revision` },
  { name: 'per-vault twin', path: `/vaults/${MISSING_ID}` },
  // #1965 — the sixth twin. It is the one that had no backstop at all, so this
  // row is the only one of the six whose 404 the twin itself could not produce
  // on the parent commit. The rail's answer is identical on both trees.
  { name: 'vault-sync twin', path: '/vault' },
] as const;

/** Every scope any of the six surfaces could ask for, so a refusal is never about scope. */
const TWIN_SCOPES = ['account:security', 'vault:sync'] as const;

describe('#1958 admin-role principals on all six twins (golden — must not move)', () => {
  it.each(TWIN_SURFACES)('404s an admin-role BEARER on the $name', async (surface) => {
    // Promote the account directly in the table, deliberately bypassing
    // `userRepo.setRole` — which bumps `securityGeneration` and would revoke the
    // token first. This constructs the one principal shape the boundary exists
    // for: a live bearer on an account that is already `role = 'admin'`.
    const { token, userId } = await mintKeyForUser([...TWIN_SCOPES]);
    await harness.db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, userId));

    const res = await request(harness.app).get(`/api/v1${surface.path}`).set(bearer(token));
    expect(answerOf(res), surface.path).toEqual([404, 'NOT_FOUND']);

    // A 404 across the account-kind boundary is not a scope event: neither the
    // rail nor any twin audits it, so the trail stays empty.
    const rows = await harness.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorId, userId),
          eq(schema.auditLog.action, 'api_key.scope_denied'),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('403s an admin-kind SESSION on every one of the six, with the admin-area pointer', async () => {
    // One (expensive) admin login drives all six surfaces: `loginAdmin` has to
    // enroll TOTP and re-authenticate through the §6.12 admin 2FA gate.
    const adminAgent = await harness.loginAdmin(await harness.seedAdmin());

    for (const surface of TWIN_SURFACES) {
      const res = await adminAgent.get(`/api/v1${surface.path}`);
      // `requireUser` refuses an admin-kind session before any twin runs, so the
      // backstop is never what answers a cookie caller — and must not become it.
      expect(answerOf(res), surface.path).toEqual([403, 'ADMIN_ACCOUNT_KIND']);
      expect(res.body.error.message, surface.path).toMatch(/admin area/i);
    }
  });
});
