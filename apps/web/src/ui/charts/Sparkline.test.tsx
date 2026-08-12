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
