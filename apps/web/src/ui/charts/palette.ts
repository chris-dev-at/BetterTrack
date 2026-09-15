/**
 * Origin chart color system (docs/history/redesign/REAL_APP_REDESIGN_PROMPT.md +
 * the dataviz method).
 *
 * - `MAIN_SERIES` is the calm analytical blue the spec reserves for neutral,
 *   single-series data (portfolio value, an asset's price). A lone line is not
 *   a categorical palette, so the spec hue is used verbatim.
 * - `CATEGORICAL_SERIES` is the fixed-order identity palette for multi-series
 *   contexts (overlays, allocation slices, comparisons). Validated with the
 *   dataviz six-checks script against the dark surface #10151b: lightness band,
 *   chroma floor, adjacent-pair CVD separation, normal-vision floor and
 *   contrast all PASS. Assign by index in this order — never re-sort by rank.
 * - Gains/losses keep the semantic pair (`POSITIVE`/`NEGATIVE`); gold stays a
 *   brand/action signal and is used in charts only for event flags.
 *
 * ── Why these are `var(...)` and not hexes (board #68) ────────────────────
 *
 * Every value below now names a token in `styles/origin.css`, which carries the
 * dark hue AND its light counterpart. The dark values are unchanged — the token
 * block holds the exact literals this file used to spell out — so the dark
 * theme is pixel-identical, and light mode arrives without a single call site
 * learning that themes exist.
 *
 * That works because a CSS custom property is legal anywhere a colour is: SVG
 * `stroke`/`fill` attributes, inline `style`, and Recharts' `<Cell fill>` (which
 * is an SVG attribute underneath). Consumers keep passing these constants
 * around exactly as before and the browser resolves them per theme, per paint.
 *
 * The one place it does NOT work is a canvas. `lightweight-charts` paints into
 * a 2D context and can only be handed a concrete colour, so `PriceChart` calls
 * {@link resolveChartColors} instead and re-applies on a theme change.
 */

/** A themed chart colour: a token reference the browser resolves per theme. */
const token = (name: string): string => `var(--bt-chart-${name})`;

export const MAIN_SERIES = token('main');
export const MAIN_AREA_TOP = token('main-top');
export const MAIN_AREA_BOTTOM = token('main-bottom');

export const CATEGORICAL_SERIES = [
  token('1'), // blue — slot 1, the categorical cousin of the analytical blue
  token('2'), // orange
  token('3'), // green
  token('4'), // yellow
  token('5'), // magenta
  token('6'), // violet
  token('7'), // teal
  token('8'), // red-brown
  token('9'), // lime
  token('10'), // purple
] as const;

/**
 * Colour for the `i`-th categorical series. Slices past the palette length
 * wrap; every consumer pairs the colour with a labelled legend and mark gaps,
 * so identity is never carried by colour alone.
 */
export function categoricalColor(index: number): string {
  return CATEGORICAL_SERIES[index % CATEGORICAL_SERIES.length]!;
}

export const POSITIVE = token('pos');
export const NEGATIVE = token('neg');
/** A series with no direction to report (a flat sparkline). */
export const FLAT = token('flat');
/**
 * The sparkline's downward stroke — historically Tailwind red-400 (`#f87171`),
 * a shade off {@link NEGATIVE}. Kept as its own token so the light theme could
 * be added without moving that dark pixel; see `Sparkline.tsx`.
 */
export const TREND_DOWN = token('trend-down');
export const GOLD_FLAG = token('flag');
export const BENCHMARK = token('benchmark');

/** Chart chrome on the app canvas: recessive grid + axis ink. */
export const CHART_GRID = token('grid');
export const CHART_TEXT = token('text');

/**
 * The concrete colours a canvas-backed chart needs, resolved out of the live
 * cascade. Keyed by the same names as the tokens.
 *
 * The fallbacks are the DARK literals, and they are load-bearing rather than
 * defensive: `getComputedStyle` returns an empty string for a custom property
 * whenever the stylesheet has not been applied — every jsdom component test,
 * and the first paint of a document whose CSS is still in flight. Falling back
 * to dark keeps those cases rendering the app's default theme instead of an
 * un-styled chart with no grid and invisible text.
 */
const CANVAS_FALLBACKS = {
  main: '#38bdf8',
  'main-top': 'rgba(56, 189, 248, 0.22)',
  'main-bottom': 'rgba(56, 189, 248, 0.02)',
  grid: 'rgba(222, 230, 239, 0.06)',
  text: '#77818d',
  pos: '#34d399',
  'pos-top': 'rgba(52, 211, 153, 0.22)',
  'pos-bottom': 'rgba(52, 211, 153, 0.02)',
  neg: '#fb7185',
  'neg-top': 'rgba(251, 113, 133, 0.02)',
  'neg-bottom': 'rgba(251, 113, 133, 0.22)',
  flat: '#71717a',
  'trend-down': '#f87171',
  flag: '#f6b82e',
  benchmark: '#9085e9',
  1: '#3987e5',
  2: '#d95926',
  3: '#199e70',
  4: '#c98500',
  5: '#d55181',
  6: '#9085e9',
  7: '#0d9488',
  8: '#c0453f',
  9: '#7a9e2b',
  10: '#b06fc9',
} as const;

export type ChartColorName = keyof typeof CANVAS_FALLBACKS;
export type ChartColors = Readonly<Record<ChartColorName, string>> & {
  /** The resolved categorical ramp, in palette order. */
  categorical: readonly string[];
};

/**
 * Read the chart tokens off the root element as concrete colour strings.
 *
 * Call this per render of a canvas chart rather than caching it at module load:
 * a theme change rewrites the cascade, and a value captured at import time
 * would pin the chart to whichever theme happened to boot first.
 */
export function resolveChartColors(): ChartColors {
  let read: (name: string) => string = () => '';
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    try {
      const computed = window.getComputedStyle(document.documentElement);
      read = (name) => computed.getPropertyValue(`--bt-chart-${name}`).trim();
    } catch {
      // A detached document — fall through to the dark defaults.
    }
  }

  const resolved = {} as Record<ChartColorName, string>;
  for (const name of Object.keys(CANVAS_FALLBACKS) as ChartColorName[]) {
    resolved[name] = read(String(name)) || CANVAS_FALLBACKS[name];
  }

  return {
    ...resolved,
    categorical: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((slot) => resolved[slot as ChartColorName]),
  };
}
