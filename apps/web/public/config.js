// SPA runtime configuration (PROJECTPLAN.md §7.1). This DEFAULT stub ships in the
// image for dev + single-origin use: app kind "user", same-origin API (empty
// apiOrigin → relative /api/v1 via the Vite proxy or a co-located nginx).
//
// In a subdomains/ports deployment each nginx server block OVERWRITES this file
// at container start with the per-origin values (see infra/nginx/templates and
// docker-entrypoint), so the same built image serves every origin unchanged.
window.__BT__ = { app: 'user', apiOrigin: '' };
