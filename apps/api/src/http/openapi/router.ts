import { Router } from 'express';

import { DOCS_CSP, DOCS_HTML } from './docsPage';
import { getOpenApiDocument } from './document';

/**
 * Public docs router (PROJECTPLAN.md §5 Meta, §6.13). Serves the OpenAPI
 * document and the human-readable reference at the API origin root:
 *
 *   - `GET /openapi.json` — the OpenAPI 3 document generated from the contracts.
 *   - `GET /docs`         — the interactive reference page.
 *
 * Both are **public** (`P`): they carry no secrets and must be mounted OUTSIDE
 * the session/CSRF/password-change chain that guards `/api/v1` (see app.ts).
 */
export function createOpenApiRouter(): Router {
  const router = Router();

  router.get('/openapi.json', (_req, res) => {
    res.json(getOpenApiDocument());
  });

  router.get('/docs', (_req, res) => {
    res.setHeader('Content-Security-Policy', DOCS_CSP);
    res.type('html').send(DOCS_HTML);
  });

  return router;
}
