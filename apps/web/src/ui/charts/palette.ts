/**
 * Origin chart color system (docs/redesign/REAL_APP_REDESIGN_PROMPT.md +
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
 */
export const MAIN_SERIES = '#38bdf8';
export const MAIN_AREA_TOP = 'rgba(56, 189, 248, 0.22)';
export const MAIN_AREA_BOTTOM = 'rgba(56, 189, 248, 0.02)';

export const CATEGORICAL_SERIES = [
  '#3987e5', // blue — slot 1, the categorical cousin of the analytical blue
  '#d95926', // orange
  '#199e70', // green
  '#c98500', // yellow
  '#d55181', // magenta
  '#9085e9', // violet
  '#0d9488', // teal
  '#c0453f', // red-brown
  '#7a9e2b', // lime
  '#b06fc9', // purple
] as const;

/**
 * Colour for the `i`-th categorical series. Slices past the palette length
 * wrap; every consumer pairs the colour with a labelled legend and mark gaps,
 * so identity is never carried by colour alone.
 */
export function categoricalColor(index: number): string {
  return CATEGORICAL_SERIES[index % CATEGORICAL_SERIES.length]!;
}

export const POSITIVE = '#34d399';
export const NEGATIVE = '#fb7185';
export const GOLD_FLAG = '#f6b82e';
export const BENCHMARK = '#9085e9';

/** Chart chrome on the graphite canvas: recessive grid + axis ink. */
export const CHART_GRID = 'rgba(222, 230, 239, 0.06)';
export const CHART_TEXT = '#77818d';
