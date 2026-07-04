import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { Disclaimer } from './Disclaimer';

describe('Disclaimer', () => {
  test('renders the given copy', () => {
    render(<Disclaimer>BetterTrack is not investment advice.</Disclaimer>);
    expect(screen.getByText('BetterTrack is not investment advice.')).toBeInTheDocument();
  });

  test('applies the muted footnote styling', () => {
    render(<Disclaimer>Market data may be delayed.</Disclaimer>);
    expect(screen.getByText('Market data may be delayed.')).toHaveClass('text-neutral-500');
  });

  test('merges an additional className', () => {
    render(<Disclaimer className="mt-4">Some copy</Disclaimer>);
    expect(screen.getByText('Some copy')).toHaveClass('mt-4', 'text-neutral-500');
  });
});
