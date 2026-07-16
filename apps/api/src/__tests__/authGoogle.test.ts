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
async function runGoogleFlow(agent: ReturnType<typeof request.agent>) {
  const start = await agent.get('/api/v1/auth/google/start');
  expect(start.status).toBe(302);
  expect(start.headers.location).toContain('accounts.google.com');
  const state = new URL(String(start.headers.location)).searchParams.get('state');
  expect(state).toBeTruthy();
  return agent.get(
    `/api/v1/auth/google/callback?state=${encodeURIComponent(state!)}&code=authcode`,
  );
}

/** Submit the connected register form for the pending ticket this agent holds. */
async function completeGoogleRegister(
  agent: ReturnType<typeof request.agent>,
  body: { username: string; password: string; inviteToken?: string; email?: string },
) {
  return agent
    .post('/api/v1/auth/google/register')
    .set(...XRW)
    .send(body);
}

/**
 * Connect (start → callback) then submit the connected register form on ONE
 * agent, so the pending-ticket cookie set at the callback rides into the submit.
 * A brand-new identity always lands on `/register?google=connected` first (owner
 * order 2026-07-16 — no account is created at the callback).
 */
async function connectAndRegister(
  g: GoogleHarness,
  profile: GoogleClaims,
  form: { username: string; password: string; inviteToken?: string; email?: string },
) {
  const agent = request.agent(g.harness.app);
  g.setClaims(profile);
  const connect = await runGoogleFlow(agent);
  expect(connect.status).toBe(302);
  expect(connect.headers.location).toContain('/register?google=connected');
  const submit = await completeGoogleRegister(agent, form);
  return { agent, connect, submit };
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
    expect((await request(app).get('/api/v1/auth/google/register-ticket')).status).toBe(404);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/google/register')
          .set(...XRW)
          .send({ username: 'someone', password: 'a-strong-password-1' })
      ).status,
    ).toBe(404);
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
    // Connect → submit registers + links the identity (open mode).
    const { submit } = await connectAndRegister(g, profile, {
      username: 'exist_user',
      password: 'exist-strong-pass-1',
    });
    expect(submit.status).toBe(201);

    // A brand-new browser signs in through the SAME Google identity.
    const agent = request.agent(g.harness.app);
    g.setClaims(profile);
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

// ── Link-by-verified-email (LOGIN path — unchanged) ──────────────────────────
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

  it('an UNVERIFIED email never auto-links — it lands on the connected register form', async () => {
    const user = await g.harness.seedUser({
      email: 'noverify@example.com',
      password: 'orig-password-1',
    });
    g.setClaims(
      claims({ sub: 'sub-noverify', email: 'noverify@example.com', emailVerified: false }),
    );

    const agent = request.agent(g.harness.app);
    const res = await runGoogleFlow(agent);
    // No auto-link on an unverified email; it falls through to the connected form
    // (a later submit would fail EMAIL_TAKEN) — crucially, NO link happened.
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/register?google=connected');
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

  it('an unverified email with NO existing account registers via connect → submit', async () => {
    const { agent, submit } = await connectAndRegister(
      g,
      claims({ sub: 'sub-fresh', email: 'fresh-unverified@example.com', emailVerified: false }),
      { username: 'fresh_user', password: 'fresh-strong-pass-1' },
    );
    expect(submit.status).toBe(201);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.email).toBe('fresh-unverified@example.com');
    const identities = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.subject, 'sub-fresh'));
    expect(identities).toHaveLength(1);
    expect(identities[0]!.emailVerified).toBe(false);
  });
});

// ── Mode matrix for a NEW Google identity (connect → prefill → submit) ────────
describe('Google-assisted registration — mode matrix (owner order 2026-07-16)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
  });

  it('open → connected form submit creates the account (with a usable password) + signs in', async () => {
    await setMode(g.adminAgent, 'open');
    const { agent, submit } = await connectAndRegister(
      g,
      claims({ sub: 'sub-open', email: 'open@example.com', name: 'Open Person' }),
      { username: 'open_user', password: 'open-strong-pass-1' },
    );
    expect(submit.status).toBe(201);
    expect(submit.body.email).toBe('open@example.com');
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('open@example.com');

    // Password rules are unchanged: the account carries the usable password the
    // applicant set on the form, so it can ALSO password-login.
    const pw = await request(g.harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'open@example.com', password: 'open-strong-pass-1' });
    expect(pw.status).toBe(200);
  });

  it('no account/identity row exists before the connected form is submitted', async () => {
    await setMode(g.adminAgent, 'open');
    const agent = request.agent(g.harness.app);
    g.setClaims(claims({ sub: 'sub-presubmit', email: 'presubmit@example.com' }));
    const connect = await runGoogleFlow(agent);
    expect(connect.status).toBe(302);
    expect(connect.headers.location).toContain('/register?google=connected');
    // The callback established no session and created nothing yet.
    expect(hasSessionCookie(connect)).toBe(false);
    expect(
      await g.harness.db.select().from(users).where(eq(users.email, 'presubmit@example.com')),
    ).toHaveLength(0);
    expect(
      await g.harness.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.subject, 'sub-presubmit')),
    ).toHaveLength(0);

    // The ticket display view reflects the pending sign-up (email locked, name).
    const ticket = await agent.get('/api/v1/auth/google/register-ticket');
    expect(ticket.status).toBe(200);
    expect(ticket.body.email).toBe('presubmit@example.com');
  });

  it('closed → friendly rejection at the callback, no account row, no ticket', async () => {
    await setMode(g.adminAgent, 'closed');
    g.setClaims(claims({ sub: 'sub-closed', email: 'closed@example.com' }));
    const agent = request.agent(g.harness.app);
    const res = await runGoogleFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=google_registration_closed');
    expect(hasSessionCookie(res)).toBe(false);
    expect(
      await g.harness.db.select().from(users).where(eq(users.email, 'closed@example.com')),
    ).toHaveLength(0);
    // No ticket was minted, so the connected form has nothing to submit against.
    const ticket = await agent.get('/api/v1/auth/google/register-ticket');
    expect(ticket.status).toBe(404);
  });

  it('invite_token → the connected form completes only with a valid token entered', async () => {
    await setMode(g.adminAgent, 'invite_token');
    const agent = request.agent(g.harness.app);
    g.setClaims(claims({ sub: 'sub-invite', email: 'invite@example.com' }));
    const connect = await runGoogleFlow(agent);
    expect(connect.headers.location).toContain('/register?google=connected');

    // Submit WITHOUT a token → rejected, no account (the ticket survives for a retry).
    const noToken = await completeGoogleRegister(agent, {
      username: 'inv_user',
      password: 'inv-strong-pass-1',
    });
    expect(noToken.status).toBe(400);
    expect(
      await g.harness.db.select().from(users).where(eq(users.email, 'invite@example.com')),
    ).toHaveLength(0);

    // Submit WITH a valid token → completes on the SAME still-live ticket.
    const token = await createInviteToken(g.adminAgent);
    const ok = await completeGoogleRegister(agent, {
      username: 'inv_user',
      password: 'inv-strong-pass-1',
      inviteToken: token,
    });
    expect(ok.status).toBe(201);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.email).toBe('invite@example.com');
  });

  it('approval → pending application carrying the Google linkage + a usable password', async () => {
    await setMode(g.adminAgent, 'approval');
    const { submit } = await connectAndRegister(
      g,
      claims({ sub: 'sub-approval', email: 'approval@example.com', name: 'Ada Lovelace' }),
      { username: 'ada_user', password: 'ada-strong-pass-1' },
    );
    expect(submit.status).toBe(202);
    expect(submit.body.pending).toBe(true);
    // No session and no account exists yet.
    expect(hasSessionCookie(submit)).toBe(false);
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

    // It ALSO keeps the usable password the applicant set — password login works.
    const pw = await request(g.harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'approval@example.com', password: 'ada-strong-pass-1' });
    expect(pw.status).toBe(200);

    // Google sign-in for that identity now works (existing identity path).
    g.setClaims(claims({ sub: 'sub-approval', email: 'approval@example.com' }));
    const signInAgent = request.agent(g.harness.app);
    const signIn = await runGoogleFlow(signInAgent);
    expect(signIn.headers.location).toContain('google=signed_in');
    const me = await signInAgent.get('/api/v1/auth/me');
    expect(me.body.email).toBe('approval@example.com');
  });
});

// ── Ticket is single-use, browser-bound, expiring, and the email is authoritative ─
describe('Google-assisted registration — ticket security (owner order 2026-07-16)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
    await setMode(g.adminAgent, 'open');
  });

  it('a second submit with the same ticket fails — single-use', async () => {
    const { agent, submit } = await connectAndRegister(
      g,
      claims({ sub: 'sub-once', email: 'once@example.com' }),
      { username: 'once_user', password: 'once-strong-pass-1' },
    );
    expect(submit.status).toBe(201);
    // The ticket was spent on success — a replay finds no ticket.
    const replay = await completeGoogleRegister(agent, {
      username: 'once_user2',
      password: 'once-strong-pass-1',
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('GOOGLE_REGISTER_TICKET_INVALID');
  });

  it('a ticket is unusable from another browser session', async () => {
    const agent = request.agent(g.harness.app);
    g.setClaims(claims({ sub: 'sub-bound', email: 'bound@example.com' }));
    const connect = await runGoogleFlow(agent);
    expect(connect.headers.location).toContain('/register?google=connected');

    // A DIFFERENT agent (no `bt_goog_reg` cookie) cannot submit the pending ticket.
    const other = request.agent(g.harness.app);
    const res = await completeGoogleRegister(other, {
      username: 'bound_user',
      password: 'bound-strong-pass-1',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GOOGLE_REGISTER_TICKET_INVALID');
    expect(
      await g.harness.db.select().from(users).where(eq(users.email, 'bound@example.com')),
    ).toHaveLength(0);
  });

  it('the register ticket is stored with a ~10-minute expiry', async () => {
    const agent = request.agent(g.harness.app);
    g.setClaims(claims({ sub: 'sub-ttl', email: 'ttl@example.com' }));
    await runGoogleFlow(agent);
    const keys = await g.harness.ctx.redis.keys('google_register_ticket:*');
    expect(keys).toHaveLength(1);
    const ttl = await g.harness.ctx.redis.ttl(keys[0]!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('a tampered form email is ignored — the account uses the ticket’s email', async () => {
    const { agent, submit } = await connectAndRegister(
      g,
      claims({ sub: 'sub-tamper', email: 'realmail@example.com' }),
      {
        username: 'tamper_user',
        password: 'tamper-strong-pass-1',
        // The form tries to smuggle a different email — it must be ignored.
        email: 'attacker@evil.com',
      },
    );
    expect(submit.status).toBe(201);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.email).toBe('realmail@example.com');
    expect(
      await g.harness.db.select().from(users).where(eq(users.email, 'attacker@evil.com')),
    ).toHaveLength(0);
  });
});

// ── Settings → Security: link status + unlink ────────────────────────────────
describe('Google sign-in — Settings link status + unlink (§13.4 V4-P4b)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
    await setMode(g.adminAgent, 'open');
  });

  it('a Google-only account (no usable password) cannot unlink — Google is the only sign-in', async () => {
    // A password-less Google account (e.g. a legacy sign-up): seed it directly
    // with its Google identity, then sign in via the existing-identity path.
    const [row] = await g.harness.db
      .insert(users)
      .values({
        email: 'only@example.com',
        username: 'onlyuser',
        passwordHash: 'unusable-placeholder',
        hasUsablePassword: false,
      })
      .returning();
    await g.harness.db.insert(externalIdentities).values({
      userId: row!.id,
      provider: 'google',
      subject: 'sub-only',
      email: 'only@example.com',
      emailVerified: true,
    });

    g.setClaims(claims({ sub: 'sub-only', email: 'only@example.com' }));
    const agent = request.agent(g.harness.app);
    const signIn = await runGoogleFlow(agent);
    expect(signIn.headers.location).toContain('google=signed_in');

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
    await runGoogleFlow(agent); // verified-email match links Google + signs in

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
    // flow (linkUserId = admin.id); linkToUser refuses admins BEFORE the
    // email-match guard (intent: link).
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

// ── Settings → Security: email-match-only "link Google to my account" ─────────
describe('Google sign-in — Settings connect is email-match-only (owner order 2026-07-16)', () => {
  let g: GoogleHarness;
  beforeEach(async () => {
    g = await makeGoogleHarness();
    await setMode(g.adminAgent, 'open');
  });

  it('links the Google account whose VERIFIED email matches this account (happy path)', async () => {
    const user = await g.harness.seedUser({
      email: 'linker@example.com',
      username: 'linker',
      password: 'link-password-1',
    });
    const agent = await loginUser(g.harness.app, user.email, user.password);
    // Email-match-only: the Google email MUST equal the account email.
    g.setClaims(
      claims({ sub: 'sub-settings-link', email: 'linker@example.com', emailVerified: true }),
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

    const status = await agent.get('/api/v1/auth/google/link-status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ linked: true, email: 'linker@example.com' });
  });

  it('refuses a connect whose Google email does NOT match the account email — no identity, session intact', async () => {
    const user = await g.harness.seedUser({
      email: 'matchme@example.com',
      username: 'matchme',
      password: 'match-password-1',
    });
    const agent = await loginUser(g.harness.app, user.email, user.password);
    // A live session makes this a LINK flow; the mismatched Google email is refused.
    g.setClaims(
      claims({ sub: 'sub-mismatch', email: 'someone.else@gmail.com', emailVerified: true }),
    );

    const res = await runGoogleFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/settings/security?error=google_email_mismatch');

    // No identity planted — neither on the account nor for the Google subject.
    expect(
      await g.harness.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.userId, user.id)),
    ).toHaveLength(0);
    expect(
      await g.harness.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.subject, 'sub-mismatch')),
    ).toHaveLength(0);
    // The session is untouched — still signed in as the same account.
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.id).toBe(user.id);
  });

  it('refuses a connect whose matching email is UNVERIFIED — no identity', async () => {
    const user = await g.harness.seedUser({
      email: 'unv@example.com',
      username: 'unvuser',
      password: 'unv-password-1',
    });
    const agent = await loginUser(g.harness.app, user.email, user.password);
    // Email equals the account email but Google has NOT verified it → refused.
    g.setClaims(claims({ sub: 'sub-unv', email: 'unv@example.com', emailVerified: false }));

    const res = await runGoogleFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=google_email_mismatch');
    expect(
      await g.harness.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.userId, user.id)),
    ).toHaveLength(0);
  });

  it('refuses linking a second Google account when one is already linked (GOOGLE_ALREADY_LINKED)', async () => {
    const user = await g.harness.seedUser({
      email: 'already@example.com',
      username: 'already',
      password: 'already-password-1',
    });
    const agent = await loginUser(g.harness.app, user.email, user.password);

    // First link succeeds (matching email).
    g.setClaims(claims({ sub: 'sub-a', email: 'already@example.com', emailVerified: true }));
    expect((await runGoogleFlow(agent)).headers.location).toContain('google=linked');

    // A second, DIFFERENT Google account presenting the SAME matching email clears
    // the email guard but is refused — one identity per provider.
    g.setClaims(claims({ sub: 'sub-b', email: 'already@example.com', emailVerified: true }));
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

  it('cannot hijack another user’s Google identity — the email guard rejects it', async () => {
    // u1 links their own Google account (email matches).
    const u1 = await g.harness.seedUser({
      email: 'owner@example.com',
      username: 'owner',
      password: 'owner-password-1',
    });
    const a1 = await loginUser(g.harness.app, u1.email, u1.password);
    g.setClaims(claims({ sub: 'sub-shared', email: 'owner@example.com', emailVerified: true }));
    expect((await runGoogleFlow(a1)).headers.location).toContain('google=linked');

    // u2 tries to connect the SAME Google account, whose email is owner@example.com
    // (not u2's) → email mismatch, nothing moved.
    const u2 = await g.harness.seedUser({
      email: 'other@example.com',
      username: 'other',
      password: 'other-password-1',
    });
    const a2 = await loginUser(g.harness.app, u2.email, u2.password);
    g.setClaims(claims({ sub: 'sub-shared', email: 'owner@example.com', emailVerified: true }));
    const res = await runGoogleFlow(a2);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/settings/security?error=google_email_mismatch');

    expect(
      await g.harness.db
        .select()
        .from(externalIdentities)
        .where(eq(externalIdentities.userId, u2.id)),
    ).toHaveLength(0);
    // The identity still belongs to u1 — the link was never moved.
    const shared = await g.harness.db
      .select()
      .from(externalIdentities)
      .where(eq(externalIdentities.subject, 'sub-shared'));
    expect(shared).toHaveLength(1);
    expect(shared[0]!.userId).toBe(u1.id);
  });
});
