import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/aiApi', () => ({
  AI_CAPABILITY_QUERY_KEY: ['ai', 'capability'],
  useAiCapability: vi.fn(),
}));

import { useAiCapability } from '../../lib/aiApi';
import { ParkedPage } from './ParkedPage';

const AI_AVAILABLE = {
  available: true,
  model: 'llama3.1:8b',
  dailyCap: 20,
  used: 0,
  remaining: 20,
};

function renderAsk() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ParkedPage page="ask" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ParkedPage — the AI-gated /ask surface (§6.18)', () => {
  test('advertises the shipped AI features and links to them while a provider is configured', () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AI_AVAILABLE } as never);
    renderAsk();

    expect(screen.getByText(/are live today/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'AI insights in Analysis' })).toHaveAttribute(
      'href',
      '/portfolio/analysis',
    );
    expect(screen.getByRole('link', { name: 'Blueprint builder' })).toHaveAttribute(
      'href',
      '/workbench/blueprints/new',
    );
  });

  test('claims nothing and links nowhere when no AI provider is configured', () => {
    vi.mocked(useAiCapability).mockReturnValue({
      data: { ...AI_AVAILABLE, available: false },
    } as never);
    renderAsk();

    // No "live today" promise, and no walk to a page that would render nothing.
    expect(screen.queryByText(/are live today/)).toBeNull();
    expect(screen.getByText(/lands here once it is built/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'AI insights in Analysis' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Blueprint builder' })).toBeNull();
  });

  test('a page with no AI claim renders without the capability read', () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: undefined } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ParkedPage page="screener" />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(useAiCapability).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open search' })).toBeInTheDocument();
  });
});
