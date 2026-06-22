import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  test('exposes an accessible loading status', () => {
    render(<Skeleton />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  test('block variant (default) is full width', () => {
    render(<Skeleton />);
    expect(screen.getByRole('status', { name: 'Loading' })).toHaveClass('w-full');
  });

  test('default height is h-4', () => {
    render(<Skeleton />);
    expect(screen.getByRole('status', { name: 'Loading' })).toHaveClass('h-4');
  });

  test('line variant defaults to w-24', () => {
    render(<Skeleton variant="line" />);
    expect(screen.getByRole('status', { name: 'Loading' })).toHaveClass('w-24');
  });

  test('explicit width overrides the default', () => {
    render(<Skeleton width="w-32" />);
    const el = screen.getByRole('status', { name: 'Loading' });
    expect(el).toHaveClass('w-32');
    expect(el).not.toHaveClass('w-full');
  });

  test('explicit height overrides the default', () => {
    render(<Skeleton height="h-8" />);
    const el = screen.getByRole('status', { name: 'Loading' });
    expect(el).toHaveClass('h-8');
    expect(el).not.toHaveClass('h-4');
  });

  test('animates via animate-pulse', () => {
    render(<Skeleton />);
    expect(screen.getByRole('status', { name: 'Loading' })).toHaveClass('animate-pulse');
  });
});
