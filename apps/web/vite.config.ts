import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In dev, the API runs separately; same-origin proxy keeps cookies simple
    // (mirrors the nginx topology described in PROJECTPLAN.md §4.6).
    proxy: {
      '/api': 'http://localhost:3000',
      // Realtime gateway websocket (§4.5, V3-P7a) — same-origin in dev, like /api.
      '/ws': { target: 'http://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
