import { describe, expect, it } from 'vitest';

import { INFLATION_INDEX_SERIES, INFLATION_PRESET_IDS } from '../inflationSeries';

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

describe('checked-in inflation index series', () => {
  it('keeps picker ids unique and aligned with the series map', () => {
    const seriesIds = Object.keys(INFLATION_INDEX_SERIES);

    expect(new Set(INFLATION_PRESET_IDS)).toHaveLength(INFLATION_PRESET_IDS.length);
    expect([...INFLATION_PRESET_IDS].sort()).toEqual(seriesIds.sort());
  });

  it('keeps every series identifiable and documented', () => {
    for (const [id, series] of Object.entries(INFLATION_INDEX_SERIES)) {
      expect(series.id).toBe(id);
      expect(series.monthly.length).toBeGreaterThanOrEqual(2);
      expect(series.label.trim()).not.toBe('');
      expect(series.unit.trim()).not.toBe('');
      expect(series.source.trim()).not.toBe('');
    }
  });

  it('keeps observations usable for interpolation and lastUpdated in sync', () => {
    for (const series of Object.values(INFLATION_INDEX_SERIES)) {
      const months = series.monthly.map(({ month }) => month);

      for (const point of series.monthly) {
        expect(point.month).toMatch(MONTH_PATTERN);
        expect(Number.isFinite(point.value)).toBe(true);
        expect(point.value).toBeGreaterThan(0);
      }

      expect(new Set(months)).toHaveLength(months.length);
      expect(months).toEqual([...months].sort());
      expect(series.lastUpdated).toBe(months.at(-1));

      // Do not require index values to rise: a deflationary observation is valid.
    }
  });
});
