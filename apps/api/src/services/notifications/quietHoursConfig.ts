import type { QuietHoursConfig } from './quietHours';

/**
 * The quiet-hours columns a stored user row carries (§13.5 V5-P3). A thin slice
 * of `UserRow` so the dispatcher and digest job can build a {@link
 * QuietHoursConfig} from whatever recipient row they already fetched — no extra
 * query, no coupling to the full user shape.
 */
export interface QuietHoursUserRow {
  quietHoursEnabled: boolean;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  timezone: string | null;
}

/** Map a stored user row to the pure {@link QuietHoursConfig}. */
export function quietHoursConfigForUser(row: QuietHoursUserRow): QuietHoursConfig {
  return {
    enabled: row.quietHoursEnabled,
    startMinute: row.quietHoursStartMinute,
    endMinute: row.quietHoursEndMinute,
    timezone: row.timezone ?? null,
  };
}
