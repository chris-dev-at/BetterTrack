import { randomBytes, randomInt } from 'node:crypto';

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

/** The flow context bound to a `state` value across the Google round-trip. */
interface StateContext {
  /** Present ⇒ an authenticated "link Google to my account" flow, not a sign-in. */
  linkUserId?: string;
  /** A registration token carried into the invite-token registration path. */
  inviteToken?: string;
}

export interface StartInput {
  /** When set, this is a LINK flow for the already-signed-in user (from Settings). */
  linkUserId?: string | null;
  /** A registration token carried in for the invite-token mode (RegisterPage). */
  inviteToken?: string | null;
}

/**
 * Outcome of the Google callback, shaped so the (redirect-only) route can decide
 * where to bounce the browser without re-deriving flow state. `error` carries the
 * `intent` so a link failure lands back on Settings and a sign-in failure on the
 * login page.
 */
export type GoogleCallbackResult =
  | { status: 'authenticated'; user: UserRow; sessionId: string; persistent: boolean }
  | { status: 'linked'; userId: string }
  | { status: 'pending' }
  | { status: 'error'; code: string; intent: 'login' | 'link' };

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
  async function signInUser(user: UserRow, ip?: string | null): Promise<GoogleCallbackResult> {
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

  /** A random, unusable argon2id hash for a password-less (Google) account. */
  const unusablePasswordHash = () => passwordHasher.hash(randomBytes(24).toString('hex'));

  /** Sanitize a username seed from the Google email local-part (fallback: name). */
  function usernameSeed(claims: GoogleClaims): string {
    const local = claims.email.split('@')[0] ?? '';
    let base = local.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (base.length < 3 && claims.name) {
      base = claims.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    }
    if (base.length < 3) base = `user${base}`;
    // Leave room for a numeric disambiguation suffix within the 40-char cap.
    return base.slice(0, 30);
  }

  /** First free username from `seed`, appending a random suffix on collision. */
  async function uniqueUsername(
    seed: string,
    taken: (candidate: string) => Promise<boolean>,
  ): Promise<string> {
    if (!(await taken(seed))) return seed;
    for (let i = 0; i < 50; i += 1) {
      const suffix = randomInt(1000, 1_000_000).toString();
      const candidate = `${seed.slice(0, 40 - suffix.length)}${suffix}`;
      if (!(await taken(candidate))) return candidate;
    }
    throw new Error('Could not allocate a unique username for the Google account');
  }

  async function buildAuthorizeUrl({
    linkUserId,
    inviteToken,
  }: StartInput): Promise<{ url: string; state: string }> {
    const state = randomBytes(32).toString('base64url');
    const context: StateContext = {};
    if (linkUserId) context.linkUserId = linkUserId;
    if (inviteToken && inviteToken.trim().length > 0) context.inviteToken = inviteToken.trim();
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
   * Register a brand-new Google identity subject to the active mode (§13.4 V4-P4b
   * acceptance): `closed` rejects; `approval` parks a pending application (no
   * account); `invite_token` requires a valid token carried into the flow; `open`
   * creates the account and signs in. Reuses the #453 registration machinery.
   */
  async function registerNew(
    claims: GoogleClaims,
    inviteToken: string | undefined,
    ip?: string | null,
  ): Promise<GoogleCallbackResult> {
    const mode = await appSettings.getRegistrationMode();
    // Closed keeps blocking everything — friendly rejection, no account row (regression).
    if (mode === 'closed') {
      throw forbidden('Self-serve registration is disabled.', 'REGISTRATION_CLOSED');
    }
    const emailAddr = claims.email.trim().toLowerCase();

    if (mode === 'approval') {
      if (await userRepo.findByEmail(emailAddr)) {
        throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
      }
      // An outstanding application for this email is idempotent — still pending.
      if (await registrationRequestRepo.findByEmail(emailAddr)) return { status: 'pending' };
      const username = await uniqueUsername(usernameSeed(claims), async (candidate) =>
        Boolean(
          (await userRepo.findByUsername(candidate)) ??
          (await registrationRequestRepo.findByUsername(candidate)),
        ),
      );
      const request = await registrationRequestRepo.create({
        email: emailAddr,
        username,
        // Password-less: approval mints a random unusable hash on the account.
        passwordHash: null,
        locale: 'en',
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
      return { status: 'pending' };
    }

    // invite_token mode: a valid, unexhausted token MUST have been carried in.
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
    const username = await uniqueUsername(usernameSeed(claims), async (candidate) =>
      Boolean(await userRepo.findByUsername(candidate)),
    );

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
      username,
      // Random unusable hash + the flag: password login can never succeed and
      // Google-unlink is refused until the user sets a password (via reset).
      passwordHash: await unusablePasswordHash(),
      hasUsablePassword: false,
      role: 'user',
      status: 'active',
      mustChangePassword: false,
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
    return signInUser(user, ip);
  }

  /** Resolution order: existing identity → verified-email link → register (§13.4). */
  async function resolveSignIn(
    claims: GoogleClaims,
    inviteToken: string | undefined,
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

    // 3. No identity, no verified-email match → register subject to the mode.
    return registerNew(claims, inviteToken, ip);
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
        return await resolveSignIn(claims, context.inviteToken, ip);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'GOOGLE_FAILED';
        if (!(err instanceof ApiError)) {
          logger.error({ err }, 'google callback failed unexpectedly');
        }
        return { status: 'error', code, intent };
      }
    },

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
