/**
 * The interactive API reference page (PROJECTPLAN.md §6.13). It renders the
 * OpenAPI document served at `/openapi.json` using Scalar's standalone build
 * from a pinned CDN asset — no secrets, no session; it is the public "front
 * door" for people integrating BetterTrack.
 *
 * The URL is passed relative so the page works in both deployment topologies
 * (subdomains and ports) without knowing the API origin.
 */
const SCALAR_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.28';

export const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BetterTrack API reference</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="${SCALAR_CDN}"></script>
  </body>
</html>
`;

/**
 * Content-Security-Policy for the docs page only. The global helmet() default
 * (`default-src 'self'`) would block the CDN + inline bootstrap, so this route
 * overrides it with a scope wide enough for Scalar and nothing more.
 */
export const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: https:",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "connect-src 'self'",
].join('; ');
