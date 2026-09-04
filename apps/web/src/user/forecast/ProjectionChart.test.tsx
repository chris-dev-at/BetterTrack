import { render } from '@testing-library/react';
import { cloneElement, isValidElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Recharts' ResponsiveContainer measures the DOM, which jsdom reports as 0×0,
// so the chart would never render. Stub it to hand the child fixed dimensions —
// enough for the axes to be produced and their tick labels asserted on.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            width: 640,
            height: 320,
          })
        : children,
  };
});

import {
  setDiscreetMode,
  setFormatLocale,
  setMoneyCurrency,
  DISCREET_MASK,
} from '../../lib/format';
import { ProjectionChart } from './ProjectionChart';

/** Five yearly points spanning 1.0M → 2.0M, so every y tick lands in millions. */
const DATA = [
  { date: '2026-01-01', base: 1_000_000 },
  { date: '2027-01-01', base: 1_250_000 },
  { date: '2028-01-01', base: 1_500_000 },
  { date: '2029-01-01', base: 1_750_000 },
  { date: '2030-01-01', base: 2_000_000 },
];

function renderChart() {
  return render(
    <ProjectionChart baseColor="#38bdf8" baseLabel="Projection" data={DATA} overlays={[]} />,
  );
}

/**
 * Every rendered tick label on the VALUE axis. Recharts renders both axes' ticks
 * with the same class, so the x axis' bare four-digit years are filtered out.
 */
function axisLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.recharts-cartesian-axis-tick-value')]
    .map((node) => node.textContent ?? '')
    .filter((text) => text.length > 0 && !/^\d{4}$/.test(text));
}

/**
 * The Forecast axis used to hardcode `€` and an English `M`/`k` pair, labelling
 * the curve with a currency it never checked — the same defect as the projection
 * summing a EUR dividend into a base-denominated balance, one layer up (#1741).
 */
describe('ProjectionChart value axis (#1741)', () => {
  afterEach(() => {
    setMoneyCurrency('EUR');
    setFormatLocale('de-AT');
    setDiscreetMode(false);
  });

  test('labels the ticks in the active base currency and locale', () => {
    const { container } = renderChart();
    const labels = axisLabels(container);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label.endsWith(' €'))).toBe(true);
    expect(labels.some((label) => label.includes('Mio.'))).toBe(true);
  });

  test('follows a non-EUR base currency', () => {
    setMoneyCurrency('USD');
    const labels = axisLabels(renderChart().container);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label.endsWith(' $'))).toBe(true);
    expect(labels.every((label) => !label.includes('€'))).toBe(true);
  });

  test('follows the active locale’s magnitude wording', () => {
    setFormatLocale('en-GB');
    const labels = axisLabels(renderChart().container);
    expect(labels.some((label) => /\dm( |$)/.test(label))).toBe(true);
    expect(labels.every((label) => !label.includes('Mio.'))).toBe(true);
  });

  test('still masks the axis in discreet mode', () => {
    setDiscreetMode(true);
    const labels = axisLabels(renderChart().container);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label === DISCREET_MASK)).toBe(true);
  });
});
