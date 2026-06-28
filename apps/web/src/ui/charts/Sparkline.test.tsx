import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

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

  test('colours an upward trend green and a downward trend red', () => {
    const up = render(<Sparkline data={[1, 2, 3]} />);
    expect(up.container.querySelector('polyline')).toHaveAttribute('stroke', '#34d399');

    const down = render(<Sparkline data={[3, 2, 1]} />);
    expect(down.container.querySelector('polyline')).toHaveAttribute('stroke', '#f87171');
  });

  test('honours the positive override regardless of the series direction', () => {
    const { container } = render(<Sparkline data={[3, 2, 1]} positive />);
    expect(container.querySelector('polyline')).toHaveAttribute('stroke', '#34d399');
  });

  test('renders a muted baseline for empty / single-point data', () => {
    const empty = render(<Sparkline data={[]} />);
    expect(empty.container.querySelector('polyline')).toBeNull();
    expect(empty.container.querySelector('line')).not.toBeNull();

    const single = render(<Sparkline data={[42]} />);
    expect(single.container.querySelector('polyline')).toBeNull();
    expect(single.container.querySelector('line')).not.toBeNull();
  });
});
