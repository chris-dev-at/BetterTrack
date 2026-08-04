// Serves the SAME SPA bundle in ADMIN mode on its own origin, the way nginx
// does in production by overwriting `config.js` per server block
// (PROJECTPLAN.md §7.1). The app kind is a RUNTIME fact, not a build flag, so
// there is nothing to build differently — only `/config.js` differs.
//
// Run alongside the user dev server:
//
//   npx vite --config vite.admin.config.mts   # http://localhost:6772
//
// The API must allow the origin — `BT_ADMIN_ORIGIN=http://localhost:6772` in
// apps/api/.env.
//
// Playwright boots this too (`playwright.config.ts`, on its own port), because
// the admin console is otherwise unreachable under test: the user dev server
// answers `/admin/*` with the USER app, which has no such route and falls
// through to the sign-in page — which is exactly what the approval-mode spec
// was failing on, having never had an admin origin to talk to.
import { mergeConfig, type Plugin } from 'vite';

import base from './vite.config';

const ADMIN_CONFIG_JS = `window.__BT__ = { app: 'admin', apiOrigin: '' };\n`;

/** Answers /config.js with the admin runtime config before static serving. */
function adminRuntimeConfig(): Plugin {
  return {
    name: 'bt-admin-runtime-config',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/config.js') return next();
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end(ADMIN_CONFIG_JS);
      });
    },
  };
}

export default mergeConfig(base, {
  // The e2e stack starts the user and admin Vite servers together. Their
  // different plugin graphs must not race over one optimize-deps cache or the
  // user app can receive 504 "Outdated Optimize Dep" modules mid-run.
  cacheDir: 'node_modules/.vite-admin',
  plugins: [adminRuntimeConfig()],
  // `--port` on the command line still wins, which is how the e2e boot moves
  // this off a developer's own admin server.
  server: { port: 6772, strictPort: true },
});
