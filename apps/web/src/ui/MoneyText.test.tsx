import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { MoneyText } from './MoneyText';

describe('MoneyText', () => {
  test('renders symbol-last "1.234,56 €" (PROJECTPLAN §7.1)', () => {
    const { container } = render(<MoneyText amount={1234.56} />);
    expect(container.textContent).toContain('1.234,56 €');
  });

  test('renders an em dash for a null amount', () => {
    render(<MoneyText amount={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  test('renders a non-EUR currency symbol-last', () => {
    const { container } = render(<MoneyText amount={100} currency="USD" />);
    expect(container.textContent).toContain('100,00 $');
  });

  test('shows the EUR equivalent in parens for a non-EUR amount', () => {
    const { container } = render(<MoneyText amount={100} currency="USD" eurAmount={92.5} />);
    const inner = container.querySelector('span.ml-1');
    expect(inner?.textContent).toBe('(92,50 €)');
  });

  test('hides the EUR equivalent when the native currency is already EUR', () => {
    const { container } = render(<MoneyText amount={100} currency="EUR" eurAmount={100} />);
    expect(container.querySelector('span.ml-1')).not.toBeInTheDocument();
  });

  test('hides the EUR equivalent when eurAmount is omitted', () => {
    const { container } = render(<MoneyText amount={100} currency="USD" />);
    expect(container.querySelector('span.ml-1')).not.toBeInTheDocument();
  });

  test('hides the EUR equivalent when eurAmount is null', () => {
    const { container } = render(<MoneyText amount={100} currency="USD" eurAmount={null} />);
    expect(container.querySelector('span.ml-1')).not.toBeInTheDocument();
  });

  test('signed positive → emerald colour and a + prefix', () => {
    const { container } = render(<MoneyText amount={50} signed />);
    const span = container.querySelector('span');
    expect(span).toHaveClass('text-emerald-400');
    expect(span?.textContent).toMatch(/^\+50,00 €/);
  });

  test('signed negative → red colour', () => {
    const { container } = render(<MoneyText amount={-50} signed />);
    const span = container.querySelector('span');
    expect(span).toHaveClass('text-red-400');
    expect(span?.textContent).toContain('-50,00 €');
  });

  test('signed zero → neutral (no colour, no + prefix)', () => {
    const { container } = render(<MoneyText amount={0} signed />);
    const span = container.querySelector('span');
    expect(span).not.toHaveClass('text-emerald-400');
    expect(span).not.toHaveClass('text-red-400');
    expect(span?.textContent).toBe('0,00 €');
  });

  test('unsigned → no colour regardless of sign', () => {
    const { container } = render(<MoneyText amount={-10} />);
    const span = container.querySelector('span');
    expect(span).not.toHaveClass('text-red-400');
    expect(span).not.toHaveClass('text-emerald-400');
  });
});
