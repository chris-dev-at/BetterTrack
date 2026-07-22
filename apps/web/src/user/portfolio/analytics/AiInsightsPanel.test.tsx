import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { AiCapabilityResponse, AiInsightsResponse } from '@bettertrack/contracts';

vi.mock('../../../lib/aiApi', () => ({
  AI_CAPABILITY_QUERY_KEY: ['ai', 'capability'],
  useAiCapability: vi.fn(),
  generateInsights: vi.fn(),
}));

import { ApiError } from '../../../lib/apiClient';
import { generateInsights, useAiCapability } from '../../../lib/aiApi';
import { AiInsightsPanel } from './AiInsightsPanel';

const AVAILABLE: AiCapabilityResponse = {
  available: true,
  model: 'llama3.1:8b',
  dailyCap: 5,
  used: 0,
  remaining: 5,
};

const INSIGHT: AiInsightsResponse = {
  model: 'llama3.1:8b',
  observations: [
    {
      kind: 'concentration',
      facts: [
        { key: 'topWeightPct', value: 42 },
        { key: 'positionCount', value: 4 },
      ],
    },
  ],
  summary: 'Your portfolio is concentrated in a few names.',
};

function renderPanel(hasHoldings = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AiInsightsPanel portfolioId="p1" hasHoldings={hasHoldings} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AiInsightsPanel', () => {
  test('renders NOTHING when the capability read says AI is unavailable (regression)', () => {
    vi.mocked(useAiCapability).mockReturnValue({
      data: { ...AVAILABLE, available: false },
    } as never);
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('AI insights')).toBeNull();
  });

  test('renders NOTHING while the capability read is still loading', () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: undefined } as never);
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });

  test('generates an insight with the hard "not financial advice" disclaimer and no action buttons', async () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AVAILABLE } as never);
    vi.mocked(generateInsights).mockResolvedValue(INSIGHT);
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Generate insights' }));

    await waitFor(() => expect(screen.getByText(INSIGHT.summary)).toBeInTheDocument());
    // Hard framing is always shown alongside the AI output.
    expect(screen.getByText(/not financial advice/i)).toBeInTheDocument();
    // Service-computed facts render (label + value).
    expect(screen.getByText('Concentration')).toBeInTheDocument();
    expect(screen.getByText('Largest holding')).toBeInTheDocument();
    // Informational only: nothing that would apply/act on the portfolio.
    expect(screen.queryByRole('button', { name: /apply|buy|sell|save|rebalance/i })).toBeNull();
  });

  test('degrades gracefully when the daily cap is exhausted mid-request', async () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AVAILABLE } as never);
    vi.mocked(generateInsights).mockRejectedValue(
      new ApiError(429, 'AI_CAP_EXCEEDED', 'Daily AI limit reached.'),
    );
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Generate insights' }));

    await waitFor(() => expect(screen.getByText(/reached today's AI limit/i)).toBeInTheDocument());
  });

  test('disables generation when the portfolio has no holdings', () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AVAILABLE } as never);
    renderPanel(false);
    expect(screen.getByRole('button', { name: 'Generate insights' })).toBeDisabled();
    expect(screen.getByText(/Add some holdings/i)).toBeInTheDocument();
  });
});
