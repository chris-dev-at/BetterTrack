import { randomBytes, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { Redis } from 'ioredis';

import {
  type AcceptInviteRequest,
  type ChangePasswordRequest,
  type PasswordResetComplete,
  type PasswordResetRequest,
  type RegisterRequest,
  type RegistrationMode,
  type RememberedDeviceResponse,
  type RememberedDeviceSummary,
  type SessionInfoResponse,
  type SessionSummary,
  type TwoFactorChannel,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { InviteRepository } from '../../data/repositories/inviteRepository';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { PasswordResetTokenRepository } from '../../data/repositories/passwordResetTokenRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { RegistrationRequestRepository } from '../../data/repositories/registrationRequestRepository';
import type { RegistrationTokenRepository } from '../../data/repositories/registrationTokenRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import type { UserRow } from '../../data/schema';
import { accountDisabled, badRequest, conflict, tooManyRequests, unauthorized } from '../../errors';
import type { EventBus, RealtimePrincipalInvalidatedEvent } from '../../events';
import type { Logger } from '../../logger';
import { applyAccountDefaultsAtRegistration } from '../account/accountDefaults';
import type { AppSettingsService } from '../appSettings/appSettingsService';
import { AuditAction, type AuditService } from '../audit/auditService';
import { generateToken, hashToken, sha256Base64Url } from '../crypto/tokens';
import type { EmailService } from '../email/emailService';
import type { PasswordHasher } from '../password/passwordHasher';
import { checkPasswordPolicy } from '../password/passwordPolicy';
import { createProgressiveLimiter } from '../security/progressiveLimiter';
import { describeUserAgent } from '../sessions/deviceLabel';
import {
  authenticationMethodOf,
  isPersistent,
  mfaAssuranceOf,
  type SecurityMutationContext,
  type SessionAuthenticationMethod,
  type SessionMfaAssurance,
  type SessionMfaMethod,
  type SessionService,
} from '../sessions/sessionService';
import {
  clearLoginThrottle,
  clearPasswordThrottle,
  isRememberableUser,
  LOGIN_ACCOUNT_NAMESPACE,
  pinFailCountKey,
  PIN_FALLBACK_THRESHOLD,
  PIN_QUICK_AUTH_WINDOW_SECONDS,
  pinQuickAuthMarkerKey,
  PIN_TOKEN_ACCOUNT_NAMESPACE,
  TWO_FACTOR_ACCOUNT_NAMESPACE,
  type RememberableUser,
} from './loginThrottle';
import { createRememberedDeviceStore } from './rememberedDeviceStore';
import type { TwoFactorService } from './twoFactorService';

export interface AuthServiceDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  inviteRepo: InviteRepository;
  passwordResetRepo: PasswordResetTokenRepository;
  /** Registration access tokens for the `invite_token` mode (§13.4 V4-P4a). */
  registrationTokenRepo: RegistrationTokenRepository;
  /** Approval-queue applications for the `approval` mode (§13.4 V4-P4a). */
  registrationRequestRepo: RegistrationRequestRepository;
  portfolioRepo: PortfolioRepository;
  /** Per-(channel, type) override seeding for the V4-P0d account-defaults matrix. */
  notificationRepo: Pick<NotificationRepository, 'upsertChannelConfig'>;
  sessions: SessionService;
  /** Best-effort lifecycle fan-out to disconnect already-open session sockets. */
  events?: Pick<EventBus, 'publish'>;
  logger?: Pick<Logger, 'warn'>;
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

export interface PasswordChangeResult {
  user: UserRow;
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

/**
 * Result of a self-serve registration (§13.4 V4-P4a). The `open` and
 * `invite_token` modes create the account and sign it in (`authenticated`); the
 * `approval` mode parks a pending application and mints NO session (`pending`).
 */
export type RegisterResult = ({ status: 'authenticated' } & SessionResult) | { status: 'pending' };

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

export interface QuickAuthInput {
  /** The opaque device id from the signed `bt_rdid` cookie; null when absent. */
  deviceId: string | null;
  /** The PIN to verify; omitted = a probe (auto-pass only if the window is open). */
  pin?: string;
  ip?: string | null;
}

/**
 * Outcome of an OAuth PIN quick re-auth (§399 §B). `authenticated` carries a
 * freshly-minted ephemeral session (the route sets its cookie); `pin_required`
 * means the probe found a closed quick-auth window, so the client must collect
 * the PIN. Every other case (unknown device, disabled/PIN-less user, wrong PIN,
 * cooldown) throws.
 */
export type QuickAuthResult =
  | { status: 'authenticated'; user: UserRow; sessionId: string }
  | { status: 'pin_required' };

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
   * persistence marker (V4-P2b) for explicit renewal/security-rotation handlers.
   */
  resolveSession(
    sessionId: string,
    userAgent?: string | null,
  ): Promise<{
    user: UserRow;
    persistent: boolean;
    securityGeneration: number;
    authenticationMethod: SessionAuthenticationMethod | null;
    mfaAssurance: SessionMfaAssurance | null;
  } | null>;
  changePassword(
    userId: string,
    input: ChangePasswordRequest,
    security: SecurityMutationContext,
    ip?: string | null,
  ): Promise<PasswordChangeResult>;
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
   * Public self-serve registration (§4, §6.12, §13.4 V4-P4a). Reads the stored
   * registration mode and gates on it: `closed` → 403 `REGISTRATION_CLOSED`;
   * `invite_token` → a valid token is required; `approval` → a pending
   * application (no session); `open` → account created and signed straight in.
   */
  register(input: RegisterRequest, ip?: string | null): Promise<RegisterResult>;
  /**
   * The active registration mode, for the PUBLIC discovery endpoint (§13.4
   * V4-P4a). Leaks only the mode so the login / register surfaces + landing page
   * can reflect it; carries nothing else.
   */
  getRegistrationInfo(): Promise<{ mode: RegistrationMode; googleEnabled: boolean }>;
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
  /**
   * OAuth PIN quick re-auth (§16, owner spec #399 §B, V4-P2b). Resolves the
   * remembered device (the signed `bt_rdid` cookie's opaque id → a user in Redis)
   * and, on that binding alone, signs the user in from the PIN — no password. A
   * `pin`-less call is a probe: it auto-passes when the ~15-min quick-auth window
   * from a recent PIN entry is still open, else returns `pin_required`. A real
   * PIN check rides the SAME per-account progressive limiter as
   * {@link verifyPinForToken}, so hammering it locks out on that schedule. The
   * minted session is always EPHEMERAL. Throws `REMEMBER_DEVICE_UNKNOWN` for an
   * absent/forgotten device or a bound account that is gone / PIN-less.
   */
  quickAuth(input: QuickAuthInput): Promise<QuickAuthResult>;
  /**
   * Remember this device for OAuth PIN quick re-auth (§399 §B). Mints an opaque
   * device id bound to the user in Redis for the lifetime of the signed browser
   * cookie and adds it to the user's deletion index. Returns the id plus the
   * identity the client stores (username + avatar + user id, never a token).
   * PIN users only — throws `PIN_NOT_ENABLED` for a PIN-less account.
   */
  rememberDevice(
    userId: string,
    ip?: string | null,
  ): Promise<{ deviceId: string; record: RememberedDeviceResponse }>;
  /**
   * Forget a remembered device — "Another account" / explicit forget (§399 §B).
   * Clears its Redis binding and quick-auth window. Callable with no live session:
   * it only ever affects the device that presents the cookie. No-op when the
   * device id is null/unknown.
   */
  forgetDevice(deviceId: string | null, ip?: string | null): Promise<void>;
  /**
   * List the caller's live remembered-device bindings as non-secret display
   * records. Ownership is resolved inside the Redis store from this user id;
   * the raw cookie ids never leave that boundary.
   */
  listRememberedDevices(userId: string): Promise<RememberedDeviceSummary[]>;
  /**
   * Idempotently revoke one caller-owned binding by its stable public handle.
   * Unknown, expired, foreign and already-revoked handles are indistinguishable
   * no-op successes at HTTP level.
   */
  revokeRememberedDevice(userId: string, handle: string, ip?: string | null): Promise<void>;
  /** Revoke and individually audit every live remembered binding of the caller. */
  revokeAllRememberedDevices(userId: string, ip?: string | null): Promise<void>;
  /**
   * Record that first-run setup is done for this account — finished or dismissed
   * (§6.12). Set-once and idempotent: replaying it never moves the stored
   * timestamp, so a double-clicked "Do this later" is harmless.
   */
  completeFirstRun(userId: string): Promise<UserRow>;
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

// Known-account requests do durable token + audit writes that an unknown address
// cannot safely mirror. Both paths therefore wait on the same deadline, masking
// that bounded work while preserving the generic acknowledgement.
export const PASSWORD_RESET_RESPONSE_FLOOR_MS = 250;

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
  /** Durable authority generation that established the first-factor proof. */
  securityGeneration: number;
  /** First-factor path that established this pending challenge. */
  authenticationMethod?: SessionAuthenticationMethod;
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
    registrationTokenRepo,
    registrationRequestRepo,
    portfolioRepo,
    notificationRepo,
    sessions,
    events,
    logger,
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
  const rememberedDevices = createRememberedDeviceStore(redis);

  async function clearRememberedDeviceState(userId: string, deviceId: string): Promise<void> {
    await rememberedDevices.clearForUser(userId, deviceId);
  }

  /**
   * Fence a remembered-device Redis write against account deletion.
   *
   * Deletion sweeps once before and once after the durable user-row removal.
   * Re-reading after this write closes the remaining race: either the
   * post-delete sweep runs after the write, or this read observes the missing /
   * inactive account and removes the write itself.
   */
  async function revalidateRememberedDeviceUser(
    userId: string,
    deviceId: string,
  ): Promise<RememberableUser | undefined> {
    try {
      const user = await userRepo.findById(userId);
      if (isRememberableUser(user)) return user;
    } catch (err) {
      await clearRememberedDeviceState(userId, deviceId);
      throw err;
    }
    await clearRememberedDeviceState(userId, deviceId);
    return undefined;
  }

  async function publishSessionInvalidation(
    event: Omit<RealtimePrincipalInvalidatedEvent, 'type' | 'kind' | 'occurredAt'>,
  ): Promise<void> {
    if (!events) return;
    try {
      await events.publish({
        type: 'realtime.principal.invalidated',
        kind: 'session',
        ...event,
        occurredAt: new Date().toISOString(),
      });
    } catch (err) {
      // Session deletion already succeeded. The gateway's periodic principal
      // revalidation is the fail-closed backstop for a missed pub/sub signal.
      logger?.warn({ err, userId: event.userId }, 'session realtime invalidation publish failed');
    }
  }

  const invalidateSession = (userId: string, sessionId: string): Promise<void> =>
    publishSessionInvalidation({
      userId,
      credentialId: sha256Base64Url(sessionId),
      exceptCredentialId: null,
    });

  const invalidateAllSessions = (
    userId: string,
    exceptSessionId: string | null = null,
  ): Promise<void> =>
    publishSessionInvalidation({
      userId,
      credentialId: null,
      exceptCredentialId: exceptSessionId ? sha256Base64Url(exceptSessionId) : null,
    });

  /**
   * Destroy a session and notify the socket owner that actually held it. Login
   * rotation can intentionally switch accounts, so the caller being signed in
   * is not necessarily the owner of the cookie being replaced.
   */
  async function destroySessionAndInvalidate(sessionId: string): Promise<void> {
    const priorSession = await sessions.get(sessionId);
    await sessions.destroy(sessionId);
    if (priorSession) await invalidateSession(priorSession.userId, sessionId);
  }

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
    securityGeneration: number,
    ip?: string | null,
    priorSessionId?: string,
    persistent?: boolean,
    authenticationMethod: SessionAuthenticationMethod = 'password',
  ): Promise<TwoFactorChallenge> {
    const methods = await twoFactor.getMethods(user.id);
    const pendingToken = randomBytes(32).toString('base64url');
    const state: Pending2faState = {
      userId: user.id,
      securityGeneration,
      authenticationMethod,
    };
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
  const destroySessionBestEffort = async (sessionId: string): Promise<void> => {
    try {
      await sessions.destroy(sessionId);
    } catch {
      // Durable generation equality is the revocation boundary. Redis deletion
      // is eager cleanup only and may not turn a committed transition into a 500.
    }
  };
  const destroyAllSessionsBestEffort = async (userId: string): Promise<void> => {
    try {
      await sessions.destroyAllForUser(userId);
    } catch {
      // See destroySessionBestEffort: every surviving cookie is already stale.
    }
  };
  // Correct-password clear that deliberately spares the second-factor throttle
  // so its §10 escalation lock accumulates across re-logins (see
  // clearPasswordThrottle). Used at the password step; the full clear above runs
  // only once a second factor has actually verified.
  const clearPasswordFailures = (userId: string) => clearPasswordThrottle(redis, userId);

  /**
   * Mint a fresh EPHEMERAL session for an OAuth PIN quick re-auth (§399 §B). A
   * Custom-Tab browser must never silently retain a persistent web session, so —
   * exactly like a PIN-less OAuth login — the session is always ephemeral; the
   * remembered device + the PIN, not the cookie, are what bring the user back.
   * Stamps last-login and audits a `quick_auth` login, mirroring the password path.
   */
  async function mintQuickAuthSession(
    user: UserRow,
    ip?: string | null,
  ): Promise<{ sessionId: string; user: UserRow }> {
    const sessionId = await sessions.create(user.id, user.securityGeneration, false, {
      method: 'pin',
    });
    const now = new Date();
    await userRepo.setLastLogin(user.id, now);
    await audit.record({
      actorId: user.id,
      action: AuditAction.LoginSuccess,
      targetType: 'user',
      targetId: user.id,
      ip,
      meta: { via: 'quick_auth' },
    });
    return { sessionId, user: { ...user, lastLoginAt: now } };
  }

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
          user.securityGeneration,
          ip,
          currentSessionId ?? undefined,
          persistent,
        );
        return { status: 'two_factor_required', challenge };
      }

      // Session rotation: drop any pre-login session before minting a new id.
      if (currentSessionId) {
        await destroySessionAndInvalidate(currentSessionId);
      }
      const sessionId = await sessions.create(user.id, user.securityGeneration, persistent, {
        method: 'password',
      });

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

      const user = await userRepo.findById(userId);
      if (
        !user ||
        user.status !== 'active' ||
        !Number.isSafeInteger(state.securityGeneration) ||
        state.securityGeneration !== user.securityGeneration
      ) {
        // The first-factor authority is valid only at the generation that
        // issued this challenge. Password, factor, recovery, and role changes
        // all advance it, so reject before consuming any second factor.
        await redis.del(pendingKey(pendingToken), emailCodeKey(pendingToken));
        throw pendingInvalid();
      }

      // Already cooling down from prior wrong factors: reject before verifying so
      // blocked retries — even a correct code — cannot brute-force through the
      // cooldown (§10). Mirrors the password limiter's peek-before-check.
      const cooling = await twoFactorThrottle.peek(userId);
      if (cooling > 0) {
        throw tooManyRequests(cooling, 'Too many incorrect codes. Please wait and try again.');
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
      let mfaMethod: SessionMfaMethod | null = null;
      if (recoveryCode) {
        ok = await twoFactor.consumeRecoveryCode(userId, recoveryCode);
        if (ok) mfaMethod = 'recovery';
      } else if (code) {
        const emailVerified = await consumeEmailCode(pendingToken, code);
        if (emailVerified) {
          ok = true;
          mfaMethod = 'email';
        } else if (await twoFactor.verifyTotpCode(userId, code)) {
          ok = true;
          mfaMethod = 'totp';
        }
      }

      if (!ok || !mfaMethod) {
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

      // Claim the verified challenge atomically before minting a session. Two
      // requests may both load the same state and validate the same live TOTP;
      // Redis DEL elects exactly one winner, while expiry or a concurrent
      // verifier makes every other request fail closed.
      const claimed = (await redis.del(pendingKey(pendingToken))) === 1;
      if (!claimed) {
        await redis.del(emailCodeKey(pendingToken));
        throw pendingInvalid();
      }
      await redis.del(emailCodeKey(pendingToken));
      await twoFactorThrottle.reset(userId);
      await clearFailures(userId);
      if (state.priorSessionId) {
        await destroySessionAndInvalidate(state.priorSessionId);
      }
      // Honour the persistence choice made at the password step (V4-P2b); a
      // reset-originated challenge carries none → persistent, today's behavior.
      const persistent = state.persistent ?? true;
      const sessionId = await sessions.create(userId, state.securityGeneration, persistent, {
        method:
          authenticationMethodOf({ authenticationMethod: state.authenticationMethod }) ??
          // Legacy pending states carried no provenance marker. They are
          // short-lived, so preserve their pre-deploy password-session behavior
          // across a rolling deploy instead of minting an unusable session.
          'password',
        mfaAssurance: { method: mfaMethod, verifiedAt: Date.now() },
      });

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
      if (
        !user ||
        user.status !== 'active' ||
        !Number.isSafeInteger(state.securityGeneration) ||
        state.securityGeneration !== user.securityGeneration
      ) {
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
      const session = await sessions.get(sessionId);
      await sessions.destroy(sessionId);
      if (session) await invalidateSession(session.userId, sessionId);
    },

    async resolveSession(sessionId, userAgent) {
      const data = await sessions.get(sessionId);
      if (!data) return null;
      const user = await userRepo.findById(data.userId);
      if (!user || user.status !== 'active') {
        // Disabled/deleted out from under a live session → terminate it.
        await destroySessionBestEffort(sessionId);
        await invalidateSession(data.userId, sessionId);
        return null;
      }
      // The equality check happens only after the fresh durable user read. Thus
      // a request that loaded its Redis record before promotion/reset but loads
      // the user afterward sees the new generation and fails closed. Legacy,
      // malformed, and stale records are never normalized in place.
      if (
        !Number.isSafeInteger(data.securityGeneration) ||
        data.securityGeneration < 0 ||
        data.securityGeneration !== user.securityGeneration
      ) {
        await destroySessionBestEffort(sessionId);
        await invalidateSession(data.userId, sessionId);
        return null;
      }
      // Admin session policy (§13.5 V5-P13c): admin sessions carry an ABSOLUTE
      // lifetime from login (`createdAt`) and expire early, independent of the
      // user-app session rules (#418) — enforced here on read, so an expired
      // admin session is rejected and destroyed regardless of any activity that
      // slid the Redis TTL. The lifetime is read per resolve (admin-only path,
      // so no cost to user requests), so a runtime change applies immediately.
      if (user.role === 'admin') {
        const lifetimeMs = (await appSettings.getAdminSessionLifetimeHours()) * 60 * 60 * 1000;
        if (Date.now() - data.createdAt >= lifetimeMs) {
          await destroySessionBestEffort(sessionId);
          await invalidateSession(data.userId, sessionId);
          return null;
        }
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
      return {
        user,
        persistent: isPersistent(data),
        securityGeneration: data.securityGeneration,
        authenticationMethod: authenticationMethodOf(data),
        mfaAssurance: mfaAssuranceOf(data),
      };
    },

    async changePassword(userId, input, security, ip) {
      // The target is always the authenticated principal's own account. Cookie
      // callers carry their exact session generation; bearer callers carry the
      // generation read while their token was authenticated.
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
      const securityGeneration = await userRepo.updatePassword(
        user.id,
        passwordHash,
        false,
        security.securityGeneration,
      );
      if (securityGeneration === null) throw unauthorized();

      // Cleanup is best effort: even a Redis failure leaves every prior cookie
      // fenced by the committed generation. Security transitions deliberately
      // retain no session, including the acting cookie; every device must log in
      // again explicitly at the committed generation. No session survives, so
      // the realtime invalidation carries no exception.
      await destroyAllSessionsBestEffort(user.id);
      await invalidateAllSessions(user.id);

      await audit.record({
        actorId: user.id,
        action: AuditAction.PasswordChanged,
        targetType: 'user',
        targetId: user.id,
        ip,
      });

      const updated = await userRepo.findById(user.id);
      return {
        user: updated ?? {
          ...user,
          passwordHash,
          mustChangePassword: false,
          securityGeneration,
        },
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

      // Email-invite is a self-serve registration path too (§13.4 V4-P0d): apply
      // the admin-configured account defaults — chat on/off, portfolio visibility,
      // notification-matrix seeds — to this new account only, mirroring `register`.
      await applyAccountDefaultsAtRegistration(
        { appSettings, userRepo, notificationRepo },
        user.id,
      );

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

      const sessionId = await sessions.create(user.id, user.securityGeneration, true, {
        method: 'registration',
      });
      return { user, sessionId, persistent: true };
    },

    async requestPasswordReset({ email: address }, ip) {
      const responseFloor = delay(PASSWORD_RESET_RESPONSE_FLOOR_MS);
      try {
        const user = await userRepo.findByEmail(address);
        const resetUser = user?.role === 'user' && user.status === 'active' ? user : null;
        const { token, tokenHash } = generateToken();
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
        // Only active, user-kind accounts get a self-service link. Admin recovery
        // is the admin temp-password path (#268); disabled accounts stay closed.
        // The caller always sees the same generic acknowledgement, and the shared
        // response deadline below masks the known-account writes (§6.1). Both
        // branches also take the repository's per-address issue lock, so a burst
        // of concurrent requests cannot distinguish the row-locking branch.
        await passwordResetRepo.issueOrEqualize(
          resetUser ? { userId: resetUser.id, tokenHash, expiresAt } : null,
          address.trim().toLowerCase(),
        );
        if (resetUser) {
          await audit.record({
            action: AuditAction.PasswordResetRequested,
            targetType: 'user',
            targetId: resetUser.id,
            ip,
          });
          // Best-effort send after the token is committed. SMTP latency must never
          // become an account-existence oracle; the detached send still owns the
          // normal email_log and failure-audit semantics (§6.10/§6.11).
          const resetUrl = `${config.appOrigin}/reset/${token}`;
          void email
            .sendPasswordReset({
              to: resetUser.email,
              resetUrl,
              audit: {
                actorId: resetUser.id,
                targetType: 'user',
                targetId: resetUser.id,
                ip,
              },
            })
            .catch((err) => {
              logger?.warn({ err, userId: resetUser.id }, 'detached password-reset email failed');
            });
        }
      } finally {
        await responseFloor;
      }
    },

    async completePasswordReset({ token, newPassword }, ip) {
      const invalid = () =>
        badRequest('This reset link is invalid or has expired.', 'INVALID_RESET');

      const record = await passwordResetRepo.findByTokenHash(hashToken(token));
      if (!record) throw invalid();

      const user = await userRepo.findById(record.userId);
      // The token was only ever issued to an active user-kind account; re-check
      // in case the account was disabled or its role changed after issue.
      if (!user || user.role !== 'user' || user.status !== 'active') throw invalid();

      const policy = checkPasswordPolicy(newPassword);
      if (!policy.ok) throw badRequest(policy.reason, 'WEAK_PASSWORD');

      // One conditional write linearizes completion before the expensive hash or
      // any credential/session mutation. A concurrent loser stops here.
      if (!(await passwordResetRepo.consume(record.id, new Date()))) throw invalid();

      const passwordHash = await passwordHasher.hash(newPassword);
      const securityGeneration = await userRepo.updatePassword(
        user.id,
        passwordHash,
        false,
        user.securityGeneration,
      );
      if (securityGeneration === null) throw invalid();

      // Revoke every other outstanding token after the password transition.
      await passwordResetRepo.deleteForUser(user.id);

      // A password change kills all sessions (§6.1).
      await destroyAllSessionsBestEffort(user.id);
      await invalidateAllSessions(user.id);

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
        const challenge = await issueTwoFactorChallenge(
          user,
          securityGeneration,
          ip,
          undefined,
          undefined,
          'password_reset',
        );
        return { status: 'two_factor_required', challenge };
      }

      const sessionId = await sessions.create(user.id, securityGeneration, true, {
        method: 'password_reset',
      });
      const updated = await userRepo.findById(user.id);
      return {
        status: 'authenticated',
        user: updated ?? {
          ...user,
          passwordHash,
          mustChangePassword: false,
          securityGeneration,
        },
        sessionId,
        // A completed reset lands a normal persistent session (§6.1, #268).
        persistent: true,
      };
    },

    async getRegistrationInfo() {
      // Leaks only the mode + whether Google sign-in is configured (§13.4 V4-P4b) —
      // both drive which auth surfaces render, nothing account-identifying.
      return {
        mode: await appSettings.getRegistrationMode(),
        googleEnabled: config.google.enabled,
      };
    },

    async register(input, ip) {
      // Gate (§4, §6.12, §13.4 V4-P4a): 403 `REGISTRATION_CLOSED` when the stored
      // mode is `closed` — closed keeps blocking everything exactly as before.
      await appSettings.assertSelfRegistrationAllowed();
      const mode = await appSettings.getRegistrationMode();

      const policy = checkPasswordPolicy(input.password);
      if (!policy.ok) throw badRequest(policy.reason, 'WEAK_PASSWORD');

      const emailAddr = input.email.trim().toLowerCase();
      const username = input.username.trim();
      // Store the register-form language verbatim; the email layer resolves it to
      // a renderable locale at decision time (EN fallback).
      const locale = input.locale ?? 'en';

      // Approval mode parks the details as a PENDING application — never a user
      // row — so the applicant has no usable account and cannot log in until an
      // admin approves. Uniqueness is checked against live accounts AND other
      // pending applications so a duplicate can't slip through either.
      if (mode === 'approval') {
        if (await userRepo.findByEmail(emailAddr)) {
          throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
        }
        if (await userRepo.findByUsername(username)) {
          throw conflict('That username is already taken.', 'USERNAME_TAKEN');
        }
        if (await registrationRequestRepo.findByEmail(emailAddr)) {
          throw conflict(
            'A registration request for this email is already pending.',
            'EMAIL_TAKEN',
          );
        }
        if (await registrationRequestRepo.findByUsername(username)) {
          throw conflict('That username is already requested.', 'USERNAME_TAKEN');
        }
        const passwordHash = await passwordHasher.hash(input.password);
        const request = await registrationRequestRepo.create({
          email: emailAddr,
          username,
          passwordHash,
          locale,
        });
        await audit.record({
          action: AuditAction.RegistrationRequested,
          targetType: 'registration_request',
          targetId: request.id,
          ip,
          meta: { via: 'approval' },
        });
        return { status: 'pending' };
      }

      // Invite-token mode requires a valid, unexpired, unexhausted token. Claim a
      // use ATOMICALLY (the repo's WHERE is the concurrency guard) so a single-use
      // token can never create two accounts and a multi-use one can never exceed
      // its cap. Uniqueness is checked first so a taken email/username doesn't
      // burn a use.
      let tokenId: string | null = null;
      if (mode === 'invite_token') {
        const raw = input.inviteToken?.trim();
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
      if (await userRepo.findByUsername(username)) {
        throw conflict('That username is already taken.', 'USERNAME_TAKEN');
      }

      if (tokenId) {
        const claimed = await registrationTokenRepo.consumeUse(tokenId, new Date());
        if (!claimed) {
          // Raced to exhaustion/expiry/revocation between the check and the claim.
          throw badRequest(
            'This registration token is invalid or has expired.',
            'INVALID_REGISTRATION_TOKEN',
          );
        }
      }

      const passwordHash = await passwordHasher.hash(input.password);
      const user = await userRepo.create({
        email: emailAddr,
        username,
        passwordHash,
        role: 'user',
        status: 'active',
        mustChangePassword: false,
        // Honour the register-form language so a DE registrant lands on a
        // DE-defaulted account (the welcome mail itself stays EN by convention —
        // see emailI18n.ts).
        locale,
      });
      // Self-serve accounts are always the user kind (§5.5): provision the one
      // default portfolio up front so the app opens onto a real workspace.
      await portfolioRepo.createDefault(user.id);

      // Apply the admin-configured account defaults (§13.4 V4-P0d) to this new
      // account only — chat on/off, portfolio visibility, notification-matrix
      // seeds. Read live, so a change applies to this (the next) registration and
      // never retroactively.
      await applyAccountDefaultsAtRegistration(
        { appSettings, userRepo, notificationRepo },
        user.id,
      );

      await audit.record({
        actorId: user.id,
        action: AuditAction.UserCreated,
        targetType: 'user',
        targetId: user.id,
        ip,
        meta: {
          via: 'registration',
          mode,
          ...(tokenId ? { tokenId } : {}),
          // Attribution for the app-native signup path (owner 2026-08-07): this
          // account was created inside an OAuth authorize flow.
          ...(input.oauthRegistration ? { oauth: true } : {}),
        },
      });

      // Best-effort welcome mail, after the account is fully provisioned.
      await email.sendWelcome({
        to: user.email,
        username: user.username,
        audit: { actorId: user.id, targetType: 'user', targetId: user.id, ip },
      });

      // Persistence decision. An ordinary web registration lands a persistent
      // session (unchanged). A registration made INSIDE an OAuth authorize flow
      // is forced EPHEMERAL — the same rule `login` applies to a PIN-less OAuth
      // login (§16, owner spec #399 §A): the Custom-Tab browser shares cookies
      // with the phone's browser, so a brand-new account must not leave a
      // persistent web session that silently re-authorizes after an app logout.
      // A fresh account never has a PIN, so no persistent branch is lost. This
      // is the authoritative enforcement; the SPA only asks.
      const persistent = !(input.oauthRegistration ?? false);
      const sessionId = await sessions.create(user.id, user.securityGeneration, persistent, {
        method: 'registration',
      });
      return { status: 'authenticated', user, sessionId, persistent };
    },

    async verifyPin({ userId, sessionId, pin, ip }) {
      const user = await userRepo.findById(userId);
      // The session guard already resolved this user, but re-check the account.
      if (!user || user.status !== 'active') {
        await sessions.destroy(sessionId);
        await invalidateSession(userId, sessionId);
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
          await invalidateSession(user.id, sessionId);
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

    async quickAuth({ deviceId, pin, ip }) {
      // A missing/forgotten device binding means this browser was never
      // remembered (or was told "Another account"): the client falls back to a
      // blank login. Every "not remembered" branch returns the SAME code so it is
      // never an oracle for which device ids or accounts exist.
      const unknownDevice = () =>
        unauthorized('This device is not remembered.', 'REMEMBER_DEVICE_UNKNOWN');
      if (!deviceId) throw unknownDevice();
      const boundUserId = await rememberedDevices.ownerOf(deviceId);
      if (!boundUserId) throw unknownDevice();

      const boundUser = await userRepo.findById(boundUserId);
      // The bound account vanished, was suspended, or dropped its PIN — the
      // memory is dead: clear the binding + window and fall back to full login.
      if (!isRememberableUser(boundUser)) {
        await clearRememberedDeviceState(boundUserId, deviceId);
        throw unknownDevice();
      }

      // Make pre-retention bindings enumerable and keep both server-side keys
      // aligned with the browser cookie, whose lifetime slides after a
      // successful quick re-auth.
      await rememberedDevices.refreshForUser(boundUser.id, deviceId);
      const user = await revalidateRememberedDeviceUser(boundUser.id, deviceId);
      if (!user) throw unknownDevice();

      // Probe (no PIN entered): auto-pass ONLY while the quick-auth window from a
      // recent PIN entry is still open (owner: "tapping your name while the PIN
      // timer is still running ⇒ auto-login"). Otherwise ask for the PIN — the
      // chooser tap already happened, this is not an error and burns no limiter.
      if (pin === undefined) {
        const windowOpen = await redis.get(pinQuickAuthMarkerKey(deviceId));
        if (!windowOpen) return { status: 'pin_required' };
        const signedIn = await mintQuickAuthSession(user, ip);
        await rememberedDevices.touchLastSeen(deviceId);
        return { status: 'authenticated', user: signedIn.user, sessionId: signedIn.sessionId };
      }

      // PIN present: reject an already-cooling account before the slow hash, then
      // ride the SAME per-account progressive limiter as the bearer PIN verify
      // (#361) — the two share the `pin_token_account` namespace keyed by user id,
      // so hammering either locks out on one schedule. No session to drop here, so
      // this limiter (not the 5-strike session counter) is the brute-force guard.
      const cooling = await pinTokenThrottle.peek(user.id);
      if (cooling > 0) throw tooManyRequests(cooling);
      const ok = await passwordHasher.verify(user.pinHash, pin);
      if (!ok) {
        const decision = await pinTokenThrottle.consume(user.id);
        await audit.record({
          action: AuditAction.PinVerifyFail,
          targetType: 'user',
          targetId: user.id,
          ip,
          meta: { via: 'quick_auth' },
        });
        if (!decision.allowed) throw tooManyRequests(decision.retryAfterSec);
        throw unauthorized('Incorrect PIN.', 'INVALID_PIN');
      }

      // Correct PIN: clear the tally and open the quick-auth window from THIS
      // entry (device-keyed, fixed TTL). An auto-pass never refreshes it, so the
      // window always measures time since the last real PIN.
      await pinTokenThrottle.reset(user.id);
      await redis.set(pinQuickAuthMarkerKey(deviceId), '1', 'EX', PIN_QUICK_AUTH_WINDOW_SECONDS);
      await audit.record({
        actorId: user.id,
        action: AuditAction.PinVerified,
        targetType: 'user',
        targetId: user.id,
        ip,
        meta: { via: 'quick_auth' },
      });
      const signedIn = await mintQuickAuthSession(user, ip);
      await rememberedDevices.touchLastSeen(deviceId);
      return { status: 'authenticated', user: signedIn.user, sessionId: signedIn.sessionId };
    },

    async rememberDevice(userId, ip) {
      const initialUser = await userRepo.findById(userId);
      if (!initialUser || initialUser.status !== 'active') throw unauthorized();
      if (!initialUser.pinEnabled || !initialUser.pinHash) {
        // Only PIN users can be remembered (owner spec §B): a no-PIN account gets
        // no remember-me and a blank login every time. The SPA only offers the
        // prompt to PIN users; this is the authoritative server-side enforcement.
        throw badRequest('A PIN is required to remember this device.', 'PIN_NOT_ENABLED');
      }
      // Opaque, high-entropy device id — the value of the signed `bt_rdid` cookie.
      // The binding and reverse index expire with the signed browser cookie.
      // This preserves long-lived account memory while bounding abandoned
      // server state and making every live binding enumerable for deletion.
      const deviceId = generateToken().token;
      await rememberedDevices.createForUser(initialUser.id, deviceId);
      const user = await revalidateRememberedDeviceUser(initialUser.id, deviceId);
      if (!user) throw unauthorized();
      await audit.record({
        actorId: user.id,
        action: AuditAction.RememberedDeviceCreated,
        targetType: 'user',
        targetId: user.id,
        ip,
      });
      return {
        deviceId,
        // The client's whole record: never a token or scope (avatar is always null
        // — the app has no avatar system yet; the chooser renders initials).
        record: { userId: user.id, username: user.username, avatarUrl: null },
      };
    },

    async forgetDevice(deviceId, ip) {
      if (!deviceId) return;
      const boundUserId = await rememberedDevices.ownerOf(deviceId);
      if (boundUserId) {
        await clearRememberedDeviceState(boundUserId, deviceId);
        await audit.record({
          actorId: boundUserId,
          action: AuditAction.RememberedDeviceForgotten,
          targetType: 'user',
          targetId: boundUserId,
          ip,
        });
      } else {
        await rememberedDevices.clearOrphan(deviceId);
      }
    },

    listRememberedDevices(userId) {
      return rememberedDevices.listForUser(userId);
    },

    async revokeRememberedDevice(userId, handle, ip) {
      const revoked = await rememberedDevices.revokeForUser(userId, handle);
      if (!revoked) return;
      await audit.record({
        actorId: userId,
        action: AuditAction.RememberedDeviceForgotten,
        targetType: 'user',
        targetId: userId,
        ip,
        meta: { via: 'management' },
      });
    },

    async revokeAllRememberedDevices(userId, ip) {
      const revoked = await rememberedDevices.revokeAllForUser(userId);
      // One audit row per binding, not one aggregate row: each revoked device is
      // a distinct security action even though the public response is minimal.
      for (let index = 0; index < revoked; index += 1) {
        await audit.record({
          actorId: userId,
          action: AuditAction.RememberedDeviceForgotten,
          targetType: 'user',
          targetId: userId,
          ip,
          meta: { via: 'management_all' },
        });
      }
    },

    async completeFirstRun(userId) {
      const user = await userRepo.findById(userId);
      if (!user) throw unauthorized();
      // Not audited: this is a UI progress flag with no security meaning — it
      // grants nothing and gates nothing but a client-side redirect.
      const updated = await userRepo.markFirstRunCompleted(user.id, new Date());
      return updated ?? user;
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
      if (revoked) {
        await publishSessionInvalidation({
          userId,
          credentialId: publicId,
          exceptCredentialId: null,
        });
      }
      return { revoked, wasCurrent };
    },

    async revokeOtherSessions(userId, currentSessionId) {
      const revoked = await sessions.revokeOthersForUser(userId, currentSessionId);
      if (revoked > 0) await invalidateAllSessions(userId, currentSessionId);
      return revoked;
    },
  };
}
