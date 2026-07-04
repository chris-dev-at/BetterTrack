import { eq } from 'drizzle-orm';

import type { Database } from '../db';
import { appSettings, type AppSettingRow } from '../schema';

/**
 * Global app-settings persistence (PROJECTPLAN.md §5.5, §6.12). A keyed store:
 * `get`/`getAll` read rows, `upsert` writes one key's jsonb value and stamps the
 * admin who changed it. Typing of individual keys lives in the settings service.
 */
export function createAppSettingsRepository(db: Database) {
  return {
    async get(key: string): Promise<AppSettingRow | null> {
      const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
      return row ?? null;
    },

    getAll(): Promise<AppSettingRow[]> {
      return db.select().from(appSettings);
    },

    async upsert(key: string, value: unknown, updatedBy: string | null): Promise<AppSettingRow> {
      const [row] = await db
        .insert(appSettings)
        .values({ key, value, updatedBy })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value, updatedBy, updatedAt: new Date() },
        })
        .returning();
      if (!row) throw new Error('Failed to upsert app setting');
      return row;
    },
  };
}

export type AppSettingsRepository = ReturnType<typeof createAppSettingsRepository>;
