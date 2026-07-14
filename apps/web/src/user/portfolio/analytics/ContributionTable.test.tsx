import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import type { AnalyticsContributionRow, PortfolioAsset } from '@bettertrack/contracts';

import { ContributionTable } from './ContributionTable';

const AAPL: PortfolioAsset = {
  id: 'a1',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  exchange: 'NASDAQ',
  currency: 'USD',
  type: 'stock',
  isCustom: false,
};

const ROW: AnalyticsContributionRow = {
  asset: AAPL,
  value: 1350,
  cost: 900,
  pnl: 450,
  weight: 0.5,
  contributionPct: 12,
};

describe('ContributionTable', () => {
  test('renders a row with locale-formatted money, weight and contribution', () => {
    render(<ContributionTable rows={[ROW]} baseCurrency="EUR" />);
    const row = within(screen.getByRole('table')).getAllByRole('row')[1]!;
    expect(within(row).getByText('AAPL')).toBeInTheDocument();
    expect(within(row).getByText('1.350,00 €')).toBeInTheDocument();
    expect(within(row).getByText('900,00 €')).toBeInTheDocument();
    // P/L is sign-prefixed for gains.
    expect(within(row).getByText('+450,00 €')).toBeInTheDocument();
    // weight is a 0..1 fraction rendered as a percent.
    expect(within(row).getByText('50,00 %')).toBeInTheDocument();
    expect(within(row).getByText('+12,00 %')).toBeInTheDocument();
  });

  test('shows an empty state when the visible set is empty', () => {
    render(<ContributionTable rows={[]} baseCurrency="EUR" />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No visible assets — adjust the filters above.')).toBeInTheDocument();
  });
});
