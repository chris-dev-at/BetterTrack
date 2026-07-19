import {
  ADMIN_SESSION_LIFETIME_MAX_HOURS,
  ADMIN_SESSION_LIFETIME_MIN_HOURS,
  NOTIFICATION_TYPES,
  notificationChannelDefaultEnabled,
  notificationMatrixSchema,
  portfolioVisibilitySchema,
  registrationModeSchema,
  type AccountDefaults,
  type NotificationMatrix,
  type PortfolioVisibility,
  type RegistrationMode,
  type UpdateAccountDefaultsRequest,
  type UpdateAppSettingsRequest,
} from '@bettertrack/contracts';

import type { AppSettingsRepository } from '../../data/repositories/appSettingsRepository';
import { forbidden } from '../../errors';

/**
 * Global app settings (PROJECTPLAN.md §4, §5.5, §6.12, §13.4 V4-P4a). Typed
 * read/write over the keyed `app_settings` store, plus the registration-mode
 * enforcement guard the public register route reads.
 *
 * All four registration modes are live (V4-P4a): the stored mode is the single
 * source of truth for how (and whether) self-serve registration works, and the
 * admin may switch it at runtime with no restart. {@link getRegistrationMode}
 * feeds the enforcement path, {@link assertSelfRegistrationAllowed} rejects the
 * `closed` mode, and {@link update} persists any valid mode.
 */

/** Keyed-store keys (§5.5). One row per setting; the value is jsonb. */
export const REGISTRATION_MODE_KEY = 'registration_mode';
export const BETA_MODE_KEY = 'beta_mode';

/** Admin session absolute lifetime, in hours (§13.5 V5-P13c). */
export const ADMIN_SESSION_LIFETIME_HOURS_KEY = 'admin_session_lifetime_hours';

/** Account-defaults keys (§13.4 V4-P0d) — one row each; applied at registration. */
export const ACCOUNT_DEFAULT_CHAT_ENABLED_KEY = 'account_default_chat_enabled';
export const ACCOUNT_DEFAULT_PORTFOLIO_VISIBILITY_KEY = 'account_default_portfolio_visibility';
export const ACCOUNT_DEFAULT_DEVELOPER_STATUS_KEY = 'account_default_developer_status';
export const ACCOUNT_DEFAULT_NOTIFICATION_MATRIX_KEY = 'account_default_notification_matrix';

/** Defaults applied when a key has no row yet (§6.12). */
export const DEFAULT_REGISTRATION_MODE: RegistrationMode = 'closed';
export const DEFAULT_BETA_MODE = false;

/** Account-defaults fallbacks (§13.4 V4-P0d): chat on, portfolios private, dev off. */
export const DEFAULT_ACCOUNT_CHAT_ENABLED = true;
export const DEFAULT_ACCOUNT_PORTFOLIO_VISIBILITY: PortfolioVisibility = 'private';
export const DEFAULT_ACCOUNT_DEVELOPER_STATUS = false;

/**
 * The lean notification matrix a fresh account resolves to with NO stored
 * overrides (V4-P0c): the account-defaults panel is pre-seeded with exactly this,
 * so an unchanged panel writes no overrides at registration. Built from the ONE
 * source of truth ({@link notificationChannelDefaultEnabled}) so web, the
 * dispatcher and this default can never drift.
 */
export function leanDefaultNotificationMatrix(): NotificationMatrix {
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [
      type,
      {
        inapp: notificationChannelDefaultEnabled('inapp', type),
        email: notificationChannelDefaultEnabled('email', type),
        telegram: notificationChannelDefaultEnabled('telegram', type),
        discord: notificationChannelDefaultEnabled('discord', type),
        push: notificationChannelDefaultEnabled('push', type),
        webpush: notificationChannelDefaultEnabled('webpush', type),
      },
    ]),
  ) as NotificationMatrix;
}

/**
 * Which registration modes permit self-serve account creation. `closed` is
 * absent, so the guard rejects it; the other three each drive their own
 * concrete flow in the auth service (§13.4 V4-P4a).
 */
const SELF_REGISTRATION_MODES: ReadonlySet<RegistrationMode> = new Set<RegistrationMode>([
  'invite_token',
  'approval',
  'open',
]);

/** The resolved global settings, with defaults filled in and metadata. */
export interface AppSettings {
  registrationMode: RegistrationMode;
  betaMode: boolean;
  /** Most-recent `updated_at` across all stored keys; null when none are set. */
  updatedAt: Date | null;
  /** `updated_by` of the most-recently-written key; null when none are set. */
  updatedBy: string | null;
}

export interface AppSettingsServiceDeps {
  repo: AppSettingsRepository;
  /**
   * Env fallback for the admin session lifetime, in hours (§13.5 V5-P13c). Used
   * when no runtime override is stored; itself clamped to the 6–24 h window on
   * read, so a bad env value can never widen the window.
   */
  adminSessionLifetimeDefaultHours: number;
}

/** The resolved admin session policy, with the stored value (or env fallback). */
export interface AdminSessionPolicy {
  /** Absolute session lifetime in hours, clamped to the 6–24 h window. */
  sessionLifetimeHours: number;
  /** When the lifetime was last written; null while it sits at the env default. */
  updatedAt: Date | null;
  /** The admin who last wrote it; null when unset. */
  updatedBy: string | null;
}

/** Clamp any candidate lifetime to the plan's 6–24 h window (whole hours). */
function clampSessionLifetimeHours(value: number): number {
  const rounded = Math.round(value);
  return Math.min(
    ADMIN_SESSION_LIFETIME_MAX_HOURS,
    Math.max(ADMIN_SESSION_LIFETIME_MIN_HOURS, rounded),
  );
}

function parseRegistrationMode(value: unknown): RegistrationMode {
  const parsed = registrationModeSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_REGISTRATION_MODE;
}

export function createAppSettingsService(deps: AppSettingsServiceDeps) {
  const { repo } = deps;

  async function getRegistrationMode(): Promise<RegistrationMode> {
    const row = await repo.get(REGISTRATION_MODE_KEY);
    return parseRegistrationMode(row?.value);
  }

  async function get(): Promise<AppSettings> {
    const rows = await repo.getAll();
    const byKey = new Map(rows.map((row) => [row.key, row]));

    const registrationRow = byKey.get(REGISTRATION_MODE_KEY);
    const betaRow = byKey.get(BETA_MODE_KEY);

    // Metadata reflects the most-recently-written key across the whole store.
    const latest = rows.reduce<(typeof rows)[number] | null>((acc, row) => {
      if (!acc || row.updatedAt.getTime() > acc.updatedAt.getTime()) return row;
      return acc;
    }, null);

    return {
      registrationMode: parseRegistrationMode(registrationRow?.value),
      betaMode: typeof betaRow?.value === 'boolean' ? betaRow.value : DEFAULT_BETA_MODE,
      updatedAt: latest?.updatedAt ?? null,
      updatedBy: latest?.updatedBy ?? null,
    };
  }

  /**
   * Resolve the account defaults, filling every unset key with its lean fallback
   * (§13.4 V4-P0d). A stored notification matrix that no longer parses (schema
   * drift) falls back to the lean matrix rather than throwing.
   */
  async function getAccountDefaults(): Promise<AccountDefaults> {
    const rows = await repo.getAll();
    const byKey = new Map(rows.map((row) => [row.key, row]));

    const chatRow = byKey.get(ACCOUNT_DEFAULT_CHAT_ENABLED_KEY);
    const visibilityParsed = portfolioVisibilitySchema.safeParse(
      byKey.get(ACCOUNT_DEFAULT_PORTFOLIO_VISIBILITY_KEY)?.value,
    );
    const developerRow = byKey.get(ACCOUNT_DEFAULT_DEVELOPER_STATUS_KEY);
    const matrixParsed = notificationMatrixSchema.safeParse(
      byKey.get(ACCOUNT_DEFAULT_NOTIFICATION_MATRIX_KEY)?.value,
    );

    return {
      chatEnabled:
        typeof chatRow?.value === 'boolean' ? chatRow.value : DEFAULT_ACCOUNT_CHAT_ENABLED,
      defaultPortfolioVisibility: visibilityParsed.success
        ? visibilityParsed.data
        : DEFAULT_ACCOUNT_PORTFOLIO_VISIBILITY,
      developerStatus:
        typeof developerRow?.value === 'boolean'
          ? developerRow.value
          : DEFAULT_ACCOUNT_DEVELOPER_STATUS,
      notificationMatrix: matrixParsed.success
        ? matrixParsed.data
        : leanDefaultNotificationMatrix(),
    };
  }

  /**
   * The admin session policy (§13.5 V5-P13c). Returns the stored runtime
   * override when present (clamped defensively), else the env fallback — so the
   * effective lifetime is always within the 6–24 h window. Read on every admin
   * session resolve, so a write takes effect on the next request with no
   * redeploy.
   */
  async function getAdminSessionPolicy(): Promise<AdminSessionPolicy> {
    const row = await repo.get(ADMIN_SESSION_LIFETIME_HOURS_KEY);
    const stored =
      typeof row?.value === 'number' && Number.isFinite(row.value)
        ? clampSessionLifetimeHours(row.value)
        : null;
    return {
      sessionLifetimeHours:
        stored ?? clampSessionLifetimeHours(deps.adminSessionLifetimeDefaultHours),
      updatedAt: stored === null ? null : (row?.updatedAt ?? null),
      updatedBy: stored === null ? null : (row?.updatedBy ?? null),
    };
  }

  /** Just the effective lifetime in hours — the hot path for session resolve. */
  async function getAdminSessionLifetimeHours(): Promise<number> {
    return (await getAdminSessionPolicy()).sessionLifetimeHours;
  }

  return {
    get,
    getRegistrationMode,
    getAccountDefaults,
    getAdminSessionPolicy,
    getAdminSessionLifetimeHours,

    /**
     * Persist the admin session lifetime (§13.5 V5-P13c). The value is clamped to
     * the 6–24 h window before storing; the change applies to session reads on the
     * next request with no redeploy. Returns the full resolved policy.
     */
    async setAdminSessionLifetimeHours(
      hours: number,
      updatedBy: string | null,
    ): Promise<AdminSessionPolicy> {
      await repo.upsert(
        ADMIN_SESSION_LIFETIME_HOURS_KEY,
        clampSessionLifetimeHours(hours),
        updatedBy,
      );
      return getAdminSessionPolicy();
    },

    /**
     * Persist a partial account-defaults change (§13.4 V4-P0d). Only the supplied
     * keys are written; the change takes effect for the NEXT registration only and
     * never touches an existing account. Returns the full resolved defaults.
     */
    async updateAccountDefaults(
      input: UpdateAccountDefaultsRequest,
      updatedBy: string | null,
    ): Promise<AccountDefaults> {
      if (input.chatEnabled !== undefined) {
        await repo.upsert(ACCOUNT_DEFAULT_CHAT_ENABLED_KEY, input.chatEnabled, updatedBy);
      }
      if (input.defaultPortfolioVisibility !== undefined) {
        await repo.upsert(
          ACCOUNT_DEFAULT_PORTFOLIO_VISIBILITY_KEY,
          input.defaultPortfolioVisibility,
          updatedBy,
        );
      }
      if (input.developerStatus !== undefined) {
        await repo.upsert(ACCOUNT_DEFAULT_DEVELOPER_STATUS_KEY, input.developerStatus, updatedBy);
      }
      if (input.notificationMatrix !== undefined) {
        await repo.upsert(
          ACCOUNT_DEFAULT_NOTIFICATION_MATRIX_KEY,
          input.notificationMatrix,
          updatedBy,
        );
      }
      return getAccountDefaults();
    },

    /**
     * Reject with 403 `REGISTRATION_CLOSED` unless the stored mode permits
     * self-serve registration. The concrete per-mode flow (open / invite-token /
     * approval) is decided by the auth service once this passes (§13.4 V4-P4a).
     */
    async assertSelfRegistrationAllowed(): Promise<void> {
      const mode = await getRegistrationMode();
      if (!SELF_REGISTRATION_MODES.has(mode)) {
        throw forbidden('Self-serve registration is disabled.', 'REGISTRATION_CLOSED');
      }
    },

    /**
     * Persist a partial settings change (§6.12). Any of the four registration
     * modes is accepted as of V4-P4a — the enforcement layer honours each one, so
     * switching the mode takes effect immediately with no restart.
     */
    async update(input: UpdateAppSettingsRequest, updatedBy: string | null): Promise<AppSettings> {
      if (input.registrationMode !== undefined) {
        await repo.upsert(REGISTRATION_MODE_KEY, input.registrationMode, updatedBy);
      }
      if (input.betaMode !== undefined) {
        await repo.upsert(BETA_MODE_KEY, input.betaMode, updatedBy);
      }
      return get();
    },
  };
}

export type AppSettingsService = ReturnType<typeof createAppSettingsService>;
