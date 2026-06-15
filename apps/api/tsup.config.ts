import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/server.ts',
    'src/scripts/worker.ts',
    'src/scripts/migrate.ts',
    'src/scripts/seed.ts',
  ],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the workspace contracts package (consumed as source) into the
  // output so the runtime artifact has no unresolved workspace imports.
  noExternal: [/^@bettertrack\//],
});
