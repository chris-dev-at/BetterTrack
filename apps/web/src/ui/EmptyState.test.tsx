import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  test('renders the title', () => {
    render(<EmptyState title="Search your first stock →" />);
    expect(screen.getByText('Search your first stock →')).toBeInTheDocument();
  });

  test('renders the description when provided', () => {
    render(<EmptyState title="Nothing here" description="Add a stock to get started." />);
    expect(screen.getByText('Add a stock to get started.')).toBeInTheDocument();
  });

  test('omits the description when not provided', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByText(/Add a stock/)).not.toBeInTheDocument();
  });

  test('renders the icon slot when provided', () => {
    render(<EmptyState title="Empty" icon="📭" />);
    expect(screen.getByText('📭')).toBeInTheDocument();
  });

  test('omits the icon wrapper when no icon is given', () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument();
  });

  test('renders the CTA slot when provided', () => {
    render(<EmptyState title="Empty" cta={<button type="button">Add stock</button>} />);
    expect(screen.getByRole('button', { name: 'Add stock' })).toBeInTheDocument();
  });

  test('omits the CTA wrapper when not provided', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
