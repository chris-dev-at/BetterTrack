import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  test('announces loading while the digest is pending and clears it when it settles', async () => {
    let resolveDigest: (value: NewsDigestResponse) => void;
    const pendingDigest = new Promise<NewsDigestResponse>((resolve) => {
      resolveDigest = resolve;
    });
    vi.mocked(getNewsDigest).mockReturnValue(pendingDigest);
    renderPage();

    const digest = screen.getByRole('region', { name: 'News' });
    expect(digest).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();

    resolveDigest!(AVAILABLE);

    expect(await screen.findByText('Apple ships a thing')).toBeInTheDocument();
    expect(digest).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByRole('status', { name: 'Loading…' })).not.toBeInTheDocument();
  });

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
    vi.mocked(getNewsDigest)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ available: true, groups: [] });
    const user = userEvent.setup();
    renderPage();
    expect(
      await screen.findByText('Could not load the news digest. Please try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'News' })).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByRole('status', { name: 'Loading…' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No recent news')).toBeInTheDocument();
    expect(getNewsDigest).toHaveBeenCalledTimes(2);
  });

  test('says the arc is unconfigured, never "no headlines yet" (regression)', async () => {
    vi.mocked(getNewsDigest).mockResolvedValue({ available: false, groups: [] });
    renderPage();
    // Reachable by direct URL only (the nav + palette entries are gone): it has
    // to name the deploy-level kill-switch rather than pass it off as a quiet
    // news day.
    expect(await screen.findByText('News is switched off here')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Market intelligence is not configured for this installation, so no headlines are collected.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('No recent news')).not.toBeInTheDocument();
    // …and never any headlines.
    expect(screen.queryByText('Held')).not.toBeInTheDocument();
    expect(screen.queryByText('Watched')).not.toBeInTheDocument();
  });
});
