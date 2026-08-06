/**
 * Normalize a request path for policy-table lookups. Express route matching is
 * case-insensitive and accepts a trailing slash by default, while query strings
 * are not part of the selected route.
 */
export function normalizeRoutePath(path: string): string {
  const pathname = path.split('?', 1)[0]!.replace(/\/+$/, '').toLowerCase();
  return pathname || '/';
}
