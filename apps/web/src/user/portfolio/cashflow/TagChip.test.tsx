import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { TagChip } from './TagChip';

describe('TagChip', () => {
  test('renders its label in the truncatable element with its full name available', () => {
    const name = 'A deliberately long cash tag name that still remains available on hover';
    render(<TagChip color="#22c55e" name={name} />);

    const label = screen.getByText(name);
    expect(label).toHaveClass('bt-tag-chip__label');
    expect(label).toHaveAttribute('title', name);
    expect(label.parentElement).toHaveClass('bt-tag-chip');
  });
});
