import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  CashMonthlySummaryResponse,
  CashTrendResponse,
  PortfolioListResponse,
} from '@bettertrack/contracts';

vi.mock('../../../lib/portfolioApi');
vi.mock('../../../lib/cashApi', () => ({
  CASH_TAGS_QUERY_KEY: ['cash', 'tags'],
  cashSummaryQueryKey: (portfolioId: string, month?: string) => [
    'cash',
    'summary',
    portfolioId,
    month,
  ],
  cashTrendsQueryKey: (portfolioId: string, months?: number) => [
    'cash',
    'trends',
    portfolioId,
    months,
  ],
  getCashSummary: vi.fn(),
  getCashTrends: vi.fn(),
  listCashTags: vi.fn(),
  previewCashRules: vi.fn(),
  setCashMovementTags: vi.fn(),
}));

import { getCashMovements, listCashSources, listPortfolios } from '../../../lib/portfolioApi';
import {
  getCashSummary,
  getCashTrends,
  listCashTags,
  previewCashRules,
} from '../../../lib/cashApi';
import { ApiError } from '../../../lib/apiClient';
import { waitForColdStart } from '../../../test/waitForColdStart';

import { CashOverviewPage } from './CashOverviewPage';
import { setViewportWidth } from '../../../test/viewport';

const PORTFOLIOS: PortfolioListResponse = {
  portfolios: [
    {
      id: 'p1',
      name: 'Main',
      visibility: 'private',
      sortOrder: 0,
      isDefault: true,
      defaultPayFromCash: false,
      archivedAt: null,
    },
  ],
};

const EMPTY_TRENDS: CashTrendResponse = { portfolioId: 'p1', points: [] };

function summary(over: Partial<CashMonthlySummaryResponse> = {}): CashMonthlySummaryResponse {
  return {
    portfolioId: 'p1',
    month: '2026-07',
    totalInflow: 0,
    totalOutflow: 0,
    net: 0,
    tags: [],
    ...over,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CashOverviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function findTagBreakdown() {
  return waitForColdStart(() => screen.getByRole('list', { name: 'Spending by tag' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPortfolios).mockResolvedValue(PORTFOLIOS);
  vi.mocked(getCashTrends).mockResolvedValue(EMPTY_TRENDS);
  vi.mocked(getCashSummary).mockResolvedValue(summary());
  vi.mocked(listCashTags).mockResolvedValue({ tags: [] });
  vi.mocked(previewCashRules).mockResolvedValue({ tagIds: [] });
  // The overview now also opens on the BALANCE, so it reads the portfolio's
  // cash sources and its ledger. Both are auto-mocked by `vi.mock` above; give
  // them empty-but-valid shapes so a case that does not care about them still
  // renders the rest of the page.
  vi.mocked(listCashSources).mockResolvedValue({ sources: [] });
  vi.mocked(getCashMovements).mockResolvedValue({
    balanceEur: 0,
    movements: [],
    sources: [],
    nextCursor: null,
  } as unknown as Awaited<ReturnType<typeof getCashMovements>>);
});

describe('CashOverviewPage', () => {
  test('requests only the bounded recent movement page', async () => {
    vi.mocked(getCashMovements).mockResolvedValue({
      balanceEur: 25,
      movements: [
        {
          id: 'movement-recent',
          sourceId: 'source-main',
          kind: 'deposit',
          amountEur: 25,
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: '2026-07-15T10:00:00.000Z',
          note: 'Recent deposit',
          source: 'manual',
          createdAt: '2026-07-15T10:00:00.000Z',
        },
      ],
      sources: [],
      nextCursor: 'older-cursor',
    } as Awaited<ReturnType<typeof getCashMovements>>);
    renderPage();

    expect(await waitForColdStart(() => screen.getByText('Recent deposit'))).toBeInTheDocument();
    expect(getCashMovements).toHaveBeenCalledWith(
      'p1',
      { cursor: undefined, limit: 5 },
      expect.anything(),
    );
    expect(getCashMovements).toHaveBeenCalledTimes(1);
  });

  test('390px keeps account actions touchable and opens the cash sheet', async () => {
    setViewportWidth(390);
    vi.mocked(listCashSources).mockResolvedValue({
      sources: [
        {
          id: 'source-savings',
          name: 'Savings',
          type: 'bank',
          isMain: true,
          archivedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          balanceEur: 500,
        },
      ],
    });
    const user = userEvent.setup();
    renderPage();

    const heading = await waitForColdStart(() => screen.getByRole('heading', { name: 'Cash' }));
    expect(heading.closest('.bt-money-surface')).not.toBeNull();
    const deposit = screen.getByRole('button', { name: 'Add to Savings' });
    expect(deposit).toHaveClass('bt-acctcard__action');

    await user.click(deposit);
    const dialog = screen.getByRole('dialog', { name: 'Record transaction' });
    expect(dialog).toHaveClass('bt-dialog__panel--phone-sheet');
    expect(within(dialog).getByRole('button', { name: 'Money in' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('renders balance-ledger read failures without hiding the monthly summary', async () => {
    vi.mocked(getCashSummary).mockResolvedValue(summary({ net: 3_200 }));
    vi.mocked(listCashSources).mockRejectedValue(new Error('sources unavailable'));
    vi.mocked(getCashMovements).mockRejectedValue(new Error('movements unavailable'));
    renderPage();

    expect(await screen.findAllByText("This information isn't available.")).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Cash' })).toBeInTheDocument();
    expect(screen.getByText(/3\.200,00.*this month/)).toBeInTheDocument();
    expect(screen.queryByText('No cash accounts yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('Total cash')).not.toBeInTheDocument();
  });

  test('keeps cached cash accounts visible after a failed background refetch', async () => {
    vi.mocked(listCashSources).mockResolvedValue({
      sources: [
        {
          id: 'src-savings',
          name: 'Savings',
          type: 'bank',
          isMain: true,
          archivedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          balanceEur: 1_234,
        },
      ],
    });
    const { client } = renderPage();

    expect(await waitForColdStart(() => screen.getByText('Savings'))).toBeInTheDocument();
    expect(screen.getByText('Total cash')).toBeInTheDocument();

    vi.mocked(listCashSources).mockRejectedValue(
      new ApiError(503, 'UNAVAILABLE', 'sources offline'),
    );
    await act(async () => {
      await client.refetchQueries({
        queryKey: ['portfolio', 'p1', 'cash-sources', false],
        type: 'active',
      });
    });

    expect(screen.getByText('Savings')).toBeInTheDocument();
    expect(screen.getByText('Total cash')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  test('renders in/out/net for the resolved portfolio', async () => {
    vi.mocked(getCashSummary).mockResolvedValue(
      summary({ totalInflow: 4_200, totalOutflow: 1_000, net: 3_200 }),
    );
    renderPage();

    // No I18nProvider wraps this render (mirrors CashSourcesPage.test.tsx), so
    // `formatMoney` renders under its de-AT module default: "1.234,56 €".
    // In/out sit together on the month line; the net reads as a change against
    // the balance above it ("… this month") rather than as a third bare figure,
    // so it is matched inside its sentence.
    expect(await waitForColdStart(() => screen.getByText(/4\.200,00/))).toBeInTheDocument();
    expect(screen.getByText(/1\.000,00/)).toBeInTheDocument();
    expect(screen.getByText(/3\.200,00.*this month/)).toBeInTheDocument();
  });

  test('states plainly that per-tag rows do not sum to the total', async () => {
    vi.mocked(getCashSummary).mockResolvedValue(
      summary({
        totalOutflow: 500,
        tags: [
          {
            tagId: 't1',
            name: 'Food',
            color: '#22c55e',
            system: false,
            outflow: 300,
            inflow: 0,
            movements: 2,
          },
          {
            tagId: 't2',
            name: 'Groceries',
            color: '#3987e5',
            system: false,
            outflow: 300,
            inflow: 0,
            movements: 2,
          },
        ],
      }),
    );
    renderPage();

    // Scoped to the ranked bars: the donut beside them carries the same labels.
    const bars = await findTagBreakdown();
    expect(within(bars).getByText('Food')).toBeInTheDocument();
    expect(within(bars).getByText('Groceries')).toBeInTheDocument();
    // 300 + 300 ≠ 500 — the note explaining why must be on screen, not just implied.
    expect(
      screen.getByText(
        "Tag totals overlap — a movement with two tags counts toward both, so they won't add up to the total above.",
      ),
    ).toBeInTheDocument();
  });

  test('labels the untagged bucket instead of rendering a blank tag chip', async () => {
    vi.mocked(getCashSummary).mockResolvedValue(
      summary({
        totalOutflow: 100,
        tags: [
          {
            tagId: null,
            name: null,
            color: null,
            system: false,
            outflow: 100,
            inflow: 0,
            movements: 1,
          },
        ],
      }),
    );
    renderPage();

    const bars = await findTagBreakdown();
    expect(within(bars).getByText('Untagged')).toBeInTheDocument();
  });

  test('omits the breakdown and its note when nothing happened this month', async () => {
    renderPage();

    expect(
      await waitForColdStart(() => screen.getByText('No cash movements recorded this month.')),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Tag totals overlap/)).not.toBeInTheDocument();
  });

  test('renders a load error when the summary request fails', async () => {
    vi.mocked(getCashSummary).mockRejectedValue(new Error('offline'));
    renderPage();

    expect(await waitForColdStart(() => screen.getByRole('alert'))).toHaveTextContent(
      "Couldn't load the cash overview.",
    );
  });
});
