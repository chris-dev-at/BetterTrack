import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

/**
 * Shared Drizzle database type. The production driver is postgres.js; tests
 * use an in-process PGlite instance cast to this same type (identical query
 * surface), so repositories are written once against `Database`.
 */
export type Database = PostgresJsDatabase<typeof schema>;

export function createDatabase(url: string): { db: Database; client: postgres.Sql } {
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema });
  return { db, client };
}
