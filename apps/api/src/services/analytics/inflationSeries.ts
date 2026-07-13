/**
 * Static, checked-in monthly consumer-price index series for the Analytics
 * real-terms (inflation) mode (PROJECTPLAN §13.3 V3-P9).
 *
 * The V3 decision (issue #424) is a small maintained static series — NO live
 * data fetching. Each series is a monthly index; the pure domain
 * `deflateSeries({ kind: 'index', monthly })` deflates a nominal value series
 * by the ratio `index(windowStart) / index(day)`, so only the RELATIVE shape
 * matters — the absolute base year is irrelevant (AT/EU use 2015=100, the US
 * series uses its native 1982-84=100; both deflate identically).
 *
 * Granularity: annual-average anchors, keyed at each year's January (`YYYY-01`).
 * `deflateSeries` carries the latest month ≤ the target date forward, so a
 * whole calendar year deflates by that year's average — a deliberate v3
 * approximation. Refine to true monthly points from the sources below when the
 * page needs intra-year resolution; the domain math is unchanged (just denser
 * `monthly` arrays).
 *
 * ── Update recipe ──────────────────────────────────────────────────────────
 * • HICP-AT / HICP-EU — Eurostat table `prc_hicp_aind` (all-items HICP, annual
 *   average, index 2015=100), geo `AT` / `EA` (euro area). Append the new
 *   year's value as `{ month: 'YYYY-01', value }` and bump `lastUpdated`.
 *   https://ec.europa.eu/eurostat/databrowser/view/prc_hicp_aind/default/table
 * • CPI-US — US BLS series `CUUR0000SA0` (CPI-U, all items, U.S. city average,
 *   NSA, 1982-84=100), annual average. Append `{ month: 'YYYY-01', value }`.
 *   https://data.bls.gov/timeseries/CUUR0000SA0
 *
 * Values are published annual averages, rounded to one decimal. Treat as a
 * periodically-refreshed snapshot, not a live feed.
 */

export type InflationIndexId = 'hicp-at' | 'hicp-eu' | 'cpi-us';

/** One monthly index observation (carry-forward between points in the domain). */
export interface InflationIndexPoint {
  /** ISO `YYYY-MM`. */
  readonly month: string;
  /** Index level (native base year). */
  readonly value: number;
}

export interface InflationIndexSeries {
  readonly id: InflationIndexId;
  readonly label: string;
  /** Native index base, e.g. `'2015=100'`. */
  readonly unit: string;
  /** Provenance for the checked-in snapshot. */
  readonly source: string;
  /** ISO `YYYY-MM` of the latest observation carried below. */
  readonly lastUpdated: string;
  readonly monthly: readonly InflationIndexPoint[];
}

const yearly = (base: number, values: Record<number, number>): InflationIndexPoint[] =>
  Object.keys(values)
    .map(Number)
    .sort((a, b) => a - b)
    .map((year) => ({ month: `${year}-01`, value: values[year] ?? base }));

/**
 * Austria all-items HICP, annual average, 2015 = 100 (Eurostat `prc_hicp_aind`,
 * geo `AT`). Austria ran hotter than the euro-area average through 2022-24.
 */
const HICP_AT: InflationIndexSeries = {
  id: 'hicp-at',
  label: 'Austria HICP (all-items)',
  unit: '2015=100',
  source: 'Eurostat prc_hicp_aind (geo=AT, annual average)',
  lastUpdated: '2025-01',
  monthly: yearly(100, {
    2015: 100.0,
    2016: 101.0,
    2017: 103.1,
    2018: 105.2,
    2019: 106.7,
    2020: 108.2,
    2021: 111.2,
    2022: 120.6,
    2023: 130.0,
    2024: 133.6,
    2025: 137.0,
  }),
};

/**
 * Euro-area all-items HICP, annual average, 2015 = 100 (Eurostat
 * `prc_hicp_aind`, geo `EA`).
 */
const HICP_EU: InflationIndexSeries = {
  id: 'hicp-eu',
  label: 'Euro area HICP (all-items)',
  unit: '2015=100',
  source: 'Eurostat prc_hicp_aind (geo=EA, annual average)',
  lastUpdated: '2025-01',
  monthly: yearly(100, {
    2015: 100.0,
    2016: 100.2,
    2017: 101.8,
    2018: 103.6,
    2019: 104.8,
    2020: 105.1,
    2021: 107.8,
    2022: 116.8,
    2023: 123.2,
    2024: 126.1,
    2025: 128.6,
  }),
};

/**
 * US CPI-U, all items, U.S. city average, annual average, 1982-84 = 100 (US BLS
 * `CUUR0000SA0`, not seasonally adjusted).
 */
const CPI_US: InflationIndexSeries = {
  id: 'cpi-us',
  label: 'US CPI-U (all items)',
  unit: '1982-84=100',
  source: 'US BLS CUUR0000SA0 (annual average, NSA)',
  lastUpdated: '2025-01',
  monthly: yearly(237, {
    2015: 237.0,
    2016: 240.0,
    2017: 245.1,
    2018: 251.1,
    2019: 255.7,
    2020: 258.8,
    2021: 271.0,
    2022: 292.7,
    2023: 304.7,
    2024: 313.7,
    2025: 320.4,
  }),
};

/** The checked-in inflation index series, keyed by mode id. */
export const INFLATION_INDEX_SERIES: Record<InflationIndexId, InflationIndexSeries> = {
  'hicp-at': HICP_AT,
  'hicp-eu': HICP_EU,
  'cpi-us': CPI_US,
};
