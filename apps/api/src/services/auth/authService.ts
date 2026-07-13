import { randomBytes, randomInt } from 'node:crypto';

import type { Redis } from 'ioredis';

import {
  type AcceptInviteRequest,
  type ChangePasswordRequest,
  type PasswordResetComplete,
  type PasswordResetRequest,
  type RegisterRequest,
  type SessionInfoResponse,
  type SessionSummary,
  type TwoFactorChannel,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { InviteRepository } from '../../data/repositories/inviteRepository';
import type { PasswordResetTokenRepository } from '../../data/repositories/passwordResetTokenRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { UserRow } from '../../data/schema';
import {
  accountDisabled,
  badRequest,
  conflict,
  forbidden,
  tooManyRequests,
  unauthorized,
} from '../../errors';
import type { AppSettingsService } from '../appSettings/appSettingsService';
import { AuditAction, type AuditService } from '../audit/auditService';
import { generateToken, hashToken, sha256Base64Url } from '../crypto/tokens';
import type { EmailService } from '../email/emailService';
import type { PasswordHasher } from '../password/passwordHasher';
import { checkPasswordPolicy } from '../password/passwordPolicy';
import { createProgressiveLimiter } from '../security/progressiveLimiter';
import { describeUserAgent } from '../sessions/deviceLabel';
import { isPersistent, type SessionService } from '../sessions/sessionService';
import {
  clearLoginThrottle,
  clearPasswordThrottle,
  LOGIN_ACCOUNT_NAMESPACE,
  pinFailCountKey,
  PIN_FALLBACK_THRESHOLD,
  PIN_TOKEN_ACCOUNT_NAMESPACE,
  TWO_FACTOR_ACCOUNT_NAMESPACE,
} from './loginThrottle';
import type { TwoFactorService } from './twoFactorService';

export interface AuthServiceDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  inviteRepo: InviteRepository;
  passwordResetRepo: PasswordResetTokenRepository;
  portfolioRepo: PortfolioRepository;
  sessions: SessionService;
  audit: AuditService;
  passwordHasher: PasswordHasher;
  email: EmailService;
  appSettings: AppSettingsService;
  /** Login-challenge factor verification + recovery-code consumption (#273, §6.1). */
  twoFactor: TwoFactorService;
}

export interface LoginInput {
  identifier: string;
  password: string;
  ip?: string | null;
  currentSessionId?: string;
  /** "Stay signed in" (V4-P2b, §399 §A). Default true = a persistent session. */
  staySignedIn?: boolean;
  /**
   * This login is part of an OAuth authorize flow (§399 §A). A PIN-less OAuth
   * login is forced ephemeral here regardless of {@link staySignedIn}.
   */
  oauthLogin?: boolean;
}

export interface SessionResult {
  user: UserRow;
  sessionId: string;
  /** Whether the minted session is persistent (V4-P2b) — drives the cookie's Max-Age. */
  persistent: boolean;
}

/** The login-time 2FA challenge handed back when an account has 2FA enabled (§6.1). */
export interface TwoFactorChallenge {
  /** Opaque bearer accepted only by the verify / email-code endpoints. */
  pendingToken: string;
  /** Which second-factor channels the client may offer. */
  channels: TwoFactorChannel[];
}

/**
 * Result of a password login. A no-2FA account lands `authenticated` with a
 * session; a 2FA-enabled account lands `two_factor_required` with a pending
 * challenge and NO session — the caller must verify a second factor first.
 */
export type LoginResult =
  | ({ status: 'authenticated' } & SessionResult)
  | { status: 'two_factor_required'; challenge: TwoFactorChallenge };

export interface VerifyTwoFactorInput {
  pendingToken: string;
  /** A 6-digit TOTP or emailed login code. Mutually exclusive with `recoveryCode`. */
  code?: string;
  /** A dashed recovery code. Mutually exclusive with `code`. */
  recoveryCode?: string;
  ip?: string | null;
}

export interface VerifyPinInput {
  userId: string;
  sessionId: string;
  pin: string;
  ip?: string | null;
}

export interface AuthService {
  /**
   * Password login (§6.1). Returns a full session for a no-2FA account, or a
   * pending 2FA challenge (session withheld) when the account has 2FA enabled.
   */
  login(input: LoginInput): Promise<LoginResult>;
  /**
   * Complete a login 2FA challenge (§6.1, §13.2 V2-P5): verify a TOTP / emailed
   * code / recovery code against the pending state and, on success, mint the real
   * session (rotate any prior id, 30-day window, `last_login_at`, audit-log).
   * Wrong attempts are throttled per account (§10); a valid recovery code is
   * consumed single-use.
   */
  verifyTwoFactor(input: VerifyTwoFactorInput): Promise<SessionResult>;
  /**
   * Send a one-time email login code for a pending 2FA challenge (§6.1). The code
   * is short-lived, single-use and dispatched through the email channel (logged to
   * `email_log`; `suppressed` with no SMTP). A bad/expired pending token is
   * rejected without sending.
   */
  requestTwoFactorEmailCode(pendingToken: string, ip?: string | null): Promise<void>;
  logout(sessionId: string): Promise<void>;
  /**
   * Resolve a session cookie to its user (every authenticated request). Also
   * stamps the session's last-seen and captures its device on first-seen
   * (V3-P11a) — a throttled write to a side key that never touches the fixed
   * 30-day window (§6.1). `userAgent` comes from the request; omit it off the
   * request path. Returns the resolved user together with the session's
   * persistence marker (V4-P2b) so the caller can re-issue the matching cookie.
   */
  resolveSession(
    sessionId: string,
    userAgent?: string | null,
  ): Promise<{ user: UserRow; persistent: boolean } | null>;
  changePassword(
    userId: string,
    input: ChangePasswordRequest,
    ip?: string | null,
  ): Promise<SessionResult>;
  validateInvite(token: string): Promise<{ valid: boolean; email: string | null }>;
  acceptInvite(input: AcceptInviteRequest, ip?: string | null): Promise<SessionResult>;
  /**
   * Self-service password reset — step 1 (§6.1, §14). Issues a single-use,
   * short-lived tokenized link for a user-kind account and emails it. Always
   * resolves the same way whether or not the email matches an account: no user
   * enumeration.
   */
  requestPasswordReset(input: PasswordResetRequest, ip?: string | null): Promise<void>;
  /**
   * Self-service password reset — step 2 (§6.1, §14). Validates and consumes the
   * token, sets the new password (enforcing the §6.1 policy) and kills all of the
   * user's sessions. A no-2FA account is then signed straight in on a fresh
   * session (no redundant prompt, #268); a 2FA-enabled account instead lands a
   * pending challenge and NO session — a mailbox alone must not defeat the second
   * factor. Rejects a used/expired/unknown token.
   */
  completePasswordReset(input: PasswordResetComplete, ip?: string | null): Promise<LoginResult>;
  /**
   * Public self-serve registration (§4, §6.12). Reads the stored registration
   * mode and rejects with 403 `REGISTRATION_CLOSED` unless the mode permits
   * self-registration. V1 runs `closed`, so this always rejects; it exists as
   * enforcement plumbing so activating a self-serve mode post-v1 is a switch.
   */
  register(input: RegisterRequest, ip?: string | null): Promise<SessionResult>;
  /**
   * Verify the PIN for the current session, renewing its 30-day window on
   * success (§6.1). {@link PIN_FALLBACK_THRESHOLD} wrong PINs in a row destroy
   * the session and throw `PIN_FALLBACK_LOGIN`, forcing a full login.
   */
  verifyPin(input: VerifyPinInput): Promise<UserRow>;
  /**
   * Verify the PIN for a **bearer** principal (personal API key / OAuth token,
   * #361) — the app-lock "Use my BetterTrack PIN". Reuses the EXACT same
   * `pin_hash` + argon2id verify as the session {@link verifyPin} (one PIN, both
   * clients — no separate mobile PIN), but has no session to renew or destroy, so
   * it protects the 4-digit secret with a per-account progressive brute-force
   * throttle instead: a wrong PIN is `401 INVALID_PIN`, a cooling-down account is
   * `429`, and `PIN_NOT_ENABLED` when no web PIN is set. Never logs the PIN.
   */
  verifyPinForToken(input: { userId: string; pin: string; ip?: string | null }): Promise<void>;
  /** Enable the PIN or change it to a new value (§6.1). */
  setPin(userId: string, pin: string, ip?: string | null): Promise<UserRow>;
  /** Turn the PIN gate off (§6.1). */
  disablePin(userId: string, ip?: string | null): Promise<UserRow>;
  /**
   * Set the AFK auto-lock idle timeout in minutes; `null` turns it off (§6.1,
   * §13.2 V2-P2). This is a per-user UI preference only — it never touches the
   * session, whose 30-day lifetime is unchanged.
   */
  setPinLockIdleMinutes(
    userId: string,
    minutes: number | null,
    ip?: string | null,
  ): Promise<UserRow>;
  /**
   * The caller's own current session timestamps (§6.11 Security) — sign-in
   * instant, last renewal, and the derived 30-day expiry. Read-only: it reuses
   * the existing `get()` and never touches the TTL. Null when the session is
   * already gone.
   */
  getSessionInfo(sessionId: string): Promise<SessionInfoResponse | null>;
  /**
   * Upgrade the caller's CURRENT session to persistent — the OAuth-login "stay
   * signed in — your PIN protects this" choice (V4-P2b, §399 §A). PIN-gated:
   * only an account WITH a PIN may persist an OAuth-flow session (a PIN-less one
   * stays ephemeral, so a Custom-Tab browser never silently retains it),
   * throwing `PIN_NOT_ENABLED` otherwise. No-op-false when the session is gone.
   */
  persistCurrentSession(userId: string, sessionId: string): Promise<void>;
  /**
   * The caller's own active sessions for Settings → Security (V3-P11a, §6.11):
   * device label, created/last-seen, and a current-session marker. Only ever the
   * user's own sessions — `userId` comes from the session cookie.
   */
  listSessions(userId: string, currentSessionId: string | null): Promise<SessionSummary[]>;
  /**
   * Revoke one of the caller's sessions by its opaque handle (V3-P11a). That
   * session's next request is rejected as unauthenticated. `wasCurrent` is true
   * when the handle is the caller's own session, so the route can clear the
   * cookie for a clean logout. `revoked` is false when no such session exists.
   */
  revokeSession(
    userId: string,
    publicId: string,
    currentSessionId: string | null,
  ): Promise<{ revoked: boolean; wasCurrent: boolean }>;
  /**
   * Revoke every session of the caller EXCEPT the current one (V3-P11a) —
   * "log out all other devices". Returns how many were revoked. The caller stays
   * logged in on `currentSessionId`.
   */
  revokeOtherSessions(userId: string, currentSessionId: string | null): Promise<number>;
}

// Self-service reset links are short-lived (§6.1, §14): valid for one hour.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// The login 2FA challenge window (§6.1, §13.2 V2-P5): the pending state — and any
// emailed code minted under it — live at most this long before the user must
// re-enter their password. Tight enough to bound a stolen pending token, long
// enough to receive an email code and type it.
const PENDING_2FA_TTL_SEC = 10 * 60;
const EMAIL_CODE_TTL_MINUTES = 10;

const pendingKey = (token: string) => `pending2fa:${token}`;
const emailCodeKey = (token: string) => `2fa_email_code:${token}`;

/** The Redis-side pending-2FA state — never a session, so no route honours it. */
interface Pending2faState {
  userId: string;
  /** A pre-login session id to rotate out on successful verify, if any. */
  priorSessionId?: string;
  /**
   * Persistence intent computed at the password step (V4-P2b, §399 §A) and
   * carried here because a 2FA login mints its session only on verify. Absent
   * for a reset-originated challenge → treated as persistent (today's behavior).
   */
  persistent?: boolean;
}

/** Single generic failure for every login rejection — no user enumeration (§6.1). */
const invalidCredentials = () =>
  unauthorized('Invalid email/username or password.', 'INVALID_CREDENTIALS');

/**
 * A pending 2FA challenge that no longer exists (expired, already consumed, or a
 * forged token). Distinct code so the SPA can bounce the user back to the
 * password step. The pending token already implies a correct password, so this
 * leaks no account-existence signal.
 */
const pendingInvalid = () =>
  unauthorized(
    'Your verification session has expired. Please sign in again.',
    'TWO_FACTOR_PENDING_INVALID',
  );

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const {
    config,
    redis,
    userRepo,
    inviteRepo,
    passwordResetRepo,
    portfolioRepo,
    sessions,
    audit,
    passwordHasher,
    email,
    appSettings,
    twoFactor,
  } = deps;
  // Per-account failed-login throttle (§6.1, §10): ~10 failures → a short
  // cooldown, escalating on repeat batches and decaying after a quiet period.
  // Tracked independently of the per-IP counter the HTTP middleware keeps.
  const accountThrottle = createProgressiveLimiter(
    redis,
    LOGIN_ACCOUNT_NAMESPACE,
    config.rateLimits.loginAccount,
  );
  // Per-account wrong-second-factor throttle (§6.1, §10): a correct password that
  // lands on the 2FA step still gates code brute-forcing per account, on the same
  // escalation ladder as failed passwords and independent of the per-IP limiter.
  const twoFactorThrottle = createProgressiveLimiter(
    redis,
    TWO_FACTOR_ACCOUNT_NAMESPACE,
    config.rateLimits.loginAccount,
  );
  // Per-account brute-force throttle for bearer PIN verification (#361). A bearer
  // has no session to drop after N wrong PINs (the session gate's defence), so a
  // 4-digit PIN is protected here on the same escalation ladder as failed
  // passwords, keyed per account and independent of the per-IP HTTP limiter.
  const pinTokenThrottle = createProgressiveLimiter(
    redis,
    PIN_TOKEN_ACCOUNT_NAMESPACE,
    config.rateLimits.loginAccount,
  );

  /** Load and parse a pending-2FA state; null when missing/expired/corrupt. */
  async function loadPending(token: string): Promise<Pending2faState | null> {
    const raw = await redis.get(pendingKey(token));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Pending2faState;
    } catch {
      await redis.del(pendingKey(token));
      return null;
    }
  }

  /**
   * Match `code` against the emailed login code for this pending challenge,
   * consuming it single-use on success. Only the hash is stored (§6.1). A
   * non-match leaves the stored code intact so a wrong guess doesn't burn it.
   */
  async function consumeEmailCode(token: string, code: string): Promise<boolean> {
    const stored = await redis.get(emailCodeKey(token));
    if (!stored) return false;
    if (hashToken(code.trim()) !== stored) return false;
    await redis.del(emailCodeKey(token));
    return true;
  }

  // Computed once, lazily — verified against on unknown-user logins so response
  // timing doesn't reveal whether an account exists.
  let dummyHashPromise: Promise<string> | null = null;
  const getDummyHash = () => {
    dummyHashPromise ??= passwordHasher.hash(randomBytes(16).toString('hex'));
    return dummyHashPromise;
  };

  /**
   * Mint a fresh 6-digit login code for this pending challenge, store only its
   * hash (§6.1), and best-effort email it (§6.11: logged to `email_log`,
   * `suppressed` with no SMTP, never throws). Shared by the up-front send for an
   * email-only account and the on-request `requestTwoFactorEmailCode` endpoint.
   */
  async function issueEmailLoginCode(
    pendingToken: string,
    user: UserRow,
    ip?: string | null,
  ): Promise<void> {
    // Admin-login email codes go to the separately-set 2FA email, NEVER the
    // account email (§6.12, #400); a user's go to the account email exactly as
    // before. If an admin somehow has the email method armed without a 2FA email
    // set (cannot happen via the enroll flow, which sets it on confirm), there is
    // nothing to deliver to — skip silently, leaving TOTP/recovery to carry the
    // challenge, and never mint a code that can't arrive.
    const to = user.role === 'admin' ? user.twoFactorEmail : user.email;
    if (!to) return;
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await redis.set(emailCodeKey(pendingToken), hashToken(code), 'EX', EMAIL_CODE_TTL_MINUTES * 60);
    await audit.record({
      actorId: user.id,
      action: AuditAction.TwoFactorEmailCodeSent,
      targetType: 'user',
      targetId: user.id,
      ip,
    });
    await email.sendTwoFactorCode({
      to,
      userId: user.id,
      code,
      expiresInMinutes: EMAIL_CODE_TTL_MINUTES,
      audit: { actorId: user.id, targetType: 'user', targetId: user.id, ip },
    });
  }

  /**
   * Issue a pending 2FA challenge for a user whose identity has already been
   * proven by a first factor (a correct password on login, a valid reset token).
   * Mints a single-purpose pending token (Redis), audits the issue, offers only
   * the channels the account enabled, and — for an email-only account — sends the
   * code up front so there is nothing to click. `priorSessionId`, if given, is
   * carried so it can be rotated out on success. The session is withheld until a
   * second factor verifies (§6.1, §13.2 V2-P5).
   */
  async function issueTwoFactorChallenge(
    user: UserRow,
    ip?: string | null,
    priorSessionId?: string,
    persistent?: boolean,
  ): Promise<TwoFactorChallenge> {
    const methods = await twoFactor.getMethods(user.id);
    const pendingToken = randomBytes(32).toString('base64url');
    const state: Pending2faState = { userId: user.id };
    if (priorSessionId) state.priorSessionId = priorSessionId;
    // Carry the password-step persistence choice to the verify step (V4-P2b).
    if (persistent !== undefined) state.persistent = persistent;
    await redis.set(pendingKey(pendingToken), JSON.stringify(state), 'EX', PENDING_2FA_TTL_SEC);
    await audit.record({
      actorId: user.id,
      action: AuditAction.TwoFactorChallengeIssued,
      targetType: 'user',
      targetId: user.id,
      ip,
    });
    const channels: TwoFactorChannel[] = [];
    if (methods.totp) channels.push('totp');
    if (methods.email) channels.push('email');
    channels.push('recovery');
    if (methods.email && !methods.totp) {
      await issueEmailLoginCode(pendingToken, user, ip);
    }
    return { pendingToken, channels };
  }

  const clearFailures = (userId: string) => clearLoginThrottle(redis, userId);
  // Correct-password clear that deliberately spares the second-factor throttle
  // so its §10 escalation lock accumulates across re-logins (see
  // clearPasswordThrottle). Used at the password step; the full clear above runs
  // only once a second factor has actually verified.
  const clearPasswordFailures = (userId: string) => clearPasswordThrottle(redis, userId);

  return {
    async login({ identifier, password, ip, currentSessionId, staySignedIn, oauthLogin }) {
      const user = await userRepo.findByIdentifier(identifier);

      if (!user) {
        await passwordHasher.verify(await getDummyHash(), password);
        await audit.record({ action: AuditAction.LoginFail, ip, meta: { reason: 'unknown_user' } });
        throw invalidCredentials();
      }

      // Account already cooling down from prior failures: reject before touching
      // the password hash. Stays a generic INVALID_CREDENTIALS (no retryAfter) so
      // the cooldown never leaks that the account exists (§6.1); the per-IP
      // limiter is what surfaces a retryAfter to the client.
      if ((await accountThrottle.peek(user.id)) > 0) {
        await audit.record({
          action: AuditAction.LoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'locked' },
        });
        throw invalidCredentials();
      }

      const passwordOk = await passwordHasher.verify(user.passwordHash, password);
      if (!passwordOk) {
        // Count the failure; the attempt that overflows the allowance arms (or
        // escalates) the cooldown for subsequent attempts.
        const decision = await accountThrottle.consume(user.id);
        await audit.record({
          action: AuditAction.LoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: decision.allowed ? 'bad_password' : 'locked' },
        });
        throw invalidCredentials();
      }

      if (user.status !== 'active') {
        // The password is already verified correct at this point, so revealing
        // the suspended status here leaks nothing to an attacker guessing
        // passwords (wrong-password/unknown-user still return the generic
        // INVALID_CREDENTIALS above). Owner-authorized 2026-06-16, §16.
        await audit.record({
          action: AuditAction.LoginFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { reason: 'disabled' },
        });
        throw accountDisabled();
      }

      // The password is correct — clear the password-failure throttle now,
      // whether or not a second factor still stands between the caller and a
      // session. Crucially this does NOT clear the second-factor throttle: a
      // correct password is precisely what a 2FA brute-forcer holds, so wiping
      // the `two_factor_account` counter on every re-login would let them reset
      // the account lock between guesses (§10). That throttle is cleared only
      // once a second factor verifies (see verifyTwoFactor).
      await clearPasswordFailures(user.id);

      // Persistence decision (V4-P2b, §399 §A). "Stay signed in" (default true)
      // asks for a persistent session; an OAuth-flow login on a PIN-less account
      // is FORCED ephemeral regardless — a Custom-Tab browser must not silently
      // keep a persistent web session that auto-re-logs-in after app logout. An
      // account WITH a PIN may still persist (the PIN gates access). This is the
      // authoritative server-side enforcement; the SPA hides the checkbox to match.
      const wantsPersist = staySignedIn ?? true;
      const persistent = wantsPersist && !((oauthLogin ?? false) && !user.pinEnabled);

      // 2FA gate (§6.1, §13.2 V2-P5): with any 2FA method on, do NOT mint a
      // session yet. Issue a short-lived, single-purpose pending challenge (Redis)
      // that only the verify / email-code endpoints accept; the session is
      // withheld until a second factor verifies. The prior session id (if any) is
      // carried so it can be rotated out on success, not destroyed on an abandoned
      // challenge. The persistence choice rides along to the verify step.
      if (await twoFactor.isEnabled(user.id)) {
        const challenge = await issueTwoFactorChallenge(
          user,
          ip,
          currentSessionId ?? undefined,
          persistent,
        );
        return { status: 'two_factor_required', challenge };
      }

      // Session rotation: drop any pre-login session before minting a new id.
      if (currentSessionId) await sessions.destroy(currentSessionId);
      const sessionId = await sessions.create(user.id, persistent);

      const now = new Date();
      await userRepo.setLastLogin(user.id, now);
      await audit.record({
        actorId: user.id,
        action: AuditAction.LoginSuccess,
        targetType: 'user',
        targetId: user.id,
        ip,
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

      return {
        status: 'authenticated',
        user: { ...user, lastLoginAt: now },
        sessionId,
        persistent,
      };
    },

    async verifyTwoFactor({ pendingToken, code, recoveryCode, ip }) {
      const state = await loadPending(pendingToken);
      if (!state) throw pendingInvalid();
      const { userId } = state;

      // Already cooling down from prior wrong factors: reject before verifying so
      // blocked retries — even a correct code — cannot brute-force through the
      // cooldown (§10). Mirrors the password limiter's peek-before-check.
      const cooling = await twoFactorThrottle.peek(userId);
      if (cooling > 0) {
        throw tooManyRequests(cooling, 'Too many incorrect codes. Please wait and try again.');
      }

      const user = await userRepo.findById(userId);
      if (!user || user.status !== 'active') {
        // Account vanished/suspended mid-challenge: drop the pending state.
        await redis.del(pendingKey(pendingToken), emailCodeKey(pendingToken));
        throw pendingInvalid();
      }

      // 2FA turned off between challenge issue and verify: every factor now
      // fails (no secret, no recovery codes), which would strand the caller on
      // wrong-code errors until the token lapses. Bounce with PENDING_INVALID so
      // the client falls back to a plain re-login (which will mint a session).
      if (!(await twoFactor.isEnabled(userId))) {
        await redis.del(pendingKey(pendingToken), emailCodeKey(pendingToken));
        throw pendingInvalid();
      }

      // Resolve the factor. A recovery code is consumed only on the recovery
      // branch; a 6-digit `code` is tried as an emailed code first (single-use)
      // then as a TOTP — the two are disjoint, so order only affects which state
      // a match burns.
      let ok = false;
      if (recoveryCode) {
        ok = await twoFactor.consumeRecoveryCode(userId, recoveryCode);
      } else if (code) {
        ok =
          (await consumeEmailCode(pendingToken, code)) ||
          (await twoFactor.verifyTotpCode(userId, code));
      }

      if (!ok) {
        const decision = await twoFactorThrottle.consume(userId);
        await audit.record({
          action: AuditAction.TwoFactorVerifyFail,
          targetType: 'user',
          targetId: userId,
          ip,
          meta: { locked: !decision.allowed },
        });
        if (!decision.allowed) {
          throw tooManyRequests(
            decision.retryAfterSec,
            'Too many incorrect codes. Please wait and try again.',
          );
        }
        throw unauthorized('That code is incorrect or has expired.', 'TWO_FACTOR_INVALID_CODE');
      }

      // Verified: burn the pending state + email code, clear the throttles, and
      // mint the real session (rotating out any pre-login id).
      await redis.del(pendingKey(pendingToken), emailCodeKey(pendingToken));
      await twoFactorThrottle.reset(userId);
      await clearFailures(userId);
      if (state.priorSessionId) await sessions.destroy(state.priorSessionId);
      // Honour the persistence choice made at the password step (V4-P2b); a
      // reset-originated challenge carries none → persistent, today's behavior.
      const persistent = state.persistent ?? true;
      const sessionId = await sessions.create(userId, persistent);

      const now = new Date();
      await userRepo.setLastLogin(userId, now);
      await audit.record({
        actorId: userId,
        action: AuditAction.LoginSuccess,
        targetType: 'user',
        targetId: userId,
        ip,
        meta: { via: '2fa' },
      });

      return { user: { ...user, lastLoginAt: now }, sessionId, persistent };
    },

    async requestTwoFactorEmailCode(pendingToken, ip) {
      const state = await loadPending(pendingToken);
      if (!state) throw pendingInvalid();
      const user = await userRepo.findById(state.userId);
      if (!user || user.status !== 'active') {
        await redis.del(pendingKey(pendingToken), emailCodeKey(pendingToken));
        throw pendingInvalid();
      }

      // Email codes are their own opt-in method now (#298): only send when the
      // account has the email method on. A TOTP-only account no longer gets an
      // emailed fallback it never chose. The UI only surfaces this when the
      // challenge lists the `email` channel, so a well-behaved client never lands
      // here otherwise — treat it as a no-op rather than leaking method config.
      const methods = await twoFactor.getMethods(user.id);
      if (!methods.email) return;

      // Fresh 6-digit code each request, overwriting any prior one; only the hash
      // is stored, keyed to this challenge, expiring with the send.
      await issueEmailLoginCode(pendingToken, user, ip);
    },

    async logout(sessionId) {
      await sessions.destroy(sessionId);
    },

    async resolveSession(sessionId, userAgent) {
      const data = await sessions.get(sessionId);
      if (!data) return null;
      const user = await userRepo.findById(data.userId);
      if (!user || user.status !== 'active') {
        // Disabled/deleted out from under a live session → terminate it.
        await sessions.destroy(sessionId);
        return null;
      }
      // Session manager bookkeeping (V3-P11a): stamp last-seen + capture the
      // device on first-seen. Throttled and written to a side key. For a
      // persistent session it never extends the fixed 30-day window (§6.1); for
      // an ephemeral session (V4-P2b) this same throttled write is where the
      // sliding idle window advances. Only when a UA is actually present (i.e.
      // an HTTP request), never on internal resolves.
      if (userAgent !== undefined) {
        await sessions.touchLastSeen(sessionId, userAgent);
      }
      return { user, persistent: isPersistent(data) };
    },

    async changePassword(userId, input, ip) {
      // The target is always THIS session's account (`userId` came from the
      // session cookie), so the outcome never depends on any admin session
      // elsewhere — no context leakage (§6.1, #248 item 6).
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();

      // A forced change after an admin reset: the session was just minted by
      // logging in with the temp password, so it is itself proof of the current
      // credential — don't ask for it again (#248 item 7). A voluntary change
      // from Settings still re-verifies the current password.
      if (!user.mustChangePassword) {
        const currentOk =
          input.currentPassword !== undefined &&
          (await passwordHasher.verify(user.passwordHash, input.currentPassword));
        if (!currentOk) throw unauthorized('Current password is incorrect.', 'INVALID_CREDENTIALS');
      }

      const policy = checkPasswordPolicy(input.newPassword);
      if (!policy.ok) throw badRequest(policy.reason, 'WEAK_PASSWORD');

      const passwordHash = await passwordHasher.hash(input.newPassword);
      await userRepo.updatePassword(user.id, passwordHash, false);

      // Kill every session, then re-establish one for the current device.
      await sessions.destroyAllForUser(user.id);
      const sessionId = await sessions.create(user.id);

      await audit.record({
        actorId: user.id,
        action: AuditAction.PasswordChanged,
        targetType: 'user',
        targetId: user.id,
        ip,
      });

      const updated = await userRepo.findById(user.id);
      return {
        user: updated ?? { ...user, passwordHash, mustChangePassword: false },
        sessionId,
        // A password change re-establishes a normal persistent session (§6.1).
        persistent: true,
      };
    },

    async validateInvite(token) {
      const invite = await inviteRepo.findByTokenHash(hashToken(token));
      if (!invite) return { valid: false, email: null };
      const valid =
        !invite.usedAt && !invite.revokedAt && new Date(invite.expiresAt).getTime() > Date.now();
      return { valid, email: valid ? invite.email : null };
    },

    async acceptInvite(input, ip) {
      const invite = await inviteRepo.findByTokenHash(hashToken(input.token));
      if (
        !invite ||
        invite.usedAt ||
        invite.revokedAt ||
        new Date(invite.expiresAt).getTime() <= Date.now()
      ) {
        throw badRequest('This invite link is invalid or has expired.', 'INVALID_INVITE');
      }

      const policy = checkPasswordPolicy(input.password);
      if (!policy.ok) throw badRequest(policy.reason, 'WEAK_PASSWORD');

      if (await userRepo.findByUsername(input.username)) {
        throw conflict('That username is already taken.', 'USERNAME_TAKEN');
      }
      if (await userRepo.findByEmail(invite.email)) {
        throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
      }

      const passwordHash = await passwordHasher.hash(input.password);
      const user = await userRepo.create({
        email: invite.email,
        username: input.username,
        passwordHash,
        role: 'user',
        status: 'active',
        mustChangePassword: false,
      });

      // Invited accounts are always the user kind (§5.5): provision their one
      // default portfolio up front so the app opens onto a real workspace.
      await portfolioRepo.createDefault(user.id);

      await inviteRepo.markUsed(invite.id, new Date());
      await audit.record({
        actorId: user.id,
        action: AuditAction.UserCreated,
        targetType: 'user',
        targetId: user.id,
        ip,
        meta: { via: 'invite' },
      });
      await audit.record({
        actorId: user.id,
        action: AuditAction.InviteUsed,
        targetType: 'invite',
        targetId: invite.id,
        ip,
      });

      // Best-effort welcome mail, after the account is fully provisioned.
      await email.sendWelcome({
        to: user.email,
        username: user.username,
        audit: { actorId: user.id, targetType: 'user', targetId: user.id, ip },
      });

      const sessionId = await sessions.create(user.id);
      return { user, sessionId, persistent: true };
    },

    async requestPasswordReset({ email: address }, ip) {
      const user = await userRepo.findByEmail(address);
      // Only active, user-kind accounts get a self-service link. Admin recovery
      // is the admin temp-password path (#268); disabled accounts stay closed.
      // Everything below is skipped for a non-match, but the caller always sees
      // the same generic acknowledgement — no user enumeration (§6.1).
      if (user && user.role === 'user' && user.status === 'active') {
        // One outstanding link per account: drop any prior token before issuing.
        await passwordResetRepo.deleteForUser(user.id);
        const { token, tokenHash } = generateToken();
        await passwordResetRepo.create({
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        });
        await audit.record({
          action: AuditAction.PasswordResetRequested,
          targetType: 'user',
          targetId: user.id,
          ip,
        });
        // Best-effort send after the token is committed — a mail failure never
        // throws back (§6.11). The email_log row is written either way (§6.10).
        const resetUrl = `${config.appOrigin}/reset/${token}`;
        await email.sendPasswordReset({
          to: user.email,
          resetUrl,
          audit: { actorId: user.id, targetType: 'user', targetId: user.id, ip },
        });
      }
    },

    async completePasswordReset({ token, newPassword }, ip) {
      const invalid = () =>
        badRequest('This reset link is invalid or has expired.', 'INVALID_RESET');

      const record = await passwordResetRepo.findByTokenHash(hashToken(token));
      if (!record || record.usedAt || new Date(record.expiresAt).getTime() <= Date.now()) {
        throw invalid();
      }

      const user = await userRepo.findById(record.userId);
      // The token was only ever issued to an active user-kind account; re-check
      // in case the account was disabled or its role changed after issue.
      if (!user || user.role !== 'user' || user.status !== 'active') throw invalid();

      const policy = checkPasswordPolicy(newPassword);
      if (!policy.ok) throw badRequest(policy.reason, 'WEAK_PASSWORD');

      const passwordHash = await passwordHasher.hash(newPassword);
      await userRepo.updatePassword(user.id, passwordHash, false);

      // Consume this token and revoke every other outstanding one for the user.
      await passwordResetRepo.markUsed(record.id, new Date());
      await passwordResetRepo.deleteForUser(user.id);

      // A password change kills all sessions (§6.1).
      await sessions.destroyAllForUser(user.id);

      await audit.record({
        actorId: user.id,
        action: AuditAction.PasswordChanged,
        targetType: 'user',
        targetId: user.id,
        ip,
      });
      await audit.record({
        actorId: user.id,
        action: AuditAction.PasswordResetCompleted,
        targetType: 'user',
        targetId: user.id,
        ip,
      });

      // 2FA gate (§6.1): the reset link proves control of the mailbox — exactly
      // the factor an authenticator app is meant to survive. With any 2FA method
      // on, withhold the session and require a second factor, mirroring login;
      // otherwise the reset lands the user signed in with no redundant prompt.
      if (await twoFactor.isEnabled(user.id)) {
        const challenge = await issueTwoFactorChallenge(user, ip);
        return { status: 'two_factor_required', challenge };
      }

      const sessionId = await sessions.create(user.id);
      const updated = await userRepo.findById(user.id);
      return {
        status: 'authenticated',
        user: updated ?? { ...user, passwordHash, mustChangePassword: false },
        sessionId,
        // A completed reset lands a normal persistent session (§6.1, #268).
        persistent: true,
      };
    },

    async register(_input, _ip) {
      // Enforcement plumbing (§4, §6.12): read the stored registration mode.
      // V1 runs `closed`, so this always rejects with 403 `REGISTRATION_CLOSED`.
      await appSettings.assertSelfRegistrationAllowed();
      // Unreachable in V1 — the guard rejects every stored mode. The concrete
      // account-creation path lands when a self-serve mode is activated post-v1.
      throw forbidden('Self-serve registration is not available.', 'REGISTRATION_CLOSED');
    },

    async verifyPin({ userId, sessionId, pin, ip }) {
      const user = await userRepo.findById(userId);
      // The session guard already resolved this user, but re-check the account.
      if (!user || user.status !== 'active') {
        await sessions.destroy(sessionId);
        throw unauthorized();
      }
      if (!user.pinEnabled || !user.pinHash) {
        // No PIN to verify — nothing to gate on; the client shouldn't be here.
        throw badRequest('No PIN is set for this account.', 'PIN_NOT_ENABLED');
      }

      const ok = await passwordHasher.verify(user.pinHash, pin);
      if (!ok) {
        const consecutive = await redis.incr(pinFailCountKey(user.id));
        // Match the session TTL so the tally never outlives the session itself.
        if (consecutive === 1) {
          await redis.expire(pinFailCountKey(user.id), Math.floor(config.cookie.maxAgeMs / 1000));
        }
        await audit.record({
          action: AuditAction.PinVerifyFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { consecutive },
        });
        if (consecutive >= PIN_FALLBACK_THRESHOLD) {
          // Too many wrong PINs: drop the session so the only way back in is a
          // full password login (§6.1). Clear the tally with the session.
          await redis.del(pinFailCountKey(user.id));
          await sessions.destroy(sessionId);
          throw unauthorized(
            'Too many incorrect PIN attempts. Please sign in with your password.',
            'PIN_FALLBACK_LOGIN',
          );
        }
        throw unauthorized('Incorrect PIN.', 'INVALID_PIN');
      }

      // Correct PIN: clear the tally and renew the full 30-day window (§6.1).
      await redis.del(pinFailCountKey(user.id));
      await sessions.renew(sessionId);
      await audit.record({
        actorId: user.id,
        action: AuditAction.PinVerified,
        targetType: 'user',
        targetId: user.id,
        ip,
      });
      return user;
    },

    async verifyPinForToken({ userId, pin, ip }) {
      const user = await userRepo.findById(userId);
      if (!user || user.status !== 'active') throw unauthorized();
      if (!user.pinEnabled || !user.pinHash) {
        // The app hides "Use my BetterTrack PIN" until a web PIN exists; still,
        // never treat a not-set PIN as a match.
        throw badRequest('No PIN is set for this account.', 'PIN_NOT_ENABLED');
      }
      // Reject an already-cooling account before the (deliberately slow) hash
      // verify, mirroring the password limiter's peek-before-check.
      const cooling = await pinTokenThrottle.peek(user.id);
      if (cooling > 0) throw tooManyRequests(cooling);

      // The SAME argon2id verify against the SAME `pin_hash` the session PIN gate
      // and web login use — one PIN, both clients. `pin` is never logged.
      const ok = await passwordHasher.verify(user.pinHash, pin);
      if (!ok) {
        const decision = await pinTokenThrottle.consume(user.id);
        await audit.record({
          action: AuditAction.PinVerifyFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { via: 'token' },
        });
        if (!decision.allowed) throw tooManyRequests(decision.retryAfterSec);
        throw unauthorized('Incorrect PIN.', 'INVALID_PIN');
      }

      // Correct PIN: clear the brute-force tally. No session to renew.
      await pinTokenThrottle.reset(user.id);
      await audit.record({
        actorId: user.id,
        action: AuditAction.PinVerified,
        targetType: 'user',
        targetId: user.id,
        ip,
        meta: { via: 'token' },
      });
    },

    async setPin(userId, pin, ip) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      // PIN is hashed with the same argon2id hasher as passwords (§10), so it
      // is never recoverable and verification is uniform across both secrets.
      const pinHash = await passwordHasher.hash(pin);
      await userRepo.setPin(user.id, pinHash);
      await redis.del(pinFailCountKey(user.id));
      await audit.record({
        actorId: user.id,
        action: AuditAction.PinEnabled,
        targetType: 'user',
        targetId: user.id,
        ip,
      });
      const updated = await userRepo.findById(user.id);
      return updated ?? { ...user, pinHash, pinEnabled: true };
    },

    async disablePin(userId, ip) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      await userRepo.clearPin(user.id);
      await redis.del(pinFailCountKey(user.id));
      await audit.record({
        actorId: user.id,
        action: AuditAction.PinDisabled,
        targetType: 'user',
        targetId: user.id,
        ip,
      });
      const updated = await userRepo.findById(user.id);
      return updated ?? { ...user, pinHash: null, pinEnabled: false };
    },

    async setPinLockIdleMinutes(userId, minutes, ip) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      await userRepo.setPinLockIdleMinutes(user.id, minutes);
      await audit.record({
        actorId: user.id,
        action: AuditAction.PinLockIdleChanged,
        targetType: 'user',
        targetId: user.id,
        ip,
        meta: { idleMinutes: minutes },
      });
      const updated = await userRepo.findById(user.id);
      return updated ?? { ...user, pinLockIdleMinutes: minutes };
    },

    async getSessionInfo(sessionId) {
      const session = await sessions.get(sessionId);
      if (!session) return null;
      return {
        signedInAt: new Date(session.createdAt).toISOString(),
        renewedAt: new Date(session.renewedAt).toISOString(),
        persistent: isPersistent(session),
        // Persistent → the fixed 30-day window from the last login / PIN verify
        // (§6.1). Ephemeral → the hard cap from creation, an upper bound only —
        // reporting the flat 30-day window here would overstate an ephemeral
        // session's lifetime by ~60× (V4-P2b, §399 §A).
        expiresAt: new Date(sessions.expiresAtFor(session)).toISOString(),
      };
    },

    async persistCurrentSession(userId, sessionId) {
      const user = await userRepo.findById(userId);
      if (!user || user.status !== 'active') throw unauthorized();
      // PIN gate (V4-P2b, §399 §A): a session may be promoted to persistent only
      // when the account has a PIN — that PIN is precisely what makes keeping a
      // browser session acceptable in the OAuth flow. A PIN-less account can
      // therefore never turn its forced-ephemeral OAuth session persistent.
      // Note: this promotes the caller's OWN current session whatever minted it
      // (not OAuth-specific) — equivalent to having ticked "stay signed in", so
      // no privilege is gained beyond that PIN-gated choice.
      if (!user.pinEnabled || !user.pinHash) {
        throw badRequest('A PIN is required to stay signed in.', 'PIN_NOT_ENABLED');
      }
      await sessions.setPersistent(sessionId, true);
    },

    async listSessions(userId, currentSessionId) {
      const entries = await sessions.listForUser(userId, currentSessionId);
      return entries.map((entry) => ({
        id: entry.id,
        device: describeUserAgent(entry.userAgent),
        createdAt: new Date(entry.createdAt).toISOString(),
        lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
        current: entry.current,
        persistent: entry.persistent,
      }));
    },

    async revokeSession(userId, publicId, currentSessionId) {
      const wasCurrent =
        currentSessionId !== null && sha256Base64Url(currentSessionId) === publicId;
      const revoked = await sessions.revokeForUser(userId, publicId);
      return { revoked, wasCurrent };
    },

    async revokeOtherSessions(userId, currentSessionId) {
      return sessions.revokeOthersForUser(userId, currentSessionId);
    },
  };
}
