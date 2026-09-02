/**
 * `/control/<segment>`s that are real pages rather than popup panels. Static
 * paths used to outrank `:panel`; the shell matcher preserves that precedence.
 */
const CONTROL_PAGE_SEGMENTS: ReadonlySet<string> = new Set(['data']);

/**
 * Panel ids the R2 restructure renamed. An unknown id falls back to the DEFAULT
 * panel, which would silently land an old deep link (or an old bookmark) on
 * Account — so retired ids resolve explicitly instead.
 *
 * This lives beside the matcher rather than in `ControlCenterOverlay` (which is
 * lazy) because the shell resolves panel ids BEFORE the overlay chunk exists.
 */
const PANEL_ALIASES: Readonly<Record<string, string>> = {
  security: 'sign-in',
  'portfolio-defaults': 'defaults',
  'api-keys': 'api',
  taxes: 'defaults',
};

/** The panel that owns both privacy modes (discreet + the paranoid vault). */
export const PRIVACY_PANEL_ID = 'privacy';

/**
 * `/control/privacy?enable=1` — the mount seam `AccountModeRoot` still honours
 * for the legacy ACCOUNT-LEVEL client-encryption stack.
 *
 * RETIRED AS AN ENTRY POINT (PROJECTPLAN §16, 2026-08-30). Nothing in the app
 * produces this param any more: the Privacy panel's "Set up" row and its wizard
 * render are gone, so a link carrying it swaps the tree and then lands on the
 * ordinary panel. The seam is kept because the swap it triggers is
 * `AccountModeRoot`'s, not this module's, and removing it belongs with the §19
 * v1 retirement rather than with a UI ruling — `UserApp.accountMode.test.tsx`
 * pins that it is now inert.
 */
export const VAULT_ENABLE_PARAM = 'enable';

/** Apply the alias table; an id that is already current passes through. */
export function resolveControlPanelId(id: string): string {
  return PANEL_ALIASES[id] ?? id;
}

/** Resolve whether a pathname opens the Control Center popup. */
export function matchControlPanel(pathname: string): { panel: string | undefined } | null {
  const match = /^\/control(?:\/([^/]+))?\/?$/.exec(pathname);
  if (match === null) return null;
  const panel = match[1];
  if (panel !== undefined && CONTROL_PAGE_SEGMENTS.has(panel)) return null;
  return { panel };
}

/**
 * Is this location the explicit "set up the encrypted vault" request?
 *
 * Resolved through {@link matchControlPanel}/{@link resolveControlPanelId}
 * rather than by comparing a pathname literal, so renaming the panel or
 * aliasing its id keeps the gate and the panel pointing at the same surface.
 */
export function matchesVaultEnableRequest(pathname: string, search: string): boolean {
  const control = matchControlPanel(pathname);
  if (control?.panel === undefined) return false;
  if (resolveControlPanelId(control.panel) !== PRIVACY_PANEL_ID) return false;
  return new URLSearchParams(search).get(VAULT_ENABLE_PARAM) === '1';
}
