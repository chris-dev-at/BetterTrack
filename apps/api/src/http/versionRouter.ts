import express from 'express';

import { versionResponseSchema } from '@bettertrack/contracts';

/**
 * Public deploy-verification marker (PROJECTPLAN.md §5 Meta): which commit the
 * running process was built from, so anyone — human or script, with NO auth —
 * can confirm a merged change actually reached the live deployment.
 *
 * The build stamps `BT_BUILD_SHA` / `BT_BUILD_TIME` into the runtime env (the
 * docker-compose `GIT_SHA`/`GIT_BUILD_TIME` build args → the api Dockerfile).
 * Read ONCE at boot (module load); an unset/empty value degrades to `"unknown"`
 * so the payload shape is always stable and the endpoint never fails.
 *
 * Mounted with the openapi docs, BEFORE the /api/v1 bearer/session/rate-limit/
 * CSRF chain (see app.ts), so it needs no session, no CSRF header, and never
 * spends the API rate limit.
 */
function readMarker(name: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : 'unknown';
}

const commit = readMarker('BT_BUILD_SHA');
const builtAt = readMarker('BT_BUILD_TIME');
const shortCommit = commit === 'unknown' ? 'unknown' : commit.slice(0, 7);

export const versionRouter = express.Router();

versionRouter.get('/version', (_req, res) => {
  // Run through the shared contract schema before it leaves the process, so the
  // API can never drift from what clients expect (mirrors healthRouter).
  const body = versionResponseSchema.parse({ commit, shortCommit, builtAt });
  res.json(body);
});
