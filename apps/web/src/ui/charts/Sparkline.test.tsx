import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { I18nProvider } from '../../i18n';
import { Sparkline } from './Sparkline';
import { sampleSparkline } from './fixtures';

describe('Sparkline', () => {
  test('draws a polyline from a fixture series', () => {
    const { container } = render(<Sparkline data={sampleSparkline} />);
    const line = container.querySelector('polyline');
    expect(line).not.toBeNull();
    // One coordinate pair per data point.
    const pairs = line?.getAttribute('points')?.trim().split(/\s+/) ?? [];
    expect(pairs).toHaveLength(sampleSparkline.length);
  });

  /**
   * The stroke is a TOKEN, not a hex: an SVG attribute resolves `var(...)` at
   * paint time, so one watchlist repaints for both themes without a single row
   * re-rendering. Asserting the token is therefore asserting the mechanism —
   * a literal here would mean the sparkline had gone dark-only again.
   */
  test('colours an upward trend green and a downward trend red', () => {
    const up = render(<Sparkline data={[1, 2, 3]} />);
    expect(up.container.querySelector('polyline')).toHaveAttribute('stroke', 'var(--bt-chart-pos)');

    const down = render(<Sparkline data={[3, 2, 1]} />);
    expect(down.container.querySelector('polyline')).toHaveAttribute(
      'stroke',
      'var(--bt-chart-trend-down)',
    );
  });

  test('honours the positive override regardless of the series direction', () => {
    const { container } = render(<Sparkline data={[3, 2, 1]} positive />);
    expect(container.querySelector('polyline')).toHaveAttribute('stroke', 'var(--bt-chart-pos)');
  });

  test('renders a muted baseline for empty / single-point data', () => {
    const empty = render(<Sparkline data={[]} />);
    expect(empty.container.querySelector('polyline')).toBeNull();
    expect(empty.container.querySelector('line')).not.toBeNull();

    const single = render(<Sparkline data={[42]} />);
    expect(single.container.querySelector('polyline')).toBeNull();
    expect(single.container.querySelector('line')).not.toBeNull();
  });

  /** The x coordinate of every plotted point, in order. */
  function xs(container: HTMLElement): number[] {
    const points = container.querySelector('polyline')?.getAttribute('points') ?? '';
    return points
      .trim()
      .split(/\s+/)
      .map((pair) => Number(pair.split(',')[0]));
  }

  test('places points on the given time axis instead of spacing them evenly (#1790)', () => {
    // Two steps of 1 day, then one of 3: an irregular series (a dividend history
    // with a skipped quarter) must read as the gap it is.
    const day = 86_400_000;
    const { container } = render(
      <Sparkline data={[1, 2, 3, 4]} at={[0, day, 2 * day, 5 * day]} width={102} />,
    );
    const [a, b, c, d] = xs(container);
    expect(b! - a!).toBeCloseTo(c! - b!, 5);
    expect(d! - c!).toBeCloseTo(3 * (b! - a!), 5);
  });

  test('ignores an axis that does not describe the series', () => {
    // A mismatched length or a non-finite position would place values at the
    // wrong times — worse than the even spacing it replaces, so it is dropped.
    const even = xs(render(<Sparkline data={[1, 2, 3]} />).container);
    expect(xs(render(<Sparkline data={[1, 2, 3]} at={[0, 1]} />).container)).toEqual(even);
    expect(xs(render(<Sparkline data={[1, 2, 3]} at={[0, Number.NaN, 2]} />).container)).toEqual(
      even,
    );
    // …and so is an axis with no span at all: every point at one instant.
    expect(xs(render(<Sparkline data={[1, 2, 3]} at={[7, 7, 7]} />).container)).toEqual(even);
  });

  test('localizes its expression-backed accessibility fallbacks', () => {
    render(
      <I18nProvider initialLocale="de">
        <Sparkline data={[1, 2]} />
        <Sparkline data={[]} />
      </I18nProvider>,
    );

    expect(screen.getByRole('img', { name: 'Aufwärtstrend' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Keine Trenddaten' })).toBeInTheDocument();
  });
});
