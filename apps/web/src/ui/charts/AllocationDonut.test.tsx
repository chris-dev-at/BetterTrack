import { render, screen, within } from '@testing-library/react';
import { cloneElement, isValidElement } from 'react';
import { describe, expect, test, vi } from 'vitest';

// Recharts' ResponsiveContainer measures the DOM, which jsdom reports as 0×0,
// so the chart would never render. Stub it to hand the child fixed dimensions —
// enough for the donut's SVG to be produced and asserted on.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            width: 200,
            height: 200,
          })
        : children,
  };
});

import { AllocationDonut } from './AllocationDonut';
import { sampleAllocation } from './fixtures';

describe('AllocationDonut', () => {
  test('renders an accessible legend with labels and shares from props', () => {
    render(<AllocationDonut data={sampleAllocation} />);

    const list = screen.getByRole('list');
    for (const seg of sampleAllocation) {
      expect(within(list).getByText(seg.label)).toBeInTheDocument();
    }
    // 32.5 of a total of 100 ⇒ "32.5%".
    expect(within(list).getByText('32.5%')).toBeInTheDocument();
    // The donut itself is labelled for screen readers.
    expect(screen.getByRole('img', { name: /allocation breakdown/i })).toBeInTheDocument();
  });

  test('draws a donut sector per segment', () => {
    const { container } = render(<AllocationDonut data={sampleAllocation} />);
    const sectors = container.querySelectorAll('path.recharts-sector');
    expect(sectors.length).toBe(sampleAllocation.length);
  });

  test('shows an empty state for no data or all-zero values', () => {
    const empty = render(<AllocationDonut data={[]} />);
    expect(empty.getByText(/no allocation data/i)).toBeInTheDocument();

    cleanupRender(empty);

    const zero = render(
      <AllocationDonut
        data={[
          { label: 'A', value: 0 },
          { label: 'B', value: 0 },
        ]}
      />,
    );
    expect(zero.getByText(/no allocation data/i)).toBeInTheDocument();
  });
});

// Tiny helper to unmount the first render before the second in a single test.
function cleanupRender({ unmount }: { unmount: () => void }) {
  unmount();
}
