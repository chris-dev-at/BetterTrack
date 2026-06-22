import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { StatCard } from './StatCard';

describe('StatCard', () => {
  test('renders the label and value', () => {
    render(<StatCard label="Portfolio value" value="1.234,56 €" />);
    expect(screen.getByText('Portfolio value')).toBeInTheDocument();
    expect(screen.getByText('1.234,56 €')).toBeInTheDocument();
  });

  test('renders the sub-value when provided', () => {
    render(<StatCard label="Day change" value="+12,34 €" subValue="+1,0 %" />);
    expect(screen.getByText('+1,0 %')).toBeInTheDocument();
  });

  test('omits the sub-value element when not provided', () => {
    const { container } = render(<StatCard label="Total" value="100 €" />);
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });

  test('accepts a ReactNode value', () => {
    render(<StatCard label="Status" value={<span data-testid="badge">Active</span>} />);
    expect(screen.getByTestId('badge')).toBeInTheDocument();
  });

  test('forwards an extra className to the root', () => {
    const { container } = render(<StatCard label="L" value="V" className="custom-class" />);
    expect(container.firstChild).toHaveClass('custom-class');
  });
});
