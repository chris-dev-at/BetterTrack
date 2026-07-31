/**
 * Interface scale — how physically large the app renders (owner, 2026-07-30:
 * "on full hd it looks good with 120% scaling and on QHD it looks good with
 * 130%. and on the mac here it looks perfect like it is rn").
 *
 * A CSS pixel is not a fixed physical size. On a HiDPI panel — every Retina Mac,
 * and Windows at 125%+ display scaling — the browser paints one CSS pixel with
 * two or more device pixels, so text is rendered at twice the detail and stays
 * comfortable while small. On a 1× 1080p or 1440p desktop monitor the same CSS
 * pixel is one flat device pixel, read from further away, and the identical
 * layout comes out too small.
 *
 * That is a property of the SCREEN, not of the account, so the choice is stored
 * per device (`localStorage`) and never synced. The same login is correct at
 * 100% on the Mac and at 120–130% on the desktop monitor next to it.
 *
 * The scale is applied as `zoom` on the root element (see origin.css), the one
 * lever that scales type, controls, spacing and hairlines together. Two known
 * consequences, both handled:
 *
 *  - viewport units do not follow `zoom` — the stylesheet reads them through
 *    `--bt-vh` / `--bt-vw` / `--bt-dvh`, which divide the scale back out;
 *  - media queries do not follow it either, so a scaled-up window has fewer
 *    effective pixels than its breakpoints think. {@link autoUiScale} therefore
 *    only scales up when there is room to spare, and backs off on a small
 *    window rather than forcing a desktop layout into a phone's worth of space.
 */

/** Per-device, never synced: the scale answers "which screen is this?". */
export const UI_SCALE_STORAGE_KEY = 'bt.ui.scale';

/** Offered as fixed steps rather than a slider — a scale is a choice, not a dial. */
export const UI_SCALE_STEPS = [1, 1.1, 1.2, 1.3, 1.4] as const;

export type UiScaleSetting = 'auto' | (typeof UI_SCALE_STEPS)[number];

/** Everything {@link autoUiScale} needs, so it is testable without a browser. */
export interface DisplayProbe {
  devicePixelRatio: number;
  /** Logical screen width in CSS px (already divided by OS display scaling). */
  screenWidth: number;
  /** Current window width in CSS px. */
  innerWidth: number;
}

/**
 * Below this many effective CSS pixels the layout starts crossing its own
 * breakpoints (the widest is 1180px), which media queries cannot see through a
 * zoom. Automatic scaling stays inside it.
 */
const MIN_EFFECTIVE_WIDTH = 1250;

/**
 * The scale this display wants when the user has not chosen one.
 *
 * `devicePixelRatio` already carries the OS display scaling, so it separates the
 * two worlds cleanly: ≥1.5 means the platform is scaling for the user (Retina,
 * Windows at 150%) and the app must not scale on top of it. Below that it is a
 * 1× desktop monitor, and the step comes from its size — the two the owner
 * measured, and nothing invented in between.
 */
export function autoUiScale(probe: DisplayProbe): number {
  if (probe.devicePixelRatio >= 1.5) return 1;
  const wanted = probe.screenWidth >= 2400 ? 1.3 : probe.screenWidth >= 1900 ? 1.2 : 1;
  return clampToWindow(wanted, probe.innerWidth);
}

/** Never scale a window past the point where the desktop layout stops fitting. */
function clampToWindow(scale: number, innerWidth: number): number {
  if (scale <= 1 || innerWidth <= 0) return scale;
  const room = innerWidth / MIN_EFFECTIVE_WIDTH;
  return room >= scale ? scale : Math.max(1, Math.floor(room * 20) / 20);
}

function isStep(value: number): value is (typeof UI_SCALE_STEPS)[number] {
  return (UI_SCALE_STEPS as readonly number[]).includes(value);
}

/** The stored choice, or `auto` when there is none (or storage is unavailable). */
export function readUiScaleSetting(): UiScaleSetting {
  try {
    const raw = localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (raw === null || raw === 'auto') return 'auto';
    const value = Number(raw);
    return Number.isFinite(value) && isStep(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** Persist the choice. A storage failure only costs the next page load. */
export function writeUiScaleSetting(setting: UiScaleSetting): void {
  try {
    if (setting === 'auto') localStorage.removeItem(UI_SCALE_STORAGE_KEY);
    else localStorage.setItem(UI_SCALE_STORAGE_KEY, String(setting));
  } catch {
    // Private mode / storage disabled — the session still renders scaled.
  }
}

/**
 * The scale actually applied. An explicit choice is honoured as given: the user
 * can see the result and change it back, and second-guessing a deliberate pick
 * is worse than a tight layout.
 */
export function resolveUiScale(setting: UiScaleSetting, probe: DisplayProbe): number {
  return setting === 'auto' ? autoUiScale(probe) : setting;
}

/** Read the live display. Safe to call before React mounts. */
export function readDisplayProbe(): DisplayProbe {
  return {
    devicePixelRatio: window.devicePixelRatio || 1,
    screenWidth: window.screen?.width ?? window.innerWidth,
    innerWidth: window.innerWidth,
  };
}

/**
 * Paint the scale. Writes the custom property only — `zoom: var(--bt-zoom)` and
 * the compensated viewport units live in the stylesheet, so there is exactly one
 * place that knows what a scale DOES.
 */
export function applyUiScale(scale: number): void {
  const root = document.documentElement;
  if (scale === 1) root.style.removeProperty('--bt-zoom');
  else root.style.setProperty('--bt-zoom', String(scale));
}

/**
 * Apply the stored scale before the first paint. Called from the entry module
 * rather than from a React effect: mounting first and scaling afterwards shows
 * the whole app at the wrong size for a frame, which reads as a glitch on every
 * single page load.
 */
export function bootUiScale(): void {
  applyUiScale(resolveUiScale(readUiScaleSetting(), readDisplayProbe()));
}
