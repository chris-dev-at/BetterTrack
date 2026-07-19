import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { NewsDigestResponse } from '@bettertrack/contracts';

vi.mock('../../lib/marketIntelApi', () => ({
  PORTFOLIO_NEWS_DIGEST_QUERY_KEY: ['portfolio', 'news-digest'],
  getNewsDigest: vi.fn(),
}));

import { getNewsDigest } from '../../lib/marketIntelApi';
import { NewsDigestPage } from './NewsDigestPage';

const AVAILABLE: NewsDigestResponse = {
  available: true,
  groups: [
    {
      assetId: 'a-aapl',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      held: true,
      watched: false,
      headlines: [
        {
          id: 'aapl-new',
          title: 'Apple ships a thing',
          publisher: 'Reuters',
          url: 'https://example.com/aapl-new',
          publishedAt: '2026-06-20T08:00:00.000Z',
        },
      ],
    },
    {
      assetId: 'a-msft',
      symbol: 'MSFT',
      name: 'Microsoft',
      held: false,
      watched: true,
      headlines: [
        {
          id: 'msft-1',
          title: 'Microsoft does something',
          publisher: 'Bloomberg',
          url: 'https://example.com/msft-1',
          publishedAt: '2026-06-19T08:00:00.000Z',
        },
      ],
    },
  ],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NewsDigestPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NewsDigestPage (§13.5 V5-P5, arc c)', () => {
  test('aggregates holdings + watchlist news, grouped per asset, newest-first', async () => {
    vi.mocked(getNewsDigest).mockResolvedValue(AVAILABLE);
    renderPage();

    await waitFor(() => expect(screen.getByText('Apple ships a thing')).toBeInTheDocument());
    // Both a held and a watchlisted asset's headlines surface.
    expect(screen.getByText('Microsoft does something')).toBeInTheDocument();
    expect(screen.getByText('Held')).toBeInTheDocument();
    expect(screen.getByText('Watched')).toBeInTheDocument();

    // Groups are ordered by their newest headline — AAPL (Jun 20) before MSFT (Jun 19).
    const symbols = screen.getAllByRole('link', { name: /AAPL|MSFT/ }).map((el) => el.textContent);
    expect(symbols).toEqual(['AAPL', 'MSFT']);
  });

  test('shows a graceful empty state when there is no news', async () => {
    vi.mocked(getNewsDigest).mockResolvedValue({ available: true, groups: [] });
    renderPage();
    expect(await screen.findByText('No recent news')).toBeInTheDocument();
  });

  test('shows a graceful error state when the request fails', async () => {
    vi.mocked(getNewsDigest).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(
      await screen.findByText('Could not load the news digest. Please try again.'),
    ).toBeInTheDocument();
  });

  test('renders no news UI when the capability is unconfigured (regression)', async () => {
    vi.mocked(getNewsDigest).mockResolvedValue({ available: false, groups: [] });
    renderPage();
    // The unconfigured shape resolves to the empty state — never any headlines.
    expect(await screen.findByText('No recent news')).toBeInTheDocument();
    expect(screen.queryByText('Held')).not.toBeInTheDocument();
    expect(screen.queryByText('Watched')).not.toBeInTheDocument();
  });
});
