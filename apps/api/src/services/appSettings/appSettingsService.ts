import {
  registrationModeSchema,
  type RegistrationMode,
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

/** Defaults applied when a key has no row yet (§6.12). */
export const DEFAULT_REGISTRATION_MODE: RegistrationMode = 'closed';
export const DEFAULT_BETA_MODE = false;

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

  return {
    get,
    getRegistrationMode,

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
