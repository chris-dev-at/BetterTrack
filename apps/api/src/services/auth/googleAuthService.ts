import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { AppConfig } from '../../config/env';
import type { IdentityRepository } from '../../data/repositories/identityRepository';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { RegistrationRequestRepository } from '../../data/repositories/registrationRequestRepository';
import type { RegistrationTokenRepository } from '../../data/repositories/registrationTokenRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { UserRow } from '../../data/schema';
import {
  accountDisabled,
  ApiError,
  badRequest,
  conflict,
  forbidden,
  unauthorized,
} from '../../errors';
import type { Logger } from '../../logger';
import { applyAccountDefaultsAtRegistration } from '../account/accountDefaults';
import type { AppSettingsService } from '../appSettings/appSettingsService';
import { AuditAction, type AuditService } from '../audit/auditService';
import { hashToken } from '../crypto/tokens';
import type { EmailService } from '../email/emailService';
import type { PasswordHasher } from '../password/passwordHasher';
import { checkPasswordPolicy } from '../password/passwordPolicy';
import type { SessionService } from '../sessions/sessionService';
import type { GoogleClaims, GoogleTokenVerifier } from './googleVerifier';

/** The one federated provider today (§13.4 V4-P4b). Stored on every identity row. */
export const GOOGLE_PROVIDER = 'google';

// The `state` (CSRF) binding + carried flow context lives in Redis, single-use,
// for the round-trip to Google and back. Short-lived: long enough to sign in,
// tight enough to bound a leaked state value.
const STATE_TTL_SECONDS = 10 * 60;
const stateKey = (state: string) => `google_oauth_state:${state}`;
const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

// A brand-new Google identity no longer instant-registers at the callback (owner
// order 2026-07-16). The verified claims are parked in this single-use ticket for
// the connected register form to submit against — short-lived, and the browser is
// bound to it by the httpOnly cookie the route drops (see cookies.ts).
const REGISTER_TICKET_TTL_SECONDS = 10 * 60;
const registerTicketKey = (ticket: string) => `google_register_ticket:${ticket}`;

/** Normalized (trimmed, lower-cased) email — the comparison key for link matching. */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** The verified Google claims parked in a pending-registration ticket. */
interface RegisterTicket {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/** The flow context bound to a `state` value across the Google round-trip. */
interface StateContext {
  /** Present ⇒ an authenticated "link Google to my account" flow, not a sign-in. */
  linkUserId?: string;
}

export interface StartInput {
  /** When set, this is a LINK flow for the already-signed-in user (from Settings). */
  linkUserId?: string | null;
}

/**
 * Outcome of the Google callback, shaped so the (redirect-only) route can decide
 * where to bounce the browser without re-deriving flow state. `error` carries the
 * `intent` so a link failure lands back on Settings and a sign-in failure on the
 * login page.
 */
/** A minted session, shared by the sign-in and connected-registration outcomes. */
type AuthenticatedResult = {
  status: 'authenticated';
  user: UserRow;
  sessionId: string;
  persistent: boolean;
};

export type GoogleCallbackResult =
  | AuthenticatedResult
  | { status: 'linked'; userId: string }
  /** A brand-new identity: land the browser on the connected register form with this ticket. */
  | { status: 'register'; ticket: string }
  | { status: 'error'; code: string; intent: 'login' | 'link' };

/** Outcome of submitting the connected register form (`POST /auth/google/register`). */
export type GoogleRegisterResult = AuthenticatedResult | { status: 'pending' };

export interface GoogleLinkStatus {
  enabled: boolean;
  linked: boolean;
  email: string | null;
  linkedAt: string | null;
  canUnlink: boolean;
}

export interface GoogleAuthServiceDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  identityRepo: IdentityRepository;
  registrationTokenRepo: RegistrationTokenRepository;
  registrationRequestRepo: RegistrationRequestRepository;
  portfolioRepo: PortfolioRepository;
  notificationRepo: Pick<NotificationRepository, 'upsertChannelConfig'>;
  sessions: SessionService;
  audit: AuditService;
  passwordHasher: PasswordHasher;
  email: EmailService;
  appSettings: AppSettingsService;
  /** Injected so tests stub the token exchange + ID-token verification (no network). */
  verifier: GoogleTokenVerifier;
  logger: Logger;
}

/**
 * Google sign-in must NEVER mint a session for an admin account. Mandatory
 * admin-login 2FA (#400, §6.12) is enforced only because the *password* path
 * withholds the session until the shared TOTP challenge passes (authService's
 * `two_factor_required` — see `requireAdminTwoFactor`, which trusts that invariant
 * and checks a per-user flag, not the current session). The Google callback has no
 * second-factor step, so signing an admin in here would hand out an admin-capable
 * session with the mandatory TOTP skipped. Admin-app Google login is out of V4-P4b
 * scope — the §16-(b) deviation only sanctions skipping *user* app-2FA, not this
 * mandatory-admin control — so refuse it with a friendly sign-in-page error.
 */
function assertNotAdmin(user: UserRow): void {
  if (user.role === 'admin') {
    throw forbidden(
      'Google sign-in is not available for administrator accounts. Please sign in with your password.',
      'GOOGLE_ADMIN_UNSUPPORTED',
    );
  }
}

export interface GoogleAuthService {
  /** Whether Google sign-in is configured on this deployment (env-gated). */
  isEnabled(): boolean;
  /**
   * Build the Google authorize URL, binding a fresh single-use `state`. Returns
   * the `state` too so the route can also drop it in a signed cookie — the
   * callback then requires both to match (login-CSRF defence).
   */
  buildAuthorizeUrl(input: StartInput): Promise<{ url: string; state: string }>;
  /** Validate `state`, verify the code, and resolve to sign-in / link / register. */
  handleCallback(input: {
    state?: string;
    /** The `state` echoed from the signed browser cookie set at `start`. */
    cookieState?: string;
    code?: string;
    ip?: string | null;
  }): Promise<GoogleCallbackResult>;
  /**
   * Display values (email, name) for a pending-registration ticket — what the
   * connected register form prefills. Returns `null` for an unknown/expired
   * ticket. Read-only: it does NOT consume the ticket.
   */
  peekRegisterTicket(ticket: string): Promise<{ email: string; name: string | null } | null>;
  /**
   * Create the account from a pending Google ticket on explicit form submit. The
   * email + the subject to link are taken from the TICKET, never the caller — a
   * tampered form email cannot redirect the account. Password rules are unchanged
   * (the form still sets one). Applies the active registration mode. The ticket is
   * single-use: spent only on success, so a validation failure leaves it live for
   * a retry.
   */
  completeRegistration(input: {
    /** The ticket reference from the signed httpOnly cookie (never the body). */
    ticket: string;
    username: string;
    password: string;
    inviteToken?: string | null;
    locale?: string | null;
    ip?: string | null;
  }): Promise<GoogleRegisterResult>;
  /** The caller's Google link state for Settings → Security. */
  getLinkStatus(userId: string): Promise<GoogleLinkStatus>;
  /** Unlink Google after a password re-auth; refused when it is the only sign-in method. */
  unlink(userId: string, password: string, ip?: string | null): Promise<void>;
}

export function createGoogleAuthService(deps: GoogleAuthServiceDeps): GoogleAuthService {
  const {
    config,
    redis,
    userRepo,
    identityRepo,
    registrationTokenRepo,
    registrationRequestRepo,
    portfolioRepo,
    notificationRepo,
    sessions,
    audit,
    passwordHasher,
    email,
    appSettings,
    verifier,
    logger,
  } = deps;

  /** The server-side callback the code is redirected to — identical on both legs. */
  const redirectUri = () => `${config.topology.apiOrigin}/api/v1/auth/google/callback`;

  /**
   * Mint a session on the SAME path a password login takes (§13.4 V4-P4b
   * acceptance): create the session, stamp last-login, and audit a `login.success`
   * (`via: google`) plus the admin-login marker. Device label, session-manager
   * listing and the login-throttle namespace all flow from `sessions.create` +
   * this audit exactly as they do for a password login. A Google sign-in is a
   * normal web login, so the session is persistent.
   */
  async function signInUser(user: UserRow, ip?: string | null): Promise<AuthenticatedResult> {
    // Authoritative gate (#400): the Google callback must never mint an admin
    // session — there is no second-factor step here. Still reachable e.g. for an
    // account linked as a user and later promoted to admin (resolveSignIn step 1);
    // the verified-email and Settings-link paths refuse earlier, before they
    // mutate. See {@link assertNotAdmin}.
    assertNotAdmin(user);
    const persistent = true;
    const sessionId = await sessions.create(user.id, persistent);
    const now = new Date();
    await userRepo.setLastLogin(user.id, now);
    await audit.record({
      actorId: user.id,
      action: AuditAction.LoginSuccess,
      targetType: 'user',
      targetId: user.id,
      ip,
      meta: { via: 'google' },
    });
    if (user.role === 'admin') {
      await audit.record({
        actorId: user.id,
        action: AuditAction.AdminLogin,
        targetType: 'user',
        targetId: user.id,
        ip,
      });
    }
    return { status: 'authenticated', user: { ...user, lastLoginAt: now }, sessionId, persistent };
  }

  /** Park verified claims in a fresh single-use ticket; return its opaque reference. */
  async function createRegisterTicket(claims: GoogleClaims): Promise<string> {
    const ticket = randomBytes(32).toString('base64url');
    const payload: RegisterTicket = {
      sub: claims.sub,
      email: normalizeEmail(claims.email),
      emailVerified: claims.emailVerified,
      ...(claims.name ? { name: claims.name } : {}),
    };
    await redis.set(
      registerTicketKey(ticket),
      JSON.stringify(payload),
      'EX',
      REGISTER_TICKET_TTL_SECONDS,
    );
    return ticket;
  }

  /** Read a ticket WITHOUT consuming it (peek / display), or `null` if gone. */
  async function readRegisterTicket(ticket: string): Promise<RegisterTicket | null> {
    const raw = await redis.get(registerTicketKey(ticket));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RegisterTicket;
    } catch {
      return null;
    }
  }

  async function buildAuthorizeUrl({
    linkUserId,
  }: StartInput): Promise<{ url: string; state: string }> {
    const state = randomBytes(32).toString('base64url');
    const context: StateContext = {};
    if (linkUserId) context.linkUserId = linkUserId;
    await redis.set(stateKey(state), JSON.stringify(context), 'EX', STATE_TTL_SECONDS);

    const params = new URLSearchParams({
      client_id: config.google.clientId ?? '',
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
    });
    return { url: `${GOOGLE_AUTHORIZE_ENDPOINT}?${params.toString()}`, state };
  }

  /**
   * Create the account from a pending ticket on explicit form submit (owner order
   * 2026-07-16). Subject to the active mode: `closed` rejects (defensive — a ticket
   * is never minted in closed mode); `approval` parks a pending application (no
   * account); `invite_token` requires a valid token entered ON the form; `open`
   * creates the account and signs in. The email + subject to link are taken from
   * the ticket, never the caller. Unlike the old callback-time path, the account
   * carries a USABLE password the applicant set on the connected form.
   */
  async function completeRegistration({
    ticket,
    username,
    password,
    inviteToken,
    locale,
    ip,
  }: {
    ticket: string;
    username: string;
    password: string;
    inviteToken?: string | null;
    locale?: string | null;
    ip?: string | null;
  }): Promise<GoogleRegisterResult> {
    // Peek (not consume): a validation failure below must leave the ticket live
    // so the user can fix the form and resubmit — it is spent only on success.
    const claims = await readRegisterTicket(ticket);
    if (!claims) {
      throw badRequest(
        'Your Google sign-up session expired. Please connect Google again.',
        'GOOGLE_REGISTER_TICKET_INVALID',
      );
    }
    const emailAddr = claims.email; // already normalized when the ticket was minted
    const uname = username.trim();
    const formLocale = locale ?? 'en';

    const mode = await appSettings.getRegistrationMode();
    // Defensive: the callback never mints a ticket in closed mode, but re-check.
    if (mode === 'closed') {
      throw forbidden('Self-serve registration is disabled.', 'REGISTRATION_CLOSED');
    }

    // Password rules stay exactly as they are today — Google prefills, it does
    // not replace credentials (owner order 2026-07-16).
    const policy = checkPasswordPolicy(password);
    if (!policy.ok) throw badRequest(policy.reason, 'WEAK_PASSWORD');
    const passwordHash = await passwordHasher.hash(password);

    // Approval parks the details as a PENDING application (never a user row),
    // carrying the Google linkage through to admin approval. Uniqueness is checked
    // against live accounts AND other pending applications.
    if (mode === 'approval') {
      if (await userRepo.findByEmail(emailAddr)) {
        throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
      }
      if (await userRepo.findByUsername(uname)) {
        throw conflict('That username is already taken.', 'USERNAME_TAKEN');
      }
      if (await registrationRequestRepo.findByEmail(emailAddr)) {
        throw conflict('A registration request for this email is already pending.', 'EMAIL_TAKEN');
      }
      if (await registrationRequestRepo.findByUsername(uname)) {
        throw conflict('That username is already requested.', 'USERNAME_TAKEN');
      }
      const request = await registrationRequestRepo.create({
        email: emailAddr,
        username: uname,
        // A usable password the applicant chose — the approved account keeps it
        // alongside the linked Google identity.
        passwordHash,
        locale: formLocale,
        provider: GOOGLE_PROVIDER,
        providerSubject: claims.sub,
        providerEmailVerified: claims.emailVerified,
      });
      await audit.record({
        action: AuditAction.RegistrationRequested,
        targetType: 'registration_request',
        targetId: request.id,
        ip,
        meta: { via: 'google' },
      });
      await redis.del(registerTicketKey(ticket));
      return { status: 'pending' };
    }

    // invite_token mode: a valid, unexhausted token entered on the form is required.
    let tokenId: string | null = null;
    if (mode === 'invite_token') {
      const raw = inviteToken?.trim();
      if (!raw) {
        throw badRequest('A registration token is required.', 'REGISTRATION_TOKEN_REQUIRED');
      }
      const record = await registrationTokenRepo.findByTokenHash(hashToken(raw));
      const usable =
        record &&
        !record.revokedAt &&
        record.useCount < record.maxUses &&
        (record.expiresAt === null || new Date(record.expiresAt).getTime() > Date.now());
      if (!record || !usable) {
        throw badRequest(
          'This registration token is invalid or has expired.',
          'INVALID_REGISTRATION_TOKEN',
        );
      }
      tokenId = record.id;
    }

    if (await userRepo.findByEmail(emailAddr)) {
      throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
    }
    if (await userRepo.findByUsername(uname)) {
      throw conflict('That username is already taken.', 'USERNAME_TAKEN');
    }

    if (tokenId) {
      const claimed = await registrationTokenRepo.consumeUse(tokenId, new Date());
      if (!claimed) {
        throw badRequest(
          'This registration token is invalid or has expired.',
          'INVALID_REGISTRATION_TOKEN',
        );
      }
    }

    const user = await userRepo.create({
      email: emailAddr,
      username: uname,
      passwordHash,
      role: 'user',
      status: 'active',
      mustChangePassword: false,
      locale: formLocale,
    });
    await portfolioRepo.createDefault(user.id);
    await applyAccountDefaultsAtRegistration({ appSettings, userRepo, notificationRepo }, user.id);
    await identityRepo.create({
      userId: user.id,
      provider: GOOGLE_PROVIDER,
      subject: claims.sub,
      email: emailAddr,
      emailVerified: claims.emailVerified,
    });
    await audit.record({
      actorId: user.id,
      action: AuditAction.UserCreated,
      targetType: 'user',
      targetId: user.id,
      ip,
      meta: { via: 'google', mode },
    });
    await audit.record({
      actorId: user.id,
      action: AuditAction.ExternalIdentityLinked,
      targetType: 'user',
      targetId: user.id,
      ip,
      meta: { provider: GOOGLE_PROVIDER },
    });
    await email.sendWelcome({
      to: user.email,
      username: user.username,
      audit: { actorId: user.id, targetType: 'user', targetId: user.id, ip },
    });
    // Single-use: burn the ticket only now that the account exists.
    await redis.del(registerTicketKey(ticket));
    return signInUser(user, ip);
  }

  /** Resolution order: existing identity → verified-email link → register (§13.4). */
  async function resolveSignIn(
    claims: GoogleClaims,
    ip?: string | null,
  ): Promise<GoogleCallbackResult> {
    // 1. Existing (provider, sub) → sign in.
    const identity = await identityRepo.findByProviderSubject(GOOGLE_PROVIDER, claims.sub);
    if (identity) {
      const user = await userRepo.findById(identity.userId);
      if (!user) throw badRequest('Google sign-in failed.', 'GOOGLE_FAILED');
      if (user.status !== 'active') throw accountDisabled();
      // Keep the email snapshot fresh if Google's changed since link time.
      if (
        identity.email !== claims.email.trim().toLowerCase() ||
        identity.emailVerified !== claims.emailVerified
      ) {
        await identityRepo.updateEmail(identity.id, claims.email, claims.emailVerified);
      }
      return signInUser(user, ip);
    }

    // 2. Verified-email match → link + sign in. An UNVERIFIED email never links.
    if (claims.emailVerified) {
      const existing = await userRepo.findByEmail(claims.email);
      if (existing) {
        if (existing.status !== 'active') throw accountDisabled();
        // Refuse admins BEFORE the verified-email auto-link mutates anything
        // (#400): an admin must not silently acquire a Google identity, let alone
        // a session that skips the mandatory 2FA challenge. See {@link assertNotAdmin}.
        assertNotAdmin(existing);
        // Only link when the account has no Google identity yet; if it already
        // linked a different Google account, sign them in without a duplicate.
        if (!(await identityRepo.findByUserProvider(existing.id, GOOGLE_PROVIDER))) {
          await identityRepo.create({
            userId: existing.id,
            provider: GOOGLE_PROVIDER,
            subject: claims.sub,
            email: claims.email,
            emailVerified: true,
          });
          await audit.record({
            actorId: existing.id,
            action: AuditAction.ExternalIdentityLinked,
            targetType: 'user',
            targetId: existing.id,
            ip,
            meta: { provider: GOOGLE_PROVIDER, via: 'verified_email' },
          });
        }
        return signInUser(existing, ip);
      }
    }

    // 3. No identity, no verified-email match → do NOT instant-register (owner
    // order 2026-07-16). `closed` keeps its friendly rejection at the callback;
    // every other mode parks the verified claims in a one-time ticket and lands
    // the browser on the connected register form, where the account is created
    // only on explicit submit.
    const mode = await appSettings.getRegistrationMode();
    if (mode === 'closed') {
      throw forbidden('Self-serve registration is disabled.', 'REGISTRATION_CLOSED');
    }
    const ticket = await createRegisterTicket(claims);
    return { status: 'register', ticket };
  }

  /** Authenticated "link Google to my account" flow (from Settings → Security). */
  async function linkToUser(
    linkUserId: string,
    claims: GoogleClaims,
    ip?: string | null,
  ): Promise<GoogleCallbackResult> {
    const user = await userRepo.findById(linkUserId);
    if (!user || user.status !== 'active') {
      throw badRequest('Google linking failed.', 'GOOGLE_FAILED');
    }
    // Keep admins and federated sign-in disjoint (#400): an admin account never
    // links a Google identity, so no linked identity can later mint an admin
    // session that skips the mandatory 2FA challenge. See {@link assertNotAdmin}.
    assertNotAdmin(user);
    // Email-match-only (owner order 2026-07-16): a Settings connect may only ever
    // attach the Google identity whose VERIFIED email equals this account's email
    // (case-insensitive) — never an arbitrary Google account. A mismatched or
    // unverified email links nothing and changes no session; the sign-in
    // verified-email auto-link path already matches BY email, so this makes the
    // Settings path enforce the same rule.
    if (!claims.emailVerified || normalizeEmail(claims.email) !== normalizeEmail(user.email)) {
      throw badRequest(
        'This Google account’s email does not match your account email.',
        'GOOGLE_EMAIL_MISMATCH',
      );
    }
    const existing = await identityRepo.findByProviderSubject(GOOGLE_PROVIDER, claims.sub);
    if (existing) {
      // Idempotent when it is already this user's; otherwise the Google account
      // belongs to someone else — refuse rather than move the link.
      if (existing.userId === linkUserId) return { status: 'linked', userId: linkUserId };
      throw conflict(
        'This Google account is already linked to another user.',
        'GOOGLE_ALREADY_LINKED',
      );
    }
    if (await identityRepo.findByUserProvider(linkUserId, GOOGLE_PROVIDER)) {
      throw conflict(
        'Your account is already linked to a Google account.',
        'GOOGLE_ALREADY_LINKED',
      );
    }
    await identityRepo.create({
      userId: linkUserId,
      provider: GOOGLE_PROVIDER,
      subject: claims.sub,
      email: claims.email,
      emailVerified: claims.emailVerified,
    });
    await audit.record({
      actorId: linkUserId,
      action: AuditAction.ExternalIdentityLinked,
      targetType: 'user',
      targetId: linkUserId,
      ip,
      meta: { provider: GOOGLE_PROVIDER, via: 'settings' },
    });
    return { status: 'linked', userId: linkUserId };
  }

  return {
    isEnabled: () => config.google.enabled,

    buildAuthorizeUrl,

    async handleCallback({ state, cookieState, code, ip }) {
      // Enforce `state` FIRST (§13.4 V4-P4b acceptance): a missing/mismatched
      // state is rejected before any token exchange or account action. Two gates,
      // both required: the query `state` must equal the signed browser cookie set
      // at `start` (login-CSRF — a planted state fails because the victim's
      // browser lacks its cookie), AND it must resolve a live single-use Redis
      // entry (read then delete so a state can't be replayed).
      if (!state || !cookieState || state !== cookieState) {
        return { status: 'error', code: 'GOOGLE_STATE_INVALID', intent: 'login' };
      }
      const rawState = await redis.get(stateKey(state));
      if (rawState) await redis.del(stateKey(state));
      if (!rawState) return { status: 'error', code: 'GOOGLE_STATE_INVALID', intent: 'login' };

      let context: StateContext = {};
      try {
        context = JSON.parse(rawState) as StateContext;
      } catch {
        context = {};
      }
      const intent: 'login' | 'link' = context.linkUserId ? 'link' : 'login';

      try {
        if (!code) throw badRequest('Google verification failed.', 'GOOGLE_VERIFY_FAILED');
        let claims: GoogleClaims;
        try {
          claims = await verifier.exchangeAndVerify({ code, redirectUri: redirectUri() });
        } catch (err) {
          logger.warn({ err }, 'google id-token verification failed');
          throw badRequest('Google verification failed.', 'GOOGLE_VERIFY_FAILED');
        }
        if (context.linkUserId) return await linkToUser(context.linkUserId, claims, ip);
        return await resolveSignIn(claims, ip);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'GOOGLE_FAILED';
        if (!(err instanceof ApiError)) {
          logger.error({ err }, 'google callback failed unexpectedly');
        }
        return { status: 'error', code, intent };
      }
    },

    async peekRegisterTicket(ticket) {
      const parsed = await readRegisterTicket(ticket);
      if (!parsed) return null;
      return { email: parsed.email, name: parsed.name ?? null };
    },

    completeRegistration,

    async getLinkStatus(userId) {
      const identity = await identityRepo.findByUserProvider(userId, GOOGLE_PROVIDER);
      const user = await userRepo.findById(userId);
      return {
        enabled: config.google.enabled,
        linked: Boolean(identity),
        email: identity?.email ?? null,
        linkedAt: identity ? new Date(identity.createdAt).toISOString() : null,
        // Refused while Google is the ONLY usable sign-in method (no password).
        canUnlink: Boolean(identity) && Boolean(user?.hasUsablePassword),
      };
    },

    async unlink(userId, password, ip) {
      const user = await userRepo.findById(userId);
      if (!user || user.status !== 'active') throw unauthorized();
      const identity = await identityRepo.findByUserProvider(userId, GOOGLE_PROVIDER);
      if (!identity) {
        throw badRequest('No Google account is linked.', 'GOOGLE_NOT_LINKED');
      }
      // Never strand an account with no other way in (§13.4 V4-P4b acceptance).
      if (!user.hasUsablePassword) {
        throw conflict(
          'Set a password before unlinking Google — it is your only sign-in method.',
          'GOOGLE_ONLY_SIGN_IN',
        );
      }
      const ok = await passwordHasher.verify(user.passwordHash, password);
      if (!ok) throw unauthorized('Your password is incorrect.', 'INVALID_CREDENTIALS');
      await identityRepo.deleteByUserProvider(userId, GOOGLE_PROVIDER);
      await audit.record({
        actorId: userId,
        action: AuditAction.ExternalIdentityUnlinked,
        targetType: 'user',
        targetId: userId,
        ip,
        meta: { provider: GOOGLE_PROVIDER },
      });
    },
  };
}
