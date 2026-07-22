import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { DISCREET_MASK, setDiscreetMode, setMoneyCurrency } from '../lib/format';
import { MoneyText } from './MoneyText';

// The default currency AND discreet flag are module-level state driven by the
// auth runtime (§5.4, V3-P10d; §13.5 V5-P13 arc (a)) — reset both so tests
// stay order-independent.
afterEach(() => {
  setMoneyCurrency('EUR');
  setDiscreetMode(false);
});

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

  test('shows the base-currency equivalent in parens for a non-base amount', () => {
    const { container } = render(<MoneyText amount={100} currency="USD" convertedAmount={92.5} />);
    const inner = container.querySelector('span.ml-1');
    expect(inner?.textContent).toBe('(92,50 €)');
  });

  test('hides the equivalent when the native currency is already the base', () => {
    const { container } = render(<MoneyText amount={100} currency="EUR" convertedAmount={100} />);
    expect(container.querySelector('span.ml-1')).not.toBeInTheDocument();
  });

  test('hides the equivalent when convertedAmount is omitted', () => {
    const { container } = render(<MoneyText amount={100} currency="USD" />);
    expect(container.querySelector('span.ml-1')).not.toBeInTheDocument();
  });

  test('hides the equivalent when convertedAmount is null', () => {
    const { container } = render(<MoneyText amount={100} currency="USD" convertedAmount={null} />);
    expect(container.querySelector('span.ml-1')).not.toBeInTheDocument();
  });

  test('a USD base renders omitted-currency amounts in $ (§5.4, V3-P10d)', () => {
    setMoneyCurrency('USD');
    const { container } = render(<MoneyText amount={1234.56} />);
    expect(container.textContent).toContain('1.234,56 $');
  });

  test('a USD base shows the parenthesised equivalent in $ for a EUR-native amount', () => {
    setMoneyCurrency('USD');
    const { container } = render(<MoneyText amount={100} currency="EUR" convertedAmount={108} />);
    const inner = container.querySelector('span.ml-1');
    expect(inner?.textContent).toBe('(108,00 $)');
  });

  test('a USD base hides the equivalent for a USD-native amount', () => {
    setMoneyCurrency('USD');
    const { container } = render(<MoneyText amount={100} currency="USD" convertedAmount={100} />);
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

  // Discreet mode (§13.5 V5-P13 arc (a)): every path that would paint an
  // absolute amount must render the shared mask instead — including the
  // parenthesised base-currency equivalent, the sign colour and the `+` prefix
  // (which would otherwise leak whether the delta was positive or negative).

  test('discreet mode masks the amount', () => {
    setDiscreetMode(true);
    const { container } = render(<MoneyText amount={1234.56} />);
    expect(container.textContent).toBe(DISCREET_MASK);
  });

  test('discreet mode drops the parenthesised base-currency equivalent', () => {
    setDiscreetMode(true);
    const { container } = render(<MoneyText amount={100} currency="USD" convertedAmount={92.5} />);
    expect(container.querySelector('span.ml-1')).not.toBeInTheDocument();
    expect(container.textContent).toBe(DISCREET_MASK);
  });

  test('discreet mode strips the sign colour and the + prefix', () => {
    setDiscreetMode(true);
    const { container: pos } = render(<MoneyText amount={50} signed />);
    expect(pos.querySelector('span')).not.toHaveClass('text-emerald-400');
    expect(pos.textContent).toBe(DISCREET_MASK);
    const { container: neg } = render(<MoneyText amount={-50} signed />);
    expect(neg.querySelector('span')).not.toHaveClass('text-red-400');
    expect(neg.textContent).toBe(DISCREET_MASK);
  });

  test('discreet mode still shows the em dash for a null amount', () => {
    setDiscreetMode(true);
    render(<MoneyText amount={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
