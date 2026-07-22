import { render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import {
  DISCREET_MASK,
  EM_DASH,
  formatMoney,
  formatPercent,
  formatSignedDelta,
  formatUnitPrice,
  setDiscreetMode,
} from '../lib/format';
import { MoneyText } from './MoneyText';
import { StatCard } from './StatCard';

/**
 * Sweep-style test for discreet mode (§13.5 V5-P13 arc (a); #682 acceptance):
 * every money-rendering component / helper that goes through the shared format
 * seam produces NO currency-formatted output while discreet is on. This proves
 * the "toggle on → zero absolute amounts" invariant at the seam itself: any
 * surface later wired up must go through the seam to inherit the guarantee (and
 * the reviewer catches the escape via a hard-coded `€`/`$` in the render tree).
 *
 * Runs percent/quantity helpers in the same block to confirm relative values
 * stay live — the "percentages still render correctly" invariant.
 */

afterEach(() => setDiscreetMode(false));

// Every money helper used across the SPA — the ones that produce currency-
// formatted output, and therefore ALL must mask under discreet mode. A finder
// grep hit these three; anything new that flows a raw amount to the UI should
// pass through one of them (or MoneyText, tested below).
const MONEY_HELPERS = [
  { label: 'formatMoney', fn: () => formatMoney(1234.56) },
  { label: 'formatMoney (USD)', fn: () => formatMoney(1234.56, 'USD') },
  { label: 'formatUnitPrice', fn: () => formatUnitPrice(0.000012) },
  { label: 'formatUnitPrice (large)', fn: () => formatUnitPrice(1234.56, 'USD') },
  { label: 'formatSignedDelta (+)', fn: () => formatSignedDelta(50) },
  { label: 'formatSignedDelta (-)', fn: () => formatSignedDelta(-50) },
];

// The MoneyText render matrix — every prop combination that could paint a
// currency symbol.
const MONEY_COMPONENTS = [
  { label: 'MoneyText (base currency)', node: <MoneyText amount={1234.56} /> },
  { label: 'MoneyText (native)', node: <MoneyText amount={100} currency="USD" /> },
  {
    label: 'MoneyText (converted)',
    node: <MoneyText amount={100} currency="USD" convertedAmount={92.5} />,
  },
  { label: 'MoneyText (signed +)', node: <MoneyText amount={50} signed /> },
  { label: 'MoneyText (signed -)', node: <MoneyText amount={-50} signed /> },
  { label: 'MoneyText (unit price)', node: <MoneyText amount={0.000012} unitPrice /> },
  {
    label: 'StatCard (MoneyText value)',
    node: (
      <StatCard
        label="Portfolio"
        value={<MoneyText amount={1234.56} />}
        subValue={<MoneyText amount={-50} signed />}
      />
    ),
  },
];

// Every currency symbol the SPA can emit (§7.1 base currencies EUR/USD/CHF/GBP
// plus the intl-emitted USD abbreviation "US$"). Any of these on-screen while
// discreet is ON is a regression — the point of the mode is that NO absolute
// amount surfaces.
const CURRENCY_SYMBOLS = ['€', '$', 'US$', 'CHF', '£'];

/** Assert the rendered text contains no currency-formatted output. */
function assertNoCurrency(text: string): void {
  for (const symbol of CURRENCY_SYMBOLS) {
    expect(text).not.toContain(symbol);
  }
}

describe('discreet-mode sweep (§13.5 V5-P13 arc (a))', () => {
  test('every money helper masks — no currency symbol emitted', () => {
    setDiscreetMode(true);
    for (const { label, fn } of MONEY_HELPERS) {
      const out = fn();
      expect(out, `${label} should mask`).toBe(DISCREET_MASK);
      assertNoCurrency(out);
    }
  });

  test('every money component renders without a currency symbol', () => {
    setDiscreetMode(true);
    for (const { label, node } of MONEY_COMPONENTS) {
      const { container, unmount } = render(node);
      const text = container.textContent ?? '';
      expect(text, `${label} rendered text: ${text}`).toContain(DISCREET_MASK);
      assertNoCurrency(text);
      unmount();
    }
  });

  test('percentages and relative helpers stay live (the "percentages still render" invariant)', () => {
    setDiscreetMode(true);
    // These are the surfaces the acceptance criteria explicitly say must
    // continue to work. They must produce their percent glyph, NOT the mask.
    expect(formatPercent(2.5)).toBe('2,50 %');
    expect(formatPercent(2.5)).not.toBe(DISCREET_MASK);
    expect(formatPercent(0)).toBe('0,00 %');
  });

  test('em dash for missing values wins over the mask (nothing to hide)', () => {
    setDiscreetMode(true);
    expect(formatMoney(null)).toBe(EM_DASH);
    expect(formatUnitPrice(null)).toBe(EM_DASH);
    expect(formatSignedDelta(null)).toBe(EM_DASH);
  });

  test('toggling back restores every helper and component exactly', () => {
    // With discreet off (the afterEach reset would apply too, but be explicit):
    setDiscreetMode(false);
    expect(formatMoney(1234.56)).toBe('1.234,56 €');
    expect(formatUnitPrice(0.000012)).toBe('0,000012 €');
    expect(formatSignedDelta(50)).toBe('+50,00');

    // Component-level: the exact restored MoneyText output.
    const { container } = render(<MoneyText amount={1234.56} />);
    expect(container.textContent).toContain('1.234,56 €');
  });
});
