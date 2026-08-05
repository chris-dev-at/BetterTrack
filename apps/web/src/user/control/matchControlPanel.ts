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
 * `/control/privacy?enable=1` — the ONE deliberate gesture that asks a
 * normal-mode account for the client-encryption stack. It rides in the URL so
 * the request survives the tree swap it triggers (see `AccountModeRoot`), which
 * is also why the panel drives its wizard from this param instead of local
 * state.
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
