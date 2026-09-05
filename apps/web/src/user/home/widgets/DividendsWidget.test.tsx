import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { DividendCalendarEntry } from '@bettertrack/contracts';

vi.mock('../../../lib/marketIntelApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/marketIntelApi')>()),
  getPortfolioDividendCalendar: vi.fn(),
}));

import { formatDate } from '../../../lib/format';
import { getPortfolioDividendCalendar } from '../../../lib/marketIntelApi';

import { DividendsWidget } from './DividendsWidget';
import type { WidgetProps } from './types';

const BASE_PROPS: Omit<WidgetProps, 'settings' | 'size'> = {
  onSettingsChange: vi.fn(),
  portfolios: [],
  scopedPortfolios: [],
  scopedPortfolio: null,
  portfoliosLoading: false,
};

function renderWidget(size: WidgetProps['size'] = 'm') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DividendsWidget {...BASE_PROPS} settings={{}} size={size} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Dates relative to the real clock, so the fixture never rots. */
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

function entry(over: Partial<DividendCalendarEntry>): DividendCalendarEntry {
  return {
    assetId: 'a-aaa',
    symbol: 'AAA',
    name: 'Alpha',
    source: 'holding',
    exDate: null,
    payDate: null,
    amount: 0.24,
    currency: 'USD',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DividendsWidget — the date an event is upcoming on (V5-P5, #1758)', () => {
  // The API's own fixture (portfolioMarketIntelService.test.ts): AAA went ex a
  // week ago but pays in a week, CCC goes ex in two days and has no pay date.
  // The endpoint therefore returns [CCC, AAA] — sorted on the date each event
  // is still upcoming on.
  const PAST_EX = iso(-7);
  const FUTURE_PAY = iso(7);
  const CCC_EX = iso(2);
  const SERVER_ORDER = [
    entry({ assetId: 'a-ccc', symbol: 'CCC', name: 'Gamma', exDate: CCC_EX, payDate: null }),
    entry({ exDate: PAST_EX, payDate: FUTURE_PAY }),
  ];

  test('renders the pay date, labelled as one, for an event already gone ex', async () => {
    vi.mocked(getPortfolioDividendCalendar).mockResolvedValue({
      available: true,
      entries: SERVER_ORDER,
    });

    renderWidget();

    expect(await screen.findByText(`Pay date · ${formatDate(FUTURE_PAY)}`)).toBeInTheDocument();
    // The ex-date is behind us: no surface under "upcoming" may print it.
    expect(screen.queryByText(new RegExp(formatDate(PAST_EX)))).not.toBeInTheDocument();
    expect(screen.getByText(`Ex-date · ${formatDate(CCC_EX)}`)).toBeInTheDocument();
  });

  test("keeps the API's order instead of re-sorting on a date that has passed", async () => {
    vi.mocked(getPortfolioDividendCalendar).mockResolvedValue({
      available: true,
      entries: SERVER_ORDER,
    });

    renderWidget();

    await waitFor(() => expect(screen.getByText('CCC')).toBeInTheDocument());
    const symbols = screen.getAllByRole('link').map((link) => link.textContent);
    expect(symbols).toEqual(['CCC', 'AAA']);
  });

  test('drops an event whose every date has passed', async () => {
    vi.mocked(getPortfolioDividendCalendar).mockResolvedValue({
      available: true,
      entries: [entry({ exDate: iso(-9), payDate: iso(-2) })],
    });

    renderWidget();

    // An event with nothing ahead of it is not information — the widget says so
    // rather than printing last week's date.
    expect(await screen.findByText('No dividends coming up.')).toBeInTheDocument();
  });
});
