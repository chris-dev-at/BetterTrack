/**
 * `/control/<segment>`s that are real pages rather than popup panels. Static
 * paths used to outrank `:panel`; the shell matcher preserves that precedence.
 */
const CONTROL_PAGE_SEGMENTS: ReadonlySet<string> = new Set(['data']);

/** Resolve whether a pathname opens the Control Center popup. */
export function matchControlPanel(pathname: string): { panel: string | undefined } | null {
  const match = /^\/control(?:\/([^/]+))?\/?$/.exec(pathname);
  if (match === null) return null;
  const panel = match[1];
  if (panel !== undefined && CONTROL_PAGE_SEGMENTS.has(panel)) return null;
  return { panel };
}
