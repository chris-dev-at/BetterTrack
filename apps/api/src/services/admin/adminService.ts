import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import {
  ADMIN_USER_NOTE_PAGE_LIMIT,
  type AccountDefaultsResponse,
  type AdminListQuery,
  type AdminUserListQuery,
  type BulkUserActionOutcome,
  type BulkUserActionRequest,
  type BulkUserActionResponse,
  type CreateInviteRequest,
  type CreateRegistrationTokenRequest,
  type CreateUserRequest,
  type UpdateAccountDefaultsRequest,
  type UpdateAdminSessionPolicyRequest,
  type UpdateAppSettingsRequest,
  type UpdateUserRequest,
} from '@bettertrack/contracts';

import type { AppConfig } from '../../config/env';
import type { ApiKeyService } from '../apiKeys/apiKeyService';
import type { OAuthService } from '../oauth/oauthService';
import type {
  AdminPeopleRepository,
  AdminUserNoteRow,
  AdminUserSharingCounts,
  AdminUserSupportRow,
} from '../../data/repositories/adminPeopleRepository';
import type { EmailLogPage, EmailLogRepository } from '../../data/repositories/emailLogRepository';
import type { IdentityRepository } from '../../data/repositories/identityRepository';
import type { InviteRepository } from '../../data/repositories/inviteRepository';
import type { NotificationRepository } from '../../data/repositories/notificationRepository';
import type { PortfolioRepository } from '../../data/repositories/portfolioRepository';
import type { RegistrationRequestRepository } from '../../data/repositories/registrationRequestRepository';
import type { RegistrationTokenRepository } from '../../data/repositories/registrationTokenRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { isUniqueViolation } from '../../data/driverError';
import type { InviteRow, RegistrationTokenRow, UserRow } from '../../data/schema';
import { badRequest, conflict, notFound } from '../../errors';
import type { EventBus, RealtimePrincipalInvalidatedEvent } from '../../events';
import type { Logger } from '../../logger';
import { applyAccountDefaultsAtRegistration } from '../account/accountDefaults';
import type {
  AdminSessionPolicy,
  AppSettings,
  AppSettingsService,
} from '../appSettings/appSettingsService';
import { AuditAction, type AuditService } from '../audit/auditService';
import { clearLoginThrottle, removeRememberedDeviceBindings } from '../auth/loginThrottle';
import { generateToken } from '../crypto/tokens';
import type { EmailSendResult, EmailService } from '../email/emailService';
import type { NotificationCenter } from '../notifications/notificationCenter';
import {
  deactivatedChannelsRequested,
  maskMatrix,
  preserveDeactivatedCells,
} from '../notifications/killSwitch';
import type { MirrorService } from '../mirror/mirrorService';
import type { PasswordHasher } from '../password/passwordHasher';
import { generateTempPassword } from '../password/tempPassword';
import type { SessionService } from '../sessions/sessionService';

export interface AdminServiceDeps {
  config: AppConfig;
  redis: Redis;
  userRepo: UserRepository;
  /** Cross-table reads + operator notes behind the People 360 tabs (#1406 W2). */
  people: AdminPeopleRepository;
  inviteRepo: InviteRepository;
  /** Registration access tokens for the `invite_token` mode (§13.4 V4-P4a). */
  registrationTokenRepo: RegistrationTokenRepository;
  /** Approval-queue applications for the `approval` mode (§13.4 V4-P4a). */
  registrationRequestRepo: RegistrationRequestRepository;
  /** Federated identities — links a Google application on approval (§13.4 V4-P4b). */
  identityRepo: IdentityRepository;
  portfolioRepo: PortfolioRepository;
  /** Per-(channel, type) override seeding for the V4-P0d account-defaults matrix. */
  notificationRepo: Pick<NotificationRepository, 'upsertChannelConfig'>;
  /** Suspension cleanup for non-session bearer credentials. */
  apiKeys: Pick<ApiKeyService, 'revokeAllForUser'>;
  /** Suspension cleanup for delegated OAuth credentials. */
  oauth: Pick<OAuthService, 'revokeAllForUser'>;
  sessions: SessionService;
  /** Best-effort lifecycle fan-out to terminate any connected principal. */
  events?: Pick<EventBus, 'publish'>;
  logger?: Pick<Logger, 'warn'>;
  audit: AuditService;
  passwordHasher: PasswordHasher;
  email: EmailService;
  emailLog: EmailLogRepository;
  appSettings: AppSettingsService;
  /** The central notification pipeline (#368) — `account.temp_password` notices. */
  notify: NotificationCenter;
  /**
   * MIRRORCHAIN §7 pre-delete succession hook (V5-P7 M4): admin delete runs the
   * same owner-succession as the self-serve pipeline BEFORE the user row is
   * removed, so an admin deleting a chain owner never orphans the chain.
   */
  mirror: Pick<MirrorService, 'handleAccountDeletion'>;
}

export interface AdminActor {
  id: string;
  ip?: string | null;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The loser of a decision race on one registration application (§6.12). A 409
 * rather than a 404: the application existed and was answered — by someone else,
 * or by this operator's other tab — and the queue view is simply stale.
 */
const registrationRequestDecided = () =>
  conflict('This registration request has already been decided.', 'REGISTRATION_REQUEST_DECIDED');

export function createAdminService(deps: AdminServiceDeps) {
  const {
    config,
    redis,
    userRepo,
    people,
    inviteRepo,
    registrationTokenRepo,
    registrationRequestRepo,
    identityRepo,
    portfolioRepo,
    notificationRepo,
    apiKeys,
    oauth,
    sessions,
    events,
    logger,
    audit,
    passwordHasher,
    email,
    emailLog,
    appSettings,
    notify,
    mirror,
  } = deps;

  async function loadUser(id: string): Promise<UserRow> {
    const user = await userRepo.findById(id);
    if (!user) throw notFound('User not found.', 'USER_NOT_FOUND');
    return user;
  }

  async function destroySessionsBestEffort(userId: string): Promise<void> {
    try {
      await sessions.destroyAllForUser(userId);
    } catch {
      // Role/password commits already advanced the durable generation. Cleanup
      // must not be promoted back into the authorization boundary.
    }
  }

  async function invalidateAllRealtimePrincipals(userId: string): Promise<void> {
    if (!events) return;
    try {
      await events.publish({
        type: 'realtime.principal.invalidated',
        userId,
        kind: 'all',
        credentialId: null,
        exceptCredentialId: null,
        occurredAt: new Date().toISOString(),
      } satisfies RealtimePrincipalInvalidatedEvent);
    } catch (err) {
      // The status/credential mutation has completed; gateway revalidation is
      // deliberately the fail-closed fallback when pub/sub delivery is down.
      logger?.warn({ err, userId }, 'admin realtime invalidation publish failed');
    }
  }

  // V5-P0 kill-switch (§13.5): the account-defaults response advertises which
  // additive channels this deployment offers at all so the admin editor hides
  // their matrix columns when the flag is off.
  function channelsConfigurableFromConfig(): { telegram: boolean; discord: boolean } {
    return { telegram: config.telegram.enabled, discord: config.discord.enabled };
  }

  async function ensureActiveAdminRemains(
    repo: Pick<UserRepository, 'countActiveAdmins'>,
    target: UserRow,
    targetRemainsActiveAdmin: boolean,
  ): Promise<void> {
    if (target.role === 'admin' && target.status === 'active' && !targetRemainsActiveAdmin) {
      const activeAdmins = await repo.countActiveAdmins();
      if (activeAdmins <= 1) {
        throw badRequest('Cannot remove the last active administrator.', 'LAST_ADMIN');
      }
    }
  }

  /**
   * Revoke bearer credentials in a fixed order. The caller deliberately changes
   * user status first, so any failure here is fail-closed: authentication and
   * exchange choke points reject the disabled user until a retry completes.
   */
  async function revokeBearerCredentials(userId: string): Promise<void> {
    await apiKeys.revokeAllForUser(userId);
    await oauth.revokeAllForUser(userId);
  }

  /** Which post-commit cleanup step of a suspension failed, for the audit row. */
  type DisableCleanupStep = 'api_keys' | 'oauth_grants' | 'sessions';
  type DisableCleanup = { ok: true } | { ok: false; step: DisableCleanupStep; error: unknown };

  /**
   * Run a committed suspension's cleanup, reporting rather than throwing. The
   * status change is already the durable kill switch, so a failure here stays
   * fail-closed and repairable — but the caller must still be able to RECORD
   * that it happened before it re-raises.
   */
  async function runDisableCleanup(userId: string): Promise<DisableCleanup> {
    const steps: ReadonlyArray<readonly [DisableCleanupStep, () => Promise<void>]> = [
      ['api_keys', () => apiKeys.revokeAllForUser(userId)],
      ['oauth_grants', () => oauth.revokeAllForUser(userId)],
      ['sessions', () => sessions.destroyAllForUser(userId)],
    ];
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        return { ok: false, step, error };
      }
    }
    // Best-effort by design (logged, never promoted into the boundary).
    await invalidateAllRealtimePrincipals(userId);
    return { ok: true };
  }

  /**
   * Finish a committed disable and ALWAYS audit it. The audit row is no longer
   * the last await behind an unguarded cleanup chain, and no longer gated on the
   * status having changed: a cleanup throw used to leave a durably-suspended
   * account with no record at all, and a repeat disable that repaired stale
   * credentials recorded nothing. The row carries what actually happened —
   * `repair` when the account was already disabled, `cleanup: 'incomplete'` plus
   * the failing step when the suspension is only half-applied.
   */
  async function finishDisableUser(
    target: UserRow,
    actor: AdminActor,
    changedStatus: boolean,
    via?: 'bulk',
  ): Promise<DisableCleanup> {
    const cleanup = await runDisableCleanup(target.id);
    const meta = {
      ...(via ? { via } : {}),
      ...(changedStatus ? {} : { repair: true }),
      ...(cleanup.ok ? {} : { cleanup: 'incomplete', step: cleanup.step }),
    };
    await audit.record({
      actorId: actor.id,
      action: AuditAction.UserDisabled,
      targetType: 'user',
      targetId: target.id,
      ip: actor.ip,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
    return cleanup;
  }

  /**
   * Re-enabling must revoke stale credentials before the transaction can make
   * the account active. A later transaction failure (including another field's
   * uniqueness check) leaves it disabled with those bearer credentials revoked.
   */
  async function prepareEnableUser(target: UserRow): Promise<void> {
    // A failed disable can leave rows physically present but unreachable under
    // the status gate. Finish the same invalidation before making them reachable
    // again; revocation is idempotent for already-revoked rows.
    await revokeBearerCredentials(target.id);
    // A prior disable can have failed after setting status but before session
    // cleanup. Never restore `active` while that old cookie could reconnect.
    await sessions.destroyAllForUser(target.id);
    await invalidateAllRealtimePrincipals(target.id);
  }

  async function finishEnableUser(target: UserRow, actor: AdminActor): Promise<void> {
    // Re-enabling must let the user back in immediately — drop any failed-login
    // / lockout state accrued before they were disabled.
    await clearLoginThrottle(redis, target.id);
    await audit.record({
      actorId: actor.id,
      action: AuditAction.UserEnabled,
      targetType: 'user',
      targetId: target.id,
      ip: actor.ip,
    });
  }

  /**
   * Bulk-disable (§6.12, §13.2): best-effort over a set — an id that can't be
   * disabled (unknown, the actor themselves, or the last active admin) is
   * skipped rather than failing the whole batch. An already-disabled row is NOT
   * skipped: it gets the same repair pass a repeat single disable gets, so a
   * batch re-run after a partial failure finishes the cleanup and records it.
   * Each row is audited exactly like a single disable, and one row's cleanup
   * failure never abandons the rest of the batch — it becomes that row's
   * outcome.
   */
  async function bulkDisableUsers(
    userIds: string[],
    actor: AdminActor,
  ): Promise<BulkUserActionOutcome[]> {
    // Stable target order prevents two overlapping bulk requests from taking
    // ordinary user-row locks in opposite order.
    const unique = [...new Set(userIds)].sort();
    const { toDisable, skippedIds } = await userRepo.withSerializedAdminMutation(async (repo) => {
      const selected: Array<{ target: UserRow; statusChanged: boolean }> = [];
      const skipped: string[] = [];

      for (const id of unique) {
        const target = await repo.findByIdForUpdate(id);
        if (!target || target.id === actor.id) {
          skipped.push(id);
          continue;
        }
        if (target.status !== 'active') {
          // Already suspended — the last-admin guard is about ACTIVE admins, so
          // this row cannot take the count to zero. Repair it instead.
          selected.push({ target, statusChanged: false });
          continue;
        }
        if (target.role === 'admin' && (await repo.countActiveAdmins()) <= 1) {
          skipped.push(id);
          continue;
        }
        await repo.setStatus(target.id, 'disabled');
        selected.push({ target, statusChanged: true });
      }

      return { toDisable: selected, skippedIds: skipped };
    });

    // The transaction committed every status first. Cleanup cannot reopen an
    // account if one target's credential/session revocation fails.
    const outcomes = new Map<string, BulkUserActionOutcome['outcome']>(
      skippedIds.map((id) => [id, 'skipped'] as const),
    );
    for (const { target, statusChanged } of toDisable) {
      let complete: boolean;
      try {
        complete = (await finishDisableUser(target, actor, statusChanged, 'bulk')).ok;
      } catch (err) {
        // The audit write itself failed. The suspension is already durable, so
        // the batch continues and this row is reported as needing repair.
        logger?.warn({ err, userId: target.id }, 'bulk disable audit record failed');
        complete = false;
      }
      outcomes.set(
        target.id,
        complete ? (statusChanged ? 'disabled' : 'repaired') : 'cleanup_failed',
      );
    }

    return unique.map((userId) => ({ userId, outcome: outcomes.get(userId) ?? 'skipped' }));
  }

  return {
    listUsers: (search?: string) => userRepo.list(search),

    /**
     * The People list (#1406 W2): filtered, ordered and windowed in SQL rather
     * than in the browser. `total` is the count for the FILTER, not the table,
     * so the footer says how many rows the operator's question has.
     */
    listUsersPage: (query: AdminUserListQuery) =>
      userRepo.listPage({
        ...(query.search !== undefined ? { search: query.search } : {}),
        ...(query.role !== undefined ? { role: query.role } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.privacyMode !== undefined ? { privacyMode: query.privacyMode } : {}),
        sort: query.sort,
        direction: query.direction,
        limit: query.limit,
        offset: query.offset,
      }),

    /**
     * One account (#1406 W2). Before this existed the detail page downloaded
     * every user to find one row; on a real instance that is the whole table on
     * every open. 404s through the shared `loadUser`, so an unknown id is
     * indistinguishable from an id the caller may not see.
     */
    getUser: (id: string) => loadUser(id),

    /**
     * The Access tab in one read. Sessions come from Redis (the session service
     * is the only place they live) and carry the PUBLIC revocation handle, never
     * the session id itself — this response must not be replayable into a
     * session. Passing `null` as the current session id is deliberate: an
     * operator is not one of this user's devices, so nothing here is ever marked
     * `current`.
     */
    async userAccess(id: string) {
      await loadUser(id);
      const [sessionList, apiKeyRows, grantRows, identityRows] = await Promise.all([
        sessions.listForUser(id, null),
        people.apiKeysFor(id),
        people.oauthGrantsFor(id),
        people.identitiesFor(id),
      ]);
      return {
        sessions: sessionList,
        apiKeys: apiKeyRows,
        oauthGrants: grantRows,
        identities: identityRows,
      };
    },

    /** The Sharing tab — counts only; see the repository for why. */
    async userSharing(id: string): Promise<AdminUserSharingCounts> {
      await loadUser(id);
      return people.sharingCountsFor(id);
    },

    /** The Support tab — this account's submissions, summarized (no bodies). */
    async userSupport(
      id: string,
      limit: number,
    ): Promise<{ rows: AdminUserSupportRow[]; total: number; openCount: number }> {
      await loadUser(id);
      return people.supportFor(id, limit);
    },

    /** The Notes tab. */
    async listUserNotes(id: string): Promise<AdminUserNoteRow[]> {
      await loadUser(id);
      return people.listNotes(id, ADMIN_USER_NOTE_PAGE_LIMIT);
    },

    /**
     * Write an operator note. Audited with the note id in `meta` and NEVER the
     * body: copying operator prose into the audit log would create a second
     * store of it that the delete route below cannot reach.
     */
    async createUserNote(id: string, body: string, actor: AdminActor): Promise<AdminUserNoteRow> {
      await loadUser(id);
      const note = await people.createNote({ userId: id, authorId: actor.id, body });
      await audit.record({
        actorId: actor.id,
        action: AuditAction.AdminUserNoteAdded,
        targetType: 'user',
        targetId: id,
        ip: actor.ip,
        meta: { noteId: note.id },
      });
      return note;
    },

    /**
     * Remove an operator note. Any admin may remove any note — there is one
     * operator today, RBAC is explicitly out (#1406), and an audit row already
     * names who did it. 404 when the note is not on THIS account, so a stale id
     * can never reach across accounts.
     */
    async deleteUserNote(id: string, noteId: string, actor: AdminActor): Promise<void> {
      await loadUser(id);
      const removed = await people.deleteNote(id, noteId);
      if (!removed) throw notFound('That note no longer exists.', 'NOTE_NOT_FOUND');
      await audit.record({
        actorId: actor.id,
        action: AuditAction.AdminUserNoteDeleted,
        targetType: 'user',
        targetId: id,
        ip: actor.ip,
        meta: { noteId },
      });
    },

    async createUser(
      input: CreateUserRequest,
      actor: AdminActor,
    ): Promise<{ user: UserRow; tempPassword: string }> {
      if (await userRepo.findByEmail(input.email)) {
        throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
      }
      if (await userRepo.findByUsername(input.username)) {
        throw conflict('That username is already taken.', 'USERNAME_TAKEN');
      }

      const tempPassword = generateTempPassword();
      const passwordHash = await passwordHasher.hash(tempPassword);
      const user = await userRepo.create({
        email: input.email,
        username: input.username,
        passwordHash,
        role: input.role,
        status: 'active',
        mustChangePassword: true,
      });

      // Account kinds are disjoint (§5.5): a new *user* opens onto a default
      // portfolio; a management-only *admin* never gets one.
      if (user.role === 'user') {
        await portfolioRepo.createDefault(user.id);
      }

      await audit.record({
        actorId: actor.id,
        action: AuditAction.UserCreated,
        targetType: 'user',
        targetId: user.id,
        ip: actor.ip,
        meta: { via: 'admin', role: input.role },
      });

      // Best-effort, post-commit: a mail failure must not undo the new account.
      await email.sendTempPassword({
        to: user.email,
        username: user.username,
        tempPassword,
        reason: 'created',
        audit: { actorId: actor.id, targetType: 'user', targetId: user.id, ip: actor.ip },
      });

      return { user, tempPassword };
    },

    async updateUser(id: string, input: UpdateUserRequest, actor: AdminActor): Promise<UserRow> {
      let enablePrepared = false;
      const runMutation = () =>
        userRepo.withSerializedAdminMutation(async (repo) => {
          const target = await repo.findByIdForUpdate(id);
          if (!target) throw notFound('User not found.', 'USER_NOT_FOUND');

          const statusChanged = input.status !== undefined && input.status !== target.status;
          const roleChanged = input.role !== undefined && input.role !== target.role;

          if (input.status === 'disabled' && statusChanged && target.id === actor.id) {
            throw badRequest('You cannot disable your own account.', 'SELF_ACTION');
          }
          if (input.role === 'user' && roleChanged && target.id === actor.id) {
            throw badRequest('You cannot remove your own administrator role.', 'SELF_ACTION');
          }

          const finalStatus = input.status ?? target.status;
          const finalRole = input.role ?? target.role;
          await ensureActiveAdminRemains(
            repo,
            target,
            finalStatus === 'active' && finalRole === 'admin',
          );

          if (statusChanged && input.status === 'active' && !enablePrepared) {
            return { kind: 'prepare-enable' as const, target };
          }

          if (statusChanged) {
            await repo.setStatus(target.id, input.status!);
          }

          if (roleChanged) {
            const securityGeneration = await repo.setRole(target.id, input.role!);
            if (securityGeneration === null) throw notFound('User not found.', 'USER_NOT_FOUND');
          }

          let changedEmail: string | undefined;
          if (input.email !== undefined) {
            const normalized = input.email.trim().toLowerCase();
            if (normalized !== target.email) {
              const existing = await repo.findByEmail(normalized);
              if (existing && existing.id !== target.id) {
                throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
              }
              await repo.updateEmail(target.id, normalized);
              changedEmail = normalized;
            }
          }

          let changedUsername: string | undefined;
          if (input.username !== undefined) {
            const trimmed = input.username.trim();
            if (trimmed.toLowerCase() !== target.username.toLowerCase()) {
              const existing = await repo.findByUsername(trimmed);
              if (existing && existing.id !== target.id) {
                throw conflict('That username is already taken.', 'USERNAME_TAKEN');
              }
              await repo.updateUsername(target.id, trimmed);
              changedUsername = trimmed;
            }
          }

          // Chat ban toggle (§13.4 V4-P0d): server-enforced in the send path.
          const changedChatBan =
            input.chatBanned !== undefined && input.chatBanned !== target.chatBanned
              ? input.chatBanned
              : undefined;
          if (changedChatBan !== undefined) {
            await repo.setChatBanned(target.id, changedChatBan);
          }

          const user = await repo.findById(target.id);
          if (!user) throw notFound('User not found.', 'USER_NOT_FOUND');
          return {
            kind: 'mutated' as const,
            target,
            user,
            statusChanged,
            roleChanged,
            changedEmail,
            changedUsername,
            changedChatBan,
          };
        });
      let outcome = await runMutation();
      while (outcome.kind === 'prepare-enable') {
        // `enablePrepared` bounds this to two passes. Cleanup stays between the
        // no-op validation pass and the retry that can restore `active`, so no
        // external repository is awaited while holding the transaction.
        await prepareEnableUser(outcome.target);
        enablePrepared = true;
        outcome = await runMutation();
      }
      const mutation = outcome;

      if (input.status === 'disabled') {
        // An explicit repeat disable repairs a previous fail-closed cleanup
        // failure without ever making the account active again — and is audited
        // whether or not it changed the status, so a repair is never silent.
        const cleanup = await finishDisableUser(mutation.target, actor, mutation.statusChanged);
        // Re-raise AFTER the audit row: the suspension stays fail-closed and the
        // operator's request still fails, but the record of it now survives.
        if (!cleanup.ok) throw cleanup.error;
      } else if (input.status === 'active' && mutation.statusChanged) {
        await finishEnableUser(mutation.target, actor);
      }

      if (mutation.roleChanged) {
        await destroySessionsBestEffort(mutation.target.id);
        await audit.record({
          actorId: actor.id,
          action: AuditAction.UserRoleChanged,
          targetType: 'user',
          targetId: mutation.target.id,
          ip: actor.ip,
          meta: { role: input.role },
        });
      }

      if (mutation.changedEmail !== undefined) {
        await audit.record({
          actorId: actor.id,
          action: AuditAction.UserEmailChanged,
          targetType: 'user',
          targetId: mutation.target.id,
          ip: actor.ip,
          meta: { email: mutation.changedEmail },
        });
      }

      if (mutation.changedUsername !== undefined) {
        await audit.record({
          actorId: actor.id,
          action: AuditAction.UserUsernameChanged,
          targetType: 'user',
          targetId: mutation.target.id,
          ip: actor.ip,
          meta: { username: mutation.changedUsername },
        });
      }

      if (mutation.changedChatBan !== undefined) {
        await audit.record({
          actorId: actor.id,
          action: mutation.changedChatBan
            ? AuditAction.UserChatBanned
            : AuditAction.UserChatUnbanned,
          targetType: 'user',
          targetId: mutation.target.id,
          ip: actor.ip,
        });
      }

      return mutation.user;
    },

    /** Bulk action from the admin user list (§6.12, §13.2). V1: bulk-disable. */
    async bulkUserAction(
      input: BulkUserActionRequest,
      actor: AdminActor,
    ): Promise<BulkUserActionResponse> {
      switch (input.action) {
        case 'disable': {
          const results = await bulkDisableUsers(input.userIds, actor);
          const tally = (outcome: BulkUserActionOutcome['outcome']) =>
            results.filter((row) => row.outcome === outcome).length;
          return {
            action: 'disable',
            disabled: tally('disabled'),
            skipped: tally('skipped'),
            repaired: tally('repaired'),
            failed: tally('cleanup_failed'),
            results,
          };
        }
      }
    },

    /**
     * Admin password reset (§6.1). Idempotent by design: every call mints a
     * fresh temp password, overwrites the stored hash, and re-arms
     * `must_change_password`, so a re-reset after a lost token issues a new,
     * immediately-usable credential and never bricks the account (#248 item 6).
     * Works for admin-kind targets too — the reset a management account recovers
     * with is completed against its own session on login, not the user app.
     */
    async resetPassword(
      id: string,
      actor: AdminActor,
    ): Promise<{ user: UserRow; tempPassword: string }> {
      const target = await loadUser(id);
      const tempPassword = generateTempPassword();
      const passwordHash = await passwordHasher.hash(tempPassword);
      const securityGeneration = await userRepo.updatePassword(target.id, passwordHash, true);
      if (securityGeneration === null) throw notFound('User not found.', 'USER_NOT_FOUND');
      await destroySessionsBestEffort(target.id);
      await invalidateAllRealtimePrincipals(target.id);
      // Clear lockout so the user can sign in with the new temp password now.
      await clearLoginThrottle(redis, target.id);
      await audit.record({
        actorId: actor.id,
        action: AuditAction.UserPasswordReset,
        targetType: 'user',
        targetId: target.id,
        ip: actor.ip,
      });
      const user = await loadUser(id);

      // Best-effort, post-commit: the admin already holds the temp password.
      // The credential email is TRANSACTIONAL and sent directly — it must never
      // ride the notification queue (#368: no secrets in Redis-persisted jobs).
      await email.sendTempPassword({
        to: user.email,
        username: user.username,
        tempPassword,
        reason: 'reset',
        audit: { actorId: actor.id, targetType: 'user', targetId: user.id, ip: actor.ip },
      });
      // The matrix-routed informational notice (inbox/push) carries NO secret.
      await notify.emit({
        type: 'account.temp_password',
        userId: user.id,
        occurredAt: new Date().toISOString(),
      });

      return { user, tempPassword };
    },

    async deleteUser(id: string, confirmUsername: string, actor: AdminActor): Promise<void> {
      // Reserve the removal by disabling the row under the serialized invariant
      // lock. This status transition is the only part of a delete that changes
      // the active-admin count; the later physical delete removes an already
      // inactive row and therefore cannot take the count from one to zero. If
      // later session or MIRRORCHAIN cleanup fails, any target (including an
      // ordinary user) deliberately remains disabled and fail-closed for retry.
      const { target, statusChanged } = await userRepo.withSerializedAdminMutation(async (repo) => {
        const lockedTarget = await repo.findByIdForUpdate(id);
        if (!lockedTarget) throw notFound('User not found.', 'USER_NOT_FOUND');
        if (lockedTarget.username.toLowerCase() !== confirmUsername.trim().toLowerCase()) {
          throw badRequest('Username confirmation does not match.', 'CONFIRMATION_MISMATCH');
        }
        if (lockedTarget.id === actor.id) {
          throw badRequest('You cannot delete your own account.', 'SELF_ACTION');
        }
        await ensureActiveAdminRemains(repo, lockedTarget, false);
        if (lockedTarget.status !== 'disabled') {
          await repo.setStatus(lockedTarget.id, 'disabled');
          return { target: lockedTarget, statusChanged: true };
        }
        return { target: lockedTarget, statusChanged: false };
      });
      try {
        await sessions.destroyAllForUser(target.id);
        await removeRememberedDeviceBindings(redis, target.id);
        await invalidateAllRealtimePrincipals(target.id);
        // MIRRORCHAIN §7: hand off any group portfolios the target owns BEFORE
        // the row delete cascades their copy away (V5-P7 M4), so the chain
        // survives.
        await mirror.handleAccountDeletion(target.id);
        await userRepo.withSerializedAdminMutation(async (repo) => {
          const reserved = await repo.findByIdForUpdate(target.id);
          if (!reserved) throw notFound('User not found.', 'USER_NOT_FOUND');
          // A concurrent enable between reservation and cascade must re-pass the
          // same invariant before this transaction removes the row.
          await ensureActiveAdminRemains(repo, reserved, false);
          await repo.remove(reserved.id);
        });
      } catch (error) {
        // The reservation above is a real, durable suspension: the account is
        // locked out and stays that way for retry. Record it before re-raising —
        // otherwise the only trace of an interrupted delete is a user who can no
        // longer log in and an audit log that shows nothing at all.
        try {
          await audit.record({
            actorId: actor.id,
            action: AuditAction.UserDisabled,
            targetType: 'user',
            targetId: target.id,
            ip: actor.ip,
            meta: {
              via: 'admin',
              reason: 'delete_incomplete',
              cleanup: 'incomplete',
              statusChanged,
            },
          });
        } catch (auditError) {
          logger?.warn({ err: auditError, userId: target.id }, 'incomplete delete audit failed');
        }
        throw error;
      }
      // The row is gone: record that first, so no later best-effort step can
      // swallow the record of a delete that actually happened.
      await audit.record({
        actorId: actor.id,
        action: AuditAction.UserDeleted,
        targetType: 'user',
        targetId: target.id,
        ip: actor.ip,
        meta: { via: 'admin' },
      });
      // Pair the pre-delete sweep with a full scan after durable deletion. This
      // also catches a writer whose new reverse-index membership was erased by
      // the first sweep's final index reset.
      await removeRememberedDeviceBindings(redis, target.id);
    },

    async createInvite(
      input: CreateInviteRequest,
      actor: AdminActor,
    ): Promise<{ invite: InviteRow; inviteUrl: string }> {
      const { token, tokenHash } = generateToken();
      const invite = await inviteRepo.create({
        email: input.email,
        tokenHash,
        createdBy: actor.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      });
      await audit.record({
        actorId: actor.id,
        action: AuditAction.InviteCreated,
        targetType: 'invite',
        targetId: invite.id,
        ip: actor.ip,
      });

      const inviteUrl = `${config.appOrigin}/invite/${token}`;
      // Best-effort, post-commit: the admin can still copy the URL on failure.
      await email.sendInvite({
        to: invite.email,
        inviteUrl,
        audit: { actorId: actor.id, targetType: 'invite', targetId: invite.id, ip: actor.ip },
      });

      return { invite, inviteUrl };
    },

    listInvites: (params: AdminListQuery) => inviteRepo.listPage(params),

    async revokeInvite(id: string, actor: AdminActor): Promise<void> {
      const invite = await inviteRepo.findById(id);
      if (!invite) throw notFound('Invite not found.', 'INVITE_NOT_FOUND');
      if (invite.usedAt) throw badRequest('This invite has already been used.', 'INVITE_USED');
      if (invite.revokedAt) return;
      await inviteRepo.revoke(id, new Date());
      await audit.record({
        actorId: actor.id,
        action: AuditAction.InviteRevoked,
        targetType: 'invite',
        targetId: id,
        ip: actor.ip,
      });
    },

    // ── Registration access tokens (§6.12, §13.4 V4-P4a) ──────────────────────
    // Admin-issued tokens that gate the `invite_token` registration mode. The raw
    // token is only ever returned here, once, inside the register URL; the store
    // keeps its hash. All actions are audit-logged.
    async createRegistrationToken(
      input: CreateRegistrationTokenRequest,
      actor: AdminActor,
    ): Promise<{ token: RegistrationTokenRow; registerUrl: string }> {
      const { token, tokenHash } = generateToken();
      const expiresAt =
        input.expiresInDays === undefined
          ? null
          : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
      const row = await registrationTokenRepo.create({
        tokenHash,
        label: input.label?.trim() ? input.label.trim() : null,
        maxUses: input.maxUses,
        createdBy: actor.id,
        expiresAt,
      });
      await audit.record({
        actorId: actor.id,
        action: AuditAction.RegistrationTokenCreated,
        targetType: 'registration_token',
        targetId: row.id,
        ip: actor.ip,
        meta: { maxUses: row.maxUses, expiresAt: expiresAt?.toISOString() ?? null },
      });
      const registerUrl = `${config.appOrigin}/register?token=${token}`;
      return { token: row, registerUrl };
    },

    listRegistrationTokens: (params: AdminListQuery) => registrationTokenRepo.listPage(params),

    async revokeRegistrationToken(id: string, actor: AdminActor): Promise<void> {
      const row = await registrationTokenRepo.findById(id);
      if (!row) throw notFound('Registration token not found.', 'REGISTRATION_TOKEN_NOT_FOUND');
      if (row.revokedAt) return;
      await registrationTokenRepo.revoke(id, new Date());
      await audit.record({
        actorId: actor.id,
        action: AuditAction.RegistrationTokenRevoked,
        targetType: 'registration_token',
        targetId: id,
        ip: actor.ip,
      });
    },

    // ── Approval queue (§6.12, §13.4 V4-P4a) ──────────────────────────────────
    // Pending `approval`-mode applications. Approve creates the real account (with
    // the applicant's chosen password) and sends a localized decision email;
    // reject drops the application and sends its own decision email. Either way the
    // row is removed so it leaves the queue.
    listRegistrationRequests: (params: AdminListQuery) => registrationRequestRepo.listPage(params),

    async approveRegistrationRequest(id: string, actor: AdminActor): Promise<UserRow> {
      const pending = await registrationRequestRepo.findById(id);
      if (!pending) {
        throw notFound('Registration request not found.', 'REGISTRATION_REQUEST_NOT_FOUND');
      }
      // Re-check uniqueness at approval time — the email/username may have been
      // claimed by an admin-created account (or another approval) since the
      // application was filed.
      if (await userRepo.findByEmail(pending.email)) {
        throw conflict('An account already exists for this email.', 'EMAIL_TAKEN');
      }
      if (await userRepo.findByUsername(pending.username)) {
        throw conflict('That username is already taken.', 'USERNAME_TAKEN');
      }

      // CLAIM the application before anything is created. A decision is
      // one-shot: two operators (or one in two tabs) can otherwise approve and
      // reject the same application, leaving the applicant with a live account
      // AND a rejection letter. The loser of the race finds nothing to consume
      // and is refused here, before an account exists.
      const request = await registrationRequestRepo.claim(id);
      if (!request) throw registrationRequestDecided();

      // Link a Google identity when the application carried one (§13.4 V4-P4b).
      // Whether the account gets a USABLE password is independent of that: it
      // derives from whether a real hash was stored. A Google-assisted
      // application (owner order 2026-07-16) sets a password on the connected
      // form, so its approved account keeps that password AND the linked
      // identity; an older password-less Google application (null hash) still
      // mints a random unusable hash and flags the account password-less.
      const isFederated = request.provider !== null && request.providerSubject !== null;
      const hasUsablePassword = request.passwordHash !== null;
      const passwordHash =
        request.passwordHash ?? (await passwordHasher.hash(randomBytes(24).toString('hex')));
      let user: UserRow;
      try {
        user = await userRepo.create({
          email: request.email,
          username: request.username,
          passwordHash,
          hasUsablePassword,
          role: 'user',
          status: 'active',
          mustChangePassword: false,
          // Carry the language they applied in onto the account (matches the
          // decision-mail locale below).
          locale: request.locale,
        });
      } catch (error) {
        // Two applications for the same address, approved concurrently: both
        // pass the pre-check above and the loser dies on the users uniqueness
        // index. That is a conflict the operator can act on, not a 500.
        if (!isUniqueViolation(error)) throw error;
        throw (await userRepo.findByEmail(request.email))
          ? conflict('An account already exists for this email.', 'EMAIL_TAKEN')
          : conflict('That username is already taken.', 'USERNAME_TAKEN');
      }
      if (isFederated) {
        await identityRepo.create({
          userId: user.id,
          provider: request.provider!,
          subject: request.providerSubject!,
          email: user.email,
          emailVerified: request.providerEmailVerified,
        });
        await audit.record({
          actorId: actor.id,
          action: AuditAction.ExternalIdentityLinked,
          targetType: 'user',
          targetId: user.id,
          ip: actor.ip,
          meta: { provider: request.provider!, via: 'approval' },
        });
      }
      await portfolioRepo.createDefault(user.id);
      // Approval completes a self-serve registration — apply the same account
      // defaults (§13.4 V4-P0d) a direct signup gets, to this new account only.
      await applyAccountDefaultsAtRegistration(
        { appSettings, userRepo, notificationRepo },
        user.id,
      );

      await audit.record({
        actorId: actor.id,
        action: AuditAction.RegistrationRequestApproved,
        targetType: 'user',
        targetId: user.id,
        ip: actor.ip,
        meta: { requestId: id },
      });

      // Best-effort, post-commit: the account exists regardless of mail state.
      await email.sendRegistrationApproved({
        to: user.email,
        userId: user.id,
        username: user.username,
        locale: request.locale,
        audit: { actorId: actor.id, targetType: 'user', targetId: user.id, ip: actor.ip },
      });
      return user;
    },

    async rejectRegistrationRequest(id: string, actor: AdminActor): Promise<void> {
      if (!(await registrationRequestRepo.findById(id))) {
        throw notFound('Registration request not found.', 'REGISTRATION_REQUEST_NOT_FOUND');
      }
      // Same one-shot claim as approve: the rejection mail is only ever sent by
      // the caller that actually consumed the application, so a second reject —
      // or a reject racing an approve — cannot mail the applicant twice or write
      // to someone whose account another operator just created.
      const request = await registrationRequestRepo.claim(id);
      if (!request) throw registrationRequestDecided();
      await audit.record({
        actorId: actor.id,
        action: AuditAction.RegistrationRequestRejected,
        targetType: 'registration_request',
        targetId: id,
        ip: actor.ip,
        meta: { email: request.email },
      });
      // No account was ever created — the decision email carries no credential.
      // The audit target is the REQUEST, matching the decision row above: a
      // `user` row pointed at a request id can never surface through
      // `listUserAudit`, and would be claimed by whatever account later takes
      // that id.
      await email.sendRegistrationRejected({
        to: request.email,
        locale: request.locale,
        audit: {
          actorId: actor.id,
          targetType: 'registration_request',
          targetId: id,
          ip: actor.ip,
        },
      });
    },

    async stats(): Promise<{
      userCount: number;
      activeUserCount: number;
      disabledUserCount: number;
      pendingInviteCount: number;
      pendingRegistrationCount: number;
    }> {
      const counts = await userRepo.counts();
      const pendingInviteCount = await inviteRepo.pendingCount();
      // #1406 W1: the Overview attention row needs the approval-queue size, and a
      // count keeps that landing read bounded instead of listing the whole queue.
      const pendingRegistrationCount = await registrationRequestRepo.count();
      return {
        userCount: counts.total,
        activeUserCount: counts.activeRecentLogin,
        disabledUserCount: counts.disabled,
        pendingInviteCount,
        pendingRegistrationCount,
      };
    },

    listAudit: (params: { limit: number; cursor?: string }) => deps.audit.list(params),

    /** One user's audit history (§6.12) — entries whose target is this user. */
    async listUserAudit(userId: string, params: { limit: number; cursor?: string }) {
      await loadUser(userId); // 404 for an unknown user, like the other per-user reads.
      return deps.audit.listForTarget({
        targetId: userId,
        limit: params.limit,
        cursor: params.cursor,
      });
    },

    /** Global email send log, newest first (PROJECTPLAN.md §6.10, §6.12). */
    listEmails: (params: { limit: number; cursor?: string }): Promise<EmailLogPage> =>
      emailLog.listGlobal(params.limit, params.cursor),

    /** One user's email send log (PROJECTPLAN.md §6.10, §6.12). */
    async listUserEmails(
      userId: string,
      params: { limit: number; cursor?: string },
    ): Promise<EmailLogPage> {
      await loadUser(userId); // 404 for an unknown user, like the other per-user reads.
      return emailLog.listForUser(userId, params.limit, params.cursor);
    },

    /** Whether the email channel is configured + wired (PROJECTPLAN.md §6.11). */
    emailStatus(): { enabled: boolean } {
      return { enabled: email.enabled };
    },

    /** Current global app settings, defaults filled in (PROJECTPLAN.md §6.12). */
    getSettings: (): Promise<AppSettings> => appSettings.get(),

    /**
     * Persist a global-settings change and audit it (PROJECTPLAN.md §6.12, §8).
     * The settings service rejects any non-`closed` registration mode in V1;
     * every accepted change is recorded with the actor and what changed.
     */
    async updateSettings(input: UpdateAppSettingsRequest, actor: AdminActor): Promise<AppSettings> {
      const settings = await appSettings.update(input, actor.id);
      await audit.record({
        actorId: actor.id,
        action: AuditAction.SettingsUpdated,
        targetType: 'app_settings',
        targetId: null,
        ip: actor.ip,
        meta: { changed: input },
      });
      return settings;
    },

    /** Current admin session policy, env fallback filled in (§13.5 V5-P13c). */
    getSessionPolicy: (): Promise<AdminSessionPolicy> => appSettings.getAdminSessionPolicy(),

    /**
     * Persist the admin session lifetime and audit it (§13.5 V5-P13c). The
     * settings service clamps the value to the 6–24 h window; the change applies
     * to session reads on the next request with no redeploy.
     */
    async updateSessionPolicy(
      input: UpdateAdminSessionPolicyRequest,
      actor: AdminActor,
    ): Promise<AdminSessionPolicy> {
      const policy = await appSettings.setAdminSessionLifetimeHours(
        input.sessionLifetimeHours,
        actor.id,
      );
      await audit.record({
        actorId: actor.id,
        action: AuditAction.AdminSessionPolicyUpdated,
        targetType: 'app_settings',
        targetId: null,
        ip: actor.ip,
        meta: { changed: input },
      });
      return policy;
    },

    /** Current new-account defaults, lean fallbacks filled in (§13.4 V4-P0d). */
    async getAccountDefaults(): Promise<AccountDefaultsResponse> {
      const defaults = await appSettings.getAccountDefaults();
      const channelsConfigurable = channelsConfigurableFromConfig();
      return {
        ...defaults,
        // V5-P0 kill-switch (#1795): the editor hides a deactivated channel's
        // column, so the response must not carry values for it either — the UI
        // round-trips what it reads, and reading `true` for a dead channel is
        // how a hidden column silently re-seeds it on the next save.
        notificationMatrix: maskMatrix(defaults.notificationMatrix, channelsConfigurable),
        channelsConfigurable,
      };
    },

    /**
     * Persist a new-account-defaults change and audit it (§13.4 V4-P0d). The change
     * applies to the NEXT registration only — never to any existing account.
     */
    async updateAccountDefaults(
      input: UpdateAccountDefaultsRequest,
      actor: AdminActor,
    ): Promise<AccountDefaultsResponse> {
      const channelsConfigurable = channelsConfigurableFromConfig();
      let effective = input;
      if (input.notificationMatrix) {
        // V5-P0 kill-switch (#1795). Turning a deactivated channel ON is
        // refused by name — seeding every new account with a default for a
        // channel this build refuses to expose is an operator mistake, not a
        // preference. An OFF cell is accepted (that is what the hidden column
        // round-trips), but the STORED cell is kept regardless, so the admin's
        // pre-deactivation defaults come back with the env flip.
        const requested = deactivatedChannelsRequested(
          input.notificationMatrix,
          channelsConfigurable,
        );
        if (requested.length > 0) {
          throw badRequest(
            `This deployment does not offer the ${requested.join(' and ')} notification ` +
              `channel${requested.length > 1 ? 's' : ''}, so no default can be set for ` +
              `${requested.length > 1 ? 'them' : 'it'}.`,
            'CHANNEL_DEACTIVATED',
          );
        }
        const stored = await appSettings.getAccountDefaults();
        effective = {
          ...input,
          notificationMatrix: preserveDeactivatedCells(
            input.notificationMatrix,
            stored.notificationMatrix,
            channelsConfigurable,
          ),
        };
      }
      const defaults = await appSettings.updateAccountDefaults(effective, actor.id);
      await audit.record({
        actorId: actor.id,
        action: AuditAction.AccountDefaultsUpdated,
        targetType: 'app_settings',
        targetId: null,
        ip: actor.ip,
        // The EFFECTIVE change, not the request: what was actually persisted is
        // what an auditor needs to see.
        meta: { changed: effective },
      });
      return {
        ...defaults,
        notificationMatrix: maskMatrix(defaults.notificationMatrix, channelsConfigurable),
        channelsConfigurable,
      };
    },

    /**
     * Admin diagnostic (PROJECTPLAN.md §6.12): send a test email to confirm SMTP
     * works. Defaults to the admin's own address. The attempt is audited (status
     * only — never credentials); a disabled channel returns `skipped`.
     */
    async sendTestEmail(
      to: string | undefined,
      actor: AdminActor,
    ): Promise<EmailSendResult & { to: string }> {
      const adminUser = await loadUser(actor.id);
      const recipient = (to ?? adminUser.email).trim();
      const result = await email.sendTest({
        to: recipient,
        audit: { actorId: actor.id, targetType: 'user', targetId: actor.id, ip: actor.ip },
      });
      await audit.record({
        actorId: actor.id,
        action: AuditAction.EmailTestSent,
        targetType: 'user',
        targetId: actor.id,
        ip: actor.ip,
        meta:
          result.status === 'failed'
            ? { status: result.status, code: result.code }
            : { status: result.status },
      });
      return { ...result, to: recipient };
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
