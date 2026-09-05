import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { NewsDigestGroup } from '@bettertrack/contracts';

vi.mock('../../../lib/marketIntelApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/marketIntelApi')>()),
  getNewsDigest: vi.fn(),
}));

import { getNewsDigest } from '../../../lib/marketIntelApi';

import { NewsWidget } from './NewsWidget';
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
      <NewsWidget {...BASE_PROPS} settings={{}} size={size} />
    </QueryClientProvider>,
  );
}

const MACRO = {
  id: 'macro-1',
  title: 'Stocks slide as yields climb',
  publisher: 'Reuters',
  url: 'https://example.com/macro-1',
  publishedAt: '2026-06-21T08:00:00.000Z',
};

function group(index: number, headlines: NewsDigestGroup['headlines']): NewsDigestGroup {
  return {
    assetId: `a-${index}`,
    symbol: `SYM${index}`,
    name: `Asset ${index}`,
    held: true,
    watched: false,
    headlines,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NewsWidget — one story, one row (#1758)', () => {
  test('renders a market-wide article once even when six held symbols carry it', async () => {
    // The shape `origin/main` served: the same macro story at the top of every
    // held asset's group, so the whole widget was one article.
    vi.mocked(getNewsDigest).mockResolvedValue({
      available: true,
      groups: Array.from({ length: 6 }, (_, i) =>
        group(i, [
          MACRO,
          {
            id: `own-${i}`,
            title: `Asset ${i} reports`,
            publisher: 'Reuters',
            url: `https://example.com/own-${i}`,
            publishedAt: '2026-06-20T08:00:00.000Z',
          },
        ]),
      ),
    });

    renderWidget();

    expect(await screen.findAllByText(MACRO.title)).toHaveLength(1);
    // …and every asset still shows its own headline.
    for (let i = 0; i < 6; i += 1) {
      expect(screen.getByText(`Asset ${i} reports`)).toBeInTheDocument();
    }
  });

  test('drops a group left with nothing of its own', async () => {
    vi.mocked(getNewsDigest).mockResolvedValue({
      available: true,
      groups: [group(0, [MACRO]), group(1, [MACRO])],
    });

    renderWidget();

    expect(await screen.findByText(MACRO.title)).toBeInTheDocument();
    expect(screen.getByText('SYM0')).toBeInTheDocument();
    // A bare symbol with no headline under it is a slot the user cannot read.
    expect(screen.queryByText('SYM1')).not.toBeInTheDocument();
  });
});
