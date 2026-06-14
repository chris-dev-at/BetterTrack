import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/data/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://bt:bt@localhost:5432/bettertrack',
  },
});
