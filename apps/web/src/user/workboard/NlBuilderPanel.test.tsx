import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { AiCapabilityResponse, AiConglomerateDraftResponse } from '@bettertrack/contracts';

vi.mock('../../lib/aiApi', () => ({
  AI_CAPABILITY_QUERY_KEY: ['ai', 'capability'],
  useAiCapability: vi.fn(),
  draftConglomerate: vi.fn(),
}));

import { draftConglomerate, useAiCapability } from '../../lib/aiApi';
import type { BuilderPosition } from './conglomerateBuilder';
import { NlBuilderPanel } from './NlBuilderPanel';

const AVAILABLE: AiCapabilityResponse = {
  available: true,
  model: 'llama3.1:8b',
  dailyCap: 5,
  used: 0,
  remaining: 5,
};

const ASSET_ID = '00000000-0000-7000-8000-000000000001';

const DRAFT: AiConglomerateDraftResponse = {
  model: 'llama3.1:8b',
  lines: [
    {
      query: 'nasdaq',
      weightPct: 60,
      asset: { id: ASSET_ID, symbol: 'QQQ', name: 'Nasdaq 100', type: 'etf', currency: 'USD' },
    },
    { query: 'unicorn dust', weightPct: 40, asset: null },
  ],
};

function renderPanel(onApply: (positions: BuilderPosition[]) => void = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NlBuilderPanel onApply={onApply} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NlBuilderPanel', () => {
  test('renders NOTHING when the capability read says AI is unavailable (regression)', () => {
    vi.mocked(useAiCapability).mockReturnValue({
      data: { ...AVAILABLE, available: false },
    } as never);
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });

  test('prefills the builder with resolved lines and flags — never drops — unresolvable ones', async () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AVAILABLE } as never);
    vi.mocked(draftConglomerate).mockResolvedValue(DRAFT);
    const onApply = vi.fn();
    renderPanel(onApply);

    await userEvent.type(screen.getByRole('textbox'), '60% nasdaq, 40% unicorn dust');
    await userEvent.click(screen.getByRole('button', { name: 'Draft basket' }));

    // Only the RESOLVED line becomes a builder position; the weight is the model's,
    // the asset id comes from the catalog resolution.
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith([
        expect.objectContaining({ kind: 'asset', refId: ASSET_ID, symbol: 'QQQ', weightPct: 60 }),
      ]),
    );

    // The unresolvable intent is surfaced (flagged), never silently dropped.
    expect(screen.getByText('unicorn dust')).toBeInTheDocument();
    expect(screen.getByText(/No catalog match/i)).toBeInTheDocument();
  });

  test('keeps the draft as a review step — the panel never saves anything itself', async () => {
    vi.mocked(useAiCapability).mockReturnValue({ data: AVAILABLE } as never);
    vi.mocked(draftConglomerate).mockResolvedValue(DRAFT);
    renderPanel();

    await userEvent.type(screen.getByRole('textbox'), 'anything');
    await userEvent.click(screen.getByRole('button', { name: 'Draft basket' }));

    await waitFor(() => expect(screen.getByText(/Prefilled/i)).toBeInTheDocument());
    // The only actions are draft/review — nothing that persists a conglomerate.
    expect(screen.queryByRole('button', { name: /save|activate|create/i })).toBeNull();
  });
});
