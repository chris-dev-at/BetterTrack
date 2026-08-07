import { beforeEach, describe, expect, test, vi } from 'vitest';

import { readChartDisplayMode, writeChartDisplayMode } from './displayMode';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('chart display mode persistence (board #68 item 4)', () => {
  test('defaults to the € curve until a mode is chosen, then round-trips', () => {
    expect(readChartDisplayMode('portfolio-overview')).toBe('value');

    writeChartDisplayMode('portfolio-overview', 'perf');
    expect(readChartDisplayMode('portfolio-overview')).toBe('perf');
    expect(localStorage.getItem('bettertrack.chartDisplayMode.portfolio-overview')).toBe('perf');
  });

  test('surfaces keep separate memories', () => {
    writeChartDisplayMode('portfolio-overview', 'perf');

    expect(readChartDisplayMode('portfolio-analysis')).toBe('value');
    writeChartDisplayMode('portfolio-analysis', 'perf');
    writeChartDisplayMode('portfolio-overview', 'value');
    expect(readChartDisplayMode('portfolio-analysis')).toBe('perf');
    expect(readChartDisplayMode('portfolio-overview')).toBe('value');
  });

  test('a foreign or corrupted stored value falls back to the default', () => {
    localStorage.setItem('bettertrack.chartDisplayMode.portfolio-overview', 'PERF');
    expect(readChartDisplayMode('portfolio-overview')).toBe('value');

    localStorage.setItem('bettertrack.chartDisplayMode.portfolio-overview', '{"mode":"perf"}');
    expect(readChartDisplayMode('portfolio-overview')).toBe('value');
  });

  test('unavailable storage degrades to the default instead of throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(readChartDisplayMode('portfolio-overview')).toBe('value');
    // A display preference must never be able to break a page render.
    expect(() => writeChartDisplayMode('portfolio-overview', 'perf')).not.toThrow();
  });
});
