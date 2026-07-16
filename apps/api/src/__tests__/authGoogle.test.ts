import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { auditLog, externalIdentities, users } from '../data/schema';
import type { MailTransport, OutgoingMail } from '../services/email/transport';
import type { GoogleClaims } from '../services/auth/googleVerifier';
import { createTestApp, type SeededAdmin, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const GOOGLE_ENV = {
  BT_GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  BT_GOOGLE_CLIENT_SECRET: 'client-secret-value',
} satisfies Partial<NodeJS.ProcessEnv>;

const SMTP_ENV = {
  SMTP_HOST: 'smtp.test.local',
  SMTP_PORT: '587',
  SMTP_USER: 'mailer',
  SMTP_PASS: 'super-secret-smtp-pass',
  SMTP_FROM: 'BetterTrack <no-reply@test.local>',
} satisfies Partial<NodeJS.ProcessEnv>;

function recordingTransport(): MailTransport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

async function setMode(
  agent: ReturnType<typeof request.agent>,
  mode: 'closed' | 'invite_token' | 'approval' | 'open',
) {
  const res = await agent
    .patch('/api/v1/admin/settings')
    .set(...XRW)
    .send({ registrationMode: mode });
  expect(res.status).toBe(200);
}

// A mutable verifier stub: the whole network seam is replaced, so the flow runs
// with canned claims and no HTTP. `calls` proves the verifier is NEVER reached
// when `state` is rejected (§13.4 V4-P4b: state is enforced BEFORE any action).
interface GoogleHarness {
  harness: TestHarness;
  transport: MailTransport & { sent: OutgoingMail[] };
  adminAgent: ReturnType<typeof request.agent>;
  setClaims(claims: GoogleClaims | Error): void;
  verifierCalls(): number;
}

async function makeGoogleHarness(): Promise<GoogleHarness> {
  const transport = recordingTransport();
  let claims: GoogleClaims | Error = new Error('verifier not primed');
  let calls = 0;
  const harness = await createTestApp({
    env: { ...SMTP_ENV, ...GOOGLE_ENV },
    emailTransport: transport,
    googleVerifier: {
      exchangeAndVerify: async () => {
        calls += 1;
        if (claims instanceof Error) throw claims;
        return claims;
      },
    },
  });
  const admin: SeededAdmin = await harness.seedAdmin();
  const adminAgent = await harness.loginAdmin(admin);
  return {
    harness,
    transport,
    adminAgent,
    setClaims: (c) => {
      claims = c;
    },
    verifierCalls: () => calls,
  };
}

/** Drive `start` → `callback`, carrying the state cookie on the agent. */
async function runGoogleFlow(
  agent: ReturnType<typeof request.agent>,
  opts: { inviteToken?: string } = {},
) {
  const startPath =
    '/api/v1/auth/google/start' +
    (opts.inviteToken ? `?inviteToken=${encodeURIComponent(opts.inviteToken)}` : '');
  const start = await agent.get(startPath);
  expect(start.status).toBe(302);
  expect(start.headers.location).toContain('accounts.google.com');
  const state = new URL(String(start.headers.location)).searchParams.get('state');
  expect(state).toBeTruthy();
  return agent.get(
    `/api/v1/auth/google/callback?state=${encodeURIComponent(state!)}&code=authcode`,
  );
}

function claims(overrides: Partial<GoogleClaims> = {}): GoogleClaims {
  return {
    sub: overrides.sub ?? 'google-sub-1',
    email: overrides.email ?? 'newperson@example.com',
    emailVerified: overrides.emailVerified ?? true,
    name: overrides.name,
  };
}

/**
 * Whether a response established a session (a `bt_sid` cookie with a value). The
 * callback always clears the single-use state cookie, so `set-cookie` is never
 * fully absent — we assert on the session cookie specifically.
 */
function hasSessionCookie(res: request.Response): boolean {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.some((c) => /^bt_sid=[^;]+/.test(c) && !/^bt_sid=;/.test(c));
}

/** Password-login a seeded user and return the session-carrying agent. */
async function loginUser(
  app: Application,
  email: string,
  password: string,
): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: email, password });
  expect(res.status).toBe(200);
  return agent;
}

async function createInviteToken(adminAgent: ReturnType<typeof request.agent>): Promise<string> {
  const created = await adminAgent
    .post('/api/v1/admin/registration-tokens')
    .set(...XRW)
    .send({});
  expect(created.status).toBe(201);
  return new URL(created.body.registerUrl).searchParams.get('token') as string;
}

// ── Env-gated OFF (no Google client configured) ──────────────────────────────
describe('Google sign-in — env-gated off (§13.4 V4-P4b)', () => {
  let harness: TestHarness;
  let app: Application;

  beforeEach(async () => {
    harness = await createTestApp();
    app = harness.app;
  });

  it('registration-info reports googleEnabled=false', async () => {
    const res = await request(app).get('/api/v1/auth/registration-info');
    expect(res.status).toBe(200);
    expect(res.body.googleEnabled).toBe(false);
  });

  it('every /auth/google/* route 404s when unconfigured', async () => {
    const user = await harness.seedUser();
    const agent = request.agent(app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });

    expect((await request(app).get('/api/v1/auth/google/start')).status).toBe(404);
    expect((await request(app).get('/api/v1/auth/google/callback?state=x&code=y')).status).toBe(
      404,
    );
    expect((await agent.get('/api/v1/auth/google/link-status')).status).toBe(404);
    expect(
      (
        await agent
          .post('/api/v1/auth/google/unlink')
          .set(...XRW)
          .send({ password: user.password })
      ).status,
    ).toBe(404);
  });
});

// ── State enforcement + verifier failure ─────────────────────────────────────
describe('Google sign-in — state + verification are enforced (§13.4 V4-P4b)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
    await setMode(g.adminAgent, 'open');
  });

  it('a callback with no state is rejected before any token exchange', async () => {
    g.setClaims(claims());
    const res = await request(g.harness.app).get('/api/v1/auth/google/callback?code=authcode');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login?error=google_state');
    expect(hasSessionCookie(res)).toBe(false);
    expect(g.verifierCalls()).toBe(0);
  });

  it('a callback whose state does not match the browser cookie is rejected', async () => {
    g.setClaims(claims());
    const agent = request.agent(g.harness.app);
    // Start binds a real state cookie; then we present a DIFFERENT state value.
    await agent.get('/api/v1/auth/google/start');
    const res = await agent.get('/api/v1/auth/google/callback?state=tampered-value&code=authcode');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=google_state');
    expect(g.verifierCalls()).toBe(0);
  });

  it('a verification failure aborts with no account created', async () => {
    g.setClaims(new Error('bad id token'));
    const agent = request.agent(g.harness.app);
    const res = await runGoogleFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=google_verify');
    const rows = await g.harness.db.select().from(users);
    // Only the seeded admin exists — no user was created from the bad token.
    expect(rows.filter((u) => u.role === 'user')).toHaveLength(0);
  });
});

// ── Existing identity → same session-issuance path ───────────────────────────
describe('Google sign-in — existing identity signs in like password login (§13.4 V4-P4b)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
    await setMode(g.adminAgent, 'open');
  });

  it('a linked (provider, sub) mints a session + audit + session-manager entry', async () => {
    const profile = claims({ sub: 'sub-existing', email: 'existing@example.com' });
    // First flow (open mode) registers + links the identity.
    g.setClaims(profile);
    const reg = await runGoogleFlow(request.agent(g.harness.app));
    expect(reg.status).toBe(302);
    expect(reg.headers.location).toContain('google=signed_in');

    // A brand-new browser signs in through the SAME Google identity.
    const agent = request.agent(g.harness.app);
    const signIn = await runGoogleFlow(agent);
    expect(signIn.status).toBe(302);
    expect(signIn.headers.location).toContain('google=signed_in');
    expect(signIn.headers['set-cookie']).toBeDefined();

    // Session cookie works on /auth/me and the session-manager lists it.
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('existing@example.com');
    const sessions = await agent.get('/api/v1/auth/sessions');
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions.length).toBeGreaterThanOrEqual(1);

    // Audit log records a login.success via google (same action as password login).
    const audits = await g.harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'login.success'));
    expect(audits.some((a) => (a.meta as { via?: string } | null)?.via === 'google')).toBe(true);

    // Exactly one identity row for this Google account (no duplicate on re-login).
    const identities = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.subject, 'sub-existing'));
    expect(identities).toHaveLength(1);
  });
});

// ── Link-by-verified-email ───────────────────────────────────────────────────
describe('Google sign-in — verified-email linking (§13.4 V4-P4b)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
    await setMode(g.adminAgent, 'open');
  });

  it('a verified email matching an existing account links + signs in, and password still works', async () => {
    const user = await g.harness.seedUser({
      email: 'linkme@example.com',
      password: 'orig-password-1',
    });
    g.setClaims(claims({ sub: 'sub-link', email: 'linkme@example.com', emailVerified: true }));

    const agent = request.agent(g.harness.app);
    const res = await runGoogleFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('google=signed_in');
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.id).toBe(user.id);

    // The identity is linked to the pre-existing account.
    const identities = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, user.id));
    expect(identities).toHaveLength(1);
    expect(identities[0]!.provider).toBe('google');

    // Password login still works for the same account afterwards.
    const pw = await request(g.harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'linkme@example.com', password: 'orig-password-1' });
    expect(pw.status).toBe(200);
    expect(pw.body.id).toBe(user.id);
  });

  it('an UNVERIFIED email never links — it falls through to the registration path', async () => {
    const user = await g.harness.seedUser({
      email: 'noverify@example.com',
      password: 'orig-password-1',
    });
    g.setClaims(
      claims({ sub: 'sub-noverify', email: 'noverify@example.com', emailVerified: false }),
    );

    const agent = request.agent(g.harness.app);
    const res = await runGoogleFlow(agent);
    // Register path hits the taken email → error, and crucially NO link happened.
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=google_email_taken');
    const identities = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, user.id));
    expect(identities).toHaveLength(0);

    // The original account is untouched and still password-logs-in.
    const pw = await request(g.harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'noverify@example.com', password: 'orig-password-1' });
    expect(pw.status).toBe(200);
  });

  it('an unverified email with NO existing account still registers a new account', async () => {
    g.setClaims(
      claims({ sub: 'sub-fresh', email: 'fresh-unverified@example.com', emailVerified: false }),
    );
    const agent = request.agent(g.harness.app);
    const res = await runGoogleFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('google=signed_in');
    const identities = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.subject, 'sub-fresh'));
    expect(identities).toHaveLength(1);
    expect(identities[0]!.emailVerified).toBe(false);
  });
});

// ── Mode matrix for a NEW Google identity ────────────────────────────────────
describe('Google sign-in — registration mode matrix (§13.4 V4-P4b)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
  });

  it('open → account created + signed in', async () => {
    await setMode(g.adminAgent, 'open');
    g.setClaims(claims({ sub: 'sub-open', email: 'open@example.com' }));
    const agent = request.agent(g.harness.app);
    const res = await runGoogleFlow(agent);
    expect(res.headers.location).toContain('google=signed_in');
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('open@example.com');
  });

  it('closed → friendly rejection, no account row created (regression)', async () => {
    await setMode(g.adminAgent, 'closed');
    g.setClaims(claims({ sub: 'sub-closed', email: 'closed@example.com' }));
    const res = await runGoogleFlow(request.agent(g.harness.app));
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=google_registration_closed');
    expect(hasSessionCookie(res)).toBe(false);
    const rows = await g.harness.db
      .select()
      .from(users)
      .where(eq(users.email, 'closed@example.com'));
    expect(rows).toHaveLength(0);
  });

  it('invite_token → completes only when a valid token is carried into the flow', async () => {
    await setMode(g.adminAgent, 'invite_token');
    g.setClaims(claims({ sub: 'sub-invite', email: 'invite@example.com' }));

    // Without a token → rejected, no account.
    const noToken = await runGoogleFlow(request.agent(g.harness.app));
    expect(noToken.headers.location).toContain('error=google_invite_required');
    expect(
      await g.harness.db.select().from(users).where(eq(users.email, 'invite@example.com')),
    ).toHaveLength(0);

    // With a valid token carried through start → completes.
    const token = await createInviteToken(g.adminAgent);
    g.setClaims(claims({ sub: 'sub-invite', email: 'invite@example.com' }));
    const agent = request.agent(g.harness.app);
    const ok = await runGoogleFlow(agent, { inviteToken: token });
    expect(ok.headers.location).toContain('google=signed_in');
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.email).toBe('invite@example.com');
  });

  it('approval → pending application; admin approve creates + links + emails; Google then signs in', async () => {
    await setMode(g.adminAgent, 'approval');
    g.setClaims(
      claims({ sub: 'sub-approval', email: 'approval@example.com', name: 'Ada Lovelace' }),
    );

    const pending = await runGoogleFlow(request.agent(g.harness.app));
    expect(pending.status).toBe(302);
    expect(pending.headers.location).toContain('google=pending');
    expect(hasSessionCookie(pending)).toBe(false);
    // No account exists yet.
    expect(
      await g.harness.db.select().from(users).where(eq(users.email, 'approval@example.com')),
    ).toHaveLength(0);

    // The application is in the admin queue.
    const list = await g.adminAgent.get('/api/v1/admin/registration-requests');
    expect(list.status).toBe(200);
    const pendingReq = list.body.requests.find(
      (r: { email: string }) => r.email === 'approval@example.com',
    );
    expect(pendingReq).toBeTruthy();

    // Approve → account created (active) + decision email sent (reuses #453).
    const sentBefore = g.transport.sent.length;
    const approve = await g.adminAgent
      .post(`/api/v1/admin/registration-requests/${pendingReq.id}/approve`)
      .set(...XRW)
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('active');
    expect(g.transport.sent.length).toBeGreaterThan(sentBefore);
    expect(g.transport.sent.some((m) => m.to === 'approval@example.com')).toBe(true);

    // The approved account carries the linked Google identity.
    const identities = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.subject, 'sub-approval'));
    expect(identities).toHaveLength(1);

    // Google sign-in for that identity now works (existing identity path).
    g.setClaims(claims({ sub: 'sub-approval', email: 'approval@example.com' }));
    const agent = request.agent(g.harness.app);
    const signIn = await runGoogleFlow(agent);
    expect(signIn.headers.location).toContain('google=signed_in');
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.email).toBe('approval@example.com');
  });
});

// ── Settings → Security: link status + unlink ────────────────────────────────
describe('Google sign-in — Settings link status + unlink (§13.4 V4-P4b)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
    await setMode(g.adminAgent, 'open');
  });

  it('a Google-only account (no password) cannot unlink — Google is the only sign-in', async () => {
    g.setClaims(claims({ sub: 'sub-only', email: 'only@example.com' }));
    const agent = request.agent(g.harness.app);
    await runGoogleFlow(agent);

    const status = await agent.get('/api/v1/auth/google/link-status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, linked: true, canUnlink: false });
    expect(status.body.email).toBe('only@example.com');

    const unlink = await agent
      .post('/api/v1/auth/google/unlink')
      .set(...XRW)
      .send({ password: 'anything' });
    expect(unlink.status).toBe(409);
    expect(unlink.body.error.code).toBe('GOOGLE_ONLY_SIGN_IN');
  });

  it('a linked password account unlinks after a correct password re-auth; wrong password is refused', async () => {
    const user = await g.harness.seedUser({
      email: 'both@example.com',
      password: 'the-password-1',
    });
    g.setClaims(claims({ sub: 'sub-both', email: 'both@example.com', emailVerified: true }));
    const agent = request.agent(g.harness.app);
    await runGoogleFlow(agent); // links Google to the password account + signs in

    const status = await agent.get('/api/v1/auth/google/link-status');
    expect(status.body).toMatchObject({ linked: true, canUnlink: true });

    // Re-auth is required: a wrong password is rejected.
    const wrong = await agent
      .post('/api/v1/auth/google/unlink')
      .set(...XRW)
      .send({ password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(
      await g.harness.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.userId, user.id)),
    ).toHaveLength(1);

    // Correct password → unlinked.
    const ok = await agent
      .post('/api/v1/auth/google/unlink')
      .set(...XRW)
      .send({ password: 'the-password-1' });
    expect(ok.status).toBe(200);
    expect(
      await g.harness.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.userId, user.id)),
    ).toHaveLength(0);
  });
});

// ── Admin accounts are refused (mandatory admin-login 2FA, #400) ──────────────
// The Google callback has no second-factor step, so an admin resolved here would
// get an admin-capable session with the mandatory TOTP skipped — defeating #400.
describe('Google sign-in — admin accounts are refused (#400)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
    await setMode(g.adminAgent, 'open');
  });

  it('refuses an admin matched by verified email — no link, no session', async () => {
    const boss = await g.harness.seedAdmin({ email: 'ceo@example.com', username: 'ceo' });
    g.setClaims(claims({ sub: 'sub-admin-email', email: 'ceo@example.com', emailVerified: true }));

    const agent = request.agent(g.harness.app);
    const res = await runGoogleFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login?error=google_admin');
    expect(hasSessionCookie(res)).toBe(false);

    // Refused BEFORE the verified-email auto-link mutates: no identity planted.
    const identities = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, boss.id));
    expect(identities).toHaveLength(0);
  });

  it('refuses an admin who already holds a linked identity (e.g. promoted after linking)', async () => {
    const boss = await g.harness.seedAdmin({ email: 'cto@example.com', username: 'cto' });
    // Simulate an identity linked while the account was still a user, pre-promotion.
    await g.harness.db.insert(externalIdentities).values({
      userId: boss.id,
      provider: 'google',
      subject: 'sub-admin-existing',
      email: 'cto@example.com',
      emailVerified: true,
    });
    g.setClaims(
      claims({ sub: 'sub-admin-existing', email: 'cto@example.com', emailVerified: true }),
    );

    const agent = request.agent(g.harness.app);
    const res = await runGoogleFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login?error=google_admin');
    expect(hasSessionCookie(res)).toBe(false);
    // The refused sign-in never established a session.
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('refuses a Settings link initiated by an admin account — no identity planted', async () => {
    // The admin agent is authenticated, so /google/start turns this into a LINK
    // flow (linkUserId = admin.id); linkToUser must refuse it (intent: link).
    g.setClaims(
      claims({ sub: 'sub-admin-link', email: 'admin-google@gmail.com', emailVerified: true }),
    );
    const res = await runGoogleFlow(g.adminAgent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/settings/security?error=google_admin');

    const identities = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.subject, 'sub-admin-link'));
    expect(identities).toHaveLength(0);
  });
});

// ── Settings → Security: authenticated "link Google to my account" flow ───────
describe('Google sign-in — Settings link flow (§13.4 V4-P4b)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
    await setMode(g.adminAgent, 'open');
  });

  it('an authenticated user links a fresh Google account from Settings', async () => {
    const user = await g.harness.seedUser({
      email: 'linker@example.com',
      username: 'linker',
      password: 'link-password-1',
    });
    const agent = await loginUser(g.harness.app, user.email, user.password);
    // A live session makes this a LINK flow regardless of the Google email — use
    // an unrelated address so it is unmistakably a link, not a verified-email match.
    g.setClaims(
      claims({ sub: 'sub-settings-link', email: 'someone.else@gmail.com', emailVerified: true }),
    );

    const res = await runGoogleFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/settings/security?google=linked');

    const identities = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, user.id));
    expect(identities).toHaveLength(1);
    expect(identities[0]!.subject).toBe('sub-settings-link');

    // The link surfaces on the status endpoint the Settings page reads.
    const status = await agent.get('/api/v1/auth/google/link-status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ linked: true, email: 'someone.else@gmail.com' });
  });

  it('refuses linking a Google account already linked to another user (GOOGLE_ALREADY_LINKED)', async () => {
    // user1 claims the Google account first (via their own Settings link).
    const u1 = await g.harness.seedUser({
      email: 'first@example.com',
      username: 'first',
      password: 'first-password-1',
    });
    const a1 = await loginUser(g.harness.app, u1.email, u1.password);
    g.setClaims(claims({ sub: 'sub-shared', email: 'shared@gmail.com', emailVerified: true }));
    expect((await runGoogleFlow(a1)).headers.location).toContain('google=linked');

    // user2 tries to link the SAME Google account → conflict, nothing linked.
    const u2 = await g.harness.seedUser({
      email: 'second@example.com',
      username: 'second',
      password: 'second-password-1',
    });
    const a2 = await loginUser(g.harness.app, u2.email, u2.password);
    g.setClaims(claims({ sub: 'sub-shared', email: 'shared@gmail.com', emailVerified: true }));
    const res = await runGoogleFlow(a2);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/settings/security?error=google_already_linked');

    expect(
      await g.harness.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.userId, u2.id)),
    ).toHaveLength(0);
    // The identity still belongs to user1 — the link was never moved.
    const shared = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.subject, 'sub-shared'));
    expect(shared).toHaveLength(1);
    expect(shared[0]!.userId).toBe(u1.id);
  });

  it('refuses linking a second Google account when one is already linked (GOOGLE_ALREADY_LINKED)', async () => {
    const user = await g.harness.seedUser({
      email: 'already@example.com',
      username: 'already',
      password: 'already-password-1',
    });
    const agent = await loginUser(g.harness.app, user.email, user.password);

    // First link succeeds.
    g.setClaims(claims({ sub: 'sub-a', email: 'a@gmail.com', emailVerified: true }));
    expect((await runGoogleFlow(agent)).headers.location).toContain('google=linked');

    // A second, DIFFERENT Google account is refused — one identity per provider.
    g.setClaims(claims({ sub: 'sub-b', email: 'b@gmail.com', emailVerified: true }));
    const res = await runGoogleFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/settings/security?error=google_already_linked');

    // Still exactly the original identity.
    const identities = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.userId, user.id));
    expect(identities).toHaveLength(1);
    expect(identities[0]!.subject).toBe('sub-a');
  });
});
