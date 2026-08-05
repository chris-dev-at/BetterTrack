import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { ComingSoon } from './ComingSoon';

test('renders the title, description and a "Coming soon" marker', () => {
  render(<ComingSoon title="Comparisons" description="Compare assets side by side." />);

  expect(screen.getByRole('heading', { name: 'Comparisons' })).toBeInTheDocument();
  expect(screen.getByText('Compare assets side by side.')).toBeInTheDocument();
  expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
});

test('description is optional', () => {
  render(<ComingSoon title="Backups" />);

  expect(screen.getByRole('heading', { name: 'Backups' })).toBeInTheDocument();
  expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
});

test('renders the CTA slot when provided', () => {
  render(
    <ComingSoon title="Transactions" cta={<a href="/portfolio">Open portfolio overview</a>} />,
  );

  expect(screen.getByRole('link', { name: 'Open portfolio overview' })).toHaveAttribute(
    'href',
    '/portfolio',
  );
});
